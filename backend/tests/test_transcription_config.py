import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.services import transcription_config as config
from app.services import transcription as asr
from fastapi import HTTPException
from tests.test_voice import wav


@pytest.fixture
def model(tmp_path):
    for name in ('model.bin', 'config.json', 'tokenizer.json'):
        (tmp_path / name).write_text('fixture')
    return tmp_path


def test_states_and_relative_path(model, monkeypatch):
    monkeypatch.setattr(config, 'find_spec', lambda _: None)
    assert config.transcription_status('') == 'unconfigured'
    assert config.transcription_status('  ') == 'unconfigured'
    assert config.transcription_status(str(model / 'missing')) == 'model_missing'
    assert config.transcription_status(str(model)) == 'dependency_missing'
    monkeypatch.setattr(config, 'find_spec', lambda _: object())
    assert config.transcription_status(str(model)) == 'configured'
    monkeypatch.setattr(config, 'BACKEND_DIR', model.parent)
    assert config.resolve_model_path(model.name) == model
    assert config.transcription_status(model.name) == 'configured'


@pytest.mark.parametrize('name', ['model.bin', 'config.json', 'tokenizer.json'])
def test_empty_model_file_is_not_configured(model, name):
    (model / name).write_bytes(b'')
    assert config.transcription_status(str(model)) == 'model_missing'


def test_filesystem_failure_is_not_exposed(monkeypatch):
    monkeypatch.setattr(Path, 'is_dir', lambda _: (_ for _ in ()).throw(PermissionError('private path')))
    assert config.transcription_status('/private/path') == 'model_missing'


def test_missing_dependency_does_not_launch(model, monkeypatch):
    monkeypatch.setattr(config, 'find_spec', lambda _: None)
    monkeypatch.setattr(asr.subprocess, 'run', lambda *a, **k: pytest.fail('must not launch'))
    with pytest.raises(HTTPException) as error:
        asr.transcribe(wav(), str(model))
    assert error.value.status_code == 503


def test_missing_converter_does_not_launch(model, monkeypatch):
    monkeypatch.setattr(config, 'find_spec', lambda name: None if name == 'opencc' else object())
    monkeypatch.setattr(asr.subprocess, 'run', lambda *a, **k: pytest.fail('must not launch'))
    assert config.transcription_status(str(model)) == 'dependency_missing'
    with pytest.raises(HTTPException) as error:
        asr.transcribe(wav(), str(model))
    assert error.value.status_code == 503


def test_settings_expose_only_status(client, anon, ready_character_id, monkeypatch):
    monkeypatch.setattr('app.services.voice.transcription_status', lambda _: 'dependency_missing')
    url = f'/api/v1/characters/{ready_character_id}/voice/settings'
    assert anon.get(url).status_code == 401
    assert client.get('/api/v1/characters/999999/voice/settings').status_code == 404
    result = client.get(url)
    assert result.status_code == 200
    assert result.json()['transcription_status'] == 'dependency_missing'
    assert 'model_path' not in result.text


def test_check_command_without_configuration():
    script = config.BACKEND_DIR / 'scripts/check_voice_transcription.py'
    result = subprocess.run([sys.executable, str(script), '--model-path', ''],
                            capture_output=True, text=True, check=False)
    assert result.returncode == 2
    assert json.loads(result.stdout)['status'] == 'unconfigured'
    assert result.stderr == ''


def test_check_command_configured_with_fake_optional_package(model, tmp_path):
    # Static inspection only: the module must never be imported or execute code.
    module = tmp_path / 'faster_whisper.py'
    module.write_text('raise RuntimeError("must not import")')
    (tmp_path / 'opencc.py').write_text('raise RuntimeError("must not import")')
    result = subprocess.run([sys.executable, str(config.BACKEND_DIR / 'scripts/check_voice_transcription.py'),
                             '--model-path', str(model)], capture_output=True, text=True,
                            env={**os.environ, 'PYTHONPATH': str(tmp_path)}, check=False)
    assert result.returncode == 0
    assert json.loads(result.stdout)['status'] == 'configured'
    assert result.stderr == ''
