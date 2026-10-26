"""Scoped adapters from a fixed acceptance window to the real business kernels.

The two databases are dedicated acceptance data, never the application's DB.
No grants, credentials, model requests or production policies are created here.
"""
from __future__ import annotations

import hashlib
from contextlib import closing
import json
from pathlib import Path
import sqlite3
from uuid import uuid4

from sqlalchemy import create_engine, select

from app.living.life_runtime import LifeRuntime
from app.living.life_provider import RESERVE_MICRO
from app.living.life_live_planner import run_real_planner
from app.living.gathering_automatic import AutomaticDialogueStore
from app.living.gathering_dialogue import run_exchange, tasks as dialogue_tasks
from app.services.life_trial_window import LifeWork
from app.services.trial_gate import TrialBlocked


def business_facts(directory):
    """Read-only counters and digest; no message, persona or provider body escapes."""
    directory = Path(directory)
    digest = hashlib.sha256()
    counts = {}
    tables = {
        'private': ('life_runtime_events', 'life_runtime_tasks', 'life_runtime_calls'),
        'shared': ('life_dialogue_tasks', 'life_gatherings'),
    }
    for kind, names in tables.items():
        path = directory / (kind + '.db')
        if path.is_symlink() or not path.is_file():
            raise TrialBlocked('isolated_business_database_required')
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise TrialBlocked('business_sqlite_invalid')
            for name in names:
                rows = db.execute('SELECT * FROM ' + name + ' ORDER BY rowid').fetchall()
                digest.update(json.dumps([kind, name, rows], sort_keys=True, default=str).encode())
            counts[kind] = db.execute(
                'SELECT count(*) FROM life_runtime_events' if kind == 'private' else
                "SELECT count(*) FROM life_dialogue_tasks WHERE state='done'").fetchone()[0]
    return dict(private_events=counts['private'], shared_events=counts['shared'],
                digest=digest.hexdigest(), sqlite_integrity='ok')


class AcceptanceHooks:
    def __init__(self, directory, factories, scope, *, stop_requested=lambda: False):
        self.directory = Path(directory).resolve()
        self.factories, self.scope = factories, scope
        self.stop_requested = stop_requested
        self.owner = scope['owner']
        self.sid, self.gid = scope['private_subject'], scope['shared_subject']
        expected = {'private_life': {'owner': self.owner, 'subject': self.sid},
                    'shared_life': {'owner': self.owner, 'subject': self.gid}}
        if factories.gate.policy['scopes'] != expected:
            raise TrialBlocked('scope_mismatch')
        paths = [self.directory / (kind + '.db') for kind in ('private', 'shared')]
        for path in paths:
            if not path.is_file() or path.is_symlink() or path.stat().st_mode & 0o077:
                raise TrialBlocked('isolated_business_database_required')
        self.engines = [create_engine('sqlite:///' + str(path)) for path in paths]
        clock = lambda: int(factories.gate.clock())
        self.runtime = LifeRuntime(self.engines[0], clock, origin='real_provider')
        self.shared = AutomaticDialogueStore(self.engines[1], clock)
        try:
            self.validate_scope()
        except BaseException:
            self.close()
            raise

    def validate_scope(self):
        # Global kernel scans are safe only in these narrowly seeded databases.
        for engine, ids in zip(self.engines, [[self.scope['private_character_id']],
                                             self.scope['shared_character_ids']]):
            with engine.connect() as db:
                rows = db.exec_driver_sql('SELECT id,owner_id,status FROM characters').fetchall()
                if ({str(row[0]) for row in rows} != {str(cid) for cid in ids}
                        or any(row[1] != self.owner or row[2] != 'ready' for row in rows)):
                    raise TrialBlocked('isolated_character_scope_mismatch')
        with self.engines[0].connect() as db:
            rows = db.exec_driver_sql('SELECT id,owner_id,companion_id FROM living_spaces').fetchall()
            if (len(rows) != 1 or rows[0][0] != self.sid or rows[0][1] != self.owner
                    or str(rows[0][2]) != str(self.scope['private_character_id'])):
                raise TrialBlocked('isolated_private_scope_mismatch')
        with self.engines[1].connect() as db:
            rows = db.exec_driver_sql('SELECT id FROM life_gatherings').fetchall()
            if len(rows) != 1 or rows[0][0] != self.gid:
                raise TrialBlocked('isolated_shared_scope_mismatch')
        self.runtime.snapshot(self.owner, self.sid)
        self.shared.status(self.owner, self.gid)

    async def catalog(self):
        # The outer trial gate separately validates fresh account/price proofs.
        return {'model': 'qwen3.8-flash', 'reserve_micro': RESERVE_MICRO}

    def prepare(self, kind):
        if self.stop_requested():
            return None
        self.validate_scope()
        if kind == 'private_life':
            self.runtime.schedule_automatic()
            specs = self.runtime.dispatched_tasks()
            if not specs:
                return None
            if len(specs) != 1 or specs[0].space_id != self.sid or specs[0].owner_id != self.owner:
                raise TrialBlocked('scoped_private_task_required')
            spec = specs[0]
            tid = spec.basis.plan_id

            async def perform(adapter):
                await run_real_planner(self.runtime, self.owner, self.sid, tid,
                                       lambda: adapter, self.catalog)
                return self.runtime.read_task(self.owner, self.sid, tid).state == 'done'

            return LifeWork(self.owner, self.sid, tid,
                            'visible' if spec.source == 'viewing' else 'away', perform)
        if kind != 'shared_life':
            raise TrialBlocked('scope_mismatch')
        before = self.shared.status(self.owner, self.gid)['today_count']
        task = self.shared.claim_next()
        if task is None:
            return None
        if task['group_id'] != self.gid or task['owner_id'] != self.owner:
            raise TrialBlocked('scoped_shared_task_required')
        away = self.shared.status(self.owner, self.gid)['today_count'] > before

        async def perform(adapter):
            await run_exchange(self.shared, task, lambda: adapter, self.catalog)
            with self.engines[1].connect() as db:
                return db.execute(select(dialogue_tasks.c.state).where(
                    dialogue_tasks.c.id == task['id'])).scalar() == 'done'

        return LifeWork(self.owner, self.gid, task['id'], 'away' if away else 'visible', perform)

    def observe(self):
        return business_facts(self.directory)

    def stop(self):
        policy = self.runtime.snapshot(self.owner, self.sid).automatic
        if policy.enabled:
            self.runtime.save_automatic(self.owner, self.sid, str(uuid4()), policy.revision, False)
        setting = self.shared.status(self.owner, self.gid)
        if setting['enabled']:
            self.shared.configure(self.owner, self.gid, str(uuid4()), setting['revision'], False)
        return (not self.runtime.snapshot(self.owner, self.sid).automatic.enabled
                and not self.shared.status(self.owner, self.gid)['enabled'])

    def close(self):
        for engine in self.engines:
            engine.dispose()
