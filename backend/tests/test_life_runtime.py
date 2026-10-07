"""Durable C1.2 lifecycle and accounting. Everything runs in temporary databases."""
import json
import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import create_engine, delete, insert, select, update
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import Base
from app.living import life_runtime as rt
from app.living.activity import events as user_events
from app.living.rules import LivingError
from app.living.store import LivingStore, metadata as living_metadata, spaces
from app.models.models import Character, Object, Photo, User

OWNER = 'c12-fixture-owner'
WALK = {'activity': 'walk', 'reason': '在允许的场景里散步'}
REST = {'activity': 'rest', 'reason': '安静休息'}


def stamp(day=1, hour=12, minute=0):
    return int(datetime(2026, 9, day, hour, minute, tzinfo=ZoneInfo('Asia/Shanghai')).timestamp())


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError('No network or model calls in C1.2')
    monkeypatch.setattr('socket.socket.connect', blocked)


@pytest.fixture
def runtime(tmp_path):
    db = tmp_path / 'life.db'
    engine = create_engine('sqlite:///' + str(db), connect_args={'check_same_thread': False, 'timeout': 10})
    Base.metadata.create_all(engine)
    living_metadata.create_all(engine)
    clock = [stamp()]
    kernel = rt.LifeRuntime(engine, lambda: clock[0])
    kernel.initialize()
    with engine.begin() as conn:
        conn.execute(insert(User).values(id=OWNER, phone='13900000912'))
        conn.execute(insert(Photo).values(id=1, filename='fixture.png', status='done', owner_id=OWNER))
        conn.execute(insert(Object).values(id=1, photo_id=1, label='合成杯子'))
        conn.execute(insert(Character).values(id=1, object_id=1, owner_id=OWNER, name='合成伙伴',
            persona='仅用于离线验证', opening_line='你好', status='ready', location_epoch=1))
    sid = str(uuid4())
    kernel.store.create_space(OWNER, sid, 'home', 'private', '1')
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == 1).values(current_space_id=sid))
    yield kernel, sid, clock, db
    engine.dispose()


def enable(kernel, sid, revision=0, enabled=True, activities=('rest', 'walk', 'observe'), rid=None):
    return kernel.save_permission(OWNER, sid, rid or str(uuid4()), revision, enabled, activities)


def queued(runtime, source='viewing'):
    kernel, sid, _, _ = runtime
    if kernel.read_permission(OWNER, sid) is None:
        enable(kernel, sid)
    return kernel.schedule(OWNER, sid, str(uuid4()), source)


def running(runtime, source='viewing'):
    kernel, sid, _, _ = runtime
    task = queued(runtime, source)
    return kernel.claim(OWNER, sid, task.spec.basis.plan_id)


def finish(kernel, sid, task, candidate=None):
    return kernel.execute_step(OWNER, sid, task.spec.basis.plan_id, task.token, candidate or WALK)


def reject(code, operation):
    with pytest.raises(LivingError) as caught:
        operation()
    assert caught.value.code == code


def allocate(kernel, sid, project=100, space=100):
    kernel.set_limit('project', project, 'synthetic-test-allocation')
    kernel.set_limit('space:' + sid, space, 'synthetic-test-allocation')


def reserve(kernel, sid, task, amount=30, call_id=None):
    return kernel.reserve_call(OWNER, sid, task.spec.basis.plan_id, task.token, call_id or str(uuid4()), amount)


def test_missing_permission_default_zero_budget_and_no_events(runtime):
    kernel, sid, _, _ = runtime
    assert kernel.read_permission(OWNER, sid) is None
    assert kernel.read_budget(OWNER, sid).cap == 0
    assert kernel.pending_tasks(OWNER, sid) == []
    assert kernel.read_events(OWNER, sid) == []
    reject('invalid_action', lambda: kernel.schedule(OWNER, sid, str(uuid4())))
    task = running(runtime)
    reject('invalid_action', lambda: reserve(kernel, sid, task))
    assert kernel.read_budget(OWNER, sid).committed == 0


def test_permission_replay_pause_and_resume_never_revives_old_task(runtime):
    kernel, sid, clock, _ = runtime
    rid = str(uuid4())
    permission = enable(kernel, sid, rid=rid)
    task = kernel.schedule(OWNER, sid, str(uuid4()))
    enable(kernel, sid, revision=1, enabled=False)
    assert kernel.read_task(OWNER, sid, task.spec.basis.plan_id).state == 'cancelled'
    assert kernel.pending_tasks(OWNER, sid) == []
    assert enable(kernel, sid, rid=rid) == permission
    assert kernel.read_permission(OWNER, sid).enabled is False
    reject('conflict', lambda: enable(kernel, sid, rid=rid, enabled=False))
    enable(kernel, sid, revision=2)
    reject('conflict', lambda: kernel.schedule(OWNER, sid, str(uuid4())))
    clock[0] += 600
    assert kernel.schedule(OWNER, sid, str(uuid4())).state == 'queued'


@pytest.mark.parametrize('enabled,activities,revision', [(True, (), 0), ('true', ('rest',), 0),
    (True, ('delete',), 0), (True, ('rest', 'rest'), 0), (True, ('rest',), True)])
def test_bad_permission_input(runtime, enabled, activities, revision):
    kernel, sid, _, _ = runtime
    reject('invalid_request', lambda: enable(kernel, sid, revision, enabled, activities))


def test_idempotent_execution_is_atomic_and_keeps_scene_and_user_events_unchanged(runtime):
    kernel, sid, _, _ = runtime
    before = kernel.store.read_space(OWNER, sid)
    task = running(runtime)
    result = finish(kernel, sid, task)
    assert result.state == 'done' and result.result.event.origin == 'offline_fixture'
    assert result.result.event.effect == 'activity_state_changed'
    assert finish(kernel, sid, task) == result
    reject('conflict', lambda: finish(kernel, sid, task, REST))
    assert kernel.schedule(OWNER, sid, task.spec.basis.plan_id) == result
    assert len(kernel.read_events(OWNER, sid)) == 1
    assert kernel.store.read_space(OWNER, sid) == before
    with kernel.engine.connect() as conn:
        assert conn.execute(select(user_events)).first() is None


def test_settings_and_task_ownership_never_cross_accounts(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    tid = task.spec.basis.plan_id
    for op in [lambda: kernel.read_permission('other', sid),
               lambda: kernel.save_permission('other', sid, str(uuid4()), 0, True, ('rest',)),
               lambda: kernel.schedule('other', sid, str(uuid4())),
               lambda: kernel.claim('other', sid, tid),
               lambda: kernel.read_task('other', sid, tid),
               lambda: kernel.pending_tasks('other', sid),
               lambda: kernel.execute_step('other', sid, tid, task.token, WALK),
               lambda: kernel.read_events('other', sid),
               lambda: kernel.read_budget('other', sid)]:
        reject('not_found', op)
    other = str(uuid4())
    kernel.store.create_space(OWNER, other, 'forest', 'private', '1')
    reject('not_found', lambda: kernel.claim(OWNER, other, tid))
    reject('conflict', lambda: kernel.schedule(OWNER, other, tid))


def test_schedule_limits_include_failed_cancelled_and_reset_by_local_day(runtime):
    kernel, sid, clock, _ = runtime
    task = running(runtime, 'offline')
    assert kernel.fail_task(OWNER, sid, task.spec.basis.plan_id, task.token).state == 'failed'
    reject('conflict', lambda: kernel.schedule(OWNER, sid, str(uuid4()), 'offline'))
    clock[0] += 600
    task = queued(runtime, 'offline')
    enable(kernel, sid, revision=1, enabled=False)
    enable(kernel, sid, revision=2)
    clock[0] += 600
    reject('conflict', lambda: kernel.schedule(OWNER, sid, str(uuid4()), 'offline'))
    clock[0] = stamp(day=2)
    assert kernel.schedule(OWNER, sid, str(uuid4()), 'offline').state == 'queued'


def test_expired_task_requires_recovery_and_does_not_catch_up(runtime):
    kernel, sid, clock, _ = runtime
    task = queued(runtime)
    clock[0] += 86400
    assert kernel.pending_tasks(OWNER, sid)[0].state == 'queued'
    reject('conflict', lambda: kernel.schedule(OWNER, sid, str(uuid4())))
    assert kernel.claim(OWNER, sid, task.spec.basis.plan_id).state == 'cancelled'
    assert kernel.read_events(OWNER, sid) == []
    assert kernel.schedule(OWNER, sid, str(uuid4())).state == 'queued'


def test_expired_lease_reclaim_fences_old_worker(runtime):
    kernel, sid, clock, _ = runtime
    first = running(runtime)
    reject('conflict', lambda: kernel.claim(OWNER, sid, first.spec.basis.plan_id))
    clock[0] += 60
    second = kernel.claim(OWNER, sid, first.spec.basis.plan_id)
    assert first.token != second.token
    reject('conflict', lambda: finish(kernel, sid, first))
    assert finish(kernel, sid, second).state == 'done'


def test_pause_running_task_fences_result_and_keeps_unknown_cost(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    allocate(kernel, sid)
    ticket = reserve(kernel, sid, task)
    enable(kernel, sid, revision=1, enabled=False)
    assert finish(kernel, sid, task).state == 'cancelled'
    assert kernel.read_events(OWNER, sid) == []
    assert kernel.read_budget(OWNER, sid).committed == 30
    kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, ticket.call.id, 7, 'failed')
    assert kernel.read_budget(OWNER, sid).committed == 7


@pytest.mark.parametrize('change', ['scene', 'return', 'away', 'permission'])
def test_fact_changes_cancel_old_task(runtime, change):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    if change == 'scene':
        kernel.store.execute(OWNER, sid, str(uuid4()), 0, {'action': 'atmosphere', 'weather': 'rain'})
    elif change == 'permission':
        enable(kernel, sid, revision=1, activities=('rest',))
    else:
        with kernel.engine.begin() as conn:
            conn.execute(update(Character).where(Character.id == 1).values(
                current_space_id=sid if change == 'return' else None, location_epoch=3))
    assert finish(kernel, sid, task).state == 'cancelled'
    assert kernel.read_events(OWNER, sid) == []


@pytest.mark.parametrize('payload', [
    {'activity': 'observe', 'target_id': str(uuid4()), 'reason': '看不存在的树'},
    {'activity': 'delete', 'reason': '删除'},
    {'activity': 'walk', 'reason': '走走', 'executed': True},
])
def test_invalid_candidates_persist_failure_without_event(runtime, payload):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    result = finish(kernel, sid, task, payload)
    assert result.state == 'failed'
    assert finish(kernel, sid, task, payload) == result
    assert kernel.read_events(OWNER, sid) == []


def test_night_execution_rechecks_time(runtime):
    kernel, sid, clock, _ = runtime
    clock[0] = stamp(hour=21, minute=59) + 30
    task = running(runtime)
    clock[0] += 30
    assert finish(kernel, sid, task).state == 'failed'
    clock[0] += 600
    task = running(runtime)
    assert finish(kernel, sid, task, REST).state == 'done'


def test_transaction_failure_rolls_back_event_and_task_then_retry(runtime, monkeypatch):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    original = kernel._finish
    def fail(*args, **kwargs):
        raise SQLAlchemyError('synthetic storage failure')
    monkeypatch.setattr(kernel, '_finish', fail)
    reject('storage_unavailable', lambda: finish(kernel, sid, task))
    assert kernel.read_task(OWNER, sid, task.spec.basis.plan_id).state == 'running'
    assert kernel.read_events(OWNER, sid) == []
    monkeypatch.setattr(kernel, '_finish', original)
    assert finish(kernel, sid, task).state == 'done'


def test_permission_write_rolls_back_on_cancellation_failure(runtime, monkeypatch):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    def fail(*args, **kwargs):
        raise SQLAlchemyError('synthetic storage failure')
    monkeypatch.setattr(kernel, '_finish', fail)
    reject('storage_unavailable', lambda: enable(kernel, sid, revision=1, enabled=False))
    assert kernel.read_permission(OWNER, sid).revision == 1
    assert kernel.read_task(OWNER, sid, task.spec.basis.plan_id).state == 'running'


def outcome(operation):
    try:
        return operation()
    except LivingError as exc:
        return exc.code


def test_concurrent_schedule_claim_and_execute(runtime):
    kernel, sid, _, _ = runtime
    enable(kernel, sid)
    rid = str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        same = list(pool.map(lambda _: kernel.schedule(OWNER, sid, rid), range(2)))
    assert same[0] == same[1]
    with ThreadPoolExecutor(max_workers=2) as pool:
        claimed = list(pool.map(lambda _: outcome(lambda: kernel.claim(OWNER, sid, rid)), range(2)))
    assert sum(isinstance(x, rt.Task) for x in claimed) == 1 and 'conflict' in claimed
    worker = next(x for x in claimed if isinstance(x, rt.Task))
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: finish(kernel, sid, worker), range(2)))
    assert results[0] == results[1]
    assert len(kernel.read_events(OWNER, sid)) == 1


def test_concurrent_different_schedule_ids_have_one_winner(runtime):
    kernel, sid, _, _ = runtime
    enable(kernel, sid)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: outcome(lambda: kernel.schedule(OWNER, sid, str(uuid4()))), range(2)))
    assert sum(isinstance(x, rt.Task) for x in results) == 1 and 'conflict' in results


def test_reservation_idempotency_unknown_cost_and_late_settlement(runtime):
    kernel, sid, clock, _ = runtime
    task = running(runtime)
    allocate(kernel, sid)
    rid = str(uuid4())
    first = reserve(kernel, sid, task, call_id=rid)
    assert first.dispatch_allowed is True
    assert reserve(kernel, sid, task, call_id=rid).dispatch_allowed is False
    reject('conflict', lambda: reserve(kernel, sid, task, amount=31, call_id=rid))
    kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, rid, None, 'unknown')
    clock[0] += 60
    new_worker = kernel.claim(OWNER, sid, task.spec.basis.plan_id)
    assert reserve(kernel, sid, new_worker, call_id=rid).dispatch_allowed is False
    assert kernel.read_budget(OWNER, sid).committed == 30
    finish(kernel, sid, new_worker)
    result = kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, rid, 12, 'succeeded')
    assert kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, rid, 12, 'succeeded') == result
    reject('conflict', lambda: kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, rid, 11, 'succeeded'))
    assert kernel.read_budget(OWNER, sid).committed == 12


@pytest.mark.parametrize('project,space', [(20, 100), (100, 20), (0, 100), (100, 0)])
def test_both_budget_limits_are_required(runtime, project, space):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    allocate(kernel, sid, project, space)
    reject('invalid_action', lambda: reserve(kernel, sid, task))
    assert kernel.read_budget(OWNER, sid).committed == 0


def test_call_count_failure_accounting_and_invalid_settlement(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    allocate(kernel, sid)
    first = reserve(kernel, sid, task)
    for amount, state in [(31, 'succeeded'), (-1, 'failed'), (True, 'succeeded'), (1.5, 'succeeded'), (0, 'unknown')]:
        reject('invalid_request', lambda: kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, first.call.id, amount, state))
    assert kernel.read_budget(OWNER, sid).committed == 30
    kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, first.call.id, 0, 'failed')
    reserve(kernel, sid, task)
    reject('invalid_action', lambda: reserve(kernel, sid, task))
    reject('conflict', lambda: kernel.set_limit('space:' + sid, 29, 'synthetic-lower-limit'))


def test_budget_contention_does_not_overspend(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    allocate(kernel, sid, 50, 50)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: outcome(lambda: reserve(kernel, sid, task)), range(2)))
    assert sum(isinstance(x, rt.Ticket) for x in results) == 1 and 'invalid_action' in results
    assert kernel.read_budget(OWNER, sid).committed == 30


def test_call_scope_rejects_other_task_or_owner(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    allocate(kernel, sid)
    ticket = reserve(kernel, sid, task)
    reject('not_found', lambda: kernel.settle_call('other', sid, task.spec.basis.plan_id, ticket.call.id, 0, 'failed'))
    reject('not_found', lambda: kernel.settle_call(OWNER, sid, str(uuid4()), ticket.call.id, 0, 'failed'))
    reject('not_found', lambda: kernel.settle_call(OWNER, sid, task.spec.basis.plan_id, str(uuid4()), 0, 'failed'))


@pytest.mark.parametrize('table,column,operation', [
    ('permission', 'payload', 'permission'), ('task', 'spec', 'task'),
    ('task', 'state', 'task'), ('limit', 'payload', 'budget'), ('call', 'payload', 'budget'),
])
def test_corrupt_records_fail_closed(runtime, table, column, operation):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    allocate(kernel, sid)
    reserve(kernel, sid, task)
    tables = {'permission': rt.permissions, 'task': rt.tasks, 'limit': rt.limits, 'call': rt.calls}
    with kernel.engine.begin() as conn:
        conn.execute(update(tables[table]).values(**{column: '{}'}))
    operations = {'permission': lambda: kernel.read_permission(OWNER, sid),
                  'task': lambda: kernel.read_task(OWNER, sid, task.spec.basis.plan_id),
                  'budget': lambda: kernel.read_budget(OWNER, sid)}
    reject('corrupt_state', operations[operation])


def test_missing_event_cannot_be_replayed_as_success(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    finish(kernel, sid, task)
    with kernel.engine.begin() as conn:
        conn.execute(delete(rt.events))
    reject('corrupt_state', lambda: finish(kernel, sid, task))


def test_global_budget_is_shared_across_spaces(runtime):
    kernel, sid, clock, _ = runtime
    first = running(runtime)
    allocate(kernel, sid, project=50, space=100)
    reserve(kernel, sid, first)
    second_sid = str(uuid4())
    kernel.store.create_space(OWNER, second_sid, 'forest', 'private', '1')
    with kernel.engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == 1).values(current_space_id=second_sid, location_epoch=2))
    enable(kernel, second_sid)
    kernel.set_limit('space:' + second_sid, 100, 'synthetic-second-space')
    second = kernel.schedule(OWNER, second_sid, str(uuid4()))
    second = kernel.claim(OWNER, second_sid, second.spec.basis.plan_id)
    reject('invalid_action', lambda: reserve(kernel, second_sid, second))
    assert kernel.read_budget(OWNER, second_sid).committed == 0
    assert kernel.read_budget(OWNER, sid).committed == 30


def test_corrupted_task_counters_and_pending_state_fail_closed(runtime):
    kernel, sid, clock, _ = runtime
    task = running(runtime, 'offline')
    kernel.fail_task(OWNER, sid, task.spec.basis.plan_id, task.token)
    clock[0] += 600
    with kernel.engine.begin() as conn:
        conn.execute(update(rt.tasks).values(day='2026-09-02'))
    reject('corrupt_state', lambda: kernel.schedule(OWNER, sid, str(uuid4()), 'offline'))
    reject('corrupt_state', lambda: kernel.pending_tasks(OWNER, sid))


def test_stored_permission_and_event_identity_mismatch(runtime):
    kernel, sid, _, _ = runtime
    task = running(runtime)
    finish(kernel, sid, task)
    with kernel.engine.begin() as conn:
        payload = json.loads(conn.execute(select(rt.permissions.c.payload)).scalar_one())
        payload['owner_id'] = 'other'
        conn.execute(update(rt.permissions).values(payload=json.dumps(payload)))
    reject('corrupt_state', lambda: kernel.read_permission(OWNER, sid))
    with kernel.engine.begin() as conn:
        payload = json.loads(conn.execute(select(rt.events.c.payload)).scalar_one())
        payload['activity'] = 'rest'
        conn.execute(update(rt.events).values(payload=json.dumps(payload)))
    reject('corrupt_state', lambda: kernel.read_events(OWNER, sid))


def test_backup_restore_preserves_permissions_tasks_events_and_unknown_cost(runtime, tmp_path):
    kernel, sid, clock, db = runtime
    task = running(runtime)
    allocate(kernel, sid)
    reserve(kernel, sid, task)
    done = finish(kernel, sid, task)
    restored = tmp_path / 'restored.db'
    with sqlite3.connect(db) as source, sqlite3.connect(restored) as target:
        source.backup(target)
    copy_engine = create_engine('sqlite:///' + str(restored))
    copy = rt.LifeRuntime(copy_engine, lambda: clock[0])
    try:
        assert copy.read_permission(OWNER, sid) == kernel.read_permission(OWNER, sid)
        assert copy.read_task(OWNER, sid, task.spec.basis.plan_id) == done
        assert copy.read_events(OWNER, sid) == kernel.read_events(OWNER, sid)
        assert copy.read_budget(OWNER, sid).committed == 30
        enable(copy, sid, revision=1, enabled=False)
        assert kernel.read_permission(OWNER, sid).enabled is True
    finally:
        copy_engine.dispose()


def test_independent_python_processes_recover_lease_budget_and_exactly_one_event(runtime):
    kernel, sid, clock, db = runtime
    enable(kernel, sid)
    allocate(kernel, sid)
    backend = Path(__file__).resolve().parents[1]
    env = {**os.environ, 'PYTHONPATH': str(backend)}
    # Each subprocess exits completely. The second knows only owner/space/db, not the task ID.
    common = '''
import json, socket, sys
from uuid import uuid4
from sqlalchemy import create_engine
from app.living.life_runtime import LifeRuntime
def blocked(*a, **k): raise AssertionError('network disabled')
socket.socket.connect = blocked
db, owner, sid, now = sys.argv[1:]
k = LifeRuntime(create_engine('sqlite:///' + db), lambda: int(now))
'''
    phase1 = common + '''
t = k.schedule(owner, sid, str(uuid4()))
t = k.claim(owner, sid, t.spec.basis.plan_id)
c = k.reserve_call(owner, sid, t.spec.basis.plan_id, t.token, str(uuid4()), 30)
print(json.dumps({'task':t.spec.basis.plan_id,'token':t.token,'call':c.call.id}))
'''
    first = json.loads(subprocess.check_output([sys.executable, '-c', phase1, str(db), OWNER, sid, str(clock[0])],
                       cwd=backend, env=env, text=True, timeout=15))
    assert kernel.read_events(OWNER, sid) == []
    phase2 = common + '''
t, = k.pending_tasks(owner, sid)
t = k.claim(owner, sid, t.spec.basis.plan_id)
r = k.execute_step(owner, sid, t.spec.basis.plan_id, t.token, {'activity':'walk','reason':'离线恢复验证'})
r2 = k.execute_step(owner, sid, t.spec.basis.plan_id, t.token, {'activity':'walk','reason':'离线恢复验证'})
print(json.dumps({'task':t.spec.basis.plan_id,'new_token':t.token,'state':r.state,
                  'events':len(k.read_events(owner,sid)),'committed':k.read_budget(owner,sid).committed,
                  'same_receipt':r == r2}))
'''
    second = json.loads(subprocess.check_output([sys.executable, '-c', phase2, str(db), OWNER, sid, str(clock[0] + 60)],
                        cwd=backend, env=env, text=True, timeout=15))
    assert second == {'task': first['task'], 'new_token': second['new_token'], 'state': 'done',
                      'events': 1, 'committed': 30, 'same_receipt': True}
    assert second['new_token'] != first['token']
    assert kernel.read_task(OWNER, sid, first['task']).state == 'done'
    assert len(kernel.read_events(OWNER, sid)) == 1
