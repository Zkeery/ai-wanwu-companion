"""Same-database free commands beside retained upstairs records; no network."""
import json
import math
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from app.core.database import engine
from app.living.gatherings import GatheringStore, groups, receipts, visits
from app.living.rules import LivingError
from app.living.villa_floor import VillaFloorStore, floors, journal
from app.models.models import Character
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member
from tests.test_gathering_activity_areas import add_character
from tests.test_villa_floor import checkpoint

OTHER = 'floor-friend'


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*_args, **_kwargs):
        pytest.fail('PARALLEL_FLOOR_NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)


@pytest.fixture
def shared(ready_character_id):
    clock = [1_800_000_000.0]
    store = GatheringStore(engine, lambda: int(clock[0]))
    group = command(store, create(store), 'visit', character_id=ready_character_id)
    second = add_character(UID, '合成一楼伙伴二')
    group = command(store, group, 'visit', character_id=second)
    group = member(store, group, OTHER)
    upstairs = add_character(OTHER, '合成二楼伙伴')
    group = command(store, group, 'visit', uid=OTHER, character_id=upstairs)
    group = command(store, group, 'activity', character_ids=[ready_character_id], activity='sleep')
    for kind in ('tree', 'bench'):
        group = command(store, group, 'layout', command=dict(action='place', kind=kind, x=.3, y=.4))
    tree = next(item['id'] for item in group['items'] if item['kind'] == 'tree')
    bench = next(item['id'] for item in group['items'] if item['kind'] == 'bench')
    group = command(store, group, 'layout', command=dict(action='store', item_id=bench))
    fs = VillaFloorStore(engine, lambda: clock[0])
    state = fs.read(OTHER, 'shared', group['id'])

    def write(current, action, **payload):
        return fs.mutate(OTHER, 'shared', group['id'], str(uuid4()), current['revision'], action, **payload)

    state = write(state, 'command', actor_id=upstairs, activity='sleep')
    viewer = str(uuid4())
    state = write(state, 'claim', viewer=viewer)
    clock[0] += 5
    state = write(state, 'checkpoint', viewer=viewer, applied=1,
                  checkpoint=checkpoint(upstairs, distance=3))
    clock[0] += 5
    cp = checkpoint(upstairs, distance=math.hypot(3.496, 5.73), phase='upper')
    cp['active'] = None
    state = write(state, 'checkpoint', viewer=viewer, applied=1, checkpoint=cp)
    return dict(store=store, fs=fs, group=group, own=ready_character_id, second=second,
                upstairs=upstairs, tree=tree, bench=bench, viewer=viewer, clock=clock, cp=cp)


def floor_row(shared):
    with engine.connect() as conn:
        row = conn.execute(select(floors).where(floors.c.scope == 'shared:' + shared['group']['id'])).mappings().one()
        return dict(row)


def raw_group(shared):
    with engine.connect() as conn:
        return tuple(conn.execute(select(groups.c.revision, groups.c.state_json).where(
            groups.c.id == shared['group']['id'])).one())


def floor_journal(shared):
    with engine.connect() as conn:
        return tuple(conn.execute(select(journal).where(journal.c.scope == 'shared:' + shared['group']['id'])).all())


def business_rows():
    with engine.connect() as conn:
        return {table.name: tuple(conn.execute(select(table)).all())
                for table in (Character.__table__, visits, receipts, groups, floors, journal)}


def assert_floor_progress_unchanged(shared, before, old_journal):
    after = floor_row(shared)
    previous_state, next_state = json.loads(before['state_json']), json.loads(after['state_json'])
    previous_state.pop('fingerprint')
    next_state.pop('fingerprint')
    assert next_state == previous_state
    assert after['revision'] == before['revision']
    assert floor_journal(shared) == old_journal
    assert shared['fs'].read(OTHER, 'shared', shared['group']['id'])['checkpoint'] == shared['cp']


@pytest.mark.parametrize('activity', ['rest', 'sleep', 'walk', 'observe', 'talk'])
def test_first_floor_activity_parallel_to_old_format_upstairs_state_and_idempotent(shared, activity):
    store, group = shared['store'], shared['group']
    before, old_journal, before_group = floor_row(shared), floor_journal(shared), json.loads(raw_group(shared)[1])
    # Preserve unknown historical extensions rather than rewriting the whole record schema.
    state = json.loads(before['state_json'])
    state['historical_extension'] = {'retained': 'original'}
    with engine.begin() as conn:
        conn.execute(update(floors).where(floors.c.scope == before['scope']).values(state_json=json.dumps(state)))
    before = floor_row(shared)
    rid = str(uuid4())
    payload = dict(action='activity', character_ids=[shared['own']], activity=activity)
    result = store.command(UID, group['id'], rid, group['revision'], payload)
    assert next(c for c in result['companions'] if c['id'] == shared['own'])['activity'] == activity
    after_group = json.loads(raw_group(shared)[1])
    assert after_group['layout'] == before_group['layout']
    assert after_group['companions'][str(shared['upstairs'])] == before_group['companions'][str(shared['upstairs'])]
    assert_floor_progress_unchanged(shared, before, old_journal)
    saved = floor_row(shared)
    assert store.command(UID, group['id'], rid, group['revision'], payload) == result
    assert floor_row(shared) == saved
    with engine.connect() as conn:
        assert conn.execute(select(receipts).where(receipts.c.request_id == rid)).first() is not None


@pytest.mark.parametrize('activity', ['tea', None])
def test_first_floor_leisure_keeps_protected_actor_and_floor_lease(shared, activity):
    before, old_journal = floor_row(shared), floor_journal(shared)
    result = command(shared['store'], shared['group'], 'leisure', character_id=shared['second'],
                     activity=activity, seat_id=None, station_version=1)
    actor = next(c for c in result['companions'] if c['id'] == shared['second'])
    assert actor.get('leisure', {}).get('activity') == activity
    assert_floor_progress_unchanged(shared, before, old_journal)


def test_recall_only_nontracked_owned_actor_preserves_upstairs_and_other_owner(shared):
    before, old_journal = floor_row(shared), floor_journal(shared)
    result = command(shared['store'], shared['group'], 'recall', character_id=shared['own'])
    assert shared['own'] not in [c['id'] for c in result['companions']]
    assert shared['upstairs'] in [c['id'] for c in result['companions']]
    assert_floor_progress_unchanged(shared, before, old_journal)


@pytest.mark.parametrize('source', ['targets', 'commands', 'checkpoint', 'returning'])
def test_union_of_all_floor_sources_protects_actor_even_if_other_sources_empty(shared, source):
    row = floor_row(shared)
    state = json.loads(row['state_json'])
    if source == 'targets':
        state['commands'] = []
        state['checkpoint'] = dict(version=1, active=None, states=[])
    elif source == 'commands':
        state['targets'] = {}
        state['commands'] = [dict(seq=1, id=shared['upstairs'], activity='sleep')]
        state['checkpoint'] = dict(version=1, active=None, states=[])
    elif source == 'checkpoint':
        state['targets'] = {}
        state['commands'] = []
    else:
        state['targets'][str(shared['upstairs'])] = None
        cp = checkpoint(shared['upstairs'], distance=.3)
        cp['states'][0]['direction'] = 'down'
        state['checkpoint'] = cp
    with engine.begin() as conn:
        conn.execute(update(floors).where(floors.c.scope == row['scope']).values(state_json=json.dumps(state)))
    before, group_before = floor_row(shared), raw_group(shared)
    with pytest.raises(LivingError):
        command(shared['store'], shared['group'], 'activity', uid=OTHER,
                character_ids=[shared['upstairs']], activity='walk')
    assert floor_row(shared) == before and raw_group(shared) == group_before


@pytest.mark.parametrize('case', ['mixed', 'foreign', 'fake', 'outsider'])
def test_no_mixed_batch_cross_owner_or_forged_actor_bypass(shared, case):
    before, group_before = floor_row(shared), raw_group(shared)
    ids, owner = [shared['own'], shared['upstairs']], UID
    if case == 'foreign':
        ids, owner = [shared['second']], OTHER
    elif case == 'fake':
        ids = [999999]
    elif case == 'outsider':
        ids, owner = [shared['own']], 'not-a-member'
    with pytest.raises(LivingError):
        command(shared['store'], shared['group'], 'activity', uid=owner, character_ids=ids, activity='walk')
    assert floor_row(shared) == before and raw_group(shared) == group_before


def test_stale_original_fingerprint_never_rebound_or_repaired(shared):
    row = floor_row(shared)
    state = json.loads(row['state_json'])
    state['fingerprint'] = '0' * 64
    with engine.begin() as conn:
        conn.execute(update(floors).where(floors.c.scope == row['scope']).values(state_json=json.dumps(state)))
    before, group_before = floor_row(shared), raw_group(shared)
    with pytest.raises(LivingError):
        command(shared['store'], shared['group'], 'activity', character_ids=[shared['own']], activity='walk')
    assert floor_row(shared) == before and raw_group(shared) == group_before


@pytest.mark.parametrize('payload', [
    dict(action='layout', command=dict(action='place', kind='tree', x=.2, y=.2)),
    dict(action='restore_inventory'), dict(action='visit'), dict(action='leave'),
    dict(action='remove', member_id=OTHER), dict(action='propose_dissolve'),
    dict(action='vote', vote_id=str(uuid4()), agree=True),
])
def test_structural_layout_and_membership_mutations_stay_locked(shared, payload):
    payload = dict(payload)
    if payload['action'] == 'restore_inventory':
        payload['item_id'] = shared['bench']
    if payload['action'] == 'visit':
        payload['character_id'] = shared['own']
    before, group_before = floor_row(shared), raw_group(shared)
    with pytest.raises(LivingError, match='下楼'):
        shared['store'].command(UID, shared['group']['id'], str(uuid4()), shared['group']['revision'], payload)
    assert floor_row(shared) == before and raw_group(shared) == group_before


def test_care_only_rebinds_nonphysical_growth_clock_fields(shared):
    before, old_journal = floor_row(shared), floor_journal(shared)
    original = json.loads(raw_group(shared)[1])
    result = command(shared['store'], shared['group'], 'layout',
                     command=dict(action='care', item_id=shared['tree']))
    after = json.loads(raw_group(shared)[1])
    assert after['companions'] == original['companions']
    before_item = original['layout']['items'][shared['tree']]
    after_item = after['layout']['items'][shared['tree']]
    assert after_item['cared_until'] == shared['clock'][0] + 86400
    assert {k: v for k, v in after_item.items() if k not in {'growth_seconds', 'cared_until', 'settled_at'}} == {
        k: v for k, v in before_item.items() if k not in {'growth_seconds', 'cared_until', 'settled_at'}}
    assert next(i for i in result['items'] if i['id'] == shared['tree'])['growth_status'] == 'growing'
    assert_floor_progress_unchanged(shared, before, old_journal)


@pytest.mark.parametrize('mutation', ['layout', 'protected_actor', 'unselected_actor', 'care_geometry', 'floor_progress'])
def test_after_apply_invariant_or_floor_cas_failure_rolls_back_whole_command(shared, monkeypatch, mutation):
    store = shared['store']
    original_apply = store.apply

    def tampered(conn, group, owner, payload, now):
        result = original_apply(conn, group, owner, payload, now)
        if mutation in ('layout', 'care_geometry'):
            group['layout']['items'][shared['tree']]['x'] = .99
        elif mutation == 'protected_actor':
            group['companions'][str(shared['upstairs'])]['activity'] = 'walk'
        elif mutation == 'unselected_actor':
            group['companions'][str(shared['second'])]['activity'] = 'rest'
        else:
            state = json.loads(floor_row(shared)['state_json'])
            state['progress_at'] += 1
            conn.execute(update(floors).where(floors.c.scope == 'shared:' + group['id']).values(state_json=json.dumps(state)))
        return result

    monkeypatch.setattr(store, 'apply', tampered)
    before, group_before, old_journal = floor_row(shared), raw_group(shared), floor_journal(shared)
    payload = dict(action='activity', character_ids=[shared['own']], activity='walk')
    if mutation == 'care_geometry':
        payload = dict(action='layout', command=dict(action='care', item_id=shared['tree']))
    with pytest.raises(LivingError):
        store.command(UID, shared['group']['id'], str(uuid4()), shared['group']['revision'], payload)
    assert floor_row(shared) == before and raw_group(shared) == group_before and floor_journal(shared) == old_journal


@pytest.mark.parametrize('mutation', ['flipped', 'kind', 'stored', 'atmosphere', 'world', 'undo', 'item_identity'])
def test_care_cannot_smuggle_other_physical_or_history_changes(shared, monkeypatch, mutation):
    original = shared['store'].apply

    def tampered(conn, group, owner, payload, now):
        result = original(conn, group, owner, payload, now)
        layout = group['layout']
        item = layout['items'][shared['tree']]
        if mutation == 'flipped':
            item['flipped'] = True
        elif mutation == 'kind':
            item['kind'] = 'flower'
            item['growth_seconds'] = item['cared_until'] = 0
        elif mutation == 'stored':
            item['stored'] = True
        elif mutation == 'atmosphere':
            layout['atmosphere']['rain'] = not layout['atmosphere']['rain']
        elif mutation == 'world':
            layout['world'] = dict(activity='observe', area='outdoor', leisure=None)
        elif mutation == 'undo':
            layout['undo'] = dict(action='move', item_id=shared['tree'], x=.1, y=.2, stored=False)
        else:
            item = layout['items'].pop(shared['tree'])
            item['id'] = str(uuid4())
            layout['items'][item['id']] = item
        return result

    monkeypatch.setattr(shared['store'], 'apply', tampered)
    before = business_rows()
    with pytest.raises(LivingError):
        command(shared['store'], shared['group'], 'layout', command=dict(action='care', item_id=shared['tree']))
    assert business_rows() == before


def test_recall_postcheck_failure_rolls_back_character_visit_event_and_receipt(shared, monkeypatch):
    original = shared['store'].clean_leisure

    def invalid_cleanup(group):
        original(group)
        group['companions'][str(shared['upstairs'])]['activity'] = 'walk'

    monkeypatch.setattr(shared['store'], 'clean_leisure', invalid_cleanup)
    before = business_rows()
    with pytest.raises(LivingError):
        command(shared['store'], shared['group'], 'recall', character_id=shared['own'])
    assert business_rows() == before


def test_floor_checkpoint_and_other_actor_command_serialize_without_lost_progress(shared):
    before = shared['fs'].read(OTHER, 'shared', shared['group']['id'], shared['viewer'])
    shared['clock'][0] += 1

    def progress():
        return shared['fs'].mutate(OTHER, 'shared', shared['group']['id'], str(uuid4()), before['revision'],
                                  'checkpoint', viewer=shared['viewer'], applied=1, checkpoint=shared['cp'])

    def other_activity():
        return command(shared['store'], shared['group'], 'activity',
                       character_ids=[shared['own']], activity='walk')

    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = pool.submit(progress), pool.submit(other_activity)
        assert a.result()['revision'] == before['revision'] + 1
        assert next(c for c in b.result()['companions'] if c['id'] == shared['own'])['activity'] == 'walk'
    final = shared['fs'].read(OTHER, 'shared', shared['group']['id'])
    assert final['checkpoint'] == before['checkpoint'] and final['revision'] == before['revision'] + 1


def test_real_http_activity_contract_saves_once_and_keeps_floor_readable(shared, client, monkeypatch):
    monkeypatch.setattr('app.api.gatherings.store', shared['store'])
    calls = []
    original = shared['store'].command

    def observe(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(shared['store'], 'command', observe)
    before, old_journal = floor_row(shared), floor_journal(shared)
    rid = str(uuid4())
    response = client.post('/api/v1/gatherings/' + shared['group']['id'] + '/commands', json=dict(
        request_id=rid, expected_revision=shared['group']['revision'],
        command=dict(action='activity', character_ids=[shared['own']], activity='walk')))
    assert response.status_code == 200
    assert next(c for c in response.json()['companions'] if c['id'] == shared['own'])['activity'] == 'walk'
    assert len(calls) == 1
    with engine.connect() as conn:
        assert len(conn.execute(select(receipts).where(receipts.c.request_id == rid)).all()) == 1
    assert_floor_progress_unchanged(shared, before, old_journal)
    assert client.get('/api/v1/living/floors/shared/' + shared['group']['id']).status_code == 200
