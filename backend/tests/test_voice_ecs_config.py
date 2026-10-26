from types import SimpleNamespace
import pytest
from app.services import cloud_speech as speech
from app.services import voice_sessions
from app.living.rules import LivingError


def test_ecs_tts_environment_precedes_local_file(monkeypatch):
    monkeypatch.setenv('QWEN_TTS_API_KEY', 'fixture-ecs-only')
    monkeypatch.setattr(speech, 'dotenv_values', lambda *_: pytest.fail('must not read fallback'))
    assert speech.project_tts_key() == 'fixture-ecs-only'
    monkeypatch.setenv('QWEN_TTS_API_KEY', '')
    assert speech.project_tts_key() == ''


def test_local_tts_fallback_is_retained(monkeypatch):
    monkeypatch.delenv('QWEN_TTS_API_KEY', raising=False)
    monkeypatch.setattr(speech, 'dotenv_values', lambda *_: {'QWEN_TTS_API_KEY': 'fixture-local'})
    assert speech.project_tts_key() == 'fixture-local'


def test_scoped_reply_uses_project_settings(monkeypatch):
    from app.core import config
    from app.living import life_live_planner, life_provider
    from app.services import voice_reply
    settings = config.Settings(_env_file=None, model_base_url=life_provider.BASE_URL,
        model_api_key='fixture-key', voice_live_reply_enabled=False)
    monkeypatch.setattr(config, 'get_settings', lambda: settings)
    calls=[]
    async def catalog(): calls.append('catalog')
    def reply(messages, **kwargs):
        calls.append('reply')
        assert kwargs['settings'].model_api_key == 'fixture-key'
        assert kwargs['settings'].model_max_retries == 0
        return 'fixture reply'
    monkeypatch.setattr(life_live_planner, 'check_current_catalog', catalog)
    monkeypatch.setattr(voice_reply, 'configured_reply', reply)
    assert voice_sessions.project_reply([]) == 'fixture reply'
    assert calls == ['catalog', 'reply']
    assert settings.voice_live_reply_enabled is False
    monkeypatch.setattr(config, 'get_settings', lambda: settings.model_copy(update={'model_api_key': ''}))
    with pytest.raises(LivingError): voice_sessions.project_reply([])
    assert calls == ['catalog', 'reply']
