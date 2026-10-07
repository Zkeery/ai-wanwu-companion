"""Isolated R2.3 browser QA. Real API/SQLite, explicitly simulated model/SMS.
Run from project root; never reads or writes the main database.
"""
import os
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'v12-r23-preview'
STATE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(PROJECT / 'backend'))
os.environ.update({
    'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}',
    'UPLOAD_DIR': str(STATE / 'uploads'), 'MODEL_API_KEY': '', 'MODEL_BASE_URL': '',
    'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '', 'LEGACY_CLAIM_USER_ID': '',
    'DEV_SMS_FIXED_CODE': '123456', 'GENERATION_QUOTA_ENABLED': 'true',
    'SCENE_AGENT_ENABLED': 'false',
})
from app.core.config import get_settings
from app.services.model_client import ModelClient
from app.services.parsers import RecognizedObject

settings = get_settings()
assert settings.use_mock and str(STATE) in settings.database_url
assert Path(settings.upload_dir).is_relative_to(STATE)


def recognize_fixture(self, image_bytes):
    return [RecognizedObject(label='模拟苹果', category='fruit', visual_features='仅供流程验收的模拟水果，非真实识别')]


def reject_real_provider(*args, **kwargs):
    raise RuntimeError('R2.3 QA forbids real provider calls')


ModelClient.recognize = recognize_fixture
ModelClient._call_vision = reject_real_provider
ModelClient._post_chat_completions = reject_real_provider
ModelClient._call_image_generation = reject_real_provider

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('app.main:app', host='127.0.0.1', port=8036, access_log=False)
