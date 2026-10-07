import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select, update

from app.core.database import engine, SessionLocal
from app.living.rules import LivingError
from app.models.models import Message
from app.services import cloud_speech as cloud
from app.services.voice import VoiceService, clear_audio, rounds
from tests.auth_helpers import TEST_USER_ID
from tests.test_voice import voice, wav  # noqa: F401
from tests.test_voice_sessions import authorize


def configure(service, cid, *, failure=None, reply='好呢，先歇一会儿。'):
    calls = []
    fail_once = [failure]

    def handler(request):
        calls.append((request.method, request.url.host))
        if request.method == 'POST':
            body = json.loads(request.content)
            assert body['input']['text'] == reply
            assert body['input']['voice'] == 'Cherry'
            assert set(body['input']) == {'text', 'voice', 'language_type', 'instructions'}
            if fail_once[0] == 'provider':
                fail_once[0] = None
                raise httpx.ReadTimeout('fixture')
            return httpx.Response(200, json={'output': {'finish_reason': 'stop', 'audio': {
                'url': 'http://dashscope-a717.oss-cn-beijing.aliyuncs.com/reply.wav?sig=private-fixture'}},
                'usage': {'characters': 29}})
        assert 'authorization' not in request.headers
        if fail_once[0] == 'download':
            fail_once[0] = None
            raise httpx.ReadTimeout('fixture')
        return httpx.Response(200, content=wav())

    adapter = cloud.QwenSpeech(engine, service.clock,
        client_factory=lambda: httpx.Client(transport=httpx.MockTransport(handler)),
        key_loader=lambda: 'offline-test-key')
    service.live_speech = adapter
    service.live_reply = lambda _: reply
    service.save_settings(TEST_USER_ID, cid, 'qwen:Cherry', None, True)
    return calls, adapter


def test_cherry_reply_is_persistent_idempotent_and_within_combined_budget(voice, ready_character_id):
    service, _ = voice
    cid, rid = ready_character_id, str(uuid4())
    calls, adapter = configure(service, cid)
    authorize(service, cid, count=1)
    result = service.send(TEST_USER_ID, cid, rid, '今天有点累', wav(), offline=True)
    assert result['state'] == 'completed' and result['error'] is None
    assert service.send(TEST_USER_ID, cid, rid, '今天有点累', wav(), offline=True) == result
    assert [method for method, _ in calls] == ['POST', 'GET']
    restored = VoiceService(engine, service.clock, service.speech,
        live_reply=service.live_reply, live_speech=adapter)
    settings = restored.read_settings(TEST_USER_ID, cid)
    assert settings['voice'] == 'qwen:Cherry'
    assert settings['live_session']['state'] == 'exhausted'
    assert settings['live_session']['reserved_micro'] == settings['live_session']['budget_micro'] == 1_200_000
    entry = next(item for item in restored.history(TEST_USER_ID, cid) if item['role'] == 'assistant')
    assert entry['voice'] == 'qwen:Cherry'
    assert restored.read_audio(TEST_USER_ID, cid, entry['id'])[0] == wav()
    assert 'private-fixture' not in json.dumps(restored.receipts(TEST_USER_ID, cid))
    with engine.connect() as conn:
        saved = conn.execute(select(cloud.requests)).mappings().one()
        assert saved['state'] == 'ready' and saved['billed_characters'] == 29
        assert saved['reserve_micro'] == cloud.SPEECH_RESERVE_MICRO


def test_natural_preview_is_free_owned_and_does_not_change_choice(voice, ready_character_id, client, anon, monkeypatch):
    service, _ = voice
    calls, _ = configure(service, ready_character_id)
    monkeypatch.setattr('app.api.voice.service', service)
    url = f'/api/v1/characters/{ready_character_id}/voice/preview'
    assert anon.post(url, json={'voice': 'qwen:Cherry'}).status_code == 401
    assert client.post('/api/v1/characters/999999/voice/preview', json={'voice': 'qwen:Cherry'}).status_code == 404
    response = client.post(url, json={'voice': 'qwen:Serena'})
    assert response.status_code == 200 and response.content == cloud.preview_audio('qwen:Serena')
    assert response.headers['cache-control'] == 'private, no-store'
    assert service.read_settings(TEST_USER_ID, ready_character_id)['voice'] == 'qwen:Cherry'
    assert not calls
    with engine.connect() as conn:
        assert not conn.execute(select(cloud.requests)).first()


def test_cloud_voice_without_scoped_allowance_never_calls_either_model(voice, ready_character_id):
    service, _ = voice
    calls, _ = configure(service, ready_character_id)
    service.live_reply = lambda _: pytest.fail('unapproved model call')
    assert service.read_settings(TEST_USER_ID, ready_character_id)['reply_origin'] == 'disabled'
    with pytest.raises(LivingError, match='真实聊天额度'):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert not calls
    with SessionLocal() as db:
        assert db.query(Message).count() == 0


@pytest.mark.parametrize('failure', ['provider', 'download'])
def test_failure_keeps_text_and_retry_only_downloads_saved_response(voice, ready_character_id, failure):
    service, _ = voice
    cid = ready_character_id
    calls, adapter = configure(service, cid, failure=failure)
    authorize(service, cid)
    result = service.send(TEST_USER_ID, cid, str(uuid4()), '你好', wav(), offline=True)
    assert result['state'] == 'completed' and result['error'] == 'audio_unavailable'
    assert service.read_settings(TEST_USER_ID, cid)['live_session']['state'] == 'failed'
    with SessionLocal() as db:
        assert db.query(Message).filter_by(role='assistant').one().content == '好呢，先歇一会儿。'
    entry = next(item for item in service.history(TEST_USER_ID, cid) if item['role'] == 'assistant')
    restored = VoiceService(engine, service.clock, service.speech,
        live_reply=service.live_reply, live_speech=adapter)
    if failure == 'download':
        assert restored.retry_audio(TEST_USER_ID, cid, entry['id'])['state'] == 'ready'
        assert [method for method, _ in calls] == ['POST', 'GET', 'GET']
    else:
        with pytest.raises(LivingError, match='文字仍可阅读'):
            restored.retry_audio(TEST_USER_ID, cid, entry['id'])
        assert [method for method, _ in calls] == ['POST']


@pytest.mark.parametrize('operation', ['delete_audio', 'clear_chat', 'expire'])
def test_private_provider_response_is_removed_with_audio_or_chat(voice, ready_character_id, operation):
    service, clock = voice
    cid, rid = ready_character_id, str(uuid4())
    _, adapter = configure(service, cid)
    authorize(service, cid)
    service.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    if operation == 'delete_audio':
        entry = next(item for item in service.history(TEST_USER_ID, cid) if item['role'] == 'assistant')
        service.delete_audio(TEST_USER_ID, cid, entry['id'])
    elif operation == 'clear_chat':
        with SessionLocal() as db:
            clear_audio(db, cid)
            db.commit()
    else:
        clock[0] += cloud.RETENTION
        # Turning the provider off must not disable the retention cleanup.
        VoiceService(engine, service.clock, service.speech).cleanup()
    with engine.connect() as conn:
        assert conn.execute(select(cloud.requests.c.response_json)).scalar_one() is None
    with pytest.raises(LivingError):
        adapter.recover(TEST_USER_ID, cid, rid)


def test_revoke_after_text_generation_prevents_speech_dispatch(voice, ready_character_id):
    service, _ = voice
    calls, _ = configure(service, ready_character_id)
    authorize(service, ready_character_id)
    def reply(_):
        service.end_live_session(TEST_USER_ID, ready_character_id)
        return '好呢，先歇一会儿。'
    service.live_reply = reply
    result = service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert result['state'] == 'completed' and result['error'] == 'audio_unavailable'
    assert not calls


def test_long_reply_is_preserved_without_a_partial_or_unbudgeted_synthesis(voice, ready_character_id):
    service, _ = voice
    calls, _ = configure(service, ready_character_id, reply='好' * 301)
    authorize(service, ready_character_id)
    result = service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert result['error'] == 'audio_unavailable' and not calls
    with SessionLocal() as db:
        assert db.query(Message).filter_by(role='assistant').one().content == '好' * 301


def test_restart_never_resubmits_and_other_owner_cannot_recover(voice, ready_character_id):
    service, _ = voice
    cid, rid = ready_character_id, str(uuid4())
    calls, adapter = configure(service, cid, failure='provider')
    authorize(service, cid)
    service.send(TEST_USER_ID, cid, rid, '你好', wav(), offline=True)
    with engine.begin() as conn:
        conn.execute(update(cloud.requests).values(state='started'))
        conn.execute(update(rounds).where(rounds.c.id == rid).values(state='text_ready'))
    service.recover()
    assert [method for method, _ in calls] == ['POST']
    with engine.connect() as conn:
        assert conn.execute(select(cloud.requests.c.state)).scalar_one() == 'interrupted'
    with pytest.raises(LivingError):
        adapter.recover('another-owner', cid, rid)
    assert len(calls) == 1
