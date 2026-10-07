"""Isolated R3.2 browser fixture. No live DB, SMS, image or AI calls.
Run: backend/.venv/bin/python backend/scripts/r32_life_preview.py
Preview backend: 8042. Sign in with synthetic 13900000332 / 123456.
"""
import os
import sys
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'v12-r32-preview'
STATE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(PROJECT / 'backend'))
os.environ.update({
    'APP_ENV': 'test', 'LIFE_SIMULATION_ENABLED': 'true', 'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}',
    'UPLOAD_DIR': str(STATE / 'uploads'), 'MODEL_API_KEY': '', 'MODEL_BASE_URL': '',
    'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '', 'LEGACY_CLAIM_USER_ID': '',
    'DEV_SMS_FIXED_CODE': '123456', 'GENERATION_QUOTA_ENABLED': 'false', 'SCENE_AGENT_ENABLED': 'false',
})
from app.services.model_client import ModelClient


def reject_provider(*args, **kwargs):
    raise RuntimeError('R3.2 QA forbids AI calls')


ModelClient._call_vision = reject_provider
ModelClient._post_chat_completions = reject_provider
ModelClient._call_image_generation = reject_provider
from app.main import app
from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, User

with SessionLocal() as db:
    user = db.query(User).filter(User.phone == '13900000332').first()
    if user is None:
        user = User(id='r32-life-fixture', phone='13900000332')
        db.add(user)
        db.flush()
        photo = Photo(filename='season-fixture.png', status='done', owner_id=user.id)
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label='四季测试杯')
        db.add(obj)
        db.flush()
        db.add(Character(object_id=obj.id, owner_id=user.id, name='四季小杯',
                         persona='温柔的合成测试伙伴', opening_line='一起看看这里的季节吧。', status='ready'))
        db.commit()

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8042, access_log=False)
