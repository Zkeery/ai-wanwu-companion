"""Free Flash integration: model selection, WAV integrity, durable round ownership."""
import hashlib
from io import BytesIO
import json
import struct
from uuid import uuid4
import wave

import httpx
import pytest
from sqlalchemy import select, update

from app.core.database import engine
from app.living.rules import LivingError
from app.services import cloud_speech as cloud, qwen_tts_candidate as tts
from app.services.voice import VoiceService
from tests.auth_helpers import TEST_USER_ID
from tests.test_voice import voice, wav  # noqa: F401
from tests.test_voice_sessions import authorize


def source_wav(*, stream=False, rate=24000):
    b = BytesIO()
    with wave.open(b, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b'\0\0' * rate)
    data = bytearray(b.getvalue())
    if stream:
        struct.pack_into('<I', data, 4, 2147483583)
        struct.pack_into('<I', data, 40, 2147483547)
    return bytes(data)


def test_explicit_flash_omits_instructions_and_keeps_legacy_default():
    assert tts.MODEL == 'qwen3-tts-instruct-flash-2026-01-26'
    legacy = tts.synthesis_input('你好。', 'Cherry')
    flash = tts.synthesis_input('你好。', 'Cherry', model=tts.FLASH_MODEL)
    assert 'instructions' in legacy
    assert flash == {'text': '你好。', 'voice': 'Cherry', 'language_type': 'Chinese'}
    assert tts.request_characters('你好。', 'Cherry', model=tts.FLASH_MODEL) == 5
    assert tts.request_characters('你好。', 'Cherry') > 5


@pytest.mark.parametrize('model', ['unknown', '', 'qwen3-tts-flash-2025-11-27', None, []])
def test_unknown_model_cannot_dispatch(model):
    calls = []
    with httpx.Client(transport=httpx.MockTransport(lambda r: calls.append(r))) as client:
        with pytest.raises(tts.CandidateError):
            tts.synthesize_text('offline-key', '你好。', 'Cherry', client=client, model=model)
    assert calls == []


def test_flash_normalizes_only_length_fields_with_unchanged_pcm():
    raw = source_wav(stream=True)
    normalized = tts.normalize_downloaded_wav(raw, model=tts.FLASH_MODEL, content_length=str(len(raw)))
    assert normalized == source_wav()
    assert normalized[44:] == raw[44:]
    with pytest.raises(tts.CandidateError):
        tts.normalize_downloaded_wav(raw, content_length=str(len(raw)))


@pytest.mark.parametrize('length,encoding', [(None, None), ('-1', None), ('1', None), ('12x', None), ('48044', 'gzip')])
def test_streaming_header_requires_full_known_uncompressed_body(length, encoding):
    raw = source_wav(stream=True)
    with pytest.raises(tts.CandidateError):
        tts.normalize_downloaded_wav(raw, model=tts.FLASH_MODEL, content_length=length, content_encoding=encoding)


@pytest.mark.parametrize('kind', ['rate', 'fmt', 'sentinel', 'odd', 'too_long'])
def test_streaming_header_does_not_repair_other_corruption(kind):
    raw = bytearray(source_wav(stream=True, rate=16000 if kind == 'rate' else 24000))
    if kind == 'fmt':
        struct.pack_into('<H', raw, 20, 3)
    elif kind == 'sentinel':
        struct.pack_into('<I', raw, 40, 2147483546)
    elif kind == 'odd':
        raw.append(0)
    elif kind == 'too_long':
        raw.extend(b'\0\0' * 24000 * 60)
    with pytest.raises(tts.CandidateError):
        tts.normalize_downloaded_wav(bytes(raw), model=tts.FLASH_MODEL, content_length=str(len(raw)))


def test_normal_wav_truncated_body_is_rejected_for_both_profiles():
    raw = source_wav()[:-2]
    for model in (tts.MODEL, tts.FLASH_MODEL):
        with pytest.raises(tts.CandidateError):
            tts.normalize_downloaded_wav(raw, model=model)


def test_transport_flash_persists_response_then_downloads_one_asset():
    calls, saved = [], []
    raw = source_wav(stream=True)
    def handler(req):
        calls.append(req.method)
        if req.method == 'POST':
            value = json.loads(req.content)
            assert value['model'] == tts.FLASH_MODEL
            assert set(value['input']) == {'text', 'voice', 'language_type'}
            return httpx.Response(200, json={'request_id': 'offline', 'output': {'audio': {
                'url': 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=fixture'}},
                'usage': {'characters': 29}})
        assert 'authorization' not in req.headers
        return httpx.Response(200, content=raw)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = tts.synthesize_text('offline-key', '你好。', 'Cherry', client=client,
            model=tts.FLASH_MODEL, on_response=saved.append)
    assert calls == ['POST', 'GET']
    assert saved[0]['request_id'] == 'offline'
    assert result.wav == source_wav()


def flash_service(service, cid, *, fail_download=False, model=None):
    calls = []
    selected = [model or tts.FLASH_MODEL]
    fails = [fail_download]
    reply = '好呢，先歇一会儿。'
    def handler(req):
        calls.append(req.method)
        if req.method == 'POST':
            payload = json.loads(req.content)
            assert payload['model'] == tts.FLASH_MODEL
            assert payload['input'] == {'text': reply, 'voice': 'Cherry', 'language_type': 'Chinese'}
            return httpx.Response(200, json={'request_id': 'offline-flash', 'output': {'finish_reason': 'stop',
                'audio': {'url': 'http://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?sig=fixture'}},
                'usage': {'characters': 29}})
        if fails[0]:
            fails[0] = False
            raise httpx.ReadTimeout('offline fixture')
        return httpx.Response(200, content=source_wav(stream=True))
    adapter = cloud.QwenSpeech(engine, service.clock,
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
        key_loader=lambda: 'offline-key', model_loader=lambda: selected[0])
    service.live_speech = adapter
    service.live_reply = lambda _: reply
    service.save_settings(TEST_USER_ID, cid, 'qwen:Cherry', None, True)
    return calls, adapter, selected, reply


def test_flash_round_persists_model_and_is_idempotent_across_restart(voice, ready_character_id):
    service, _ = voice
    cid, rid = ready_character_id, str(uuid4())
    calls, adapter, selected, reply = flash_service(service, cid)
    authorize(service, cid, count=1)
    result = service.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    assert result['error'] is None
    assert calls == ['POST', 'GET']
    restored = VoiceService(engine, service.clock, service.speech, live_reply=service.live_reply, live_speech=adapter)
    assert restored.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True) == result
    assert calls == ['POST', 'GET']
    with engine.connect() as conn:
        row = conn.execute(select(cloud.requests)).mappings().one()
        assert json.loads(row['response_json'])['_wanwu_tts_model'] == tts.FLASH_MODEL
        assert row['reserve_micro'] == cloud.SPEECH_RESERVE_MICRO
    selected[0] = tts.MODEL
    assert adapter.synthesize(reply, 'qwen:Cherry', uid=TEST_USER_ID, cid=cid, rid=rid) == source_wav()
    assert calls == ['POST', 'GET', 'GET']


def test_flash_download_recovery_uses_saved_profile_after_config_changes(voice, ready_character_id):
    service, _ = voice
    cid = ready_character_id
    calls, adapter, selected, _ = flash_service(service, cid, fail_download=True)
    authorize(service, cid, count=1)
    result = service.send(TEST_USER_ID, cid, str(uuid4()), '你好', wav(), offline=True)
    assert result['error'] == 'audio_unavailable'
    selected[0] = tts.MODEL
    entry = next(x for x in service.history(TEST_USER_ID, cid) if x['role'] == 'assistant')
    assert service.retry_audio(TEST_USER_ID, cid, entry['id'])['state'] == 'ready'
    assert calls == ['POST', 'GET', 'GET']


def test_flash_recovery_still_rejects_other_owner(voice, ready_character_id):
    service, _ = voice
    calls, adapter, _, _ = flash_service(service, ready_character_id, fail_download=True)
    authorize(service, ready_character_id)
    rid = str(uuid4())
    service.send(TEST_USER_ID, ready_character_id, rid, '你好', wav(), offline=True)
    previous = list(calls)
    with pytest.raises(LivingError):
        adapter.recover('other-owner', ready_character_id, rid)
    assert calls == previous


def test_unknown_profile_keeps_text_without_dispatch(voice, ready_character_id):
    service, _ = voice
    calls, _, _, _ = flash_service(service, ready_character_id, model='unapproved-model')
    authorize(service, ready_character_id)
    result = service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert result['error'] == 'audio_unavailable' and calls == []
    with engine.connect() as conn:
        assert conn.execute(select(cloud.requests)).first() is None


def test_historical_response_without_profile_keeps_legacy_recovery(voice, ready_character_id, monkeypatch):
    from tests.test_cloud_speech import configure
    service, _ = voice
    calls, adapter = configure(service, ready_character_id)
    authorize(service, ready_character_id)
    rid = str(uuid4())
    service.send(TEST_USER_ID, ready_character_id, rid, '你好', wav(), offline=True)
    with engine.begin() as conn:
        row = conn.execute(select(cloud.requests)).mappings().one()
        body = json.loads(row['response_json'])
        body.pop('_wanwu_tts_model')
        conn.execute(update(cloud.requests).values(response_json=json.dumps(body)))
    selected = []
    original = cloud.download_candidate
    def observe(body, **kwargs):
        selected.append(kwargs['model'])
        return original(body, **kwargs)
    monkeypatch.setattr(cloud, 'download_candidate', observe)
    assert adapter.recover(TEST_USER_ID, ready_character_id, rid) == wav()
    assert selected == [tts.MODEL]
    assert calls == [('POST', 'dashscope.aliyuncs.com'), ('GET', 'dashscope-a717.oss-cn-beijing.aliyuncs.com'),
        ('GET', 'dashscope-a717.oss-cn-beijing.aliyuncs.com')]


def test_explicit_environment_model_does_not_fall_back_when_empty(monkeypatch):
    monkeypatch.setenv('QWEN_TTS_MODEL', tts.FLASH_MODEL)
    assert cloud.project_tts_model() == tts.FLASH_MODEL
    monkeypatch.setenv('QWEN_TTS_MODEL', '')
    assert cloud.project_tts_model() == ''
