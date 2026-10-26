"""Offline single-round admission tests: no model transport or external accounts."""
import asyncio
import json
import socket
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import pytest
from sqlalchemy import insert, select, update

from app.core.database import SessionLocal, engine
from app.living.gathering_automatic import automatic
from app.living.gathering_dialogue import DialogueStore, grants, run_exchange, tasks
from app.living.gatherings import GatheringStore
from app.living.rules import LivingError
from app.models.models import Character, User
from tests.auth_helpers import TEST_USER_ID as OWNER_A
from tests.test_gatherings import command, create, member

OWNER_B = 'synthetic-owner-b'


@pytest.fixture(autouse=True)
def deny_network(monkeypatch):
    def denied(*_args, **_kwargs):
        raise AssertionError('Network is forbidden in the manual dialogue mutex tests')
    monkeypatch.setattr(socket, 'create_connection', denied)
    monkeypatch.setattr(socket, 'getaddrinfo', denied)
    monkeypatch.setattr(socket.socket, 'connect', denied)
    monkeypatch.setattr(socket.socket, 'connect_ex', denied)


@pytest.fixture
def shared_round(ready_character_id):
    with SessionLocal() as db:
        first = db.get(Character, ready_character_id)
        db.add(User(id=OWNER_B, phone='16200000002'))
        db.flush()
        second = Character(object_id=first.object_id, owner_id=OWNER_B, name='合成朋友伙伴',
                           persona='synthetic fixture only', opening_line='', status='ready')
        db.add(second)
        db.flush()
        ids = [first.id, second.id]
        db.commit()
    clock = [1_800_000_000]
    store = DialogueStore(engine, lambda: clock[0])
    group = member(store, create(store), OWNER_B)
    for owner, cid in zip((OWNER_A, OWNER_B), ids):
        group = command(store, group, 'visit', uid=owner, character_id=cid)
        group = command(store, group, 'dialogue_consent', uid=owner, character_id=cid, enabled=True)
    group = command(store, group, 'dialogue_space', enabled=True)
    authorizations = {owner: store.authorize(owner, group['id'], ids, str(uuid4()))
                      for owner in (OWNER_A, OWNER_B)}
    return store, clock, group, ids, authorizations


def prepare(shared, owner, request_id=None, revision=None):
    store, _, group, ids, authorizations = shared
    return store.prepare(owner, group['id'], request_id or str(uuid4()),
                         group['revision'] if revision is None else revision, ids, authorizations[owner])


def persisted(shared):
    _, _, group, _, _ = shared
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(select(tasks).where(tasks.c.group_id == group['id'])
                .order_by(tasks.c.id)).mappings()]
        usage = dict(conn.execute(select(grants.c.owner_id, grants.c.used)
                                 .where(grants.c.group_id == group['id'])).all())
    return rows, usage


def response(ids):
    return {'lines': [{'character_id': cid, 'text': '一起看看眼前的风景吧。', 'item_ids': []} for cid in ids]}


def finish_offline(shared, task, calls):
    store, _, _, ids, _ = shared

    class SyntheticClient:
        async def exchange(self, facts):
            calls.append(facts)
            return response(ids)

    async def offline_catalog():
        return {'verified': True, 'origin': 'offline_fixture'}

    asyncio.run(run_exchange(store, task, SyntheticClient, offline_catalog))


def test_two_owners_racing_on_independent_store_connections_admit_and_dispatch_once(shared_round):
    store, clock, group, ids, authorizations = shared_round
    before = json.dumps(group, sort_keys=True)
    barrier = Barrier(2)

    def attempt(owner):
        contender = DialogueStore(engine, lambda: clock[0])
        barrier.wait(timeout=5)
        try:
            task, fresh = contender.prepare(owner, group['id'], str(uuid4()), group['revision'], ids, authorizations[owner])
            return owner, task, fresh
        except LivingError as exc:
            return owner, exc.code, False

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, (OWNER_A, OWNER_B)))
    admitted = [(owner, task) for owner, task, fresh in results if fresh]
    rejected = [(owner, code) for owner, code, fresh in results if not fresh]
    assert len(admitted) == len(rejected) == 1
    assert rejected[0][1] == 'conflict'
    rows, usage = persisted(shared_round)
    assert len(rows) == 1 and rows[0]['state'] == 'running' and rows[0]['dispatched'] == 0
    assert usage == {admitted[0][0]: 1, rejected[0][0]: 0}
    calls = []
    finish_offline(shared_round, admitted[0][1], calls)
    assert len(calls) == 1
    rows, usage = persisted(shared_round)
    assert rows[0]['state'] == 'done' and usage[rejected[0][0]] == 0
    assert len(store.read(OWNER_A, group['id'])['exchanges']) == 1
    assert len(store.read(OWNER_B, group['id'])['exchanges']) == 1
    assert json.dumps(group, sort_keys=True) == before


@pytest.mark.parametrize('dispatch_first', [False, True])
def test_second_owner_is_rejected_before_grant_consumption_even_before_first_dispatch(shared_round, dispatch_first):
    store, _, _, _, _ = shared_round
    task, fresh = prepare(shared_round, OWNER_A)
    assert fresh
    if dispatch_first:
        store.dispatch(task['id'])
    before = persisted(shared_round)
    with pytest.raises(LivingError) as exc:
        prepare(shared_round, OWNER_B)
    assert exc.value.code == 'conflict'
    assert persisted(shared_round) == before
    assert before[1][OWNER_B] == 0


def test_same_owner_same_request_race_replays_one_task_and_consumes_one_grant(shared_round):
    store, clock, group, ids, authorizations = shared_round
    request_id, barrier = str(uuid4()), Barrier(3)

    def replay(_index):
        contender = DialogueStore(engine, lambda: clock[0])
        barrier.wait(timeout=5)
        return contender.prepare(OWNER_A, group['id'], request_id, group['revision'], ids, authorizations[OWNER_A])

    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(replay, range(3)))
    assert sum(fresh for _, fresh in results) == 1
    assert len({task['id'] for task, _ in results}) == 1
    task = results[0][0]
    store.dispatch(task['id'])
    with pytest.raises(LivingError):
        store.dispatch(task['id'])
    rows, usage = persisted(shared_round)
    assert len(rows) == 1 and usage == {OWNER_A: 1, OWNER_B: 0}
    with pytest.raises(LivingError) as exc:
        store.prepare(OWNER_A, group['id'], request_id, group['revision'], list(reversed(ids)), authorizations[OWNER_A])
    assert exc.value.code == 'conflict'


def test_completed_round_releases_slot_for_a_different_explicit_authorization(shared_round):
    store, _, group, ids, authorizations = shared_round
    request_id = str(uuid4())
    first, _ = prepare(shared_round, OWNER_A, request_id)
    calls = []
    finish_offline(shared_round, first, calls)
    current = GatheringStore.read(store, OWNER_B, group['id'])
    second, fresh = prepare(shared_round, OWNER_B, revision=current['revision'])
    assert fresh and second['grant_id'] == authorizations[OWNER_B] and second['id'] != first['id']
    finish_offline(shared_round, second, calls)
    prior, replayed = store.prepare(OWNER_A, group['id'], request_id, group['revision'], ids, authorizations[OWNER_A])
    assert not replayed and prior['id'] == first['id'] and prior['state'] == 'done'
    rows, usage = persisted(shared_round)
    assert len(calls) == len(rows) == 2 and all(row['state'] == 'done' for row in rows)
    assert usage == {OWNER_A: 1, OWNER_B: 1}


@pytest.mark.parametrize('state', ['failed', 'unknown', 'done'])
def test_terminal_request_replay_does_not_restore_retry_or_refund(shared_round, state):
    store, _, group, ids, authorizations = shared_round
    request_id = str(uuid4())
    task, _ = prepare(shared_round, OWNER_A, request_id)
    if state == 'done':
        store.dispatch(task['id']); store.complete(task['id'], response(ids))
    elif state == 'unknown':
        store.dispatch(task['id']); store.finish_failure(task['id'], 'provider_timeout')
    else:
        store.finish_failure(task['id'], 'dialogue_json_invalid')
    before = persisted(shared_round)
    replay, fresh = prepare(shared_round, OWNER_A, request_id)
    assert not fresh and replay['state'] == state and replay['id'] == task['id']
    assert persisted(shared_round) == before
    assert before[1][OWNER_A] == 1
    if state == 'unknown':
        with pytest.raises(LivingError) as exc:
            prepare(shared_round, OWNER_B)
        assert exc.value.code == 'conflict'
        assert persisted(shared_round) == before


@pytest.mark.parametrize('was_dispatched', [False, True])
def test_expired_running_slot_stays_pending_review_before_and_after_read(shared_round, was_dispatched):
    store, clock, group, _, _ = shared_round
    task, _ = prepare(shared_round, OWNER_A)
    if was_dispatched:
        store.dispatch(task['id'])
    clock[0] += 61
    before = persisted(shared_round)
    with pytest.raises(LivingError) as exc:
        prepare(shared_round, OWNER_B)
    assert exc.value.code == 'conflict'
    assert persisted(shared_round) == before
    state = store.read(OWNER_A, group['id'])
    assert state['tasks'][0]['state'] == 'unknown' and state['tasks'][0]['error_code'] == 'interrupted'
    after_read = persisted(shared_round)
    with pytest.raises(LivingError):
        prepare(shared_round, OWNER_B)
    with pytest.raises(LivingError):
        store.dispatch(task['id'])
    assert persisted(shared_round) == after_read
    assert after_read[1] == {OWNER_A: 1, OWNER_B: 0}
    assert after_read[0][0]['dispatched'] == int(was_dispatched)


def test_automatic_mode_still_blocks_manual_without_mutating_grants_or_settings(shared_round):
    _, clock, group, _, _ = shared_round
    with engine.begin() as conn:
        conn.execute(insert(automatic).values(group_id=group['id'], revision=3, enabled=1, session_id=None,
            next_at=clock[0] + 600, day=0, today_count=0, last_task_id=None, stop_reason=None))
        before = dict(conn.execute(select(automatic)).mappings().one())
    with pytest.raises(LivingError):
        prepare(shared_round, OWNER_A)
    rows, usage = persisted(shared_round)
    assert rows == [] and usage == {OWNER_A: 0, OWNER_B: 0}
    with engine.connect() as conn:
        assert dict(conn.execute(select(automatic)).mappings().one()) == before


@pytest.mark.parametrize('area,activity,label', [
    ('outdoor', 'observe', '院子'), ('indoor', 'rest', '客厅'), ('bedroom', 'sleep', '卧室')])
def test_admission_keeps_region_and_original_task_audit_fields(shared_round, area, activity, label):
    store, clock, group, ids, authorizations = shared_round
    for owner, cid in zip((OWNER_A, OWNER_B), ids):
        group = command(store, group, 'activity', uid=owner, character_ids=[cid], activity=activity)
    shared = store, clock, group, ids, authorizations
    request_id = str(uuid4())
    task, fresh = prepare(shared, OWNER_A, request_id)
    assert fresh
    facts = json.loads(task['facts_json'])
    assert facts['area'] == area and facts['area_label'] == label
    assert facts['items'] == []
    before = persisted(shared)
    with pytest.raises(LivingError):
        prepare(shared, OWNER_B)
    assert persisted(shared) == before
    store.dispatch(task['id']); store.complete(task['id'], response(ids))
    row = persisted(shared)[0][0]
    for key in ('id', 'group_id', 'owner_id', 'grant_id', 'request_id', 'digest', 'revision', 'created_at', 'facts_json'):
        assert row[key] == task[key]
    assert row['state'] == 'done' and row['dispatched'] == 1
    for owner in (OWNER_A, OWNER_B):
        event = store.read(owner, group['id'])['exchanges'][0]
        assert event['area'] == area and event['origin'] == 'real_provider'
        assert [line['character_id'] for line in event['lines']] == ids


def test_legacy_competing_rows_cannot_both_dispatch_or_be_silently_cleaned_up(shared_round):
    store, _, group, _, authorizations = shared_round
    first, _ = prepare(shared_round, OWNER_A)
    legacy = dict(first, id=str(uuid4()), owner_id=OWNER_B, grant_id=authorizations[OWNER_B], request_id=str(uuid4()))
    with engine.begin() as conn:
        conn.execute(update(grants).where(grants.c.id == authorizations[OWNER_B]).values(used=1))
        conn.execute(insert(tasks).values(**legacy))
    before = persisted(shared_round)
    for task in (first, legacy):
        with pytest.raises(LivingError) as exc:
            store.dispatch(task['id'])
        assert exc.value.code == 'conflict'
    assert persisted(shared_round) == before
