"""Fixed-window control for explicitly bounded life acceptance.

No CLI, credentials, grants, worker registration or policy enabling here.
Business hooks must prepare existing scoped work, verify durable completion and
stop their own policies. Accelerated tests retain an explicit mock origin.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
from typing import Awaitable, Callable

from app.services.trial_gate import TrialBlocked
from app.services.trial_wiring import preflight

KINDS = ('private_life', 'shared_life')
TERMINAL = ('passed', 'failed', 'stopped')


@dataclass(frozen=True)
class LifeWork:
    owner: str
    subject: str
    operation: str
    presence: str
    perform: Callable[[object], Awaitable[bool]]


class LifeWindow:
    def __init__(self, path, factories, prepare_work, observe, stop_work, *, origin):
        self.path = Path(path)
        self.factories = factories
        self.gate = factories.gate
        self.clock = self.gate.clock
        self.prepare_work, self.observe, self.stop_work = prepare_work, observe, stop_work
        if origin not in ('mock_simulated', 'real_wall_clock') or self.gate.policy['mode'] != 'life':
            raise TrialBlocked('window_configuration_invalid')
        self.origin = origin
        if origin == 'real_wall_clock' and self.clock is not time.time:
            raise TrialBlocked('real_clock_required')
        if self.path.is_symlink() or not self.path.is_file() or self.path.stat().st_mode & 0o077:
            raise TrialBlocked('original_private_window_required')
        with self.connect() as db:
            s = self.state(db)
            if s['binding'] != self.binding():
                raise TrialBlocked('window_binding_changed')
        marker = self.gate.path.with_suffix(self.gate.path.suffix + '.life-window-binding.json')
        if marker.is_symlink() or json.loads(marker.read_text()) != self.binding():
            raise TrialBlocked('window_binding_changed')

    def binding(self):
        return {'policy_sha256': hashlib.sha256(json.dumps(self.gate.policy, sort_keys=True).encode()).hexdigest(),
                'ledger': str(self.gate.path.resolve()), 'window': str(self.path.resolve()), 'origin': self.origin}

    @classmethod
    def create(cls, path, factories, prepare_work, observe, stop_work, *, origin):
        path = Path(path)
        if factories.gate.policy['mode'] != 'life' or origin not in ('mock_simulated', 'real_wall_clock'):
            raise TrialBlocked('window_configuration_invalid')
        if origin == 'real_wall_clock' and factories.gate.clock is not time.time:
            raise TrialBlocked('real_clock_required')
        obj = object.__new__(cls)
        obj.path, obj.gate, obj.origin = path, factories.gate, origin
        # One original control window per frozen approval, including after DB
        # loss. A fresh filename must not create a second observation history.
        if path.exists() or path.is_symlink():
            raise FileExistsError(path)
        marker = obj.gate.path.with_suffix(obj.gate.path.suffix + '.life-window-binding.json')
        try:
            fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            raise TrialBlocked('window_already_bound') from None
        with os.fdopen(fd, 'w') as handle:
            json.dump(obj.binding(), handle, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(fd)
        state = dict(binding=obj.binding(), status='prepared', starts_at=obj.gate.policy['starts_at'],
                     deadline=obj.gate.policy['ends_at'], first_observed_at=None, last_observed_at=None,
                     max_gap_seconds=0, scans=0, in_flight=None, work_stopped=False,
                     stopped_facts=None, last_dispatch={}, operation_count=0, failure_code=None)
        with sqlite3.connect(path) as db:
            db.executescript('CREATE TABLE state (id INTEGER PRIMARY KEY, data TEXT NOT NULL);'
                             'CREATE TABLE observations (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, data TEXT NOT NULL);')
            db.execute('INSERT INTO state VALUES(1,?)', (json.dumps(state, sort_keys=True),))
        return cls(path, factories, prepare_work, observe, stop_work, origin=origin)

    def connect(self):
        if self.path.is_symlink():
            raise TrialBlocked('original_private_window_required')
        db = sqlite3.connect(self.path.resolve().as_uri() + '?mode=rw', uri=True, timeout=5)
        db.execute('PRAGMA synchronous=FULL')
        return db

    @staticmethod
    def state(db):
        return json.loads(db.execute('SELECT data FROM state WHERE id=1').fetchone()[0])

    def save(self, state):
        with self.connect() as db:
            db.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(state, sort_keys=True),))

    @contextmanager
    def lock(self):
        lock_path = self.path.with_suffix(self.path.suffix + '.lock')
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise TrialBlocked('window_already_running') from None
            yield

    def facts(self):
        # The hook exposes counters/digest only, never messages, keys or provider bodies.
        value = self.observe()
        if (set(value) != {'private_events', 'shared_events', 'digest', 'sqlite_integrity'}
                or any(type(value[k]) is not int or value[k] < 0 for k in ('private_events', 'shared_events'))
                or not isinstance(value['digest'], str) or len(value['digest']) != 64
                or any(c not in '0123456789abcdef' for c in value['digest'])
                or value['sqlite_integrity'] != 'ok'):
            raise TrialBlocked('business_evidence_invalid')
        return value

    def stop_policies(self, state):
        if not state['work_stopped']:
            # Hook must read back both persisted policies as disabled. It must
            # also be idempotent: crash before save may invoke it again.
            if self.stop_work() is not True:
                raise TrialBlocked('policy_stop_unverified')
            state['work_stopped'] = True
            state['stopped_facts'] = self.facts()
            self.save(state)

    def fail(self, state, code, *, status='failed'):
        state.update(status=status, failure_code=code)
        self.save(state)  # Fail closed even if policy teardown itself fails.
        self.stop_gate(code)
        try:
            self.stop_policies(state)
        except Exception:
            state['stop_verification_failed'] = True
            self.save(state)
        return self.report()

    def stop_gate(self, code):
        # The existing gate persists the stop and then raises deliberately.
        try:
            self.gate.stop(code)
        except TrialBlocked:
            pass

    async def tick(self):
        with self.lock():
            with self.connect() as db:
                state = self.state(db)
            if state['status'] in TERMINAL:
                return self.report()  # Never restart a terminal window.
            now = int(self.clock())
            try:
                if state['in_flight']:
                    return self.fail(state, 'interrupted_work_unknown')
                last = state['last_observed_at']
                if now < state['starts_at'] and last is None:
                    return self.report()
                gap = now - (last if last is not None else state['starts_at'])
                state['max_gap_seconds'] = max(state['max_gap_seconds'], gap)
                if gap < 0 or gap > 120:
                    return self.fail(state, 'observation_gap' if gap > 120 else 'clock_reversed')
                summary = self.gate.summary()
                if summary['state'] != 'active' or summary['unknown']:
                    return self.fail(state, 'trial_gate_stopped_or_unknown')
                state['status'] = 'running'
                if state['first_observed_at'] is None:
                    state['first_observed_at'] = now
                    with self.connect() as db:
                        db.execute('INSERT INTO observations(at,data) VALUES(?,?)',
                                   (now, json.dumps({'ended_at': now, **self.facts()}, sort_keys=True)))
                if now < state['deadline'] and not state['work_stopped']:
                    for kind in KINDS:
                        current = int(self.clock())
                        if current < now or current - (last if last is not None else now) > 120:
                            return self.fail(state, 'work_observation_gap')
                        if current >= state['deadline']:
                            break
                        if self.gate.summary()['counts'][kind] >= 3:
                            continue
                        if now - state['last_dispatch'].get(kind, now - 600) < 600:
                            continue
                        preflight(self.gate, self.factories.reader)
                        work = self.prepare_work(kind)
                        if work is None:
                            continue
                        state['in_flight'] = {'kind': kind, 'operation_sha256': hashlib.sha256(work.operation.encode()).hexdigest()}
                        self.save(state)
                        adapter = self.factories.adapter(kind, work.owner, work.subject, work.operation, presence=work.presence)
                        before = self.gate.summary()['counts'][kind]
                        business_before = self.facts()
                        success = await work.perform(adapter)
                        after = self.gate.summary()
                        business_after = self.facts()
                        event_key = 'private_events' if kind == 'private_life' else 'shared_events'
                        other_key = 'shared_events' if kind == 'private_life' else 'private_events'
                        if (success is not True or after['unknown'] or after['counts'][kind] != before + 1
                                or business_after[event_key] != business_before[event_key] + 1
                                or business_after[other_key] != business_before[other_key]):
                            return self.fail(state, 'business_completion_unverified')
                        state['in_flight'] = None
                        state['last_dispatch'][kind] = int(self.clock())
                        state['operation_count'] += 1
                        self.save(state)
                        ended_work = int(self.clock())
                        if ended_work < current or ended_work - (last if last is not None else now) > 120:
                            return self.fail(state, 'work_observation_gap')
                    if all(n == 3 for n in self.gate.summary()['counts'].values()):
                        self.stop_policies(state)
                if now >= state['deadline']:
                    self.stop_policies(state)
                observed = self.facts()
                if state['work_stopped'] and observed != state['stopped_facts']:
                    return self.fail(state, 'business_changed_after_stop')
                ended = int(self.clock())
                duration = ended - now
                observed_gap = ended - (last if last is not None else now)
                state['max_gap_seconds'] = max(state['max_gap_seconds'], duration, observed_gap)
                if duration < 0 or observed_gap < 0 or observed_gap > 120 or duration > 120:
                    return self.fail(state, 'work_observation_gap')
                state['scans'] += 1
                state['last_observed_at'] = ended
                # Record scan START too: a long call cannot conceal a monitoring gap.
                with self.connect() as db:
                    db.execute('INSERT INTO observations(at,data) VALUES(?,?)',
                               (now, json.dumps({'ended_at': ended, **observed}, sort_keys=True)))
                if now >= state['deadline'] and now - state['first_observed_at'] >= 86400:
                    counts = self.gate.summary()['counts']
                    valid = (state['operation_count'] == 6 and all(n == 3 for n in counts.values()) and observed['private_events'] == 3
                             and observed['shared_events'] == 3 and state['max_gap_seconds'] <= 120)
                    if not valid:
                        return self.fail(state, 'window_evidence_incomplete')
                    state.update(status='passed', finished_at=ended)
                    self.save(state)
                    self.stop_gate('window_completed')
                else:
                    self.save(state)
                return self.report()
            except TrialBlocked as e:
                return self.fail(state, str(e) if str(e) in {
                    'window_not_started', 'scope_mismatch', 'trial_preflight_blocked'} else 'trial_blocked')
            except Exception:
                return self.fail(state, 'business_or_evidence_error')

    def stop(self):
        with self.lock():
            with self.connect() as db:
                state = self.state(db)
            return self.report() if state['status'] in TERMINAL else self.fail(state, 'stopped_by_operator', status='stopped')

    def report(self):
        with self.connect() as db:
            state = self.state(db)
            integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
        first, last = state['first_observed_at'], state['last_observed_at']
        return dict(status=state['status'], evidence_origin=self.origin, starts_at=state['starts_at'],
                    deadline=state['deadline'], first_observed_at=first, last_observed_at=last,
                    observed_span_seconds=0 if first is None or last is None else last-first,
                    max_gap_seconds=state['max_gap_seconds'], scans=state['scans'],
                    operation_count=state['operation_count'], failure_code=state['failure_code'],
                    work_stopped=state['work_stopped'], sqlite_integrity=integrity,
                    trial=self.gate.summary(), real_acceptance_passed=state['status']=='passed' and self.origin=='real_wall_clock')
