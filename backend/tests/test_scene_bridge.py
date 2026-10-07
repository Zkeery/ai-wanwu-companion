"""R3 regressions: shared canonical state, safe import and bound proposals."""
import json
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, text, update

from app.core.database import SessionLocal, engine
from app.living.store import LivingStore, spaces
from app.models.models import Character, SceneImport, SceneState
from app.services import scene as legacy
from tests.auth_helpers import TEST_USER_ID


def home(client, cid, scene='home', mode='private'):
    payload = {'scene_type': scene, 'mode': mode}
    if mode == 'private':
        payload['companion_id'] = str(cid)
    response = client.post('/api/v1/living/spaces', json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def act(client, snap, command, request_id=None):
    return client.post(f"/api/v1/living/spaces/{snap['id']}/actions", json={
        'request_id': request_id or str(uuid4()), 'expected_revision': snap['revision'], 'command': command})


def scene(client, cid):
    r = client.get(f'/api/v1/characters/{cid}/scene')
    assert r.status_code == 200, r.text
    return r.json()


def proposal(client, cid, parse_sse, message='种一棵树'):
    response = client.post(f'/api/v1/characters/{cid}/chat', json={'message': message})
    events = parse_sse(response.text)
    done = [d for e, d in events if e == 'done']
    assert len(done) == 1, events
    return done[0]['proposal']


def test_first_home_import_and_bidirectional_updates(client, ready_character_id):
    cid = ready_character_id
    base = f'/api/v1/characters/{cid}/scene'
    client.post(base+'/actions/plant_tree')
    client.post(base+'/actions/light_rain')
    with SessionLocal() as db:
        original = db.query(SceneState).filter_by(character_id=cid).one().state_json
    snap = home(client, cid)
    assert len(snap['items']) == 1 and snap['atmosphere']['rain']
    assert scene(client, cid)['living']['id'] == snap['id']
    result = client.post(base+'/actions/plant_tree').json()
    assert result['elements']['tree'] == 2
    latest = client.get('/api/v1/living/spaces/'+snap['id']).json()
    assert len(latest['items']) == 2
    stored = act(client, latest, {'action': 'store', 'item_id': latest['items'][0]['id']}).json()
    assert scene(client, cid)['elements']['tree'] == 1
    for _ in range(3):
        assert len(scene(client, cid)['living']['items']) == 2
    with SessionLocal() as db:
        assert db.query(SceneState).filter_by(character_id=cid).one().state_json == original
        assert db.get(SceneImport, cid).source_json == original
    # A fresh engine observes exactly the same durable state (not process memory).
    fresh = create_engine(engine.url)
    try:
        actual = LivingStore(fresh).read_space(TEST_USER_ID, snap['id'])
        assert actual['items'] == stored['items']
        assert actual['revision'] == stored['revision']
        assert actual['atmosphere'] == stored['atmosphere']
    finally:
        fresh.dispose()


def test_existing_home_import_preserves_position_storage_and_growth(client, ready_character_id):
    cid = ready_character_id
    # Simulate a home created before this fix, with independently placed/stored items.
    store = LivingStore(engine)
    snap = store.create_space(TEST_USER_ID, str(uuid4()), 'home', 'private', str(cid))
    snap = store.execute(TEST_USER_ID, snap['id'], str(uuid4()), 0, {'action':'place','kind':'tree','x':.8,'y':.7})
    snap = store.execute(TEST_USER_ID, snap['id'], str(uuid4()), 1, {'action':'store','item_id':snap['items'][0]['id']})
    existing = snap['items'][0]
    with SessionLocal() as db:
        elements = legacy.default_elements()
        elements.update(tree=3, flower=2)
        db.add(SceneState(character_id=cid, state_json=legacy.serialize(elements, [])))
        db.commit()
    result = client.get('/api/v1/living/spaces/'+snap['id']).json()
    assert len(result['items']) == 5
    assert next(i for i in result['items'] if i['id']==existing['id'])['stored']
    assert next(i for i in result['items'] if i['id']==existing['id'])['x'] == .8
    assert len(client.get('/api/v1/living/spaces/'+snap['id']).json()['items']) == 5


def test_current_desert_proposal_targets_desert_not_home(client, ready_character_id, parse_sse):
    cid = ready_character_id
    old_home = home(client,cid)
    desert = home(client,cid,'desert')
    client.put(f'/api/v1/characters/{cid}/location',json={'space_id':desert['id']})
    p = proposal(client,cid,parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/scene/proposals/{p['id']}/confirm")
    assert res.status_code == 200, res.text
    assert res.json()['living']['id'] == desert['id']
    assert len(res.json()['living']['items']) == 1
    assert not client.get('/api/v1/living/spaces/'+old_home['id']).json()['items']
    assert proposal(client,cid,parse_sse,'下一点小雨') is None
    assert client.post(f"/api/v1/characters/{cid}/scene/proposals/{p['id']}/confirm").status_code == 409


@pytest.mark.parametrize('change',['revision','away_back','remove_member','delete_space'])
def test_stale_proposal_never_mutates_another_state(client, ready_character_id, parse_sse, change):
    cid=ready_character_id
    h=home(client,cid,'home', 'shared' if change=='remove_member' else 'private')
    if change=='remove_member':
        client.post(f"/api/v1/living/spaces/{h['id']}/members",json={'companion_id':str(cid)})
    client.put(f'/api/v1/characters/{cid}/location',json={'space_id':h['id']})
    p=proposal(client,cid,parse_sse)
    if change=='revision':
        assert act(client,h,{'action':'place','kind':'bench','x':.5,'y':.5}).status_code==200
    elif change=='away_back':
        d=home(client,cid,'desert')
        for sid in [d['id'],h['id']]:
            assert client.put(f'/api/v1/characters/{cid}/location',json={'space_id':sid}).status_code==200
    elif change=='remove_member':
        client.delete(f"/api/v1/living/spaces/{h['id']}/members/{cid}")
    else:
        client.delete('/api/v1/living/spaces/'+h['id'])
    r=client.post(f"/api/v1/characters/{cid}/scene/proposals/{p['id']}/confirm")
    assert r.status_code==409,r.text
    all_spaces=client.get('/api/v1/living/spaces').json()
    for space in all_spaces:
        assert not any(i['kind']=='tree' for i in client.get('/api/v1/living/spaces/'+space['id']).json()['items'])


def test_shared_chat_and_editor_use_same_space(client,ready_character_id,parse_sse):
    cid=ready_character_id
    s=home(client,cid,'home','shared')
    client.post(f"/api/v1/living/spaces/{s['id']}/members",json={'companion_id':str(cid)})
    client.put(f'/api/v1/characters/{cid}/location',json={'space_id':s['id']})
    p=proposal(client,cid,parse_sse,'下一点小雨')
    r=client.post(f"/api/v1/characters/{cid}/scene/proposals/{p['id']}/confirm")
    assert r.status_code==200,r.text
    assert client.get('/api/v1/living/spaces/'+s['id']).json()['atmosphere']['rain']


def test_atmosphere_receipts_undo_and_scene_restriction(client,ready_character_id):
    s=home(client,ready_character_id)
    rid=str(uuid4()); cmd={'action':'atmosphere','weather':'rain'}
    first=act(client,s,cmd,rid).json()
    assert act(client,s,cmd,rid).json()==first
    quiet=act(client,first,{'action':'atmosphere','weather':'quiet'}).json()
    assert quiet['atmosphere']=={'rain':True,'sound':False}
    undone=act(client,quiet,{'action':'undo'}).json()
    assert undone['atmosphere']==first['atmosphere']
    clear=act(client,undone,{'action':'atmosphere','weather':'clear'}).json()
    assert clear['atmosphere']['rain'] is False
    d=home(client,ready_character_id,'desert')
    assert act(client,d,cmd).status_code==409


def test_v1_state_is_compatible_but_corruption_is_not_repaired(client,ready_character_id):
    s=home(client,ready_character_id)
    with engine.begin() as conn:
        raw=json.loads(conn.execute(select(spaces.c.state_json).where(spaces.c.id==s['id'])).scalar_one())
        raw['schema_version']=1;raw.pop('atmosphere')
        conn.execute(update(spaces).where(spaces.c.id==s['id']).values(state_json=json.dumps(raw)))
    assert client.get('/api/v1/living/spaces/'+s['id']).status_code==200
    with engine.begin() as conn:
        raw.pop('undo')
        conn.execute(update(spaces).where(spaces.c.id==s['id']).values(state_json=json.dumps(raw)))
    r=client.get('/api/v1/living/spaces/'+s['id'])
    assert r.status_code==500 and r.json()['error']['code']=='corrupt_state'


def test_scene_column_migration_is_additive_and_repeatable(tmp_path):
    from app.core.scene_schema import ensure_scene_columns
    e=create_engine('sqlite:///'+str(tmp_path/'old.db'))
    with e.begin() as conn:
        conn.execute(text('CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT)'))
        conn.execute(text("INSERT INTO characters VALUES (7,'保留名字')"))
        conn.execute(text('CREATE TABLE scene_proposals (id TEXT PRIMARY KEY, action TEXT)'))
        conn.execute(text("INSERT INTO scene_proposals VALUES ('p','plant_tree')"))
    ensure_scene_columns(e);ensure_scene_columns(e)
    with e.connect() as conn:
        assert conn.execute(text('SELECT * FROM characters')).one()==(7,'保留名字',0)
        assert conn.execute(text('SELECT * FROM scene_proposals')).one()==('p','plant_tree',None,None,None)
    e.dispose()


def test_inflight_chat_cannot_restore_proposal_after_location_roundtrip(client,ready_character_id,parse_sse,monkeypatch):
    from app.services.model_client import ModelClient
    cid=ready_character_id
    h=home(client,cid);d=home(client,cid,'desert')
    client.put(f'/api/v1/characters/{cid}/location',json={'space_id':h['id']})
    def delayed(self,messages):
        assert '家庭庭院' in messages[0]['content']
        yield '我们一起种树吧。'
        for sid in [d['id'],h['id']]:
            assert client.put(f'/api/v1/characters/{cid}/location',json={'space_id':sid}).status_code==200
    monkeypatch.setattr(ModelClient,'chat_stream',delayed)
    assert proposal(client,cid,parse_sse) is None
    assert scene(client,cid)['proposal'] is None
    assert scene(client,cid)['elements']['tree']==0


def test_import_transaction_rolls_back_on_invalid_source(client,ready_character_id):
    cid=ready_character_id
    with SessionLocal() as db:
        db.add(SceneState(character_id=cid,state_json='{broken'))
        db.commit()
    r=client.post('/api/v1/living/spaces',json={'scene_type':'home','mode':'private','companion_id':str(cid)})
    assert r.status_code==409
    assert client.get('/api/v1/living/spaces').json()==[]
    with SessionLocal() as db:
        assert db.get(SceneImport,cid) is None
        assert db.query(SceneState).filter_by(character_id=cid).one().state_json=='{broken'


def test_new_import_uses_separate_positions_without_moving_existing_items(client,ready_character_id):
    cid=ready_character_id
    for _ in range(3):
        client.post(f'/api/v1/characters/{cid}/scene/actions/plant_tree')
    s=home(client,cid)
    assert len({(i['x'],i['y']) for i in s['items']})==3
    assert [i['x'] for i in s['items']]==[.05,.5,.95]
    old_positions={i['id']:(i['x'],i['y']) for i in s['items']}
    added=client.post(f'/api/v1/characters/{cid}/scene/actions/plant_tree').json()['living']
    assert {i['id']:(i['x'],i['y']) for i in added['items'] if i['id'] in old_positions}==old_positions
    assert len({(i['x'],i['y']) for i in added['items']})==4


def test_deleted_home_cannot_reactivate_the_archived_legacy_writer(client,ready_character_id):
    cid=ready_character_id
    client.post(f'/api/v1/characters/{cid}/scene/actions/plant_tree')
    s=home(client,cid)
    assert client.delete('/api/v1/living/spaces/'+s['id']).status_code==204
    r=client.get(f'/api/v1/characters/{cid}/scene')
    assert r.status_code==409 and r.json()['error']['code']=='scene_required'
    assert client.post(f'/api/v1/characters/{cid}/scene/actions/plant_tree').status_code==409
    new=home(client,cid)
    assert new['items']==[]  # Explicit deletion is not undone by re-importing an archive.
    with SessionLocal() as db:
        assert legacy.deserialize(db.query(SceneState).filter_by(character_id=cid).one().state_json)[0]['tree']==1
