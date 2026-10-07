"""Isolated synthetic UI rehearsal. Network provider calls are always blocked."""
import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import secrets
import time
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / '.runtime/r47-automatic-review'
ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
os.environ.update(APP_ENV='test', DATABASE_URL=f'sqlite:///{ROOT / "check.db"}',
    UPLOAD_DIR=str(ROOT/'uploads'), WALK_WORKFLOW_ROOT=str(ROOT/'ledger'), MODEL_API_KEY='',
    MODEL_BASE_URL='', IMAGE_BASE_URL='', SMS_PROVIDER='mock', SMS_LIVE_ENABLED='false', SMS_DAILY_LIMIT='0',
    LIFE_RUNTIME_ENABLED='false', LIFE_RUNTIME_PREVIEW_ENABLED='false', LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false',
    LIFE_SIMULATION_ENABLED='false', SCENE_AGENT_ENABLED='false', MOTION_GENERATION_ENABLED='false',
    GATHERING_DIALOGUE_ENABLED='false', GATHERING_DIALOGUE_AUTOMATIC_ENABLED='false', VOICE_LIVE_REPLY_ENABLED='false')

from app.main import app  # noqa: E402
from app.core.database import engine, SessionLocal  # noqa: E402
from app.core.security import hash_token  # noqa: E402
from app.models.models import User, Session, Photo, Object, Character  # noqa: E402
from app.living.gathering_automatic import AutomaticDialogueStore  # noqa: E402
from app.living.life_provider import RESERVE_MICRO  # noqa: E402
from app.api import gatherings  # noqa: E402

OWNER = 'r47-synthetic-only'


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f)


def clock():
    return int(time.time()) + json.loads((ROOT/'clock.json').read_text())['offset']


store = AutomaticDialogueStore(engine, clock)


async def catalog():
    return {'offline_fixture': True}


class OfflineDialogue:
    async def exchange(self, facts):
        await asyncio.sleep(1)
        number = len(facts['recent_exchanges']) + 1
        return {'lines': [dict(character_id=p['character_id'], text=f'离线流程验收第{number}轮：我们接着看眼前的场景。', item_ids=[])
                          for p in facts['participants']]}


def install():
    import httpx
    async def blocked(*args, **kwargs):
        raise RuntimeError('Network provider forbidden in synthetic rehearsal')
    httpx.AsyncClient.send = blocked
    from app.living import gathering_automatic
    original = gathering_automatic.run_exchange
    async def offline_run(selected, task, factory, **kwargs):
        await original(selected, task, OfflineDialogue, catalog)
    gathering_automatic.run_exchange = offline_run
    gatherings.automatic_store = store
    gatherings.dialogue_store = store
    gatherings.store.clock = clock
    gatherings.automatic_available = lambda: True
    gatherings.dialogue_available = lambda: True
    gatherings.automatic_client = OfflineDialogue
    gatherings.dialogue_client = OfflineDialogue


def seed():
    if (ROOT/'identity.json').exists():
        raise ValueError('Existing rehearsal must not be seeded twice')
    private_json(ROOT/'clock.json', {'offset': 0})
    token = secrets.token_urlsafe(32)
    with SessionLocal() as db:
        db.add(User(id=OWNER, phone='13900000470')); db.flush()
        now = datetime.now(timezone.utc).replace(tzinfo=None)
        db.add(Session(token_hash=hash_token(token), user_id=OWNER, created_at=now,
                       expires_at=now+timedelta(days=1), last_seen_at=now))
        photo = Photo(filename='synthetic-no-image.png', status='done', owner_id=OWNER)
        db.add(photo); db.flush()
        obj = Object(photo_id=photo.id, label='离线流程验收'); db.add(obj); db.flush()
        ids = []
        for name in ['离线验收杯子', '离线验收苹果']:
            ch = Character(object_id=obj.id, owner_id=OWNER, name=name, persona='离线合成数据', opening_line='', status='ready')
            db.add(ch); db.flush(); ids.append(ch.id)
        db.commit()
    group = store.create(OWNER, str(uuid4()), '离线自动交流验收', '验收账号', 'home')
    for cid in ids:
        for payload in [dict(action='visit',character_id=cid), dict(action='dialogue_consent',character_id=cid,enabled=True)]:
            group = store.command(OWNER, group['id'], str(uuid4()), group['revision'], payload)
    group = store.command(OWNER, group['id'], str(uuid4()), group['revision'], dict(action='dialogue_space',enabled=True))
    session = store.authorize_session(OWNER, group['id'], ids, 4, 'r47-synthetic-only-no-paid-requests',
        project_cap_micro=RESERVE_MICRO*4, space_cap_micro=RESERVE_MICRO*4)
    private_json(ROOT/'identity.json', dict(owner=OWNER, group_id=group['id'], characters=ids, token=token, session_id=session))
    print(json.dumps({'seeded':True,'characters':ids,'model_requests':0}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['seed','serve','status','advance'])
    parser.add_argument('--seconds', type=int, choices=range(0, 1801), default=600)
    args = parser.parse_args()
    if args.mode == 'seed':
        seed(); return
    if args.mode == 'serve':
        install()
        import uvicorn
        uvicorn.run(app, host='127.0.0.1', port=8049); return
    if args.mode == 'advance':
        saved = json.loads((ROOT/'clock.json').read_text())
        private_json(ROOT/'clock.json', dict(offset=saved['offset']+args.seconds))
    identity = json.loads((ROOT/'identity.json').read_text())
    status = store.status(OWNER, identity['group_id'])
    print(json.dumps(dict(status=status, exchanges=len(store.read(OWNER, identity['group_id'])['exchanges']),
                         synthetic_clock=clock(), model_requests=0), ensure_ascii=False))


if __name__ == '__main__':
    main()
