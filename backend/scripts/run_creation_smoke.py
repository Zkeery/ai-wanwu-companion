"""Prepared real-provider smoke test. Dry-run by default; --run requires approval.

One synthetic cup, one recognition, two text calls, one image; no auto retries.
All application data is isolated. Does not read existing companion history.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import tempfile
import time
import zlib

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "docs/PRD/版本/V1.0/验收证据/前端阶段2"


def synthetic_cup():
    """Small procedural PNG test fixture, not an example of product art."""
    def chunk(kind, body):
        return struct.pack('!I', len(body)) + kind + body + struct.pack('!I', zlib.crc32(kind + body))
    rows = []
    for y in range(256):
        row = bytearray([0])
        for x in range(256):
            color = (230, 235, 222)
            if y > 210:
                color = (177, 141, 111)
            ring = ((x - 178) / 37) ** 2 + ((y - 134) / 38) ** 2
            if 0.52 < ring < 1:
                color = (247, 236, 208)
            if 65 <= x <= 177 and 78 <= y <= 183:
                color = (252, 242, 217)
            if ((x - 121) / 56) ** 2 + ((y - 183) / 21) ** 2 < 1:
                color = (252, 242, 217)
            if ((x - 121) / 56) ** 2 + ((y - 78) / 14) ** 2 < 1:
                color = (112, 91, 73)
            row.extend(color)
        rows.append(row)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', 256, 256, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b'')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', action='store_true')
    parser.add_argument('--batch', choices=['initial', 'retry1'], default='initial')
    args = parser.parse_args()
    suffix = '' if args.batch == 'initial' else '-retry1'
    result_path = EVIDENCE / f'真实创建冒烟结果{suffix}.json'
    if result_path.exists():
        raise SystemExit('Existing results and manifest retained; no repeat allowed.')
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    image = synthetic_cup()
    (EVIDENCE / '真实冒烟合成杯子.png').write_bytes(image)
    text_reserve = (6000 * 2.1 + 1024 * 2.7) / 1_000_000
    ceiling = 2 * text_reserve + 0.016
    manifest_name = f'真实冒烟运行配置{suffix}.json'
    prior_ceiling = 0
    for old_path in EVIDENCE.glob('真实创建冒烟结果*.json'):
        if old_path == result_path:
            continue
        old = json.loads(old_path.read_text())
        prior_ceiling += sum(call['reserved_cny'] for call in old['calls'])
    manifest = {
        'budget_cny': 0.05, 'preflight_ceiling_cny': ceiling,
        'prior_reserved_cny': prior_ceiling, 'batch': args.batch,
        'models': {'vision': 'ling-3.0-flash-vl', 'chat': 'qwen3.8-flash', 'image': 'wan2.6-t2i'},
        'calls': {'vision': 1, 'text': 2, 'image': 1}, 'max_retries': 0,
        'max_tokens_per_text_call': 1024, 'max_input_text_bytes': 6000,
        'prices': {'vision': 'Current official announcement: temporarily free', 'chat_input_conservative_cny_per_million': 2.1, 'chat_output_cny_per_million': 2.7, 'image_cny_each': 0.016},
        'pricing_checked': '2026-09-18',
        'pricing_sources': ['https://maas.antdigital.com/models/modelservice-1779365948338001295', 'https://maas.antdigital.com/models/modelservice-1788174495570001431'],
        'fixture_sha256': hashlib.sha256(image).hexdigest(),
        'scope': 'One isolated photo->correction->generation->rename->collection smoke; not visual quality scoring',
    }
    (EVIDENCE / manifest_name).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    assert ceiling + prior_ceiling <= manifest['budget_cny']
    if not args.run:
        print(json.dumps({'dry_run': True, 'ceiling_cny': ceiling, 'paid_calls': 0}))
        return
    import sys
    sys.path.insert(0, str(PROJECT / 'backend'))
    (PROJECT / '.runtime').mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='creation-real-', dir=PROJECT / '.runtime') as tmp:
        os.environ['DATABASE_URL'] = f'sqlite:///{tmp}/smoke.db'
        os.environ['UPLOAD_DIR'] = f'{tmp}/uploads'
        os.environ['MODEL_MAX_RETRIES'] = '0'
        from app.core.config import get_settings
        settings = get_settings()
        assert not settings.use_mock
        assert settings.model_base_url == 'https://maas-api.antdigital.com/v1'
        assert (settings.image_base_url or settings.model_base_url) == settings.model_base_url
        assert [settings.vision_model, settings.chat_model, settings.image_model] == list(manifest['models'].values())
        import httpx
        original_post = httpx.Client.post
        counts = Counter()
        result = {'manifest': manifest_name, 'calls': [], 'checks': {}, 'passed': False}

        def persist():
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')

        def bounded_post(client, url, **kwargs):
            if not str(url).startswith(settings.model_base_url + '/'):
                return original_post(client, url, **kwargs)
            payload = kwargs.get('json', {})
            model = payload.get('model')
            limits = {settings.vision_model: 1, settings.chat_model: 2, settings.image_model: 1}
            assert model in limits and counts[model] < limits[model], 'Unexpected paid call blocked'
            assert str(url) == settings.model_base_url + ('/images/generations' if model == settings.image_model else '/chat/completions')
            if model == settings.image_model:
                assert payload['n'] == 1 and payload['size'] == '1024x1024'
            else:
                payload['max_tokens'] = 1024
                if model == settings.chat_model:
                    assert len(json.dumps(payload['messages'], ensure_ascii=False).encode()) <= 6000
            counts[model] += 1
            call = {'model': model, 'started_at': time.time(), 'reserved_cny': 0.016 if model == settings.image_model else text_reserve if model == settings.chat_model else 0}
            result['calls'].append(call)
            persist()
            try:
                response = original_post(client, url, **kwargs)
            except Exception as exc:
                call['transport_error_type'] = type(exc).__name__
                call['transport_cause_type'] = type(exc.__cause__).__name__ if exc.__cause__ else None
                call['seconds'] = round(time.time() - call['started_at'], 3)
                persist()
                raise
            call['http_status'] = response.status_code
            call['seconds'] = round(time.time() - call['started_at'], 3)
            if response.status_code == 200:
                call['usage'] = response.json().get('usage')
            persist()
            return response

        httpx.Client.post = bounded_post
        try:
            from fastapi.testclient import TestClient
            from app.main import app
            from uuid import uuid4
            with TestClient(app) as client:
                response = client.post('/api/v1/photos', files={'file': ('synthetic-cup.png', image, 'image/png')}, headers={'Idempotency-Key': str(uuid4())})
                result['recognition_http_status'] = response.status_code
                if response.status_code != 201:
                    result['recognition_error'] = response.json()
                assert response.status_code == 201, 'Recognition failed'
                photo = response.json()
                result['photo'] = photo
                oid = photo['objects'][0]['id']
                response = client.post('/api/v1/characters', json={'object_id': oid, 'label': '一只米白色陶瓷杯，带圆形把手'})
                result['generation_sse'] = response.text
                saved = client.get(f'/api/v1/characters/by-object/{oid}').json()
                assert saved and saved['status'] == 'ready', 'Generation incomplete'
                image_file = Path(settings.upload_dir) / saved['image_path']
                assert image_file.is_file() and image_file.stat().st_size > 256, 'Image not saved'
                artifact = '真实生成杯子' + image_file.suffix
                shutil.copyfile(image_file, EVIDENCE / artifact)
                result['image_artifact'] = artifact
                renamed = client.patch(f"/api/v1/characters/{saved['id']}", json={'name': '冒烟小杯'}).json()
                collection = client.get('/api/v1/characters').json()
                assert renamed['name'] == '冒烟小杯' and len(collection) == 1 and collection[0]['name'] == '冒烟小杯'
                result['checks'] = {'recognition': True, 'generation_ready': True, 'image_saved': True, 'renamed_and_collected': True}
                result['character'] = renamed
                result['passed'] = True
        except Exception as exc:
            result['error_type'] = type(exc).__name__
        finally:
            httpx.Client.post = original_post
            result['reserved_cny'] = sum(c['reserved_cny'] for c in result['calls'])
            persist()
        print(json.dumps({'passed': result['passed'], 'calls': dict(counts), 'reserved_cny': result['reserved_cny']}))


if __name__ == '__main__':
    main()
