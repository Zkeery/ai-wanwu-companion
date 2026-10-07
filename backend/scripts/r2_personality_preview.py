"""V1.2 R2.1 isolated browser fixture: no real provider or main user data.
Run from project root: backend/.venv/bin/python backend/scripts/r2_personality_preview.py
"""
import os
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'v12-r2-preview'
STATE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(PROJECT / 'backend'))
os.environ.update({
    'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}', 'UPLOAD_DIR': str(STATE / 'uploads'),
    'MODEL_API_KEY': '', 'MODEL_BASE_URL': '', 'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '',
    'DEV_SMS_FIXED_CODE': '123456', 'GENERATION_QUOTA_ENABLED': 'false', 'SCENE_AGENT_ENABLED': 'false',
})

from app.services.model_client import ModelClient
from app.services.parsers import RecognizedObject


def recognize_fixture(self, data):
    return [RecognizedObject(label='模拟苹果', category='fruit', visual_features='离线合成测试素材，不代表真实识别')]


ModelClient.recognize = recognize_fixture

if __name__ == '__main__':
    import uvicorn
    uvicorn.run('app.main:app', host='127.0.0.1', port=8036)
