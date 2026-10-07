"""Offline, non-loading configuration checks shared by HTTP and the operator CLI."""
from importlib.util import find_spec
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]
STATUS_MESSAGES = {
    'unconfigured': '本地识别尚未配置，可以先填写录音文字。',
    'model_missing': '本地识别模型尚未准备好，可以先填写录音文字。',
    'dependency_missing': '本地识别组件尚未准备好，可以先填写录音文字。',
    'configured': '本地识别已配置，可以尝试识别；识别后请核对文字。',
}


def resolve_model_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else BACKEND_DIR / path


def transcription_status(value: str) -> str:
    if not value.strip():
        return 'unconfigured'
    try:
        model = resolve_model_path(value)
        if not model.is_dir() or not all((model / name).is_file() and (model / name).stat().st_size > 0
                for name in ('model.bin', 'config.json', 'tokenizer.json')):
            return 'model_missing'
    except (OSError, ValueError, RuntimeError):
        return 'model_missing'
    try:
        if any(find_spec(name) is None for name in ('faster_whisper', 'opencc')):
            return 'dependency_missing'
    except (ImportError, ValueError):
        return 'dependency_missing'
    return 'configured'
