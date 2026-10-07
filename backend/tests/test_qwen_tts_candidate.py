"""Candidate transport must bound paid calls, downloads and restarts."""

from io import BytesIO
import json
import wave

import httpx
import pytest

from app.services import qwen_tts_candidate as tts
from scripts import preview_qwen_tts as preview


def wav_sample():
    stream = BytesIO()
    with wave.open(stream, 'wb') as writer:
        writer.setnchannels(1)
        writer.setsampwidth(2)
        writer.setframerate(16000)
        writer.writeframes(b'\0\0' * 16000)
    return stream.getvalue()


@pytest.mark.parametrize('envelope', ['dashscope', 'maas'])
def test_candidate_uses_fixed_model_and_downloads_only_verified_wav(envelope):
    calls = []
    audio = wav_sample()

    def handler(request):
        calls.append((request.method, request.url.host))
        if request.method == 'POST':
            body = json.loads(request.content)
            assert request.headers['Authorization'] == 'Bearer offline-test-key'
            assert body['model'] == tts.MODEL
            assert body['input']['voice'] == 'Serena'
            assert body['input']['text'] == tts.SAMPLE_TEXT
            body = {'output': {'finish_reason': 'stop' if envelope == 'dashscope' else None,
                'audio': {'url': 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=test'}},
                'usage': {'characters': 33}}
            body.update({'status_code': 200} if envelope == 'dashscope' else {'success': True})
            return httpx.Response(200, json=body)
        assert request.url.scheme == 'https'
        return httpx.Response(200, content=audio)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = tts.synthesize_candidate('offline-test-key', 'Serena', client=client)
    assert result.wav == audio and result.billed_characters == 33
    assert calls == [('POST', 'dashscope.aliyuncs.com'),
        ('GET', 'dashscope-result-bj.oss-cn-beijing.aliyuncs.com')]


@pytest.mark.parametrize('url', [
    'https://evil.example/a.wav?sig=abc',
    'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.example/a.wav?sig=abc',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:444/a.wav?sig=abc',
    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav',
])
def test_candidate_rejects_unexpected_download_without_get(url):
    calls = []

    def handler(request):
        calls.append(request.method)
        return httpx.Response(200, json={'status_code': 200, 'output': {'finish_reason': 'stop',
            'audio': {'url': url}}, 'usage': {'characters': 33}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(tts.CandidateError):
            tts.synthesize_candidate('offline-test-key', 'Serena', client=client)
    assert calls == ['POST']


def test_candidate_rejects_invalid_audio_and_does_not_retry_provider():
    calls = []

    def handler(request):
        calls.append(request.method)
        if request.method == 'POST':
            return httpx.Response(200, json={'status_code': 200, 'output': {'finish_reason': 'stop',
                'audio': {'url': 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=test'}},
                'usage': {'characters': 33}})
        return httpx.Response(200, content=b'not a wav')

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(tts.CandidateError) as error:
            tts.synthesize_candidate('offline-test-key', 'Serena', client=client)
    assert calls == ['POST', 'GET']
    assert error.value.stage == 'audio_validation'


def test_candidate_records_safe_http_stage_without_provider_body():
    def handler(request):
        return httpx.Response(403, json={'message': 'private-provider-detail'})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(tts.CandidateError) as error:
            tts.synthesize_candidate('offline-test-key', 'Serena', client=client)
    assert error.value.stage == 'provider_request'
    assert error.value.http_status == 403
    assert 'private-provider-detail' not in str(error.value)


def test_candidate_rejects_explicit_provider_failure_without_download():
    calls = []

    def handler(request):
        calls.append(request.method)
        return httpx.Response(200, json={'success': False, 'output': {'finish_reason': 'error',
            'audio': {'url': 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=test'}},
            'usage': {'characters': 33}})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(tts.CandidateError) as error:
            tts.synthesize_candidate('offline-test-key', 'Serena', client=client)
    assert error.value.stage == 'provider_response'
    assert calls == ['POST']


def test_batch_receipt_blocks_duplicate_and_stops_after_first_failure(tmp_path, monkeypatch):
    monkeypatch.setattr(preview, 'ROOT', tmp_path)
    attempted = []

    def fail_first(key, voice, *, client, on_response):
        attempted.append(voice)
        on_response({'request_id': 'offline-request', 'output': {'audio': {'url': 'private-signed-url'}}})
        raise tts.CandidateError('offline fixture', stage='audio_download', http_status=403)

    monkeypatch.setattr(preview, 'synthesize_candidate', fail_first)
    with pytest.raises(ValueError):
        preview.run_batch('test-batch-01', '')
    assert not (tmp_path / 'test-batch-01').exists()
    result = preview.run_batch('test-batch-01', 'offline-test-key')
    assert result['state'] == 'failed'
    assert attempted == ['Serena']
    call = json.loads((tmp_path / 'test-batch-01/receipt.json').read_text())['calls'][0]
    assert call['state'] == 'failed' and call['stage'] == 'audio_download' and call['http_status'] == 403
    response_path = tmp_path / 'test-batch-01/Serena.response.json'
    assert json.loads(response_path.read_text())['request_id'] == 'offline-request'
    assert response_path.stat().st_mode & 0o777 == 0o600
    assert 'private-signed-url' not in json.dumps(result)
    with pytest.raises(FileExistsError):
        preview.run_batch('test-batch-01', 'offline-test-key')
    assert attempted == ['Serena']


def test_validation_failure_preserves_response_without_another_synthesis():
    calls, saved = [], []
    body = {'request_id': 'offline-request', 'output': {'audio': {'url': 'unexpected'}},
        'usage': {'characters': 29}}

    def handler(request):
        calls.append(request.method)
        return httpx.Response(200, json=body)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(tts.CandidateError) as error:
            tts.synthesize_candidate('offline-test-key', 'Serena', client=client, on_response=saved.append)
    assert error.value.stage == 'audio_url'
    assert saved == [body]
    assert calls == ['POST']


def test_recover_observed_beijing_response_downloads_without_synthesis():
    calls = []
    audio = wav_sample()
    body = {'output': {'finish_reason': 'stop', 'audio': {
        'url': 'http://dashscope-a717.oss-cn-beijing.aliyuncs.com/a.wav?sig=test'}},
        'usage': {'characters': 29}}

    def handler(request):
        calls.append(request.method)
        assert request.url.scheme == 'https'
        assert request.url.host == 'dashscope-a717.oss-cn-beijing.aliyuncs.com'
        assert 'authorization' not in request.headers
        return httpx.Response(200, content=audio)

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = tts.download_candidate(body, client=client)
    assert calls == ['GET']
    assert result.wav == audio and result.billed_characters == 29
