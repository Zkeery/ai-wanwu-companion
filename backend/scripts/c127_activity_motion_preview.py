"""Create isolated, unanimated C1.27 samples once; never enable daily automation.

Reuses the existing offline-only preview environment. No provider calls and no
changes to earlier fixtures. Scheduling/execution remains an explicit UI action.
"""
import json
from uuid import uuid4
import c119_scene_activity_preview as previous

preview = previous.preview
runtime = previous.runtime
state = preview.PROJECT / '.runtime' / 'c127-qa'
state.mkdir(parents=True, exist_ok=True)
manifest = state / 'samples.json'
samples = json.loads(manifest.read_text()) if manifest.exists() else {}
for scene in ('home', 'forest', 'desert'):
    if scene not in samples:
        with preview.SessionLocal() as db:
            photo = preview.Photo(filename='sample.png', status='done', owner_id=preview.owner)
            db.add(photo); db.flush()
            obj = preview.Object(photo_id=photo.id, label='当前活动动作离线样例')
            db.add(obj); db.flush()
            ch = preview.Character(object_id=obj.id, owner_id=preview.owner,
                name='动作核对·' + scene, persona='合成样例，没有活动分类素材',
                opening_line='看看保存的活动。', image_path='sample.png',
                status='ready', location_epoch=1)
            db.add(ch); db.flush(); cid = ch.id; db.commit()
        sid = str(uuid4())
        preview.living_store.create_space(preview.owner, sid, scene, 'private', str(cid))
        with preview.SessionLocal() as db:
            db.get(preview.Character, cid).current_space_id = sid; db.commit()
        samples[scene] = {'character_id': cid, 'space_id': sid}
        manifest.write_text(json.dumps(samples), encoding='utf-8')
    sid = samples[scene]['space_id']
    if runtime.read_permission(preview.owner, sid) is None:
        runtime.save_permission(preview.owner, sid, str(uuid4()), 0, True, ('rest',))
print(json.dumps(samples))
