from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select, update
from app.living.seasons import RealSettings, VirtualSettings, project, preferences, receipts
from app.core.database import engine

VIRTUAL = {"mode": "virtual", "weeks": 2, "start_season": "autumn"}


def stamp(year=2026, month=1, day=1, hour=0):
    return int(datetime(year, month, day, hour, tzinfo=ZoneInfo("Asia/Shanghai")).timestamp())


@pytest.mark.parametrize("month,season", [(1,"winter"),(2,"winter"),(3,"spring"),(4,"spring"),(5,"spring"),(6,"summer"),(7,"summer"),(8,"summer"),(9,"autumn"),(10,"autumn"),(11,"autumn"),(12,"winter")])
@pytest.mark.parametrize("hemisphere", ["north", "south"])
def test_months(month, season, hemisphere):
    settings = RealSettings(mode="real", hemisphere=hemisphere)
    result = project(settings, stamp(), 1, stamp(month=month))
    opposite = {"spring":"autumn", "summer":"winter", "autumn":"spring", "winter":"summer"}
    assert result["current_season"] == (opposite[season] if hemisphere == "south" else season)
    assert result["next_change_at"] > result["observed_at"]
    next_result = project(settings, stamp(), 1, result["next_change_at"])
    assert next_result["current_season"] != result["current_season"]


def test_shanghai_month_boundary_and_year():
    config = RealSettings(mode="real", hemisphere="north")
    assert project(config, stamp(), 1, stamp(month=3)-1)["current_season"] == "winter"
    assert project(config, stamp(), 1, stamp(month=3))["current_season"] == "spring"
    assert project(config, stamp(), 1, stamp(month=12))["next_change_at"] == stamp(2027,3)


@pytest.mark.parametrize("weeks", [1,2,4])
def test_virtual_boundaries_and_offline(weeks):
    config = VirtualSettings(mode="virtual", weeks=weeks, start_season="autumn")
    duration = weeks * 7 * 86400
    assert project(config, 100, 1, 99)["current_season"] == "autumn"
    assert project(config, 100, 1, 100+duration-1)["current_season"] == "autumn"
    assert project(config, 100, 1, 100+duration)["current_season"] == "winter"
    assert project(config, 100, 1, 100+duration*101)["current_season"] == "winter"


@pytest.fixture
def url(client, ready_character_id):
    result = client.post('/api/v1/living/spaces', json={"scene_type":"home", "mode":"private", "companion_id":str(ready_character_id)})
    assert result.status_code == 201
    return f'/api/v1/living/spaces/{result.json()["id"]}/season'


def payload(revision=0, settings=None):
    return {"request_id":str(uuid4()), "expected_revision":revision, "settings":settings or VIRTUAL}


def test_empty_preview_save_and_idempotence(client, url, monkeypatch):
    from app.api.living import living_store
    monkeypatch.setattr(living_store, 'clock', lambda: stamp(month=9))
    assert client.get(url).json()["settings"] is None
    preview = client.post(url+'/preview', json={"settings":VIRTUAL})
    assert preview.status_code == 200
    assert preview.json()["current_season"] == "autumn"
    assert client.get(url).json()["revision"] == 0
    p = payload()
    saved = client.put(url, json=p)
    assert saved.status_code == 200
    assert saved.json()["revision"] == 1
    monkeypatch.setattr(living_store, 'clock', lambda: stamp(month=10))
    assert client.put(url,json=p).json() == saved.json()
    assert client.get(url).json()["current_season"] == "spring"
    unchanged = client.put(url,json=payload(1)).json()
    assert unchanged["started_at"] == saved.json()["started_at"]
    assert unchanged["revision"] == 1
    assert client.post(url+'/preview',json={"settings":VIRTUAL}).json()["current_season"] == "spring"
    assert client.put(url,json=payload()).status_code == 409
    p["settings"] = {"mode":"real", "hemisphere":"north"}
    assert client.put(url,json=p).status_code == 409


def test_season_does_not_change_layout_growth_or_undo(client, url):
    from app.living.store import spaces
    sid = url.split('/')[-2]
    response = client.post(url.removesuffix('/season')+'/actions',json={"request_id":str(uuid4()),"expected_revision":0,"command":{"action":"place","kind":"tree","x":0.3,"y":0.4}})
    assert response.status_code == 200
    with engine.connect() as conn:
        before = dict(conn.execute(select(spaces).where(spaces.c.id==sid)).mappings().one())
    assert client.put(url,json=payload()).status_code == 200
    with engine.connect() as conn:
        after = dict(conn.execute(select(spaces).where(spaces.c.id==sid)).mappings().one())
    assert before == after
    engine.dispose()
    assert client.get(url).json()["settings"] == VIRTUAL


@pytest.mark.parametrize("settings", [{"mode":"real"},{"mode":"real","hemisphere":"east"},{"mode":"virtual","weeks":3,"start_season":"spring"},{"mode":"virtual","weeks":"2","start_season":"spring"},{"mode":"real","hemisphere":"north","weeks":2}])
def test_invalid_settings(client, url, settings):
    assert client.put(url,json=payload(settings=settings)).status_code == 422


def test_auth_and_shared_permissions(client, anon, url):
    assert anon.get(url).status_code == 401
    assert client.get('/api/v1/living/spaces/'+str(uuid4())+'/season').status_code == 404
    shared = client.post('/api/v1/living/spaces',json={"scene_type":"forest","mode":"shared"}).json()['id']
    for method,suffix,body in [('get','',None),('post','/preview',{"settings":VIRTUAL}),('put','',payload())]:
        kwargs = {"json":body} if body else {}
        assert getattr(client,method)(f'/api/v1/living/spaces/{shared}/season'+suffix,**kwargs).status_code == 409
    from app.living.store import spaces
    sid=url.split('/')[-2]
    with engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id==sid).values(owner_id='another-user'))
    assert client.get(url).status_code == 404
    assert client.post(url+'/preview',json={"settings":VIRTUAL}).status_code == 404
    assert client.put(url,json=payload()).status_code == 404


def test_corruption_fails_closed_and_delete_cascades(client,url):
    assert client.put(url,json=payload()).status_code == 200
    sid=url.split('/')[-2]
    with engine.begin() as conn:
        conn.execute(update(preferences).where(preferences.c.space_id==sid).values(settings_json='{}'))
    response=client.get(url)
    assert response.status_code == 500 and response.json()['error']['code']=='corrupt_state'
    assert client.delete(url.removesuffix('/season')).status_code == 204
    with engine.connect() as conn:
        assert conn.execute(select(preferences)).first() is None
        assert conn.execute(select(receipts)).first() is None


def test_parallel_saves_use_one_version_and_one_receipt(client, url):
    from concurrent.futures import ThreadPoolExecutor
    p = payload()
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda _: client.put(url, json=p), range(2)))
    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    with engine.connect() as conn:
        assert len(conn.execute(select(receipts)).all()) == 1
    choices = [payload(1, {"mode":"real","hemisphere":"north"}), payload(1, {"mode":"real","hemisphere":"south"})]
    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(lambda choice: client.put(url, json=choice), choices))
    assert sorted(r.status_code for r in responses) == [200, 409]
    assert client.get(url).json()['revision'] == 2


def test_boolean_is_not_a_virtual_period(client, url):
    assert client.put(url, json=payload(settings={"mode":"virtual","weeks":True,"start_season":"spring"})).status_code == 422
