"""SQLite-only bedroom routing; no model, asset generation, or network work."""
import asyncio
import json
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.database import engine
from app.living.gatherings import GatheringStore, companion_area, memories, receipts
from app.living.gathering_dialogue import grants, tasks, run_exchange
from app.living.gathering_automatic import AutomaticDialogueStore, consume_once, sessions
from app.living.life_provider import RESERVE_MICRO
from app.living.rules import LivingError
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member
from tests.test_gathering_activity_areas import (
    add_character, area_world, by_id, dialogue_pair, raw_group,
)


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


def test_sleep_enters_bedroom_and_survives_reopen_without_changing_yard(area_world):
    store, clock, group, cid = area_world
    group = command(store, group, 'layout', command=dict(action='place', kind='tree', x=.3, y=.4))
    before_items = group['items']
    before_avatar = by_id(group, cid)['avatar3d']
    group = command(store, group, 'activity', character_ids=[cid], activity='sleep')
    companion = by_id(group, cid)
    assert companion['activity'] == 'sleep' and companion['area'] == 'bedroom'
    assert companion['avatar3d'] == before_avatar
    assert group['items'] == before_items
    event = group['events'][-1]
    assert event['activity'] == 'sleep' and event['area'] == 'bedroom'
    assert event['characters'] == [cid] and '在卧室睡觉' in event['message']
    assert '交流' not in event['message'] and '一起' not in event['message']
    reopened = GatheringStore(engine, lambda: clock[0]).read(UID, group['id'])
    assert reopened == group
    assert json.loads(raw_group(group['id'])[1])['companions'][str(cid)]['area'] == 'bedroom'


@pytest.mark.parametrize('activity,area,phrase', [
    ('rest', 'indoor', '在客厅休息'),
    ('walk', 'outdoor', '在院子散步'),
    ('observe', 'outdoor', '在院子观察周围'),
])
def test_owner_can_leave_bedroom_with_an_existing_activity(area_world, activity, area, phrase):
    store, _, group, cid = area_world
    group = command(store, group, 'activity', character_ids=[cid], activity='sleep')
    group = command(store, group, 'activity', character_ids=[cid], activity=activity)
    assert by_id(group, cid)['area'] == area
    assert by_id(group, cid)['activity'] == activity
    assert group['events'][-1]['area'] == area and phrase in group['events'][-1]['message']


def test_sleep_neither_moves_nor_authorizes_a_friends_companion(area_world):
    store, _, group, cid = area_world
    friend = 'sleep-friend'
    group = member(store, group, friend)
    friend_id = add_character(friend)
    group = command(store, group, 'visit', uid=friend, character_id=friend_id)
    friend_before = by_id(group, friend_id).copy()
    group = command(store, group, 'activity', character_ids=[cid], activity='sleep')
    assert by_id(group, friend_id) == friend_before
    before = raw_group(group['id'])
    with pytest.raises(LivingError, match='自己的'):
        command(store, group, 'activity', character_ids=[cid, friend_id], activity='sleep')
    assert raw_group(group['id']) == before


@pytest.mark.parametrize('scene', ['forest', 'desert'])
def test_natural_sleep_enters_explicit_versioned_bedroom_and_reopens(ready_character_id, scene):
    store = GatheringStore(engine, lambda: 1_800_000_000)
    group = create(store, scene=scene)
    group = command(store, group, 'visit', character_id=ready_character_id)
    group = command(store, group, 'activity', character_ids=[ready_character_id], activity='sleep')
    assert by_id(group, ready_character_id)['area'] == 'bedroom'
    assert by_id(group, ready_character_id)['area_origin'] == 'world_v1'
    assert GatheringStore(engine, store.clock).read(UID, group['id']) == group


def test_legacy_sleep_is_only_projected_to_bedroom_without_rewriting_records(area_world):
    store, clock, group, cid = area_world
    with store.transaction() as connection:
        state, revision = store.load(connection, group['id'])
        state['companions'][str(cid)].pop('area')
        state['companions'][str(cid)]['activity'] = 'sleep'
        store.save(connection, state, revision)
    before = raw_group(group['id'])
    snapshot = store.read(UID, group['id'])
    assert by_id(snapshot, cid)['area'] == 'bedroom'
    assert by_id(GatheringStore(engine, lambda: clock[0]).read(UID, group['id']), cid)['area'] == 'bedroom'
    assert snapshot['events'] == group['events'] and raw_group(group['id']) == before
    companion = dict(id=cid, activity='sleep')
    assert companion_area(dict(scene_type='home'), companion) == 'bedroom'
    assert companion == dict(id=cid, activity='sleep')


@pytest.mark.parametrize('scene', ['forest', 'desert'])
def test_nonhome_legacy_sleep_or_bedroom_still_projects_outdoor(scene):
    companion = dict(activity='sleep', area='bedroom')
    assert companion_area(dict(scene_type=scene), companion) == 'outdoor'
    assert companion_area(dict(scene_type=scene), dict(activity='sleep')) == 'outdoor'
    assert companion == dict(activity='sleep', area='bedroom')


@pytest.mark.parametrize('other_activity', ['rest', 'observe'])
def test_talk_rejects_bedroom_mixed_with_other_areas_atomically(area_world, other_activity):
    store, _, group, cid = area_world
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    group = command(store, group, 'activity', character_ids=[cid], activity='sleep')
    group = command(store, group, 'activity', character_ids=[second], activity=other_activity)
    before = raw_group(group['id'])
    with pytest.raises(LivingError) as error:
        command(store, group, 'activity', character_ids=[cid, second], activity='talk')
    assert error.value.code == 'area_mismatch' and raw_group(group['id']) == before


def test_bedroom_talk_stays_inside_and_does_not_invent_other_area_participants(area_world):
    store, _, group, cid = area_world
    friend = 'sleep-friend'
    group = member(store, group, friend)
    friend_id = add_character(friend)
    group = command(store, group, 'visit', uid=friend, character_id=friend_id)
    group = command(store, group, 'activity', uid=friend, character_ids=[friend_id], activity='talk')
    friend_before = by_id(group, friend_id).copy()
    group = command(store, group, 'activity', character_ids=[cid], activity='sleep')
    group = command(store, group, 'activity', character_ids=[cid], activity='talk')
    assert by_id(group, cid)['area'] == 'bedroom'
    assert group['events'][-1]['characters'] == [cid]
    assert '在卧室准备交流' in group['events'][-1]['message']
    assert by_id(group, friend_id) == friend_before
    second = add_character()
    group = command(store, group, 'visit', character_id=second)
    group = command(store, group, 'activity', character_ids=[second], activity='sleep')
    group = command(store, group, 'activity', character_ids=[cid, second], activity='talk')
    event = group['events'][-1]
    assert event['area'] == 'bedroom' and set(event['characters']) == {cid, second}
    assert '在卧室一起聊' in event['message'] and friend_id not in event['characters']


def test_sleep_replay_preserves_receipt_and_has_no_duplicate_events(area_world):
    store, _, group, cid = area_world
    request = str(uuid4())
    action = dict(action='activity', character_ids=[cid], activity='sleep')
    result = store.command(UID, group['id'], request, group['revision'], action)
    before = raw_group(group['id'])
    with engine.connect() as connection:
        receipt = connection.execute(select(receipts.c.result_json).where(
            receipts.c.owner_id == UID, receipts.c.request_id == request)).scalar_one()
    assert store.command(UID, group['id'], request, group['revision'], action) == result
    assert raw_group(group['id']) == before
    with engine.connect() as connection:
        assert connection.execute(select(receipts.c.result_json).where(
            receipts.c.owner_id == UID, receipts.c.request_id == request)).scalar_one() == receipt
    with pytest.raises(LivingError) as error:
        store.command(UID, group['id'], request, group['revision'], dict(action, activity='rest'))
    assert error.value.code == 'conflict' and raw_group(group['id']) == before


def test_stale_sleep_command_cannot_overwrite_a_newer_owner_action(area_world):
    store, _, group, cid = area_world
    revision = group['revision']
    group = command(store, group, 'activity', character_ids=[cid], activity='rest')
    before = raw_group(group['id'])
    with pytest.raises(LivingError) as error:
        store.command(UID, group['id'], str(uuid4()), revision,
                      dict(action='activity', character_ids=[cid], activity='sleep'))
    assert error.value.code == 'conflict' and raw_group(group['id']) == before


def test_sleep_keeps_competition_exclusion(area_world, monkeypatch):
    store, _, group, cid = area_world
    monkeypatch.setattr('app.living.competitions.character_competing', lambda *_: True)
    before = raw_group(group['id'])
    with pytest.raises(LivingError, match='比赛'):
        command(store, group, 'activity', character_ids=[cid], activity='sleep')
    assert raw_group(group['id']) == before


@pytest.mark.parametrize('scene', ['home', 'forest', 'desert'])
def test_authenticated_activity_api_accepts_all_three_existing_dwelling_bedrooms(client, ready_character_id, scene):
    store = GatheringStore(engine)
    group = create(store, scene=scene)
    group = command(store, group, 'visit', character_id=ready_character_id)
    response = client.post(f"/api/v1/gatherings/{group['id']}/commands", json=dict(
        request_id=str(uuid4()), expected_revision=group['revision'],
        command=dict(action='activity', character_ids=[ready_character_id], activity='sleep')))
    assert response.status_code == 200
    assert by_id(response.json(), ready_character_id)['area'] == 'bedroom'


def test_bedroom_dialogue_facts_do_not_invent_outdoor_items(area_world):
    store, _, group, ids = dialogue_pair(area_world)
    group = command(store, group, 'layout', command=dict(action='place', kind='tree', x=.3, y=.4))
    group = command(store, group, 'activity', character_ids=ids, activity='sleep')
    with store.transaction() as connection:
        state, _ = store.load(connection, group['id'])
        facts = store.facts(connection, state, UID, ids)
    assert facts['scene'] == 'home' and facts['area'] == 'bedroom' and facts['area_label'] == '卧室'
    assert facts['items'] == [] and group['items']
    assert [person['character_id'] for person in facts['participants']] == ids


def test_bedroom_separation_refuses_dialogue_before_grant_or_task_mutation(area_world):
    store, _, group, ids = dialogue_pair(area_world)
    grant = store.authorize(UID, group['id'], ids, 'synthetic-sleep-once')
    group = command(store, group, 'activity', character_ids=[ids[0]], activity='sleep')
    with pytest.raises(LivingError, match='不同区域'):
        store.prepare(UID, group['id'], str(uuid4()), group['revision'], ids, grant)
    with engine.connect() as connection:
        assert connection.execute(select(grants.c.used).where(grants.c.id == grant)).scalar_one() == 0
        assert connection.execute(select(tasks)).all() == []


@pytest.mark.parametrize('other_activity', ['rest', 'observe'])
def test_automatic_bedroom_separation_stops_before_any_provider_work(area_world, other_activity):
    _, clock, group, ids = dialogue_pair(area_world)
    store = AutomaticDialogueStore(engine, lambda: clock[0])
    session = store.authorize_session(UID, group['id'], ids, 2, 'synthetic-sleep-auto',
                                      project_cap_micro=2 * RESERVE_MICRO, space_cap_micro=2 * RESERVE_MICRO)
    store.configure(UID, group['id'], str(uuid4()), store.status(UID, group['id'])['revision'], True, session)
    group = command(store, group, 'activity', character_ids=[ids[0]], activity='sleep')
    group = command(store, group, 'activity', character_ids=[ids[1]], activity=other_activity)
    calls = []

    def provider_factory():
        calls.append('provider')
        pytest.fail('cross-room automatic work must stop before provider creation')

    async def catalog():
        calls.append('catalog')
        pytest.fail('cross-room automatic work must stop before catalog work')

    asyncio.run(consume_once(store, provider_factory, catalog))
    assert calls == []
    status = store.status(UID, group['id'])
    assert not status['enabled'] and status['stop_reason'] == 'permission_changed'
    with engine.connect() as connection:
        row = connection.execute(select(sessions).where(sessions.c.id == session)).mappings().one()
        assert row['used_rounds'] == 0 and row['stopped'] == 1
        assert connection.execute(select(tasks)).all() == []


@pytest.mark.parametrize('automatic', [False, True], ids=['manual', 'automatic'])
def test_new_dialogue_events_keep_fact_area_without_backfilling_legacy_events(area_world, automatic):
    """Synthetic adapters exercise publication, not a real provider/model acceptance."""
    store, clock, group, ids = dialogue_pair(area_world)
    if automatic:
        store = AutomaticDialogueStore(engine, lambda: clock[0])
    group = command(store, group, 'activity', character_ids=ids, activity='sleep')
    with store.transaction() as connection:
        state, revision = store.load(connection, group['id'])
        store.event(connection, state, '合成历史交流', clock[0] - 1, kind='dialogue',
                    characters=ids, origin='real_provider', audience=list(state['members']),
                    lines=[dict(character_id=cid, name=by_id(group, cid)['name'],
                                text='这是过去的交流。', item_ids=[]) for cid in ids])
        legacy_event = state['events'][-1].copy()
        store.save(connection, state, revision)
        legacy_memory = connection.execute(select(memories.c.event_json).where(
            memories.c.owner_id == UID, memories.c.event_id == legacy_event['id'])).scalar_one()
    calls = []

    class SyntheticClient:
        async def exchange(self, facts):
            calls.append(facts['area'])
            return dict(lines=[dict(character_id=cid, text='这是同区的合成交流。', item_ids=[]) for cid in ids])

    async def catalog():
        return dict(verified=True)

    if automatic:
        session = store.authorize_session(UID, group['id'], ids, 1, 'synthetic-bubble-auto',
                                          project_cap_micro=RESERVE_MICRO, space_cap_micro=RESERVE_MICRO)
        store.configure(UID, group['id'], str(uuid4()), store.status(UID, group['id'])['revision'], True, session)
        asyncio.run(consume_once(store, SyntheticClient, catalog))
    else:
        grant = store.authorize(UID, group['id'], ids, 'synthetic-bubble-manual')
        task, fresh = store.prepare(UID, group['id'], str(uuid4()), group['revision'], ids, grant)
        assert fresh
        asyncio.run(run_exchange(store, task, SyntheticClient, catalog))
    snapshot = GatheringStore(engine, lambda: clock[0]).read(UID, group['id'])
    new_event = snapshot['events'][-1]
    assert calls == ['bedroom'] and new_event['kind'] == 'dialogue'
    assert new_event['origin'] == 'real_provider' and new_event['area'] == 'bedroom'
    assert [line['character_id'] for line in new_event['lines']] == ids
    assert 'audience' not in new_event  # The snapshot retains existing recipient filtering.
    assert next(event for event in snapshot['events'] if event['id'] == legacy_event['id']) == {
        key: value for key, value in legacy_event.items() if key != 'audience'}
    with engine.connect() as connection:
        assert connection.execute(select(memories.c.event_json).where(
            memories.c.owner_id == UID, memories.c.event_id == legacy_event['id'])).scalar_one() == legacy_memory
        saved_event = json.loads(connection.execute(select(memories.c.event_json).where(
            memories.c.owner_id == UID, memories.c.event_id == new_event['id'])).scalar_one())
        assert saved_event['area'] == 'bedroom'
