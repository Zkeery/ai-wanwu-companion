"""Isolated shared-season QA: synthetic data only, no provider calls.

Run backend/.venv/bin/python backend/scripts/r41_gathering_seasons_preview.py.
Backend 8046; companion frontend 3048. Local SMS fixture: 13900000411 / 123456.
"""
import json
import os
from pathlib import Path
import shutil
import sys
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'r41-shared-seasons'
STATE.mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(PROJECT / 'backend'))
os.environ.update({
    'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}',
    'UPLOAD_DIR': str(STATE / 'uploads'), 'MODEL_API_KEY': '', 'MODEL_BASE_URL': '',
    'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '', 'LEGACY_CLAIM_USER_ID': '',
    'DEV_SMS_FIXED_CODE': '123456', 'GENERATION_QUOTA_ENABLED': 'false', 'SCENE_AGENT_ENABLED': 'false',
    'LIFE_SIMULATION_ENABLED': 'false', 'LIFE_RUNTIME_PREVIEW_ENABLED': 'false',
    'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'false', 'VOICE_LIVE_REPLY_ENABLED': 'false',
})
from app.services.model_client import ModelClient


def reject_provider(*args, **kwargs):
    raise RuntimeError('R4.1 QA forbids provider calls')


ModelClient._call_vision = reject_provider
ModelClient._post_chat_completions = reject_provider
ModelClient._call_image_generation = reject_provider
from app.main import app
from app.api.gatherings import store
from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, User

uploads = STATE / 'uploads'
uploads.mkdir(exist_ok=True)
# Reuse a public development illustration; never copy user photos or sessions.
shutil.copyfile(PROJECT / 'frontend/public/motion-preview-assets/static.png', uploads / 'r41-sample.png')
owner = 'r41-synthetic-owner'
with SessionLocal() as db:
    for index, uid in enumerate([owner, 'r41-synthetic-second', 'r41-synthetic-third']):
        if db.get(User, uid) is None:
            db.add(User(id=uid, phone=f'1390000041{index + 1}'))
    db.flush()
    character = db.query(Character).filter(Character.owner_id == owner).first()
    if character is None:
        photo = Photo(filename='r41-sample.png', status='done', owner_id=owner)
        db.add(photo); db.flush()
        obj = Object(photo_id=photo.id, label='合成四季样例')
        db.add(obj); db.flush()
        character = Character(object_id=obj.id, owner_id=owner, name='四季样例伙伴',
                              persona='仅用于隔离验证的合成角色', opening_line='一起看看四季。',
                              image_path='r41-sample.png', status='ready')
        db.add(character); db.flush()
    character_id = character.id
    character.image_path = 'r41-sample.png'
    db.commit()

index_file = STATE / 'spaces.json'
if not index_file.exists():
    spaces = {}
    for scene in ['home', 'desert', 'forest']:
        g = store.create(owner, str(uuid4()), f'四季验证·{scene}', '样例主人', scene,
                         {'mode': 'virtual', 'weeks': 4, 'start_season': 'autumn'})
        g = store.command(owner, g['id'], str(uuid4()), g['revision'], {'action': 'invite'})
        invitation = g['invitation']
        for uid in ['r41-synthetic-second', 'r41-synthetic-third']:
            g = store.join(uid, str(uuid4()), invitation, '合成成员')
        g = store.command(owner, g['id'], str(uuid4()), g['revision'], {'action': 'layout', 'command': {'action': 'place', 'kind': 'tree', 'x': .35, 'y': .5}})
        tree = g['items'][0]
        g = store.command(owner, g['id'], str(uuid4()), g['revision'], {'action': 'layout', 'command': {'action': 'care', 'item_id': tree['id']}})
        spaces[scene] = g['id']
    # One character has one current location; other scenes remain empty.
    g = store.read(owner, spaces['home'])
    store.command(owner, g['id'], str(uuid4()), g['revision'], {'action': 'visit', 'character_id': character_id})
    index_file.write_text(json.dumps(spaces), encoding='utf-8')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8046, access_log=False)
