import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

from fastapi import HTTPException
import pytest

from app.services import transcription as asr
from app.services import transcription_worker
from tests.test_voice import wav


@pytest.fixture
def model(tmp_path, monkeypatch):
    monkeypatch.setattr('app.services.transcription_config.find_spec', lambda name: object())
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (tmp_path / name).write_text('fixture')
    return str(tmp_path)


def test_missing_model_never_launches(monkeypatch):
    monkeypatch.setattr(asr.subprocess, 'run', lambda *a, **k: pytest.fail('must not launch'))
    with pytest.raises(HTTPException) as error:
        asr.transcribe(wav(), '')
    assert error.value.status_code == 503


@pytest.mark.parametrize('mode', ['success', 'empty', 'punctuation', 'invalid', 'oversize', 'timeout', 'failed'])
def test_worker_contract_and_cleanup(model, monkeypatch, mode):
    paths = []
    def run(args, **kwargs):
        paths.extend([Path(args[-2]), Path(args[-1])])
        assert paths[0].read_bytes() == wav()
        assert kwargs['env']['HF_HUB_OFFLINE'] == '1'
        assert kwargs['timeout'] == 60 and kwargs['check']
        if mode == 'timeout':
            raise subprocess.TimeoutExpired(args, 60)
        if mode == 'failed':
            raise subprocess.CalledProcessError(1, args)
        value = {'success': '  今天很开心。 ', 'empty': '', 'punctuation': '，！？…', 'invalid': {}, 'oversize': 'x' * 2001}[mode]
        paths[1].write_text(json.dumps(value))
    monkeypatch.setattr(asr.subprocess, 'run', run)
    if mode == 'success':
        assert asr.transcribe(wav(), model) == '今天很开心。'
    else:
        with pytest.raises(HTTPException) as error:
            asr.transcribe(wav(), model)
        assert error.value.status_code == (504 if mode == 'timeout' else 422 if mode in ('empty', 'punctuation') else 503)
        if mode in ('empty', 'punctuation'):
            assert error.value.detail['error']['code'] == 'no_speech'
    assert all(not path.exists() for path in paths)
    assert asr._slot.acquire(blocking=False)
    asr._slot.release()


def test_silent_recording_does_not_start_worker(model, monkeypatch):
    monkeypatch.setattr(asr.subprocess, 'run', lambda *a, **k: pytest.fail('silent recording must not start worker'))
    with pytest.raises(Exception, match='重录或改用文字'):
        asr.transcribe(wav(silent=True), model)


@pytest.mark.parametrize(('segments', 'expected'), [
    (['你好'], '你好'),
    (['我今天有點累，', '想安靜聊兩句。'], '我今天有点累，想安静聊两句。'),
    (['今天很開心，天气很好。'], '今天很开心，天气很好。'),
    (['週末聽音樂，頭髮乾了。'], '周末听音乐，头发干了。'),
    (['AI 伙伴 Cherry，2026年10月1日 12:30，很開心！'],
     'AI 伙伴 Cherry，2026年10月1日 12:30，很开心！'),
    (['我今天有点累，想安静聊两句。'], '我今天有点累，想安静聊两句。'),
])
def test_worker_uses_model_length_and_returns_simplified(tmp_path, monkeypatch, segments, expected):
    recording = tmp_path / 'recording.wav'
    result = tmp_path / 'result.json'
    recording.write_bytes(wav())

    class Model:
        def __init__(self, path, **kwargs):
            assert path == str(tmp_path)
            assert kwargs['local_files_only'] is True

        def transcribe(self, path, **kwargs):
            assert path == str(recording)
            assert kwargs == dict(language='zh', beam_size=1, temperature=0,
                condition_on_previous_text=False)
            return [SimpleNamespace(text=text) for text in segments], None

    monkeypatch.setitem(sys.modules, 'faster_whisper', SimpleNamespace(WhisperModel=Model))
    monkeypatch.setattr(sys, 'argv', ['transcription_worker.py', str(tmp_path), str(recording), str(result)])
    transcription_worker.main()
    assert json.loads(result.read_text()) == expected


def test_busy_does_not_queue(model):
    assert asr._slot.acquire(blocking=False)
    try:
        with pytest.raises(HTTPException) as error:
            asr.transcribe(wav(), model)
        assert error.value.status_code == 429
    finally:
        asr._slot.release()


def test_api_transcription_is_private_and_does_not_send(client, anon, ready_character_id, monkeypatch):
    from app.core.database import SessionLocal
    from app.models.models import Message
    from app.services.voice import VoiceService
    from app.core.database import engine
    from tests.auth_helpers import TEST_USER_ID
    monkeypatch.setattr('app.api.voice.transcribe', lambda data, model_path: '今天很开心')
    path = f'/api/v1/characters/{ready_character_id}/voice/transcribe'
    files = {'recording': ('clip.wav', wav(), 'audio/wav')}
    assert anon.post(path, files=files).status_code == 401
    assert client.post('/api/v1/characters/999999/voice/transcribe', files=files).status_code == 404
    result = client.post(path, files=files)
    assert result.status_code == 200 and result.json() == {'text': '今天很开心'}
    assert result.headers['cache-control'] == 'private, no-store'
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=ready_character_id).count() == 0
    assert VoiceService(engine).history(TEST_USER_ID, ready_character_id) == []
