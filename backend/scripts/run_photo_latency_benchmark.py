"""One authorized, isolated browser benchmark. Defaults to dry-run, no provider calls."""
import argparse
import json
import os
from pathlib import Path
import sys
from threading import Lock
import time

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / 'docs/PRD/版本/V1.1/验收证据/阶段3'
AUTH = EVIDENCE / '真实全链路测速价格与授权.json'
LEDGER = EVIDENCE / '真实全链路测速调用账本.json'
RUNTIME = PROJECT / '.runtime/photo-latency-benchmark'
MODELS = {'vision': 'ling-3.0-flash-vl', 'text': 'qwen3.8-flash', 'image': 'wan2.6-t2i'}
RESERVES = {'vision': 0.0, 'text': 0.1, 'image': 0.016}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    auth = json.loads(AUTH.read_text())
    assert auth['authorized'] and auth['max_groups'] == 3 and auth['budget_cny'] == 1
    assert auth['date'] == time.strftime('%Y-%m-%d') == '2026-09-21', 'Recheck authorization and prices for a new date'
    assert auth['prices']['vision']['input_cny_per_million'] == auth['prices']['vision']['output_cny_per_million'] == 0
    assert auth['prices']['text']['input_cny_per_million'] <= 0.8
    assert auth['prices']['text']['output_cny_per_million'] <= 2.7
    assert auth['prices']['image']['cny_each'] <= RESERVES['image']
    assert 3 * sum(RESERVES.values()) <= auth['budget_cny']
    if not args.run:
        print(json.dumps({'dry_run': True, 'provider_calls': 0, 'maximum_reserved_cny': 3 * sum(RESERVES.values()), 'max_groups': 3}))
        return
    # A durable exclusive ledger blocks accidental re-execution after any outcome.
    with LEDGER.open('x') as f:
        json.dump({'status': 'starting', 'calls': []}, f)
    RUNTIME.mkdir(parents=True, exist_ok=True)
    os.environ.update(DATABASE_URL='sqlite:///' + str(RUNTIME / 'test.db'), UPLOAD_DIR=str(RUNTIME / 'uploads'), MODEL_MAX_RETRIES='0', CHARACTER_BUNDLE_ENABLED='true')
    sys.path.insert(0, str(PROJECT / 'backend'))
    from app.core.config import get_settings
    settings = get_settings()
    assert not settings.use_mock
    assert settings.model_base_url.rstrip('/') == 'https://maas-api.antdigital.com/v1'
    assert (settings.image_base_url or settings.model_base_url).rstrip('/') == settings.model_base_url.rstrip('/')
    assert (settings.vision_model, settings.chat_model, settings.image_model) == tuple(MODELS[k] for k in ['vision', 'text', 'image'])
    import httpx
    original_post, original_get = httpx.Client.post, httpx.Client.get
    lock = Lock()
    result = {'date': auth['date'], 'status': 'running', 'mock': False, 'budget_cny': 1, 'calls': [], 'downloads': []}

    def persist():
        tmp = LEDGER.with_suffix('.tmp')
        tmp.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        tmp.replace(LEDGER)

    def bounded_post(client, url, **kwargs):
        assert str(url).startswith(settings.model_base_url.rstrip('/') + '/'), 'Unexpected model endpoint'
        payload = kwargs.get('json', {})
        model = payload.get('model')
        kind = next((k for k, v in MODELS.items() if v == model), None)
        assert kind is not None
        assert str(url).endswith('/images/generations' if kind == 'image' else '/chat/completions')
        if kind == 'image':
            assert payload['n'] == 1 and payload['size'] == '1024x1024'
        else:
            if kind == 'text':
                assert len(json.dumps(payload['messages'], ensure_ascii=False).encode()) <= 20000
            payload['max_tokens'] = 4096
        with lock:
            assert time.strftime('%Y-%m-%d') == auth['date'], 'Price confirmation expired'
            assert sum(c['kind'] == kind for c in result['calls']) < 3, 'Call limit reached'
            assert sum(c['reserved_cny'] for c in result['calls']) + RESERVES[kind] <= 1
            group = sum(c['kind'] == 'vision' for c in result['calls']) + int(kind == 'vision')
            assert 1 <= group <= 3
            call = {'group': group, 'kind': kind, 'model': model, 'reserved_cny': RESERVES[kind], 'started_at': time.strftime('%Y-%m-%d %H:%M:%S')}
            result['calls'].append(call)
            persist()
        started = time.perf_counter()
        try:
            response = original_post(client, url, **kwargs)
            with lock:
                call['http_status'] = response.status_code
                if response.status_code == 200:
                    data = response.json()
                    call['usage'] = data.get('usage')
                    choices = data.get('choices') or []
                    if choices: call['finish_reason'] = choices[0].get('finish_reason')
            return response
        except Exception as exc:
            with lock: call['error_type'] = type(exc).__name__
            raise
        finally:
            with lock:
                call['seconds'] = round(time.perf_counter() - started, 3)
                result['reserved_cny'] = round(sum(c['reserved_cny'] for c in result['calls']), 6)
                persist()

    def timed_get(client, url, **kwargs):
        started = time.perf_counter()
        entry = {'group': sum(c['kind'] == 'vision' for c in result['calls'])}
        try:
            response = original_get(client, url, **kwargs)
            entry['http_status'] = response.status_code
            entry['bytes'] = len(response.content)
            return response
        except Exception as exc:
            entry['error_type'] = type(exc).__name__
            raise
        finally:
            with lock:
                entry['seconds'] = round(time.perf_counter() - started, 3)
                result['downloads'].append(entry)
                persist()

    httpx.Client.post, httpx.Client.get = bounded_post, timed_get
    from app.main import app
    import uvicorn
    try:
        uvicorn.run(app, host='127.0.0.1', port=8025)
    finally:
        with lock:
            result['status'] = 'stopped'
            persist()


if __name__ == '__main__':
    main()
