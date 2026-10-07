"""Synthetic, offline 25-record history QA on the existing isolated 8047 DB.

Inherits C1.10's provider rejection and synthetic login; never targets the main DB.
Historical times below are deliberate test data, not real user activity.
"""
import json
from uuid import uuid4

import c110_life_dispatch_preview as preview

STATE = preview.PROJECT / '.runtime' / 'c113-history'
STATE.mkdir(parents=True, exist_ok=True)
manifest = STATE / 'space.json'
runtime = preview.life_runtime.selected_runtime()
runtime.initialize()
if not manifest.exists():
    with preview.SessionLocal() as db:
        photo = preview.Photo(filename='sample.png', status='done', owner_id=preview.owner)
        db.add(photo); db.flush()
        obj = preview.Object(photo_id=photo.id, label='活动历史离线样例'); db.add(obj); db.flush()
        character = preview.Character(object_id=obj.id, owner_id=preview.owner, name='活动历史·离线样例',
                                      persona='合成分页验证，不是真实经历', opening_line='看看留下的小记录。',
                                      image_path='sample.png', status='ready', location_epoch=1)
        db.add(character); db.flush(); cid = character.id; db.commit()
    sid = str(uuid4())
    with preview.SessionLocal() as db:
        db.get(preview.Character, cid).current_space_id = sid; db.commit()
    original_clock = preview.living_store.clock
    stamp = [preview.living_store._now() - 26 * 601]
    preview.living_store.clock = lambda: stamp[0]
    try:
        preview.living_store.create_space(preview.owner, sid, 'home', 'private', str(cid))
        revision = 1
        runtime.save_permission(preview.owner, sid, str(uuid4()), 0, True, ('rest',))
        for index in range(25):
            tid = str(uuid4())
            runtime.schedule(preview.owner, sid, tid)
            if index % 5 == 4:
                runtime.save_permission(preview.owner, sid, str(uuid4()), revision, False, ('rest',)); revision += 1
                runtime.save_permission(preview.owner, sid, str(uuid4()), revision, True, ('rest',)); revision += 1
            else:
                runtime.run_fixture(preview.owner, sid, tid)
            stamp[0] += 601
        runtime.save_permission(preview.owner, sid, str(uuid4()), revision, False, ('rest',))
    finally:
        preview.living_store.clock = original_clock
    manifest.write_text(json.dumps({'character_id': cid, 'space_id': sid, 'synthetic_tasks': 25}), encoding='utf-8')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(preview.app, host='127.0.0.1', port=8047, access_log=False)
