"""C1.17–19 private scene QA: existing isolated 8047 database, zero provider calls.

Creates three synthetic companions once. --refresh-activities explicitly starts
another due offline fixture round for these samples only; never resets history.
"""
import json
import sys
from uuid import uuid4

import c115_life_automatic_preview as previous
from app.living import seasons
from app.living.rules import LivingError

preview = previous.preview
runtime = preview.life_runtime.selected_runtime()
STATE = preview.PROJECT / '.runtime' / 'c119-scene-life'
STATE.mkdir(parents=True, exist_ok=True)
manifest = STATE / 'spaces.json'
samples = json.loads(manifest.read_text()) if manifest.exists() else {}

for scene, activity, season in [('home', 'observe', 'spring'), ('forest', 'walk', 'autumn'), ('desert', 'rest', 'summer')]:
    if scene not in samples:
        with preview.SessionLocal() as db:
            photo = preview.Photo(filename='sample.png', status='done', owner_id=preview.owner)
            db.add(photo); db.flush()
            obj = preview.Object(photo_id=photo.id, label='场景活动离线样例'); db.add(obj); db.flush()
            ch = preview.Character(object_id=obj.id, owner_id=preview.owner, name={'home': '观察小满', 'forest': '散步小满', 'desert': '休息小满'}[scene],
                persona='隔离规则动画样例，不是真实AI经历', opening_line='一起看看小天地。',
                image_path='sample.png', status='ready', location_epoch=1)
            db.add(ch); db.flush(); cid = ch.id; db.commit()
        sid = str(uuid4())
        preview.living_store.create_space(preview.owner, sid, scene, 'private', str(cid))
        with preview.SessionLocal() as db:
            db.get(preview.Character, cid).current_space_id = sid; db.commit()
        samples[scene] = {'character_id': cid, 'space_id': sid, 'activity': activity, 'initialized': False}
        manifest.write_text(json.dumps(samples), encoding='utf-8')
    if not samples[scene].get('initialized', True):
        sid = samples[scene]['space_id']
        for kind, x, y in [('tree', .58, .48), ('cushion' if scene == 'forest' else 'pond', .25, .65)]:
            space = preview.living_store.read_space(preview.owner, sid)
            if not any(item['kind'] == kind for item in space['items']):
                preview.living_store.execute(preview.owner, sid, str(uuid4()), space['revision'],
                    {'action': 'place', 'kind': kind, 'x': x, 'y': y})
        with runtime.engine.begin() as conn:
            if seasons.read(conn, preview.owner, sid, runtime._now())['revision'] == 0:
                seasons.save(conn, preview.owner, sid, str(uuid4()), 0,
                    seasons.VirtualSettings(mode='virtual', weeks=4, start_season=season), runtime._now())
        if runtime.read_permission(preview.owner, sid) is None:
            runtime.save_permission(preview.owner, sid, str(uuid4()), 0, True, (activity,))
        if not runtime.snapshot(preview.owner, sid).tasks:
            task = runtime.schedule(preview.owner, sid, str(uuid4()), 'viewing')
            runtime.run_fixture(preview.owner, sid, task.spec.basis.plan_id)
        samples[scene]['initialized'] = True
        manifest.write_text(json.dumps(samples), encoding='utf-8')
    elif '--refresh-activities' in sys.argv:
        sid = samples[scene]['space_id']
        status = runtime.snapshot(preview.owner, sid)
        if status.next_allowed_at <= status.observed_at and status.permission.enabled:
            try:
                task = runtime.schedule(preview.owner, sid, str(uuid4()), 'viewing')
                runtime.run_fixture(preview.owner, sid, task.spec.basis.plan_id)
            except LivingError:
                print('sample not eligible; existing data kept')

if __name__ == '__main__' and '--refresh-activities' not in sys.argv:
    import uvicorn
    uvicorn.run(preview.app, host='127.0.0.1', port=8047, access_log=False)
