"""Isolated opt-in daily fixture scheduling; inherits provider rejection on 8047."""
import json
from uuid import uuid4

import c110_life_dispatch_preview as preview

STATE = preview.PROJECT / '.runtime' / 'c115-auto'
STATE.mkdir(parents=True, exist_ok=True)
manifest = STATE / 'space.json'
preview.life_runtime.selected_runtime().initialize()
if not manifest.exists():
    with preview.SessionLocal() as db:
        photo = preview.Photo(filename='sample.png', status='done', owner_id=preview.owner)
        db.add(photo); db.flush()
        obj = preview.Object(photo_id=photo.id, label='每日自动离线样例'); db.add(obj); db.flush()
        character = preview.Character(object_id=obj.id, owner_id=preview.owner, name='每天的小日常·离线样例',
            persona='隔离自动调度样例，不是真实AI经历', opening_line='一起看看每天的小记录。',
            image_path='sample.png', status='ready', location_epoch=1)
        db.add(character); db.flush(); cid = character.id
        sid = str(uuid4()); character.current_space_id = sid; db.commit()
    preview.living_store.create_space(preview.owner, sid, 'home', 'private', str(cid))
    manifest.write_text(json.dumps({'character_id': cid, 'space_id': sid}), encoding='utf-8')

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(preview.app, host='127.0.0.1', port=8047, access_log=False)
