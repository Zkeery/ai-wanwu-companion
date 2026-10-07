from uuid import uuid4

import pytest
from sqlalchemy import select, update

from app.core.database import engine, SessionLocal
from app.living.rules import LivingError
from app.models.models import Message
from app.services import voice_sessions as grants
from app.services.voice import VoiceService
from tests.auth_helpers import TEST_USER_ID
from tests.test_voice import voice, wav  # noqa: F401


def authorize(service, cid, count=2, ref='explicit-test-authorization'):
    with service.storage.transaction() as conn:
        return grants.authorize(conn, TEST_USER_ID, cid, ref, count, service.clock())


def test_two_real_scoped_rounds_keep_context_and_stop_without_falling_back(voice, ready_character_id):
    service, _ = voice
    calls = []
    def reply(messages):
        calls.append(messages)
        return f'这是第{len(calls)}次回复'
    service.live_reply = reply
    authorize(service, ready_character_id)
    first = str(uuid4())
    result = service.send(TEST_USER_ID, ready_character_id, first, '第一句话', wav(), offline=True)
    assert result['origin'] == 'configured_model' and result['state'] == 'completed'
    assert service.send(TEST_USER_ID, ready_character_id, first, '第一句话', wav(), offline=True) == result
    service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '接着刚才说', wav(), offline=True)
    assert len(calls) == 2
    assert any(m['role'] == 'assistant' and m['content'] == '这是第1次回复' for m in calls[1])
    settings = service.read_settings(TEST_USER_ID, ready_character_id)
    assert settings['reply_origin'] == 'disabled'
    assert settings['live_session']['state'] == 'exhausted'
    assert settings['live_session']['reserved_micro'] == 2 * grants.RESERVE_MICRO
    with pytest.raises(LivingError, match='额度已用完'):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '第三轮不能发', wav(), offline=True)
    with SessionLocal() as db:
        assert db.query(Message).count() == 4
    assert len(calls) == 2


@pytest.mark.parametrize('failure', ['provider', 'audio'])
def test_failure_stops_remaining_allowance_without_retry_or_refund(voice, ready_character_id, failure):
    service, _ = voice
    calls = []
    def reply(messages):
        calls.append(True)
        if failure == 'provider':
            raise TimeoutError()
        return '文字成功'
    class FailedSpeech:
        def synthesize(self, *_):
            raise RuntimeError()
    service.live_reply = reply
    if failure == 'audio':
        service.speech = FailedSpeech()
    authorize(service, ready_character_id)
    service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    restored = VoiceService(engine, service.clock, service.speech, live_reply=reply)
    settings = restored.read_settings(TEST_USER_ID, ready_character_id)
    assert settings['live_session']['state'] == 'failed'
    assert settings['live_session']['used_rounds'] == 1
    with pytest.raises(LivingError):
        restored.send(TEST_USER_ID, ready_character_id, str(uuid4()), '不能自动再试', wav(), offline=True)
    assert len(calls) == 1


def test_pending_round_blocks_concurrent_charge_and_recovery_stops_session(voice, ready_character_id):
    service, _ = voice
    service.live_reply = lambda _: '不能调用'
    authorize(service, ready_character_id)
    with service.storage.transaction() as conn:
        row = grants.latest(conn, TEST_USER_ID, ready_character_id)
        grants.reserve(conn, row, str(uuid4()), service.clock())
    with pytest.raises(LivingError, match='上一轮'):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    service.recover()
    settings = service.read_settings(TEST_USER_ID, ready_character_id)
    assert settings['live_session']['used_rounds'] == 1
    assert settings['live_session']['state'] == 'failed'
    assert settings['reply_origin'] == 'disabled'


def test_expiration_revocation_and_missing_adapter_never_spend(voice, ready_character_id):
    service, clock = voice
    authorize(service, ready_character_id)
    with pytest.raises(LivingError):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    service.live_reply = lambda _: pytest.fail('must not call')
    clock[0] += 86400
    assert service.read_settings(TEST_USER_ID, ready_character_id)['live_session']['state'] == 'expired'
    with pytest.raises(LivingError):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    authorize(service, ready_character_id, ref='another-explicit-authorization')
    service.end_live_session(TEST_USER_ID, ready_character_id)
    assert service.read_settings(TEST_USER_ID, ready_character_id)['live_session']['state'] == 'revoked'
    with pytest.raises(LivingError):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert service.read_settings(TEST_USER_ID, ready_character_id)['live_session']['used_rounds'] == 0


def test_no_regrant_on_same_reference_and_invalid_input_does_not_spend(voice, ready_character_id):
    service, _ = voice
    service.live_reply = lambda _: pytest.fail('must not call')
    authorize(service, ready_character_id)
    with pytest.raises(LivingError):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(silent=True), offline=True)
    service.end_live_session(TEST_USER_ID, ready_character_id)
    with pytest.raises(LivingError, match='不能再次'):
        authorize(service, ready_character_id)
    assert service.read_settings(TEST_USER_ID, ready_character_id)['live_session']['used_rounds'] == 0


def test_api_end_is_owned_and_idempotent(voice, ready_character_id, client, anon):
    service, _ = voice
    authorize(service, ready_character_id)
    url = f'/api/v1/characters/{ready_character_id}/voice/session/end'
    assert anon.post(url).status_code == 401
    assert client.post('/api/v1/characters/999999/voice/session/end').status_code == 404
    assert client.post(url).json()['live_session']['state'] == 'revoked'
    assert client.post(url).json()['live_session']['state'] == 'revoked'
    with pytest.raises(LivingError):
        service.read_settings('another-owner', ready_character_id)
    with engine.connect() as conn:
        assert conn.execute(select(grants.sessions.c.used_rounds)).scalar_one() == 0


def test_reservation_rollback_and_revocation_before_dispatch(voice, ready_character_id, monkeypatch):
    service, _ = voice
    service.live_reply = lambda _: pytest.fail('must not call')
    authorize(service, ready_character_id)
    from app.services import voice as module
    original = module.append_life_context
    def revoke(db, uid, cid, messages):
        original(db, uid, cid, messages)
        db.execute(update(grants.sessions).values(state='revoked'))
    monkeypatch.setattr(module, 'append_life_context', revoke)
    result = service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)
    assert result['state'] == 'failed'
    assert service.read_settings(TEST_USER_ID, ready_character_id)['live_session']['used_rounds'] == 1


def test_project_adapter_checks_price_and_bounds_only_its_own_settings(monkeypatch):
    from app.core.config import get_settings
    from app.living.life_provider import BASE_URL, MODEL
    from app.services.model_client import ModelClient, ModelError
    checks, calls = [], []
    async def catalog():
        checks.append(True)
        return {'reserve_micro': grants.RESERVE_MICRO}
    monkeypatch.setattr('dotenv.dotenv_values', lambda _: {'MODEL_BASE_URL': BASE_URL, 'MODEL_API_KEY': 'fixture-only'})
    monkeypatch.setattr('app.living.life_live_planner.check_current_catalog', catalog)
    def post(self, payload, settings):
        calls.append(True)
        assert payload['model'] == MODEL and payload['max_tokens'] == 1024
        assert settings.model_max_retries == 0 and settings.model_timeout_seconds == 30
        assert settings.model_base_url == BASE_URL and settings.model_api_key == 'fixture-only'
        return '嗯，接着聊吧。'
    monkeypatch.setattr(ModelClient, '_post_chat_completions', post)
    original = get_settings().model_api_key
    messages = [{'role': 'system', 'content': '本伙伴'}, {'role': 'user', 'content': '你好'}]
    assert grants.project_reply(messages) == '嗯嗯，接着聊吧。'
    assert len(checks) == len(calls) == 1 and get_settings().model_api_key == original
    with pytest.raises(ModelError):
        grants.project_reply([{'role': 'system', 'content': '长' * 32768}, messages[1]])
    assert len(calls) == 1


def test_price_check_failure_never_reaches_the_provider(monkeypatch):
    from app.living.life_provider import BASE_URL
    async def catalog():
        raise RuntimeError('catalog unavailable')
    monkeypatch.setattr('dotenv.dotenv_values', lambda _: {'MODEL_BASE_URL': BASE_URL, 'MODEL_API_KEY': 'fixture-only'})
    monkeypatch.setattr('app.living.life_live_planner.check_current_catalog', catalog)
    monkeypatch.setattr('app.services.model_client.ModelClient._post_chat_completions', lambda *a: pytest.fail('must not call'))
    with pytest.raises(RuntimeError):
        grants.project_reply([{'role': 'system', 'content': '伙伴'}, {'role': 'user', 'content': '你好'}])
