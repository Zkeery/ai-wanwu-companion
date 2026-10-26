"""POST-only sync/async envelopes for a separately approved finite trial.

Download recovery uses the existing HTTPS/host/size guarded asset downloader,
not this transport. Neither transport enables a production route or scheduler.
"""
import json
import hashlib
import logging
import time
import httpx

from app.services.trial_gate import PROFILES, TrialBlocked

TEXT_URL = 'https://maas-api.antdigital.com/v1/chat/completions'
TTS_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
MAX_RESPONSE = 1024 * 1024
logger = logging.getLogger(__name__)


def _dispatch_failure(kind, stage, error, status, started):
    # Fixed codes only: never log exception text, provider bodies, URLs or headers.
    if isinstance(error, httpx.ReadTimeout):
        code = 'read_timeout'
    elif isinstance(error, httpx.ConnectTimeout):
        code = 'connect_timeout'
    elif isinstance(error, httpx.WriteTimeout):
        code = 'write_timeout'
    elif isinstance(error, httpx.PoolTimeout):
        code = 'pool_timeout'
    elif isinstance(error, httpx.TimeoutException):
        code = 'provider_timeout'
    elif isinstance(error, httpx.ConnectError):
        code = 'connection_error'
    elif isinstance(error, httpx.RemoteProtocolError):
        code = 'protocol_error'
    elif status is not None and status != 200:
        code = 'http_error'
    elif isinstance(error, TrialBlocked) and error.args == ('response_too_large',):
        code = 'response_too_large'
    elif stage == 'response_validation':
        code = 'response_invalid'
    else:
        code = 'dispatch_interrupted'
    logger.warning('TRIAL_DISPATCH_FAILURE %s', json.dumps({
        'code': code, 'stage': stage, 'kind': kind, 'vendor': PROFILES[kind][0],
        'elapsed_ms': max(0, round((time.monotonic() - started) * 1000)),
        'http_status': status,
    }, sort_keys=True))


def _object(pairs):
    out = {}
    for key, value in pairs:
        if key in out:
            raise ValueError('duplicate_field')
        out[key] = value
    return out


def _constant(_):
    raise ValueError('nonfinite_json')


class Envelope:
    def __init__(self, gate, kind, owner, subject, operation, evidence, *, presence='visible'):
        self.gate, self.kind = gate, kind
        self.owner, self.subject, self.operation = owner, subject, operation
        self.evidence, self.presence = evidence, presence

    def claim(self, request):
        try:
            assert self.kind in PROFILES
            vendor = PROFILES[self.kind][0]
            header = request.headers.get('authorization', '')
            assert header.startswith('Bearer ') and hashlib.sha256(header[7:].encode()).hexdigest() == self.gate.policy['credentials'][vendor]
            assert request.method == 'POST' and not request.url.query
            assert str(request.url) == (TTS_URL if self.kind == 'voice_tts' else TEXT_URL)
            assert len(request.content) <= (32768 if self.kind.startswith('voice') else 40000)
            body = json.loads(request.content, object_pairs_hook=_object, parse_constant=_constant)
            assert body['model'] == PROFILES[self.kind][1]
            if self.kind == 'voice_tts':
                assert set(body) == {'model', 'input'}
                inp = body['input']
                assert set(inp) == {'text', 'voice', 'language_type'}
                assert inp['voice'] == 'Cherry' and inp['language_type'] == 'Chinese'
                assert isinstance(inp['text'], str) and 0 < len(inp['text']) <= 300
            else:
                assert set(body) <= {'model', 'messages', 'max_tokens', 'stream', 'temperature', 'enable_thinking', 'thinking', 'response_format'}
                if self.kind == 'shared_life':
                    from app.living.gathering_dialogue import MaaSDialogueAdapter
                    assert body.get('response_format') == MaaSDialogueAdapter.request_options['response_format']
                else:
                    assert 'response_format' not in body
                assert body['stream'] is False
                assert type(body['max_tokens']) is int and body['max_tokens'] == (1024 if self.kind == 'voice_text' else 512)
                assert body.get('enable_thinking', False) is False
                assert body.get('thinking', {'type': 'disabled'}) == {'type': 'disabled'}
                assert isinstance(body['messages'], list) and body['messages']
                if self.kind != 'voice_text':
                    assert len(body['messages']) == 2
                assert body['messages'][0]['role'] == 'system' and body['messages'][-1]['role'] == 'user'
                assert all(set(m) == {'role', 'content'} and m['role'] in ('system', 'user', 'assistant')
                           and isinstance(m['content'], str) for m in body['messages'])
                if self.gate.policy['mode'] == 'shared_dialogue':
                    assert self.kind == 'shared_life'
                    facts = json.loads(body['messages'][-1]['content'], object_pairs_hook=_object, parse_constant=_constant)
                    pair = [p['character_id'] for p in facts['participants']]
                    assert all(type(cid) is int for cid in pair) and pair == self.gate.policy['character_ids']
        except (KeyError, TypeError, AssertionError, ValueError):
            self.gate.stop('request_envelope_invalid')
        try:
            evidence = self.evidence()  # Re-read wallet/price; never cache a previous permission.
        except Exception:
            self.gate.stop('evidence_unavailable')
        return self.gate.reserve(self.kind, self.owner, self.subject, self.operation, request.content,
                                 evidence, presence=self.presence)

    def validate(self, response, content):
        try:
            assert response.status_code == 200 and len(content) <= MAX_RESPONSE
            data = json.loads(content, object_pairs_hook=_object, parse_constant=_constant)
            if self.kind == 'voice_tts':
                assert data.get('status_code') in (None, 200) and data.get('success') is not False
                n = data['usage']['characters']
                assert type(n) is int and 0 <= n <= 600
                assert data['output'].get('finish_reason') in (None, 'stop')
                from app.services.qwen_tts_candidate import _validated_audio_url
                _validated_audio_url(data['output']['audio']['url'])
                usage = {'model': PROFILES[self.kind][1], 'characters': n}
            else:
                assert data['model'] == PROFILES[self.kind][1] and len(data['choices']) == 1
                choice = data['choices'][0]
                assert choice['finish_reason'] == 'stop' and choice['message']['role'] == 'assistant'
                assert not any(choice['message'].get(k) for k in ('tool_calls', 'function_call', 'refusal'))
                text = choice['message']['content']
                assert isinstance(text, str) and text.strip()
                if self.kind == 'voice_text':
                    assert len(text) <= 300
                u = data['usage'];a, b, total = (u[k] for k in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
                assert all(type(v) is int and v >= 0 for v in (a, b, total))
                assert a <= 1_000_000 and b <= 128_000 and total == a + b
                usage = {'model': data['model'], 'prompt_tokens': a, 'completion_tokens': b, 'total_tokens': total}
                if self.kind == 'private_life':
                    from app.living.life_provider import decode_reply
                    decode_reply(content)
                elif self.kind == 'shared_life':
                    from app.living.gathering_dialogue import decode_exchange
                    decode_exchange(content)
        except Exception:
            raise TrialBlocked('response_or_usage_unverified') from None
        return usage


class TrialTransport(httpx.BaseTransport):
    def __init__(self, envelope, delegate=None):
        self.envelope = envelope
        self.delegate = delegate or httpx.HTTPTransport(retries=0)

    def handle_request(self, request):
        e = self.envelope
        with e.gate.single_dispatch():
            e.claim(request)
            started, stage, status = time.monotonic(), 'provider_request', None
            try:
                response = self.delegate.handle_request(request)
                status, stage = response.status_code, 'response_body'
                try:
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE:
                            raise TrialBlocked('response_too_large')
                    stage = 'response_validation'
                    usage = e.validate(response, bytes(body))
                finally:
                    response.close()
                result = httpx.Response(response.status_code, headers={k: v for k, v in response.headers.items()
                    if k.lower() not in ('content-encoding', 'content-length', 'transfer-encoding')}, content=bytes(body), request=request)
                e.gate.finish(e.operation, e.kind, True, response.status_code, usage=usage)
                return result
            except BaseException as error:
                e.gate.abort(e.operation, e.kind)
                _dispatch_failure(e.kind, stage, error, status, started)
                raise TrialBlocked('dispatch_failed_no_retry') from None

    def close(self):
        self.delegate.close()


class AsyncTrialTransport(httpx.AsyncBaseTransport):
    def __init__(self, envelope, delegate=None):
        self.envelope = envelope
        self.delegate = delegate or httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request):
        e = self.envelope
        with e.gate.single_dispatch():
            e.claim(request)
            try:
                response = await self.delegate.handle_async_request(request)
                try:
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE:
                            raise TrialBlocked('response_too_large')
                    usage = e.validate(response, bytes(body))
                finally:
                    await response.aclose()
                result = httpx.Response(response.status_code, headers={k: v for k, v in response.headers.items()
                    if k.lower() not in ('content-encoding', 'content-length', 'transfer-encoding')}, content=bytes(body), request=request)
                e.gate.finish(e.operation, e.kind, True, response.status_code, usage=usage)
                return result
            except BaseException:
                e.gate.abort(e.operation, e.kind)
                raise TrialBlocked('dispatch_failed_no_retry') from None

    async def aclose(self):
        await self.delegate.aclose()
