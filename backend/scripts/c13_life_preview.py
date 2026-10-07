"""C1.3 isolated UI preview, backend 8043; never uses the main database or AI."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import sys
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'v12-c13-preview'
RUNTIME_TABLES = {f'life_runtime_{name}' for name in ('permissions', 'setting_receipts', 'tasks', 'events', 'limits', 'calls')}


def database_facts(conn):
    result = {}
    names = [row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
    for name in names:
        quoted = '"' + name.replace('"', '""') + '"'
        rows = conn.execute('SELECT * FROM ' + quoted).fetchall()
        result[name] = {'rows': len(rows), 'digest': hashlib.sha256(repr(sorted(rows, key=repr)).encode()).hexdigest()}
    return result


def backup_before_schema(state):
    db = state / 'preview.db'
    if not db.exists():
        return None
    with sqlite3.connect(f'file:{db}?mode=ro', uri=True) as source:
        facts = database_facts(source)
        if RUNTIME_TABLES.issubset(facts):
            return None
        destination = state / 'backups' / ('before-runtime-' + str(uuid4()))
        destination.mkdir(parents=True)
        with sqlite3.connect(destination / 'preview.db') as restored:
            source.backup(restored)
            if restored.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or database_facts(restored) != facts:
                raise RuntimeError('Preview backup verification failed; schema unchanged')
    uploads = state / 'uploads'
    if uploads.exists():
        shutil.copytree(uploads, destination / 'uploads')
        for file in uploads.rglob('*'):
            if file.is_file() and file.read_bytes() != (destination / 'uploads' / file.relative_to(uploads)).read_bytes():
                raise RuntimeError('Preview asset backup mismatch; schema unchanged')
    (destination / 'manifest.json').write_text(json.dumps({'tables': facts, 'verified': True}, indent=2), encoding='utf8')
    return destination


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    backup_before_schema(STATE)
    sys.path.insert(0, str(PROJECT / 'backend'))
    os.environ.update({
        'APP_ENV': 'test', 'LIFE_RUNTIME_PREVIEW_ENABLED': 'true', 'LIFE_SIMULATION_ENABLED': 'false',
        'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}', 'UPLOAD_DIR': str(STATE / 'uploads'),
        'MODEL_API_KEY': '', 'MODEL_BASE_URL': '', 'IMAGE_BASE_URL': '', 'DEV_AUTH_TOKEN': '',
        'LEGACY_CLAIM_USER_ID': '', 'DEV_SMS_FIXED_CODE': '123456',
        'GENERATION_QUOTA_ENABLED': 'false', 'SCENE_AGENT_ENABLED': 'false',
    })
    from app.services.model_client import ModelClient
    def forbidden(*args, **kwargs):
        raise RuntimeError('C1.3 preview forbids model calls')
    ModelClient._call_vision = forbidden
    ModelClient._post_chat_completions = forbidden
    ModelClient._call_image_generation = forbidden
    from app.main import app
    from app.api.living import living_store
    from app.core.database import SessionLocal, engine
    from app.living.store import spaces
    from app.models.models import Character, Object, Photo, User
    from sqlalchemy import select, update
    with SessionLocal() as db:
        user = db.query(User).filter(User.phone == '13900000133').first()
        if user is None:
            user = User(id='c13-life-fixture', phone='13900000133')
            db.add(user); db.flush()
            photo = Photo(filename='c13-fixture.png', status='done', owner_id=user.id)
            db.add(photo); db.flush()
            obj = Object(photo_id=photo.id, label='生活测试杯')
            db.add(obj); db.flush()
            db.add(Character(object_id=obj.id, owner_id=user.id, name='生活小杯',
                             persona='温柔的合成测试伙伴', opening_line='一起安排今天的生活吧。', status='ready'))
            db.commit()
        cid = db.query(Character.id).filter(Character.owner_id == user.id).order_by(Character.id).first()[0]
        owner = user.id
    with engine.connect() as conn:
        exists = conn.execute(select(spaces.c.id).where(spaces.c.owner_id == owner,
            spaces.c.companion_id == str(cid), spaces.c.scene_type == 'home')).scalar_one_or_none()
    if exists is None:
        sid = str(uuid4())
        living_store.create_space(owner, sid, 'home', 'private', str(cid))
        living_store.execute(owner, sid, str(uuid4()), 0, {'action': 'place', 'kind': 'tree', 'x': 0.35, 'y': 0.55})
        with engine.begin() as conn:
            conn.execute(update(Character).where(Character.id == cid).values(current_space_id=sid, location_epoch=1))
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8043, access_log=False)


if __name__ == '__main__':
    main()
