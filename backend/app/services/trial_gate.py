"""Finite acceptance batches. No credentials, activation, clock reset or refunds.

Only an operator holding a new, specific approval may create a real ledger.
Opening an existing ledger never grants anything and never resumes a failure.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time

from app.services.daily_model_quota import DailyModelQuota

if not __debug__:
    raise RuntimeError('trial_guards_require_unoptimized_python')

PROFILES = {
    'voice_text': ('maas', 'qwen3.8-flash', 1_145_600),
    'voice_tts': ('bailian', 'qwen3-tts-flash', 54_400),
    'private_life': ('maas', 'qwen3.8-flash', 1_145_600),
    'shared_life': ('maas', 'qwen3.8-flash', 1_145_600),
}
PRICE_CAPS = {'maas': {'input_per_million': 800_000, 'output_per_million': 2_700_000},
              'bailian': {'characters_per_10000': 800_000}}


class TrialBlocked(RuntimeError):
    """Codes only: never put a provider response or user content in the error."""


def integer(value, minimum=0):
    return type(value) is int and value >= minimum


def validate_policy(p):
    try:
        fields = {'approved', 'authorization_ref', 'mode', 'starts_at', 'ends_at', 'scopes', 'budget_micro', 'accounts', 'credentials'}
        single = p.get('mode') == 'shared_dialogue'
        assert set(p) == fields | ({'character_ids', 'max_requests'} if single else set())
        assert p['approved'] is True
        assert isinstance(p['authorization_ref'], str) and 8 <= len(p['authorization_ref']) <= 120
        assert p['mode'] in ('voice', 'life', 'shared_dialogue')
        assert integer(p['starts_at']) and integer(p['ends_at'])
        duration = p['ends_at'] - p['starts_at']
        assert duration == 86400 if p['mode'] == 'life' else 0 < duration <= (900 if single else 86400)
        assert integer(p['budget_micro'], 1)
        assert p['budget_micro'] <= (1_200_000 if single else 2_400_000 if p['mode'] == 'voice' else 7_000_000)
        kinds = {'shared_life'} if single else {'voice_text', 'voice_tts'} if p['mode'] == 'voice' else {'private_life', 'shared_life'}
        if single:
            assert p['authorization_ref'].startswith('shared-dialogue-')
            assert type(p['max_requests']) is int and p['max_requests'] == 1
            assert isinstance(p['character_ids'], list) and len(p['character_ids']) == 2
            assert all(type(cid) is int and cid > 0 for cid in p['character_ids'])
            assert len(set(p['character_ids'])) == 2
            assert p['budget_micro'] >= PROFILES['shared_life'][2]
        vendors = {PROFILES[k][0] for k in kinds}
        assert set(p['accounts']) == set(p['credentials']) == vendors
        assert all(isinstance(v, str) and 0 < len(v) <= 128 for v in p['accounts'].values())
        assert all(isinstance(v, str) and len(v) == 64 and all(c in '0123456789abcdef' for c in v)
                   for v in p['credentials'].values())
        assert isinstance(p['scopes'], dict) and set(p['scopes']) == kinds
        for scope in p['scopes'].values():
            assert set(scope) == {'owner', 'subject'}
            assert all(isinstance(v, str) and 0 < len(v) <= 128 for v in scope.values())
        if p['mode'] == 'voice':
            assert p['scopes']['voice_text'] == p['scopes']['voice_tts']
    except (AssertionError, KeyError, TypeError, ValueError, AttributeError):
        raise TrialBlocked('approval_invalid') from None
    return p


class TrialGate:
    def __init__(self, path, daily: DailyModelQuota, *, clock=time.time):
        self.path, self.daily, self.clock = Path(path), daily, clock
        if (not self.path.is_file() or self.path.is_symlink() or daily.limit != 30
                or self.path.resolve() == daily.path.resolve() or self.path.samefile(daily.path)
                or str(self.path.resolve()).startswith(str(daily.path.resolve()) + '-')):
            raise TrialBlocked('ledger_or_daily_guard_invalid')
        with self.connection() as db:
            row = db.execute('SELECT policy FROM batch WHERE id=1').fetchone()
        if row is None:
            raise TrialBlocked('approval_missing')
        self.policy = validate_policy(json.loads(row[0]))
        if self.policy['mode'] == 'shared_dialogue' and self.path.stat().st_mode & 0o077:
            raise TrialBlocked('private_ledger_required')
        digest = hashlib.sha256(row[0].encode()).hexdigest()
        with daily.connection() as db:
            binding = db.execute('SELECT path,policy_digest FROM acceptance_authorizations WHERE ref=?',
                                 (self.policy['authorization_ref'],)).fetchone()
        if binding != (str(self.path.resolve()), digest):
            raise TrialBlocked('approval_binding_changed')

    @classmethod
    def create(cls, path, daily, policy, *, clock=time.time):
        validate_policy(policy)
        path = Path(path)
        if policy['mode'] == 'shared_dialogue':
            # Serialize the approval binding before exclusive file creation. A
            # concurrent duplicate approval must not leave another live ledger.
            frozen = json.dumps(policy, sort_keys=True)
            with daily.connection() as binding:
                binding.execute('BEGIN IMMEDIATE')
                binding.execute('CREATE TABLE IF NOT EXISTS acceptance_authorizations(ref TEXT PRIMARY KEY,path TEXT NOT NULL,policy_digest TEXT NOT NULL)')
                if binding.execute('SELECT 1 FROM acceptance_authorizations WHERE ref=?',
                                   (policy['authorization_ref'],)).fetchone():
                    raise TrialBlocked('approval_already_used')
                with path.open('xb'):
                    pass
                path.chmod(0o600)
                with sqlite3.connect(path) as db:
                    db.execute('PRAGMA synchronous=FULL')
                    db.execute('CREATE TABLE batch(id INTEGER PRIMARY KEY, policy TEXT NOT NULL, state TEXT NOT NULL)')
                    db.execute('INSERT INTO batch VALUES(1,?,?)', (frozen, 'active'))
                    db.execute('''CREATE TABLE attempts(
                        operation TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL,
                        presence TEXT NOT NULL, started_at INTEGER NOT NULL, reserve_micro INTEGER NOT NULL,
                        state TEXT NOT NULL, daily_id TEXT, PRIMARY KEY(operation,kind))''')
                binding.execute('INSERT INTO acceptance_authorizations VALUES(?,?,?)',
                                (policy['authorization_ref'], str(path.resolve()), hashlib.sha256(frozen.encode()).hexdigest()))
            return cls(path, daily, clock=clock)
        # Exclusive creation preserves all old approvals and outcomes.
        with path.open('xb'):
            pass
        path.chmod(0o600)
        with sqlite3.connect(path) as db:
            db.execute('PRAGMA synchronous=FULL')
            db.execute('CREATE TABLE batch(id INTEGER PRIMARY KEY, policy TEXT NOT NULL, state TEXT NOT NULL)')
            db.execute('INSERT INTO batch VALUES(1,?,?)', (json.dumps(policy, sort_keys=True), 'active'))
            db.execute('''CREATE TABLE attempts(
                operation TEXT NOT NULL, kind TEXT NOT NULL, digest TEXT NOT NULL,
                presence TEXT NOT NULL, started_at INTEGER NOT NULL, reserve_micro INTEGER NOT NULL,
                state TEXT NOT NULL, daily_id TEXT, PRIMARY KEY(operation,kind))''')
        frozen = json.dumps(policy, sort_keys=True)
        with daily.connection() as db:
            db.execute('CREATE TABLE IF NOT EXISTS acceptance_authorizations(ref TEXT PRIMARY KEY,path TEXT NOT NULL,policy_digest TEXT NOT NULL)')
            try:
                db.execute('INSERT INTO acceptance_authorizations VALUES(?,?,?)',
                           (policy['authorization_ref'], str(path.resolve()), hashlib.sha256(frozen.encode()).hexdigest()))
            except sqlite3.IntegrityError:
                raise TrialBlocked('approval_already_used') from None
        return cls(path, daily, clock=clock)

    @contextmanager
    def connection(self):
        # Never create a missing ledger or follow a substituted leaf symlink.
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
            identity = os.fstat(fd)
            if (not stat.S_ISREG(identity.st_mode)
                    or (getattr(self, 'policy', {}).get('mode') == 'shared_dialogue' and identity.st_mode & 0o077)):
                raise OSError()
        except OSError:
            if 'fd' in locals():
                os.close(fd)
            raise TrialBlocked('private_ledger_required') from None
        db = None
        try:
            db = sqlite3.connect(self.path.absolute().as_uri() + '?mode=rw', uri=True, timeout=10)
            current = self.path.lstat()
            if (current.st_dev, current.st_ino) != (identity.st_dev, identity.st_ino):
                raise TrialBlocked('ledger_identity_changed')
        except BaseException:
            if db is not None:
                db.close()
            os.close(fd)
            raise
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        try:
            with db:
                yield db
        finally:
            db.close()
            os.close(fd)

    @contextmanager
    def single_dispatch(self):
        lock = self.path.with_suffix('.dispatch.lock')
        if lock.is_symlink():
            raise TrialBlocked('lock_invalid')
        with lock.open('a') as handle:
            try:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise TrialBlocked('dispatch_busy') from None
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def preflight_evidence(self, reader):
        """Read-only startup/send check for all vendors, before any paid leg."""
        now = int(self.clock())
        state = self.summary()
        if state['state'] != 'active' or state['unknown'] or not self.policy['starts_at'] <= now < self.policy['ends_at']:
            raise TrialBlocked('trial_not_ready')
        try:
            for kind in self.policy['scopes']:
                vendor, model, reserve = PROFILES[kind]
                value = reader(kind)
                if self.policy['mode'] == 'shared_dialogue':
                    self._single_evidence(value, now)
                wallet, price = value['wallet'], value['price']
                assert wallet['account'] == self.policy['accounts'][vendor]
                for record in (wallet, price):
                    assert record['verified'] is True and record['vendor'] == vendor and record['currency'] == 'CNY'
                    assert record['authorization_ref'] == self.policy['authorization_ref']
                    assert integer(record['checked_at']) and 0 <= now-record['checked_at'] <= 900
                assert price['model'] == model and set(price['rates']) == set(PRICE_CAPS[vendor])
                assert all(integer(v) and v <= PRICE_CAPS[vendor][k] for k,v in price['rates'].items())
                assert integer(wallet['available_micro']) and integer(wallet['pending_micro'])
                with self.connection() as db:
                    retained = sum(r['reserve_micro'] for r in db.execute('SELECT kind,reserve_micro FROM attempts')
                                   if PROFILES[r['kind']][0] == vendor)
                assert wallet['available_micro']-wallet['pending_micro']-retained >= reserve
        except Exception:
            raise TrialBlocked('funds_or_price_unverified') from None

    def _single_evidence(self, evidence, now):
        from app.services.trial_admission import validate_evidence
        admission = validate_evidence({'shared_life': evidence}, self.policy['authorization_ref'],
                                      ('shared_life',), now, {'maas': PROFILES['shared_life'][2]})
        if self.policy['ends_at'] > admission['expires_at']:
            raise TrialBlocked('trial_exceeds_financial_proof')

    def stop(self, code='stopped'):
        # Terminal; a fresh approval must use a different ledger.
        with self.connection() as db:
            db.execute("UPDATE batch SET state='stopped' WHERE id=1 AND state='active'")
        raise TrialBlocked(code)

    def _halt(self, db, code):
        db.execute("UPDATE batch SET state='stopped' WHERE id=1")
        db.commit()
        raise TrialBlocked(code)

    def reserve(self, kind, owner, subject, operation, payload, evidence, *, presence='visible'):
        """Called inside single_dispatch, immediately before the sole outbound POST."""
        now, p = int(self.clock()), self.policy
        if (kind not in p['scopes'] or p['scopes'][kind] != {'owner': owner, 'subject': subject}
                or not isinstance(operation, str) or not 8 <= len(operation) <= 128
                or presence not in ('visible', 'away')):
            raise TrialBlocked('scope_mismatch')
        vendor, model, reserve = PROFILES[kind]
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT state FROM batch').fetchone()[0] != 'active':
                raise TrialBlocked('batch_stopped')
            if not p['starts_at'] <= now < p['ends_at']:
                self._halt(db, 'outside_window')
            if db.execute('SELECT 1 FROM attempts WHERE operation=? AND kind=?', (operation, kind)).fetchone():
                raise TrialBlocked('already_attempted')
            pending = db.execute("SELECT daily_id FROM attempts WHERE state='in_flight'").fetchall()
            if pending:
                db.execute("UPDATE attempts SET state='unknown' WHERE state='in_flight'")
                self._halt(db, 'interrupted_unknown')
            rows = db.execute('SELECT * FROM attempts ORDER BY started_at,rowid').fetchall()
            if p['mode'] == 'shared_dialogue' and len(rows) >= p['max_requests']:
                self._halt(db, 'window_count_exhausted')
            group = [r for r in rows if r['kind'] == kind]
            if len(group) >= (2 if p['mode'] == 'voice' else 3):
                raise TrialBlocked('window_count_exhausted')
            if sum(r['reserve_micro'] for r in rows) + reserve > p['budget_micro']:
                self._halt(db, 'window_budget_exhausted')
            if kind == 'voice_tts' and not any(r['operation'] == operation and r['kind'] == 'voice_text'
                                             and r['state'] == 'succeeded' for r in rows):
                raise TrialBlocked('text_prerequisite_missing')
            if p['mode'] == 'life':
                if sum(r['presence'] == presence for r in group) >= (1 if presence == 'visible' else 2):
                    raise TrialBlocked('presence_count_exhausted')
                if group and now - group[-1]['started_at'] < 600:
                    raise TrialBlocked('minimum_interval')
            try:
                if p['mode'] == 'shared_dialogue':
                    self._single_evidence(evidence, now)
                wallet, price = evidence['wallet'], evidence['price']
                assert wallet['account'] == p['accounts'][vendor]
                for record in (wallet, price):
                    assert record['verified'] is True and record['vendor'] == vendor
                    assert record['currency'] == 'CNY' and record['authorization_ref'] == p['authorization_ref']
                    assert integer(record['checked_at']) and 0 <= now - record['checked_at'] <= 900
                assert price['model'] == model and set(price['rates']) == set(PRICE_CAPS[vendor])
                assert all(integer(v) and v <= PRICE_CAPS[vendor][k] for k, v in price['rates'].items())
                assert integer(wallet['available_micro']) and integer(wallet['pending_micro'])
                retained = sum(r['reserve_micro'] for r in rows if PROFILES[r['kind']][0] == vendor)
                assert wallet['available_micro'] - wallet['pending_micro'] - retained >= reserve
            except (KeyError, TypeError, AssertionError, TrialBlocked):
                self._halt(db, 'funds_or_price_unverified')
            db.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,NULL)',
                       (operation, kind, hashlib.sha256(payload).hexdigest(), presence, now, reserve, 'in_flight'))
        try:
            daily_id = self.daily.reserve()
        except Exception:
            self.finish(operation, kind, False)
            raise TrialBlocked('daily_guard_blocked') from None
        with self.connection() as db:
            db.execute('UPDATE attempts SET daily_id=? WHERE operation=? AND kind=?', (daily_id, operation, kind))
        return daily_id

    def abort(self, operation, kind):
        with self.connection() as db:
            row = db.execute('SELECT daily_id FROM attempts WHERE operation=? AND kind=?', (operation, kind)).fetchone()
            db.execute("UPDATE attempts SET state='unknown' WHERE operation=? AND kind=?", (operation, kind))
            db.execute("UPDATE batch SET state='stopped' WHERE id=1")
        if row and row['daily_id']:
            self.daily.finish(row['daily_id'], None)

    def finish(self, operation, kind, success, status=None, *, usage=None):
        with self.connection() as db:
            row = db.execute('SELECT * FROM attempts WHERE operation=? AND kind=?', (operation, kind)).fetchone()
            if not row or row['state'] != 'in_flight':
                raise TrialBlocked('attempt_not_pending')
            if usage is not None:
                required = {'model', 'characters'} if kind == 'voice_tts' else {
                    'model', 'prompt_tokens', 'completion_tokens', 'total_tokens'}
                if (not success or set(usage) != required or usage['model'] != PROFILES[kind][1]
                        or any(not integer(v) for k, v in usage.items() if k != 'model')
                        or (kind != 'voice_tts' and usage['total_tokens'] != usage['prompt_tokens'] + usage['completion_tokens'])):
                    raise TrialBlocked('usage_invalid')
                db.execute('CREATE TABLE IF NOT EXISTS provider_usage(operation TEXT NOT NULL,kind TEXT NOT NULL,'
                           'usage_json TEXT NOT NULL,verified_at INTEGER NOT NULL,status INTEGER,'
                           'PRIMARY KEY(operation,kind))')
                db.execute('INSERT INTO provider_usage VALUES(?,?,?,?,?)',
                           (operation, kind, json.dumps(usage, sort_keys=True), int(self.clock()), status))
            db.execute('UPDATE attempts SET state=? WHERE operation=? AND kind=?',
                       ('succeeded' if success else 'unknown', operation, kind))
            if not success:
                db.execute("UPDATE batch SET state='stopped' WHERE id=1")
            elif self.policy['mode'] == 'shared_dialogue':
                db.execute("UPDATE batch SET state='completed' WHERE id=1")
        if row['daily_id']:
            self.daily.finish(row['daily_id'], status)

    def usage(self):
        """Verified supplier usage only; never claim this is a cash invoice."""
        with self.connection() as db:
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_usage'").fetchone()
            rows = db.execute('SELECT * FROM provider_usage ORDER BY verified_at,operation,kind').fetchall() if exists else []
        return {'origin': 'provider_response_usage', 'actual_bill_verified': False,
                'actual_bill_micro': None, 'records': [
                    dict(operation=r['operation'], kind=r['kind'], **json.loads(r['usage_json']),
                         verified_at=r['verified_at'], status=r['status']) for r in rows]}

    def summary(self):
        with self.connection() as db:
            state = db.execute('SELECT state FROM batch').fetchone()[0]
            rows = db.execute('SELECT kind,state,reserve_micro FROM attempts').fetchall()
        return {'state': state, 'attempts': len(rows), 'reserved_micro': sum(r['reserve_micro'] for r in rows),
                'counts': {k: sum(r['kind'] == k for r in rows) for k in self.policy['scopes']},
                'unknown': sum(r['state'] in ('unknown', 'in_flight') for r in rows)}
