"""Isolated C1.10 queue QA; synthetic offline tasks, no paid provider.

Backend 8047 / frontend 3049. Local fixture 13900000110 / 123456.
A four-second fixture delay makes background execution and pause observable.
"""
import asyncio
import json
import os
from pathlib import Path
import shutil
import sys
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'c110-dispatch'
STATE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(PROJECT / 'backend'))
os.environ.update({
    'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}',
    'UPLOAD_DIR': str(STATE / 'uploads'), 'MODEL_API_KEY': '', 'MODEL_BASE_URL': '',
    'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '', 'LEGACY_CLAIM_USER_ID': '',
    'DEV_SMS_FIXED_CODE': '123456', 'GENERATION_QUOTA_ENABLED': 'false',
    'SCENE_AGENT_ENABLED': 'false', 'LIFE_SIMULATION_ENABLED': 'false',
    'LIFE_RUNTIME_PREVIEW_ENABLED': 'true', 'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'false',
    'VOICE_LIVE_REPLY_ENABLED': 'false',
})
from app.services.model_client import ModelClient


def reject_provider(*args, **kwargs):
    raise RuntimeError('C1.10 QA forbids external provider calls')


ModelClient._call_vision = reject_provider
ModelClient._post_chat_completions = reject_provider
ModelClient._call_image_generation = reject_provider
from app.main import app
from app.api import life_runtime
from app.api.living import living_store
from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, User

uploads = STATE / 'uploads'
uploads.mkdir(exist_ok=True)
shutil.copyfile(PROJECT / 'frontend/public/motion-preview-assets/static.png', uploads / 'sample.png')
owner = 'c110-synthetic-owner'
with SessionLocal() as db:
    if db.get(User, owner) is None:
        db.add(User(id=owner, phone='13900000110')); db.commit()
index_file = STATE / 'spaces.json'
if not index_file.exists():
    index = {}
    for label in ['normal', 'restart', 'pause']:
        with SessionLocal() as db:
            photo = Photo(filename='sample.png', status='done', owner_id=owner)
            db.add(photo); db.flush()
            obj = Object(photo_id=photo.id, label='离线队列样例'); db.add(obj); db.flush()
            ch = Character(object_id=obj.id, owner_id=owner, name='生活队列·' + label,
                           persona='仅供隔离工程验证', opening_line='一起看看生活。',
                           image_path='sample.png', status='ready', location_epoch=1)
            db.add(ch); db.flush(); cid = ch.id; db.commit()
        sid = str(uuid4())
        living_store.create_space(owner, sid, 'home', 'private', str(cid))
        with SessionLocal() as db:
            db.get(Character, cid).current_space_id = sid; db.commit()
        index[label] = {'character_id': cid, 'space_id': sid}
    index_file.write_text(json.dumps(index), encoding='utf-8')

original_execute = life_runtime.execute_requested


async def delayed_fixture(runtime, owner_id, sid, tid):
    if runtime.origin != 'offline_fixture':
        raise RuntimeError('C1.10 preview must remain offline')
    await asyncio.sleep(4)
    await original_execute(runtime, owner_id, sid, tid)


life_runtime.execute_requested = delayed_fixture

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8047, access_log=False)
