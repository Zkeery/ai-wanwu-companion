"""Explicit local transcription; no model download, paid calls or audio persistence."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading

from app.core.errors import api_error
from app.services.voice import validate_audio
from app.services.transcription_config import resolve_model_path, transcription_status, STATUS_MESSAGES

_slot = threading.BoundedSemaphore(1)


def transcribe(data: bytes, model_path: str) -> str:
    validate_audio(data)
    status = transcription_status(model_path)
    if status != 'configured':
        raise api_error(503, 'transcription_unavailable', STATUS_MESSAGES[status])
    model = resolve_model_path(model_path)
    if not _slot.acquire(blocking=False):
        raise api_error(429, 'transcription_busy', '识别正在使用中，请稍后再试')
    try:
        with tempfile.TemporaryDirectory(prefix='companion-asr-') as directory:
            recording = Path(directory) / 'recording.audio'
            result = Path(directory) / 'result.json'
            recording.write_bytes(data)
            env = {**os.environ, 'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1'}
            subprocess.run([sys.executable, str(Path(__file__).with_name('transcription_worker.py')),
                str(model.resolve()), str(recording), str(result)], env=env,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                check=True, timeout=60)
            if result.stat().st_size > 16000:
                raise ValueError('Oversize result')
            text = json.loads(result.read_text(encoding='utf-8'))
            if not isinstance(text, str) or len(text) > 2000:
                raise ValueError('Invalid transcript')
            if not any(char.isalnum() for char in text):
                raise api_error(422, 'no_speech', '没有识别到可用文字，请重录或自己填写')
            return text.strip()
    except subprocess.TimeoutExpired:
        raise api_error(504, 'transcription_timeout', '识别超时，录音未发送，可以重试或填写文字') from None
    except (OSError, ValueError, subprocess.SubprocessError):
        raise api_error(503, 'transcription_unavailable', '暂时无法识别，请重试或填写录音文字') from None
    finally:
        _slot.release()
