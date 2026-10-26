"""Real SQL transactions, free commands, safe owner projection, crash recovery."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from app.core.database import engine
from app.living.gatherings import GatheringStore
from app.living.gathering_mahjong import MahjongStore, games, events, receipts
from app.living.rules import LivingError
from app.models.models import Character
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member
from tests.test_gathering_activity_areas import add_character, raw_group


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


@pytest.fixture
def table():
    clock = [1_800_000_000_000]
    free = GatheringStore(engine, lambda: clock[0] // 1000)
    g = create(free)
    g = member(free, g, 'mahjong-b')
    ids = []
    for index, owner in enumerate([UID, UID, 'mahjong-b', 'mahjong-b']):
        cid = add_character(owner, f'合成牌桌{index}')
        ids.append(cid)
        g = command(free, g, 'visit', uid=owner, character_id=cid)
        g = command(free, g, 'leisure', uid=owner, character_id=cid, activity='mahjong',
                    seat_id=f'mahjong-{index}', station_version=1)
    return free, MahjongStore(engine, lambda: clock[0], lambda: list(range(108))), clock, g, ids


def act(store, g, value=None, uid=UID, action='start', rid=None):
    value = None if value is None else value['game']
    return store.command(uid, g['id'], rid or str(uuid4()),
        None if value is None else value['game_id'], 0 if value is None else value['revision'], action)


def test_start_requires_four_valid_seats_no_automatic_game(table):
    free, store, clock, g, ids = table
    assert g['mahjong_available']
    before = raw_group(g['id'])
    view = store.read(UID, g['id'])
    assert view['game'] is None and view['can_start'] and view['start_blocked_reason'] is None
    assert raw_group(g['id']) == before
    view = act(store, g)
    assert view['game']['wall_remaining'] == 55 and view['game']['revision'] == 1
    assert view['game']['phase'] == 'exchange' and not view['game']['advance_due']
    assert not view['can_start'] and not view['can_new_round']
    assert view['start_blocked_reason'] == 'game_in_progress'
    g = command(free, g, 'leisure', character_id=ids[0], activity=None)
    assert store.read(UID, g['id'])['game']['status'] == 'interrupted'


def test_owner_hands_privacy_readonly_restart_and_due(table):
    _, store, clock, g, ids = table
    a = act(store, g)
    b = store.read('mahjong-b', g['id'])
    assert {h['character_id'] for h in a['game']['own_hands']} == set(ids[:2])
    assert {h['character_id'] for h in b['game']['own_hands']} == set(ids[2:])
    common_a, common_b = copy.deepcopy(a['game']), copy.deepcopy(b['game'])
    common_a.pop('own_hands'); common_b.pop('own_hands')
    assert common_a == common_b
    with engine.connect() as conn:
        raw = conn.execute(select(games.c.state_json)).scalar_one()
    with pytest.raises(LivingError) as early:
        act(store, g, a, action='advance')
    assert early.value.code == 'conflict'
    assert MahjongStore(engine, lambda: clock[0]).read(UID, g['id']) == a
    for _ in range(60):
        clock[0] = a['game']['next_due_at_ms']
        a = act(store, g, a, action='advance')
        if a['game']['last_event'] and a['game']['last_event']['kind'] == 'draw':
            break
    assert a['game']['last_event']['kind'] == 'draw'
    assert a['game']['last_event']['tile'] is None and a['game']['last_event']['text'] == '摸牌'
    serialized = json.dumps(a)
    assert all(f'"{key}"' not in serialized for key in ['wall', 'rng_state', 'roster_json', 'state_json', 'seed'])
    assert raw


def test_receipt_replay_digest_and_concurrent_advance_once(table):
    _, store, clock, g, _ = table
    rid = str(uuid4())
    initial = act(store, g, rid=rid)
    assert act(store, g, rid=rid) == initial
    with pytest.raises(LivingError):
        act(store, g, initial, action='advance', rid=rid)
    clock[0] = initial['game']['next_due_at_ms']
    def advance_once():
        try:
            return act(store, g, initial, action='advance')['game']['revision']
        except LivingError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: advance_once(), range(2)))
    assert sorted(map(str, results)) == ['2', 'conflict']
    with engine.connect() as conn:
        assert conn.execute(select(games.c.revision)).scalar_one() == 2
        assert len(conn.execute(select(receipts)).all()) == 2


@pytest.mark.parametrize('change', ['recall', 'activity', 'leave', 'owner', 'location'])
def test_roster_changes_interrupt_without_erasing_game(table, change):
    free, store, clock, g, ids = table
    initial = act(store, g)
    if change == 'recall':
        g = command(free, g, 'recall', uid='mahjong-b', character_id=ids[2])
    elif change == 'activity':
        g = command(free, g, 'activity', uid='mahjong-b', character_ids=[ids[2]], activity='walk')
    elif change == 'leave':
        g = command(free, g, 'leave', uid='mahjong-b')
    else:
        with engine.begin() as conn:
            conn.execute(update(Character).where(Character.id == ids[2]).values(
                **({'owner_id': UID} if change == 'owner' else {'location_epoch': Character.location_epoch + 1})))
        # Unrelated free save rechecks the exact server-owned character binding.
        g = command(free, g, 'invite')
    view = store.read(UID, g['id'])
    assert view['game']['game_id'] == initial['game']['game_id']
    assert view['game']['status'] == 'interrupted' and not view['game']['can_advance']
    with engine.connect() as conn:
        assert conn.execute(select(games.c.id)).scalar_one() == initial['game']['game_id']
        assert any(json.loads(r[0])['kind'] == 'interrupted' for r in conn.execute(select(events.c.event_json)))


def test_nonmembers_spectators_and_foreign_request_ids(table):
    free, store, clock, g, ids = table
    rid = str(uuid4())
    initial = act(store, g, rid=rid)
    with pytest.raises(LivingError) as denied:
        store.read('outsider', g['id'])
    assert denied.value.code == 'not_found'
    g = member(free, g, 'mahjong-spectator')
    spectator = store.read('mahjong-spectator', g['id'])
    assert spectator['game']['own_hands'] == [] and not spectator['game']['can_advance']
    assert spectator['start_blocked_reason'] == 'no_owned_participant'
    with pytest.raises(LivingError):
        act(store, g, initial, uid='mahjong-spectator', action='advance', rid=rid)


def test_old_round_is_retained_and_never_implicitly_restarted(table):
    _, store, clock, g, _ = table
    view = act(store, g)
    for _ in range(2500):
        if view['game']['status'] != 'playing':
            break
        clock[0] = view['game']['next_due_at_ms']
        view = act(store, g, view, action='advance')
    assert view['game']['status'] == 'ended' and view['can_new_round']
    unchanged = store.read(UID, g['id'])
    assert unchanged == view
    new = act(store, g, view, action='new_round')
    assert new['game']['game_id'] != view['game']['game_id'] and new['game']['revision'] == 1
    with engine.connect() as conn:
        assert len(conn.execute(select(games)).all()) == 2
        assert len(conn.execute(select(events)).all()) > 1


def test_bad_clock_and_saved_corruption_stop_without_replacing(table):
    _, store, clock, g, _ = table
    initial = act(store, g)
    clock[0] = 3.5
    with pytest.raises(LivingError):
        store.read(UID, g['id'])
    clock[0] = initial['game']['next_due_at_ms']
    with engine.begin() as conn:
        conn.execute(update(games).values(state_json='{"broken":true}'))
    with pytest.raises(LivingError) as error:
        act(store, g, initial, action='advance')
    assert error.value.code == 'storage_unavailable'
    with engine.connect() as conn:
        assert conn.execute(select(games.c.state_json)).scalar_one() == '{"broken":true}'


def test_restart_advance_is_identical_and_lost_response_receipt_never_advances_twice(table):
    _, store, clock, g, _ = table
    initial = act(store, g)
    clock[0] = initial['game']['next_due_at_ms']
    rid = str(uuid4())
    result = act(MahjongStore(engine, store.clock), g, initial, action='advance', rid=rid)
    replay = act(MahjongStore(engine, store.clock), g, initial, action='advance', rid=rid)
    assert result == replay and result['game']['revision'] == 2
    with engine.connect() as conn:
        assert conn.execute(select(games.c.revision)).scalar_one() == 2


def test_receipt_replay_cannot_return_hand_after_character_ownership_changes(table):
    free, store, clock, g, ids = table
    rid = str(uuid4())
    result = act(store, g, rid=rid)
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == ids[0]).values(owner_id='mahjong-b'))
    replay = act(store, g, rid=rid)
    assert {h['character_id'] for h in replay['game']['own_hands']} == {ids[1]}
    assert len(result['game']['own_hands']) == 2
    with engine.connect() as conn:
        # Preserve original receipt; filtering is read-time, not retroactive audit rewriting.
        receipt = json.loads(conn.execute(select(receipts.c.result_json)).scalar_one())
        assert len(receipt['game']['own_hands']) == 2


def test_failure_after_transition_rolls_back_state_and_receipt(table, monkeypatch):
    from sqlalchemy import event
    from sqlalchemy.exc import OperationalError
    _, store, clock, g, _ = table
    initial = act(store, g)
    clock[0] = initial['game']['next_due_at_ms']
    def fail_receipt(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO life_gathering_mahjong_receipts'):
            raise OperationalError(statement, {}, Exception('synthetic storage failure'))
    event.listen(engine, 'before_cursor_execute', fail_receipt)
    try:
        with pytest.raises(LivingError) as error:
            act(store, g, initial, action='advance')
        assert error.value.code == 'storage_unavailable'
    finally:
        event.remove(engine, 'before_cursor_execute', fail_receipt)
    assert store.read(UID, g['id'])['game']['revision'] == 1
    with engine.connect() as conn:
        assert len(conn.execute(select(receipts)).all()) == 1


def test_duplicate_or_invalid_seat_and_stale_game_cannot_start_new_wall(table):
    from app.living.gatherings import groups
    free, store, clock, g, ids = table
    initial = act(store, g)
    with pytest.raises(LivingError):
        store.command(UID, g['id'], str(uuid4()), str(uuid4()), initial['game']['revision'], 'advance')
    with engine.begin() as conn:
        row = conn.execute(select(groups).where(groups.c.id == g['id'])).mappings().one()
        raw = json.loads(row['state_json'])
        raw['companions'][str(ids[1])]['leisure']['seat_id'] = 'mahjong-0'
        conn.execute(update(groups).where(groups.c.id == g['id']).values(state_json=json.dumps(raw)))
    before = store.read(UID, g['id'])
    assert before['start_blocked_reason'] == 'seat_conflict' and not before['game']['can_advance']
    with pytest.raises(LivingError):
        act(store, g, initial, action='advance')
    with engine.connect() as conn:
        assert len(conn.execute(select(games)).all()) == 1


@pytest.mark.parametrize('damage', ['missing', 'turn', 'won', 'suit', 'event', 'transfer'])
def test_damaged_saved_schema_get_and_command_do_not_write_or_leak(table, damage):
    _, store, clock, g, _ = table
    initial = act(store, g)
    with engine.begin() as conn:
        state = json.loads(conn.execute(select(games.c.state_json)).scalar_one())
        if damage == 'missing':
            del state['supplement']
        elif damage == 'turn':
            state['turn'] = 4
        elif damage == 'won':
            state['players'][0]['won'] = 'secret-canary'
        elif damage == 'suit':
            state['players'][0]['missing_suit'] = 'secret-canary'
        elif damage == 'event':
            state['last_event'] = {'text': 'secret-canary'}
        else:
            state['score_transfers'] = [{'secret-canary': 'hidden'}]
        encoded = json.dumps(state)
        conn.execute(update(games).values(state_json=encoded))
    clock[0] = initial['game']['next_due_at_ms']
    for operation in (lambda: store.read(UID, g['id']), lambda: act(store, g, initial, action='advance')):
        with pytest.raises(LivingError) as error:
            operation()
        assert error.value.code == 'storage_unavailable' and 'secret-canary' not in str(error.value)
    with engine.connect() as conn:
        assert conn.execute(select(games.c.state_json)).scalar_one() == encoded
        assert conn.execute(select(games.c.revision)).scalar_one() == 1
        assert len(conn.execute(select(receipts)).all()) == 1
