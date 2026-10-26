"""Free, socket-isolated persistence and ownership contracts for real worlds."""
import copy
import json
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.database import engine, SessionLocal
from app.living.gatherings import GatheringStore
from app.living.rules import LivingError
from app.living.store import LivingStore, spaces, receipts
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member
from tests.test_gathering_activity_areas import add_character, by_id, raw_group


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


@pytest.fixture
def shared(ready_character_id):
    store = GatheringStore(engine, lambda: 1_800_000_000)
    group = command(store, create(store), 'visit', character_id=ready_character_id)
    return store, group, ready_character_id


def leisure(store, group, cid, kind, seat=None, uid=UID, **extra):
    return command(store, group, 'leisure', uid=uid, character_id=cid,
                   activity=kind, **({} if seat is None else {'seat_id': seat}), **extra)


@pytest.mark.parametrize('kind,seat', [('tea', 'tea-1'), ('television', 'television-1'), ('mahjong', 'mahjong-0')])
def test_shared_station_roundtrip_stop_and_original_activity(shared, kind, seat):
    store, group, cid = shared
    before = copy.deepcopy(by_id(group, cid))
    group = leisure(store, group, cid, kind, seat)
    actor = by_id(group, cid)
    assert actor['activity'] == before['activity'] and (actor['x'], actor['y']) == (before['x'], before['y'])
    assert actor['leisure'] == dict(activity=kind, seat_id=seat, station_version=1)
    assert actor['area'] == ('indoor' if kind == 'television' else 'outdoor')
    assert GatheringStore(engine, store.clock).read(UID, group['id']) == group
    stopped = leisure(store, group, cid, None)
    assert by_id(stopped, cid) == before


def test_shared_seat_replay_and_stale_revision_are_atomic(shared):
    store, group, cid = shared
    rid = str(uuid4())
    action = dict(action='leisure', character_id=cid, activity='tea', seat_id='tea-1', station_version=1)
    result = store.command(UID, group['id'], rid, group['revision'], action)
    raw = raw_group(group['id'])
    assert store.command(UID, group['id'], rid, group['revision'], action) == result
    assert raw_group(group['id']) == raw
    with pytest.raises(LivingError, match='空间已更新'):
        store.command(UID, group['id'], str(uuid4()), group['revision'], action)
    with pytest.raises(LivingError, match='同一请求'):
        store.command(UID, group['id'], rid, group['revision'], dict(action, seat_id='tea-0'))
    assert raw_group(group['id']) == raw


@pytest.mark.parametrize('kind,seat,extra', [
    ('tea', 'unknown', {}), ('tea', 'television-0', {}), ('bad', None, {}),
    (None, 'tea-1', {}), ('tea', 'tea-1', {'station_version': 2}),
    ('tea', 'tea-1', {'station_version': True}),
])
def test_invalid_shared_station_never_saves(shared, kind, seat, extra):
    store, group, cid = shared
    before = raw_group(group['id'])
    with pytest.raises(LivingError):
        leisure(store, group, cid, kind, seat, **extra)
    assert raw_group(group['id']) == before


def test_shared_owner_only_and_seat_conflict_with_distinct_accounts(shared):
    store, group, cid = shared
    group = member(store, group, 'friend')
    friend = add_character('friend')
    group = command(store, group, 'visit', uid='friend', character_id=friend)
    before = raw_group(group['id'])
    with pytest.raises(LivingError, match='自己的'):
        leisure(store, group, friend, 'tea', 'tea-1')
    assert raw_group(group['id']) == before
    group = leisure(store, group, cid, 'tea', 'tea-1')
    before = raw_group(group['id'])
    with pytest.raises(LivingError, match='座位'):
        leisure(store, group, friend, 'tea', 'tea-1', uid='friend')
    assert raw_group(group['id']) == before
    group = leisure(store, group, friend, 'mahjong', 'mahjong-0', uid='friend')
    assert by_id(group, cid)['leisure']['activity'] == 'tea'
    assert sum(c.get('leisure', {}).get('activity') == 'mahjong' for c in group['companions']) == 1


def test_saved_bench_tea_alias_and_cleanup_are_physical(shared):
    store, group, cid = shared
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    group = command(store, group, 'layout', command=dict(action='place', kind='bench', x=.62375, y=.7596153846153846))
    bench = next(i for i in group['items'] if i['kind'] == 'bench')
    group = leisure(store, group, cid, 'tea', 'tea-0')
    with pytest.raises(LivingError, match='座位'):
        leisure(store, group, second, 'bench', 'bench-' + bench['id'] + '-0')
    group = command(store, group, 'layout', command=dict(action='store', item_id=bench['id']))
    assert 'leisure' not in by_id(group, cid)
    group = leisure(store, group, cid, 'tea', 'tea-1')
    group = command(store, group, 'activity', character_ids=[cid], activity='walk')
    assert 'leisure' not in by_id(group, cid)
    group = leisure(store, group, cid, 'tea', 'tea-1')
    group = command(store, group, 'recall', character_id=cid)
    assert not any(c['id'] == cid for c in group['companions'])


def test_television_respects_the_original_physical_sofa(shared):
    store, group, cid = shared
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    with pytest.raises(LivingError, match='座位'):
        leisure(store, group, second, 'television', 'television-0')
    group = leisure(store, group, second, 'television', 'television-1')
    group = member(store, group, 'friend')
    third = add_character('friend')
    group = command(store, group, 'visit', uid='friend', character_id=third)
    with pytest.raises(LivingError, match='沙发'):
        command(store, group, 'activity', uid='friend', character_ids=[third], activity='rest')


@pytest.mark.parametrize('scene', ['forest', 'desert'])
def test_natural_rest_sleep_capacity_and_station_scope(ready_character_id, scene):
    store = GatheringStore(engine, lambda: 1_800_000_000)
    group = command(store, create(store, scene=scene), 'visit', character_id=ready_character_id)
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    group = command(store, group, 'activity', character_ids=[ready_character_id], activity='sleep')
    before = raw_group(group['id'])
    with pytest.raises(LivingError, match='床位已满'):
        command(store, group, 'activity', character_ids=[second], activity='sleep')
    assert raw_group(group['id']) == before
    assert by_id(group, ready_character_id)['area'] == 'bedroom'
    group = command(store, group, 'activity', character_ids=[ready_character_id, second], activity='rest')
    assert all(c['area'] == 'indoor' for c in group['companions'])
    group = leisure(store, group, second, 'tea', f'natural-{scene}-tea-1')
    assert by_id(group, second)['area'] == 'outdoor'
    with pytest.raises(LivingError):
        leisure(store, group, second, 'television', 'television-1')


@pytest.fixture
def private(client, ready_character_id):
    response = client.post('/api/v1/living/spaces', json=dict(scene_type='home', mode='private', companion_id=str(ready_character_id)))
    assert response.status_code == 201
    return response.json(), ready_character_id


def private_action(client, space, action, **fields):
    return client.post(f"/api/v1/living/spaces/{space['id']}/actions", json=dict(
        request_id=str(uuid4()), expected_revision=space['revision'], command=dict(action=action, **fields)))


def test_private_projection_has_safe_identity_and_scene_bridge(client, private):
    space, cid = private
    assert space['owner_id'] == UID and space['world'] == dict(activity='observe', area='outdoor')
    assert space['resident_here'] is True
    assert space['avatar3d']['kind'] == 'cup'
    assert set(space['avatar3d']) == {'version', 'kind', 'body', 'accent', 'detail', 'seed', 'source'}
    scene = client.get(f'/api/v1/characters/{cid}/scene')
    assert scene.status_code == 200
    assert scene.json()['living']['owner_id'] == UID
    assert scene.json()['living']['avatar3d'] == space['avatar3d']


@pytest.mark.parametrize('activity,area', [('rest', 'indoor'), ('sleep', 'bedroom'), ('walk', 'outdoor'), ('observe', 'outdoor'), ('talk', 'outdoor')])
def test_private_world_activity_durable_without_changing_layout(client, private, activity, area):
    space, _ = private
    response = private_action(client, space, 'world_activity', activity=activity)
    assert response.status_code == 200
    result = response.json()
    assert result['items'] == space['items']
    assert result['world'] == dict(activity=activity, area=area)
    assert client.get(f"/api/v1/living/spaces/{space['id']}").json()['world'] == result['world']
    reopened = LivingStore(engine).read_space(UID, space['id'])
    assert reopened['world'] == result['world']


def test_private_leisure_replay_cleanup_and_no_business_activity_history(client, private):
    space, _ = private
    response = private_action(client, space, 'world_activity', activity='sleep')
    space = response.json()
    rid = str(uuid4())
    payload = dict(request_id=rid, expected_revision=space['revision'], command=dict(action='world_leisure', activity='tea', seat_id='tea-1', station_version=1))
    response = client.post(f"/api/v1/living/spaces/{space['id']}/actions", json=payload)
    assert response.status_code == 200
    result = response.json()
    assert result['world'] == dict(activity='sleep', area='outdoor', leisure=dict(activity='tea', seat_id='tea-1', station_version=1))
    assert client.post(f"/api/v1/living/spaces/{space['id']}/actions", json=payload).json() == result
    assert client.get(f"/api/v1/living/spaces/{space['id']}/activity").json()['events'] == []
    result = private_action(client, result, 'world_leisure', activity=None).json()
    assert result['world'] == dict(activity='sleep', area='bedroom')
    with engine.connect() as conn:
        assert len(conn.execute(select(receipts).where(receipts.c.space_id == space['id'])).all()) == 3


def test_private_legacy_read_never_rewrites_source_or_old_receipt(client, private):
    space, _ = private
    with engine.begin() as conn:
        row = LivingStore._row(conn, UID, space['id'])
        raw = json.loads(row['state_json'])
        raw.pop('world', None)
        original = json.dumps(raw)
        conn.exec_driver_sql('UPDATE living_spaces SET state_json=? WHERE id=?', (original, space['id']))
    assert client.get(f"/api/v1/living/spaces/{space['id']}").json()['world'] == dict(activity='observe', area='outdoor')
    with engine.connect() as conn:
        assert LivingStore._row(conn, UID, space['id'])['state_json'] == original


@pytest.mark.parametrize('extra', [{'station_version': 2}, {'station_version': True}, {'seat_id': 'fake'}, {'seat_id': 'television-1'}, {'actor_id': 99}, {'x': .2}])
def test_private_invalid_leisure_leaves_revision_and_state(client, private, extra):
    space, _ = private
    response = private_action(client, space, 'world_leisure', activity='tea', **extra)
    assert response.status_code in (409, 422)
    assert client.get(f"/api/v1/living/spaces/{space['id']}").json()['revision'] == space['revision']


def test_private_cannot_write_a_shared_space_or_another_account(client, anon, private):
    space, _ = private
    assert anon.get(f"/api/v1/living/spaces/{space['id']}").status_code == 401
    foreign = LivingStore(engine).create_space('other', str(uuid4()), 'home', 'private', '999')
    assert client.get(f"/api/v1/living/spaces/{foreign['id']}").status_code == 404
    response = client.post('/api/v1/living/spaces', json=dict(scene_type='home', mode='shared'))
    assert response.status_code == 201
    assert private_action(client, response.json(), 'world_activity', activity='rest').status_code == 409


def test_private_away_partner_cannot_change_world(client, private):
    space, cid = private
    store = GatheringStore(engine)
    group = create(store)
    command(store, group, 'visit', character_id=cid)
    assert private_action(client, space, 'world_activity', activity='rest').status_code == 409
    assert client.get(f"/api/v1/living/spaces/{space['id']}").json()['resident_here'] is False


def test_private_saved_bench_removal_cleans_overlay_but_preserves_original_activity(client, private):
    space, _ = private
    space = private_action(client, space, 'place', kind='bench', x=.62375, y=.7596153846153846).json()
    bench = next(item for item in space['items'] if item['kind'] == 'bench')
    space = private_action(client, space, 'world_activity', activity='sleep').json()
    space = private_action(client, space, 'world_leisure', activity='tea', seat_id='tea-0').json()
    assert space['world']['leisure']['seat_id'] == 'tea-0'
    space = private_action(client, space, 'store', item_id=bench['id']).json()
    assert space['world'] == dict(activity='sleep', area='bedroom')
    assert any(item['id'] == bench['id'] and item['stored'] for item in space['items'])


def test_old_receipt_is_replayed_without_backfilling_world(client, private):
    space, _ = private
    store = LivingStore(engine)
    rid = str(uuid4())
    action = dict(action='place', kind='flower', x=.2, y=.2)
    result = store.execute(UID, space['id'], rid, space['revision'], action)
    with engine.connect() as conn:
        original = conn.execute(select(receipts.c.result_json).where(receipts.c.space_id == space['id'], receipts.c.request_id == rid)).scalar_one()
    assert 'world' not in result
    store.execute(UID, space['id'], str(uuid4()), result['revision'], dict(action='world_activity', activity='rest'))
    assert store.execute(UID, space['id'], rid, space['revision'], action) == result
    with engine.connect() as conn:
        assert conn.execute(select(receipts.c.result_json).where(receipts.c.space_id == space['id'], receipts.c.request_id == rid)).scalar_one() == original


def test_gathering_http_leisure_schema_and_membership_are_strict(client, anon, shared, monkeypatch):
    store, group, cid = shared
    monkeypatch.setattr('app.api.gatherings.store', store)
    url = f"/api/v1/gatherings/{group['id']}/commands"
    body = dict(request_id=str(uuid4()), expected_revision=group['revision'], command=dict(action='leisure', character_id=cid, activity='mahjong', seat_id='mahjong-0', station_version=1))
    assert anon.post(url, json=body).status_code == 401
    for change in ({'x': .1}, {'character_id': True}, {'station_version': True}, {'station_version': 2}):
        bad = dict(body, command={**body['command'], **change})
        assert client.post(url, json=bad).status_code == 422
    response = client.post(url, json=body)
    assert response.status_code == 200
    assert by_id(response.json(), cid)['leisure']['seat_id'] == 'mahjong-0'
    assert sum(c.get('leisure', {}).get('activity') == 'mahjong' for c in response.json()['companions']) == 1


@pytest.mark.parametrize('scene', ['forest', 'desert'])
def test_private_only_current_residence_has_actor_and_allows_world_actions(client, private, scene):
    home, cid = private
    other = client.post('/api/v1/living/spaces', json=dict(scene_type=scene, mode='private', companion_id=str(cid))).json()
    assert other['resident_here'] is False
    assert private_action(client, other, 'world_activity', activity='sleep').status_code == 409
    changed = client.put(f'/api/v1/characters/{cid}/location', json=dict(space_id=other['id']))
    assert changed.status_code == 200
    assert client.get(f"/api/v1/living/spaces/{home['id']}").json()['resident_here'] is False
    other = client.get(f"/api/v1/living/spaces/{other['id']}").json()
    assert other['resident_here'] is True
    sleeping = private_action(client, other, 'world_activity', activity='sleep')
    assert sleeping.status_code == 200 and sleeping.json()['world']['area'] == 'bedroom'


def test_server_seat_centers_match_version_one_and_refuse_near_distinct_stations(shared):
    from app.living.world_state import seat_positions, station_catalog
    store, group, cid = shared
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    # A separately saved bench is only .1m from the new builtin tea stool.
    group = command(store, group, 'layout', command=dict(action='place', kind='bench', x=.80625, y=.5576923076923077))
    bench = next(item for item in group['items'] if item['kind'] == 'bench')
    positions = seat_positions('home', group['items'])
    assert positions['tea-1'] == (2.35, 4.4)
    group = leisure(store, group, cid, 'tea', 'tea-1')
    before = raw_group(group['id'])
    with pytest.raises(LivingError, match='座位'):
        leisure(store, group, second, 'bench', f"bench-{bench['id']}-0")
    assert raw_group(group['id']) == before
    # A saved bench too close to the table cannot masquerade as a valid tea seat.
    assert 'tea-0' not in station_catalog('home', [dict(id=str(uuid4()), kind='bench', x=.75, y=.75)])


def test_private_free_talk_preserves_its_actual_room_without_starting_dialogue(client, private):
    space, _ = private
    space = private_action(client, space, 'world_activity', activity='sleep').json()
    space = private_action(client, space, 'world_activity', activity='talk').json()
    assert space['world'] == dict(activity='talk', area='bedroom')


def test_forest_existing_bench_can_be_saved_and_used_without_removing_original_kinds(client, private):
    home, cid = private
    space = client.post('/api/v1/living/spaces', json=dict(scene_type='forest', mode='private', companion_id=str(cid))).json()
    assert client.put(f'/api/v1/characters/{cid}/location', json=dict(space_id=space['id'])).status_code == 200
    for kind, x, y in [('tree', .1, .1), ('cushion', .5, .2), ('bench', .85, .8)]:
        response = private_action(client, space, 'place', kind=kind, x=x, y=y)
        assert response.status_code == 200
        space = response.json()
    bench = next(item for item in space['items'] if item['kind'] == 'bench')
    response = private_action(client, space, 'world_leisure', activity='bench', seat_id='natural-forest-bench-' + bench['id'])
    assert response.status_code == 200
    assert {item['kind'] for item in response.json()['items']} == {'tree', 'cushion', 'bench'}
