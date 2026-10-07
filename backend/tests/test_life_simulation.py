from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from pydantic import ValidationError
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.database import engine
from app.living import life_simulation as life
from app.living.store import spaces


def stamp(day=1, hour=12, minute=0):
    return int(datetime(2026, 9, day, hour, minute, tzinfo=ZoneInfo('Asia/Shanghai')).timestamp())


@pytest.fixture
def setup(client, ready_character_id, monkeypatch):
    settings = get_settings()
    monkeypatch.setattr(settings, 'app_env', 'test')
    monkeypatch.setattr(settings, 'life_simulation_enabled', True)
    life.metadata.drop_all(engine)
    life.metadata.create_all(engine)
    from app.api.living import living_store
    clock = [stamp()]
    monkeypatch.setattr(living_store, 'clock', lambda: clock[0])
    r = client.post('/api/v1/living/spaces', json={'scene_type':'forest','mode':'private','companion_id':str(ready_character_id)})
    assert r.status_code == 201
    sid = r.json()['id']
    assert client.put(f'/api/v1/characters/{ready_character_id}/location', json={'space_id':sid}).status_code == 200
    yield f'/api/v1/living/spaces/{sid}/life-simulation', clock, ready_character_id
    life.metadata.drop_all(engine)


def settings_request(enabled=True, activities=None, revision=0):
    return {'request_id':str(uuid4()),'expected_revision':revision,
            'settings':{'enabled':enabled,'activities':activities if activities is not None else ['rest','walk','observe']}}


def step(client, url, source='viewing', rid=None):
    r = client.post(url+'/step',json={'request_id':rid or str(uuid4()),'source':source})
    assert r.status_code == 200, r.text
    return r.json()


def test_default_read_does_not_run_and_paused_step(client, setup):
    url, _, _ = setup
    for _ in range(3):
        r = client.get(url).json()
        assert r['settings'] == {'enabled':False,'activities':[]} and r['events'] == []
    assert step(client,url)['outcome'] == 'paused'
    with engine.connect() as conn:
        assert conn.execute(select(life.events)).first() is None


def test_save_repeat_conflict_and_pause_keeps_interval(client, setup):
    url, clock, _ = setup
    p = settings_request()
    r = client.put(url,json=p)
    assert r.status_code == 200
    assert client.put(url,json=p).json() == r.json()
    assert client.put(url,json=settings_request()).status_code == 409
    p['settings']['enabled'] = False
    assert client.put(url,json=p).status_code == 409
    assert step(client,url)['outcome'] == 'executed'
    assert client.put(url,json=settings_request(False,revision=1)).status_code == 200
    assert step(client,url)['outcome'] == 'paused'
    assert client.put(url,json=settings_request(revision=2)).status_code == 200
    assert step(client,url)['outcome'] == 'cooldown'
    clock[0] += 599
    assert step(client,url)['outcome'] == 'cooldown'
    clock[0] += 1
    assert step(client,url)['outcome'] == 'executed'


def test_day_cycle_offline_limit_restart_and_clock_rollback(client, setup):
    url, clock, _ = setup
    client.put(url,json=settings_request())
    assert step(client,url,'offline')['outcome'] == 'executed'
    clock[0] += 600
    assert step(client,url,'offline')['outcome'] == 'executed'
    clock[0] += 600
    assert step(client,url,'offline')['outcome'] == 'offline_limit'
    engine.dispose()
    assert len(client.get(url).json()['events']) == 2
    clock[0] = stamp(hour=11)
    assert step(client,url)['outcome'] == 'cooldown'
    clock[0] = stamp(hour=22)
    assert step(client,url)['events'][0]['activity'] == 'rest'
    clock[0] = stamp(day=2,hour=0)
    assert step(client,url,'offline')['outcome'] == 'executed'
    clock[0] += 600
    assert step(client,url,'offline')['outcome'] == 'executed'
    clock[0] += 600
    assert step(client,url,'offline')['outcome'] == 'offline_limit'


def test_no_target_or_unauthorized_night_activity_does_not_create_event(client, setup):
    url, clock, _ = setup
    client.put(url,json=settings_request(activities=['observe']))
    assert step(client,url)['outcome'] == 'no_allowed_activity'
    clock[0] = stamp(hour=23)
    client.put(url,json=settings_request(activities=['walk'],revision=1))
    assert step(client,url)['outcome'] == 'no_allowed_activity'
    assert client.get(url).json()['events'] == []


def test_plan_whitelist_and_stored_item_rejection():
    from app.living.rules import State, LivingError
    state = State(last_write_at=1)
    with pytest.raises(ValidationError):
        life.Plan(activity='delete', command='anything')
    with pytest.raises(LivingError):
        life.validate_plan(life.Plan(activity='observe',target_id='missing'),life.Settings(enabled=True,activities=['observe']),state)
    with pytest.raises(LivingError):
        life.validate_plan(life.Plan(activity='walk'),life.Settings(enabled=True,activities=['rest']),state)


def test_observe_actual_item_season_and_unchanged_scene(client, setup):
    url, clock, _ = setup
    base=url.removesuffix('/life-simulation'); sid=base.split('/')[-1]
    placed=client.post(base+'/actions',json={'request_id':str(uuid4()),'expected_revision':0,'command':{'action':'place','kind':'tree','x':0.3,'y':0.5}}).json()
    item=placed['items'][0]['id']
    client.put(base+'/season',json={'request_id':str(uuid4()),'expected_revision':0,'settings':{'mode':'virtual','weeks':1,'start_season':'autumn'}})
    client.put(url,json=settings_request(activities=['observe']))
    with engine.connect() as conn:
        before=dict(conn.execute(select(spaces).where(spaces.c.id==sid)).mappings().one())
    event=step(client,url)['events'][0]
    assert event['activity']=='observe' and event['target_id']==item and event['season']=='autumn'
    with engine.connect() as conn:
        assert dict(conn.execute(select(spaces).where(spaces.c.id==sid)).mappings().one()) == before
    client.post(base+'/actions',json={'request_id':str(uuid4()),'expected_revision':1,'command':{'action':'store','item_id':item}})
    clock[0]+=600
    assert step(client,url)['outcome']=='no_allowed_activity'
    clock[0]+=7*86400
    client.post(base+'/actions',json={'request_id':str(uuid4()),'expected_revision':2,'command':{'action':'restore','item_id':item,'x':0.4,'y':0.5}})
    assert step(client,url)['events'][0]['season']=='winter'


def test_same_and_different_concurrent_requests(client, setup):
    url,clock,_=setup
    client.put(url,json=settings_request())
    rid=str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:step(client,url,rid=rid),range(2)))
    assert results[0]==results[1] and len(results[0]['events'])==1
    clock[0] += 600
    with ThreadPoolExecutor(max_workers=2) as pool:
        results=list(pool.map(lambda _:step(client,url),range(2)))
    assert sorted(r['outcome'] for r in results)==['cooldown','executed']
    assert len(client.get(url).json()['events'])==2
    assert client.post(url+'/step',json={'request_id':rid,'source':'offline'}).status_code==409


def test_auth_away_shared_and_disabled_environment(client,anon,setup,monkeypatch):
    url,_,cid=setup
    assert anon.get(url).status_code==401
    client.put(url,json=settings_request())
    other=client.post('/api/v1/living/spaces',json={'scene_type':'desert','mode':'private','companion_id':str(cid)}).json()['id']
    client.put(f'/api/v1/characters/{cid}/location',json={'space_id':other})
    assert step(client,url)['outcome']=='away'
    shared=client.post('/api/v1/living/spaces',json={'scene_type':'home','mode':'shared'}).json()['id']
    assert client.get(f'/api/v1/living/spaces/{shared}/life-simulation').status_code==409
    sid=url.split('/')[-2]
    with engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id==sid).values(owner_id='someone-else'))
    assert client.get(url).status_code==404
    assert client.put(url,json=settings_request()).status_code==404
    assert client.post(url+'/step',json={'request_id':str(uuid4()),'source':'viewing'}).status_code==404
    for mode in ['development','production']:
        monkeypatch.setattr(get_settings(),'app_env',mode)
        assert client.get(url).status_code==404
    monkeypatch.setattr(get_settings(),'app_env','test')
    monkeypatch.setattr(get_settings(),'life_simulation_enabled',False)
    assert client.get(url).status_code==404


@pytest.mark.parametrize('settings',[{'enabled':True,'activities':[]},{'enabled':'true','activities':['rest']},{'enabled':True,'activities':['rest','rest']},{'enabled':True,'activities':['water']},{'enabled':True,'activities':['rest'],'budget':1}])
def test_invalid_settings(client,setup,settings):
    url,_,_=setup
    p=settings_request();p['settings']=settings
    assert client.put(url,json=p).status_code==422


def test_corrupt_state_and_no_client_clock(client,setup):
    url,_,_=setup;sid=url.split('/')[-2]
    client.put(url,json=settings_request())
    assert client.post(url+'/step',json={'request_id':str(uuid4()),'source':'viewing','now':stamp(day=2)}).status_code==422
    with engine.begin() as conn:
        conn.execute(update(life.preferences).where(life.preferences.c.space_id==sid).values(settings_json='{}'))
    assert client.get(url).status_code==500


def test_failed_receipt_rolls_back_event_and_can_retry_same_request(client,setup,monkeypatch):
    from sqlalchemy.exc import SQLAlchemyError
    url,_,_=setup
    client.put(url,json=settings_request())
    original=life.finish
    def fail(*args,**kwargs):
        raise SQLAlchemyError('simulated storage failure')
    rid=str(uuid4())
    monkeypatch.setattr(life,'finish',fail)
    r=client.post(url+'/step',json={'request_id':rid,'source':'viewing'})
    assert r.status_code==503
    assert client.get(url).json()['events']==[]
    monkeypatch.setattr(life,'finish',original)
    assert step(client,url,rid=rid)['outcome']=='executed'
