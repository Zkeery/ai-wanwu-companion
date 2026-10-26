"""SQLite-only room routing; all model/network boundaries are forbidden."""
import asyncio
import json
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from app.core.database import engine, SessionLocal
from app.living.gatherings import GatheringStore, companion_area, groups, receipts
from app.living.gathering_dialogue import DialogueStore, grants, tasks
from app.living.gathering_automatic import AutomaticDialogueStore, consume_once, sessions
from app.living.life_provider import RESERVE_MICRO
from app.living.rules import LivingError
from app.models.models import Character, Object, Photo, User
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


def add_character(owner=UID, name='合成区域伙伴'):
    with SessionLocal() as db:
        if db.get(User, owner) is None:
            db.add(User(id=owner, phone='18900000009'))
            db.flush()
        photo = Photo(filename='synthetic-area.png', status='done', owner_id=owner)
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label='合成杯子')
        db.add(obj)
        db.flush()
        character = Character(object_id=obj.id, owner_id=owner, name=name,
                              persona='合成测试', opening_line='', status='ready')
        db.add(character)
        db.commit()
        return character.id


@pytest.fixture
def area_world(ready_character_id):
    clock = [1_800_000_000]
    store = GatheringStore(engine, lambda: clock[0])
    group = create(store)
    group = command(store, group, 'visit', character_id=ready_character_id)
    return store, clock, group, ready_character_id


def raw_group(gid):
    with engine.connect() as connection:
        row = connection.execute(select(groups).where(groups.c.id == gid)).mappings().one()
        return row['revision'], row['state_json']


def by_id(snapshot, cid):
    return next(c for c in snapshot['companions'] if c['id'] == cid)


def test_rest_enters_living_room_and_survives_reopen(area_world):
    store, clock, group, cid = area_world
    assert by_id(group, cid)['area'] == 'outdoor'
    assert group['events'][-1]['area'] == 'outdoor'
    before_avatar = by_id(group, cid)['avatar3d']
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    assert by_id(group, cid)['area'] == 'indoor'
    assert (by_id(group, cid)['x'], by_id(group, cid)['y']) == (.35, .65)
    event = group['events'][-1]
    assert event['area'] == 'indoor' and '在客厅休息' in event['message']
    assert by_id(group, cid)['avatar3d'] == before_avatar
    reopened = GatheringStore(engine, lambda: clock[0]).read(UID, group['id'])
    assert reopened == group
    assert json.loads(raw_group(group['id'])[1])['companions'][str(cid)]['area'] == 'indoor'


@pytest.mark.parametrize('activity,phrase', [('walk', '在院子散步'), ('observe', '在院子观察周围')])
def test_walk_observe_return_to_courtyard(area_world, activity, phrase):
    store, _, group, cid = area_world
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    group = command(store, group, 'activity', character_ids=[cid], activity=activity)
    assert by_id(group, cid)['area'] == 'outdoor'
    assert (by_id(group, cid)['x'], by_id(group, cid)['y']) == (.65, .55)
    assert group['events'][-1]['area'] == 'outdoor' and phrase in group['events'][-1]['message']


def test_owner_cannot_move_friend_or_change_friend_area(area_world):
    store, _, group, cid = area_world
    friend = 'area-friend'
    group = member(store, group, friend)
    friend_id = add_character(friend)
    group = command(store, group, 'visit', uid=friend, character_id=friend_id)
    friend_before = by_id(group, friend_id).copy()
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    assert by_id(group, friend_id) == friend_before
    before = raw_group(group['id'])
    with pytest.raises(LivingError):
        command(store, group, 'activity', character_ids=[cid, friend_id], activity='rest')
    assert raw_group(group['id']) == before


def test_mixed_area_talk_joins_a_common_area_once(area_world):
    store, _, group, cid = area_world
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    before = raw_group(group['id'])
    with engine.connect() as connection:
        receipt_count = len(connection.execute(select(receipts)).all())
    group = command(store, group, 'activity', character_ids=[cid, second], activity='talk')
    assert {by_id(group, i)['area'] for i in [cid, second]} == {'outdoor'}
    assert set(group['events'][-1]['characters']) == {cid, second}
    assert raw_group(group['id'])[0] == before[0] + 1
    with engine.connect() as connection:
        assert len(connection.execute(select(receipts)).all()) == receipt_count + 1


def test_talk_joins_opted_in_peer_without_changing_friend(area_world):
    store, _, group, cid = area_world
    friend = 'area-friend'
    group = member(store, group, friend)
    friend_id = add_character(friend)
    group = command(store, group, 'visit', uid=friend, character_id=friend_id)
    group = command(store, group, 'activity', uid=friend, character_ids=[friend_id], activity='talk')
    friend_before = by_id(group, friend_id).copy()
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    group = command(store, group, 'activity', character_ids=[cid], activity='talk')
    assert by_id(group, cid)['area'] == 'outdoor'
    assert set(group['events'][-1]['characters']) == {cid, friend_id}
    assert group['events'][-1]['area'] == 'outdoor'
    assert by_id(group, friend_id) == friend_before
    group = command(store, group, 'activity', character_ids=[cid], activity='walk')
    group = command(store, group, 'activity', character_ids=[cid], activity='talk')
    assert set(group['events'][-1]['characters']) == {cid, friend_id}
    assert group['events'][-1]['area'] == 'outdoor'
    assert by_id(group, friend_id) == friend_before


def test_new_area_request_replays_once_without_duplicate_events(area_world):
    store, _, group, cid = area_world
    request = str(uuid4())
    action = dict(action='activity', character_ids=[cid], activity='rest')
    first = store.command(UID, group['id'], request, group['revision'], action)
    after = raw_group(group['id'])
    assert store.command(UID, group['id'], request, group['revision'], action) == first
    assert raw_group(group['id']) == after


@pytest.mark.parametrize('activity,area', [('rest', 'indoor'), ('walk', 'outdoor'), ('talk', 'outdoor')])
def test_legacy_area_is_snapshot_only_and_does_not_rewrite_history(area_world, activity, area):
    store, clock, group, cid = area_world
    with store.transaction() as connection:
        state, revision = store.load(connection, group['id'])
        state['companions'][str(cid)].pop('area')
        state['companions'][str(cid)]['activity'] = activity
        store.save(connection, state, revision)
    before = raw_group(group['id'])
    snapshot = store.read(UID, group['id'])
    assert by_id(snapshot, cid)['area'] == area
    assert by_id(GatheringStore(engine, lambda: clock[0]).read(UID, group['id']), cid)['area'] == area
    assert raw_group(group['id']) == before
    assert snapshot['events'] == group['events']


@pytest.mark.parametrize('scene', ['forest', 'desert'])
def test_new_natural_indoor_rest_and_legacy_indoor_projection_stay_distinct(ready_character_id, scene):
    store = GatheringStore(engine, lambda: 1_800_000_000)
    group = create(store, scene=scene)
    group = command(store, group, 'visit', character_id=ready_character_id)
    group = command(store, group, 'activity', character_ids=[ready_character_id], activity='rest')
    assert by_id(group, ready_character_id)['area'] == 'indoor'
    assert group['events'][-1]['area'] == 'indoor' and '休息间' in group['events'][-1]['message']
    with store.transaction() as connection:
        state, revision = store.load(connection, group['id'])
        state['companions'][str(ready_character_id)]['area'] = 'indoor'
        state['companions'][str(ready_character_id)].pop('area_origin')
        store.save(connection, state, revision)
    before = raw_group(group['id'])
    assert by_id(store.read(UID, group['id']), ready_character_id)['area'] == 'outdoor'
    assert raw_group(group['id']) == before


def dialogue_pair(area_world):
    _, clock, group, cid = area_world
    store = DialogueStore(engine, lambda: clock[0])
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    for id in [cid, second]:
        group = command(store, group, 'dialogue_consent', character_id=id, enabled=True)
    group = command(store, group, 'dialogue_space', enabled=True)
    return store, clock, group, [cid, second]


def test_dialogue_cross_area_rejected_before_consuming_grant_or_task(area_world):
    store, _, group, ids = dialogue_pair(area_world)
    grant = store.authorize(UID, group['id'], ids, 'synthetic-area-once')
    group = command(store, group, 'activity', character_ids=[ids[0]], activity='rest')
    with pytest.raises(LivingError, match='不同区域'):
        store.prepare(UID, group['id'], str(uuid4()), group['revision'], ids, grant)
    with engine.connect() as connection:
        assert connection.execute(select(grants.c.used).where(grants.c.id == grant)).scalar_one() == 0
        assert connection.execute(select(tasks)).all() == []


def test_dialogue_indoor_facts_do_not_invent_courtyard_furniture(area_world):
    store, _, group, ids = dialogue_pair(area_world)
    group = command(store, group, 'layout', command=dict(action='place', kind='tree', x=.3, y=.4))
    with store.transaction() as connection:
        state, _ = store.load(connection, group['id'])
        outdoor = store.facts(connection, state, UID, ids)
    assert outdoor['area'] == 'outdoor' and outdoor['area_label'] == '院子' and outdoor['items']
    group = command(store, group, 'activity', character_ids=ids, activity='rest')
    with store.transaction() as connection:
        state, _ = store.load(connection, group['id'])
        indoor = store.facts(connection, state, UID, ids)
    assert indoor['area'] == 'indoor' and indoor['area_label'] == '客厅' and indoor['items'] == []
    assert group['items']  # Only prompt visibility changes; the saved yard is intact.


def test_automatic_stops_after_area_separation_without_a_provider_call(area_world):
    _, clock, group, ids = dialogue_pair(area_world)
    store = AutomaticDialogueStore(engine, lambda: clock[0])
    session = store.authorize_session(UID, group['id'], ids, 2, 'synthetic-area-auto',
                                      project_cap_micro=2 * RESERVE_MICRO, space_cap_micro=2 * RESERVE_MICRO)
    store.configure(UID, group['id'], str(uuid4()), store.status(UID, group['id'])['revision'], True, session)
    group = command(store, group, 'activity', character_ids=[ids[0]], activity='rest')
    calls = []

    def provider_factory():
        calls.append('provider')
        pytest.fail('area mismatch must stop before creating a provider')

    async def catalog():
        calls.append('catalog')
        pytest.fail('area mismatch must stop before catalog/model work')

    asyncio.run(consume_once(store, provider_factory, catalog))
    assert calls == []
    status = store.status(UID, group['id'])
    assert status['enabled'] is False and status['stop_reason'] == 'permission_changed'
    with engine.connect() as connection:
        row = connection.execute(select(sessions).where(sessions.c.id == session)).mappings().one()
        assert row['used_rounds'] == 0 and row['stopped'] == 1
        assert connection.execute(select(tasks)).all() == []


def test_legacy_idempotency_receipt_remains_byte_identical(area_world):
    store, _, group, cid = area_world
    request = str(uuid4())
    action = dict(action='activity', character_ids=[cid], activity='rest')
    current = store.command(UID, group['id'], request, group['revision'], action)
    legacy = json.loads(json.dumps(current))
    for c in legacy['companions']:
        c.pop('area', None)
    encoded = json.dumps(legacy, ensure_ascii=False)
    with store.transaction() as connection:
        connection.execute(update(receipts).where(receipts.c.owner_id == UID,
                                                  receipts.c.request_id == request).values(result_json=encoded))
    state_before = raw_group(group['id'])
    assert store.command(UID, group['id'], request, group['revision'], action) == legacy
    with engine.connect() as connection:
        assert connection.execute(select(receipts.c.result_json).where(
            receipts.c.owner_id == UID, receipts.c.request_id == request)).scalar_one() == encoded
    assert raw_group(group['id']) == state_before


def test_area_projection_helper_never_modifies_input():
    c = dict(id=1, activity='rest')
    assert companion_area(dict(scene_type='home'), c) == 'indoor'
    assert c == dict(id=1, activity='rest')
