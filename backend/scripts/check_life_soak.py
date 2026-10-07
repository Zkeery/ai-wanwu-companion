"""C1.74: isolated, network-forbidden scheduling soak. Never live AI evidence.

Default: 30 accelerated days. Wall-clock mode retains its original deadline
when resumed. Neither mode reads API credentials or touches an existing DB.
"""
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import fcntl
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
from uuid import uuid4

from sqlalchemy import create_engine, insert, select, update

from app.core.database import Base
from app.living.life_runtime import LifeRuntime, tasks, events, calls
from app.living.life_worker import consume_once
from app.living.store import metadata as living_metadata
from app.models.models import User, Photo, Object, Character

PROJECT = Path(__file__).resolve().parents[2]
RUNS = PROJECT / '.runtime' / 'c174-quality-stability'
OWNER = 'c174-offline-soak-owner'
TZ = timezone(timedelta(hours=8))


@contextmanager
def no_network():
    original = socket.socket.connect
    original_ex = socket.socket.connect_ex
    def forbidden(*_args, **_kwargs):
        raise AssertionError('C1.74 offline soak forbids network access')
    socket.socket.connect = socket.socket.connect_ex = forbidden
    try:
        yield
    finally:
        socket.socket.connect, socket.socket.connect_ex = original, original_ex


def save(path, data):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    os.replace(temporary, path)


def checked_run(path):
    if path.is_symlink():
        raise ValueError('Run directory must not be a symbolic link')
    path = path.resolve()
    if path.parent != RUNS.resolve():
        raise ValueError('Use a fresh direct child of the C1.74 runtime directory')
    return path


def open_kernel(path, clock, *, create=False):
    if (path/'soak.db').is_symlink() or (not create and not (path/'soak.db').is_file()):
        raise ValueError('Keep the original isolated database; missing DB cannot be recreated on resume')
    engine = create_engine('sqlite:///' + str(path / 'soak.db'),
                           connect_args={'check_same_thread': False, 'timeout': 30})
    runtime = LifeRuntime(engine, clock, origin='offline_fixture')
    runtime.initialize()
    return runtime


def seed(path, mode, seconds, observed_at=None):
    checked_run(path)
    path.mkdir(parents=True, exist_ok=False)
    now = int(time.time())
    state = dict(schema_version=1, evidence_origin='offline_fixture', mode=mode,
                 started_at=now, deadline=now + seconds if mode == 'wall-clock' else None,
                 status='running', sid=str(uuid4()), scans=0, subprocess_checks=0,
                 engine_reopens=0, simulated_days=0, provider_requests=0, cost=0,
                 largest_observation_gap_seconds=0, resumes=0)
    runtime = open_kernel(path, lambda: now if observed_at is None else observed_at, create=True)
    try:
        Base.metadata.create_all(runtime.engine)
        living_metadata.create_all(runtime.engine)
        with runtime.engine.begin() as conn:
            conn.execute(insert(User).values(id=OWNER, phone='13900000741'))
            conn.execute(insert(Photo).values(id=1, filename='synthetic-only.png',
                                             status='done', owner_id=OWNER))
            conn.execute(insert(Object).values(id=1, photo_id=1, label='合成物品'))
            conn.execute(insert(Character).values(id=1, object_id=1, owner_id=OWNER,
                name='离线长期检查', persona='合成账号，不是实际用户', opening_line='',
                status='ready', location_epoch=1))
        runtime.store.create_space(OWNER, state['sid'], 'home', 'private', '1')
        with runtime.engine.begin() as conn:
            conn.execute(update(Character).where(Character.id == 1)
                         .values(current_space_id=state['sid']))
        runtime.save_permission(OWNER, state['sid'], str(uuid4()), 0, True, ('rest', 'walk'))
        runtime.save_automatic(OWNER, state['sid'], str(uuid4()), 0, True)
        save(path / 'state.json', state)
    finally:
        runtime.engine.dispose()
    return state


def facts(runtime, sid):
    with runtime.engine.connect() as conn:
        task_rows = conn.execute(select(tasks).where(tasks.c.space_id == sid)
                                 .order_by(tasks.c.created_at, tasks.c.id)).mappings().all()
        event_rows = conn.execute(select(events).where(events.c.space_id == sid)
                                  .order_by(events.c.task_id)).mappings().all()
        call_rows = conn.execute(select(calls)).all()
        integrity = conn.exec_driver_sql('PRAGMA integrity_check').scalar()
    assert integrity == 'ok', 'Database integrity check failed'
    assert len(call_rows) == 0, 'Offline check unexpectedly created a provider ledger'
    assert all(row['state'] == 'done' for row in task_rows), 'Task did not finish'
    assert len(event_rows) == len(task_rows), 'Missing or duplicated completion event'
    assert len({row['task_id'] for row in event_rows}) == len(event_rows), 'Duplicate event'
    counts = Counter(row['day'] for row in task_rows if row['source'] == 'offline')
    assert all(n <= 2 for n in counts.values()), 'Unwatched daily limit exceeded'
    stamps = [row['created_at'] for row in task_rows]
    assert all(b - a >= 600 for a, b in zip(stamps, stamps[1:])), 'Cadence exceeded'
    payload = [dict(row) for row in task_rows] + [dict(row) for row in event_rows]
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
    return dict(tasks=len(task_rows), events=len(event_rows),
                offline_tasks=sum(counts.values()), offline_days=len(counts),
                max_daily_offline=max(counts.values(), default=0),
                min_interval=min((b-a for a, b in zip(stamps, stamps[1:])), default=None),
                provider_requests=0, sqlite_integrity=integrity, digest=digest)


def tick(runtime):
    async def execute(owner, sid, tid):
        runtime.run_fixture(owner, sid, tid)
    asyncio.run(consume_once(runtime, execute))


def subprocess_check(path, now, expected):
    result = subprocess.run([sys.executable, '-m', 'scripts.check_life_soak',
                             '_verify', '--run', str(path), '--now', str(now)],
                            cwd=PROJECT / 'backend', capture_output=True,
                            text=True, timeout=30, check=True)
    assert json.loads(result.stdout) == expected, 'Independent process disagrees with stored state'


def stop_and_verify(runtime, state):
    sid = state['sid']
    before = facts(runtime, sid)
    revision = runtime.snapshot(OWNER, sid).automatic.revision
    runtime.save_automatic(OWNER, sid, str(uuid4()), revision, False)
    tick(runtime)
    assert facts(runtime, sid) == before, 'Stopped policy created new activity'
    assert not runtime.snapshot(OWNER, sid).automatic.enabled
    return before


def accelerated(path, days=30):
    if not 1 <= days <= 90:
        raise ValueError('Accelerated duration must be 1–90 days')
    with no_network():
        # Fixed Beijing midnight: each case covers complete natural days.
        clock = [int(datetime(2026, 10, 1, tzinfo=TZ).timestamp())]
        state = seed(path, 'accelerated', 0, clock[0])
        runtime = open_kernel(path, lambda: clock[0])
        try:
            for day in range(days):
                # Two unviewed rounds and a daily six-round watched window.
                lease = str(uuid4())
                for slot in range(144):
                    clock[0] = int(datetime(2026, 10, 1, tzinfo=TZ).timestamp()) + day*86400 + slot*600
                    if 12 <= slot < 18:
                        runtime.save_viewing(OWNER, state['sid'], lease, 1, True)
                    if slot == 12:
                        with ThreadPoolExecutor(max_workers=3) as pool:
                            list(pool.map(lambda _: runtime.schedule_automatic(), range(3)))
                    tick(runtime)
                    state['scans'] += 1
                expected = facts(runtime, state['sid'])
                assert expected['tasks'] == (day+1)*8, 'Watched/unwatched daily coverage differs'
                assert expected['offline_tasks'] == (day+1)*2
                # Reopen the engine and independently start another Python process.
                runtime.engine.dispose()
                runtime = open_kernel(path, lambda: clock[0])
                assert facts(runtime, state['sid']) == expected
                subprocess_check(path, clock[0], expected)
                state['engine_reopens'] += 1
                state['subprocess_checks'] += 1
                state['simulated_days'] = day+1
                save(path / 'state.json', state)
            # A 3-day service absence creates at most one current round, no catch-up.
            clock[0] += 3*86400
            before = facts(runtime, state['sid'])['tasks']
            tick(runtime)
            assert facts(runtime, state['sid'])['tasks'] == before+1, 'Absent days were backfilled'
            state['absence_days'] = 3
            state['facts'] = stop_and_verify(runtime, state)
            state.update(status='passed', finished_at=int(time.time()),
                         wall_elapsed_seconds=int(time.time())-state['started_at'])
            save(path / 'state.json', state)
            return public_status(state)
        except Exception as exc:
            state.update(status='failed', error_type=type(exc).__name__)
            save(path / 'state.json', state)
            raise
        finally:
            runtime.engine.dispose()


def public_status(state):
    return {k: v for k, v in state.items() if k != 'sid'}


def read_status(path):
    state = json.loads((path/'state.json').read_text(encoding='utf-8'))
    value = public_status(state)
    if state['mode'] == 'wall-clock' and state['status'] == 'running':
        active = False
        if (path/'runner.lock').is_file():
            with (path/'runner.lock').open('rb') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    active = True
        value['process_lock_held'] = active
        value['execution_state'] = 'running' if active else 'interrupted'
    return value


def wall_clock(path, seconds=86400, resume=False, poll_seconds=60):
    if not 1 <= seconds <= 7*86400 or poll_seconds <= 0:
        raise ValueError('Invalid wall-clock duration or polling interval')
    checked_run(path)
    if resume:
        state = json.loads((path / 'state.json').read_text(encoding='utf-8'))
        if state['mode'] != 'wall-clock' or state['status'] != 'running':
            raise ValueError('Only a running wall-clock check can resume')
    else:
        with no_network():
            state = seed(path, 'wall-clock', seconds)
    with (path / 'runner.lock').open('a') as lock, no_network():
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads((path / 'state.json').read_text(encoding='utf-8'))
        if state['status'] != 'running':
            raise ValueError('Run is already finished')
        if resume and state.get('pid'):
            state['resumes'] += 1
        state['largest_observation_gap_seconds'] = max(
            state['largest_observation_gap_seconds'],
            int(time.time()) - state.get('last_checked_at', state['started_at']))
        state['pid'] = os.getpid()
        save(path / 'state.json', state)
        runtime = None
        try:
            runtime = open_kernel(path, lambda: int(time.time()))
            while time.time() < state['deadline']:
                state['largest_observation_gap_seconds'] = max(
                    state['largest_observation_gap_seconds'],
                    int(time.time()) - state.get('last_checked_at', state['started_at']))
                tick(runtime)
                state['scans'] += 1
                state['facts'] = facts(runtime, state['sid'])
                state['last_checked_at'] = int(time.time())
                state['wall_elapsed_seconds'] = int(time.time())-state['started_at']
                save(path / 'state.json', state)
                # Deadline persists; downtime counts as absence, never added duration.
                time.sleep(min(poll_seconds, max(0, state['deadline']-time.time())))
            state['facts'] = stop_and_verify(runtime, state)
            subprocess_check(path, int(time.time()), state['facts'])
            state['subprocess_checks'] += 1
            # Elapsed time alone is insufficient if the process was absent.
            gap = int(time.time()) - state.get('last_checked_at', state['started_at'])
            state['largest_observation_gap_seconds'] = max(state['largest_observation_gap_seconds'], gap)
            continuous = state['scans'] > 0 and state['largest_observation_gap_seconds'] <= 120
            state.update(status='passed' if continuous else 'completed_with_gaps', finished_at=int(time.time()),
                         wall_elapsed_seconds=int(time.time())-state['started_at'])
            save(path / 'state.json', state)
            return public_status(state)
        except Exception as exc:
            state.update(status='failed', error_type=type(exc).__name__)
            save(path / 'state.json', state)
            raise
        finally:
            if runtime is not None:
                runtime.engine.dispose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['accelerated', 'wall-clock', 'launch', 'status', '_verify'], default='accelerated', nargs='?')
    parser.add_argument('--run', type=Path, required=True)
    parser.add_argument('--days', type=int, default=30)
    parser.add_argument('--seconds', type=int, default=86400)
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--now', type=int)
    args = parser.parse_args()
    path = checked_run(args.run)
    if args.mode == 'launch':
        if args.resume:
            state = json.loads((path / 'state.json').read_text(encoding='utf-8'))
            if state['mode'] != 'wall-clock' or state['status'] != 'running':
                raise ValueError('Only a running wall-clock check can resume')
            with (path/'runner.lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:
            with no_network():
                state = seed(path, 'wall-clock', args.seconds)
        temp = path/'tmp'
        temp.mkdir(exist_ok=True)
        with (path/'runner.log').open('a') as log:
            process = subprocess.Popen([sys.executable, '-m', 'scripts.check_life_soak',
                'wall-clock', '--run', str(path), '--resume'], cwd=PROJECT/'backend',
                env={**os.environ, 'TMPDIR': str(temp)}, stdin=subprocess.DEVNULL,
                stdout=log, stderr=log, start_new_session=True)
        value = dict(status='launched', pid=process.pid, deadline=state['deadline'],
                     evidence_origin='offline_fixture', provider_requests=0)
    elif args.mode == 'status':
        value = read_status(path)
    elif args.mode == '_verify':
        state = json.loads((path / 'state.json').read_text(encoding='utf-8'))
        with no_network():
            runtime = open_kernel(path, lambda: args.now)
            try:
                value = facts(runtime, state['sid'])
            finally:
                runtime.engine.dispose()
    elif args.mode == 'accelerated':
        value = accelerated(path, args.days)
    else:
        value = wall_clock(path, args.seconds, args.resume)
    print(json.dumps(value, ensure_ascii=False))


if __name__ == '__main__':
    main()
