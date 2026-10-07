from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from app.core.config import Settings
from app.core.database import SessionLocal
from app.core.voice_schema import ensure_voice_columns
from app.living.rules import LivingError
from app.models.models import Message
from app.services.model_client import ModelError
from app.services import voice_reply
from tests.auth_helpers import TEST_USER_ID
from tests.test_voice import voice, wav  # noqa: F401


@pytest.fixture
def configured(monkeypatch):
    settings = Settings(_env_file=None, app_env='development', model_api_key='fixture-only',
        model_base_url='https://invalid.example', voice_live_reply_enabled=True)
    monkeypatch.setattr(voice_reply, 'get_settings', lambda: settings)
    return settings


def test_disabled_cannot_write_messages(voice, ready_character_id, configured):
    configured.voice_live_reply_enabled = False
    service, _ = voice
    with pytest.raises(LivingError):
        service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=False)
    assert not service.history(TEST_USER_ID, ready_character_id)
    with SessionLocal() as db:
        assert db.query(Message).count() == 0


def test_live_round_bounded_once_and_saved_origin(voice, ready_character_id, configured, monkeypatch):
    calls = []
    def complete(self, payload, settings):
        assert settings.model_max_retries == 0 and settings.model_timeout_seconds <= 30
        assert payload['max_tokens'] == 1024 and payload['stream'] is False
        assert payload['messages'][-1]['content'] == '今天很开心'
        assert '先顺着用户眼前这句话回应' in payload['messages'][0]['content']
        assert '未由用户确认的场景动作不能说已经完成' in payload['messages'][0]['content']
        calls.append(True)
        return '听到你开心，我也想和你一起看看小树。'
    monkeypatch.setattr('app.services.model_client.ModelClient._post_chat_completions', complete)
    service, _ = voice
    rid = str(uuid4())
    result = service.send(TEST_USER_ID, ready_character_id, rid, '今天很开心', wav(), offline=False)
    assert result['state'] == 'completed' and result['origin'] == 'configured_model'
    # Switching to offline/disabled later must not relabel or re-run old rounds.
    configured.voice_live_reply_enabled = False
    assert service.send(TEST_USER_ID, ready_character_id, rid, '今天很开心', wav(), offline=True) == result
    assert len(calls) == 1
    assert {a['origin'] for a in service.history(TEST_USER_ID, ready_character_id)} == {'configured_model'}


def test_voice_dialogue_style_keeps_existing_context_and_does_not_mutate_it():
    original = [{'role': 'system', 'content': '角色和心情已确认'},
                {'role': 'assistant', 'content': '上一轮'}, {'role': 'user', 'content': '我今天有点累'}]
    prepared = voice_reply.voice_dialogue_messages(original)
    assert original[0]['content'] == '角色和心情已确认'
    assert prepared is not original and prepared[0] is not original[0]
    assert prepared[0]['content'].startswith(original[0]['content'])
    assert '简单、暖一点的口语' in prepared[0]['content']
    assert prepared[1:] == original[1:]
    archived = voice_reply.voice_dialogue_messages(original, style_version='v2')
    assert '少用“我在呢”' in archived[0]['content']
    assert '简单、暖一点的口语' not in archived[0]['content']
    assert archived[1:] == original[1:]


def test_new_voice_opening_keeps_archived_style_unchanged(configured, monkeypatch):
    payloads = []

    def complete(_client, payload, _settings):
        payloads.append(payload)
        return '嗯，今天先聊聊吧。'

    monkeypatch.setattr('app.services.model_client.ModelClient._post_chat_completions', complete)
    messages = [{'role': 'system', 'content': '角色和心情已确认'},
                {'role': 'user', 'content': '今天有点累'}]
    assert voice_reply.configured_reply(messages) == '嗯嗯，今天先聊聊吧。'
    assert voice_reply.configured_reply(messages, style_version='v3') == '嗯，今天先聊聊吧。'
    assert '好呢' in payloads[0]['messages'][0]['content']
    assert '好呢' not in payloads[1]['messages'][0]['content']
    assert messages[0]['content'] == '角色和心情已确认'


@pytest.mark.parametrize('messages', [[], 'not-messages', [None], [{'role': 'user', 'content': '你好'}],
    [{'role': 'system', 'content': 123}, {'role': 'user', 'content': '你好'}],
    [{'role': 'system', 'content': '角色'}, {'role': 'user', 'content': None}],
    [{'role': 'system', 'content': '角色'}, {'role': 'assistant', 'content': '旧话'}]])
def test_voice_dialogue_style_rejects_invalid_messages(messages):
    with pytest.raises(ModelError, match='语音回复上下文格式无效'):
        voice_reply.voice_dialogue_messages(messages)


def test_voice_dialogue_style_rejects_unknown_version():
    with pytest.raises(ModelError, match='语音回复上下文格式无效'):
        voice_reply.voice_dialogue_messages(
            [{'role': 'system', 'content': '角色'}, {'role': 'user', 'content': '你好'}],
            style_version='unknown')


@pytest.mark.parametrize('result', ['', 'x' * 4001, {}, TimeoutError('private-provider-info')])
def test_provider_failure_keeps_original_and_never_retries(voice, ready_character_id, configured, monkeypatch, result):
    calls = []
    def complete(*args):
        calls.append(True)
        if isinstance(result, Exception):
            raise result
        return result
    monkeypatch.setattr('app.services.model_client.ModelClient._post_chat_completions', complete)
    service, _ = voice
    rid = str(uuid4())
    response = service.send(TEST_USER_ID, ready_character_id, rid, '你好', wav(), offline=False)
    assert response['state'] == 'failed' and response['error'] == 'reply_unavailable'
    assert service.send(TEST_USER_ID, ready_character_id, rid, '你好', wav(), offline=False) == response
    assert len(calls) == 1
    assert [a['role'] for a in service.history(TEST_USER_ID, ready_character_id)] == ['user']


def test_preview_never_uses_live_adapter(voice, ready_character_id, configured, monkeypatch):
    configured.app_env = 'test'
    assert voice_reply.reply_mode() == 'offline_fixture'
    monkeypatch.setattr('app.services.model_client.ModelClient._post_chat_completions',
        lambda *args: pytest.fail('real-capable entry point'))
    with pytest.raises(ModelError):
        voice_reply.configured_reply([])
    service, _ = voice
    assert service.send(TEST_USER_ID, ready_character_id, str(uuid4()), '你好', wav(), offline=True)['origin'] == 'offline_fixture'


def test_missing_key_never_calls_provider(configured, monkeypatch):
    configured.model_api_key = ''
    monkeypatch.setattr('app.services.model_client.ModelClient._post_chat_completions',
        lambda *args: pytest.fail('provider called'))
    with pytest.raises(ModelError):
        voice_reply.configured_reply([])


def test_additive_migration_preserves_legacy_payload(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'legacy.db'))
    with engine.begin() as conn:
        conn.execute(text('CREATE TABLE companion_voice_rounds (id TEXT PRIMARY KEY, state TEXT, payload BLOB)'))
        conn.execute(text("INSERT INTO companion_voice_rounds VALUES ('saved', 'completed', :data)"), {'data': b'original-audio'})
    ensure_voice_columns(engine)
    ensure_voice_columns(engine)
    with engine.connect() as conn:
        row = conn.execute(text('SELECT * FROM companion_voice_rounds')).mappings().one()
        assert dict(row) == dict(id='saved', state='completed', payload=b'original-audio', origin='offline_fixture')
    engine.dispose()
