"""Independent, explicitly admitted life-window worker. Importing starts nothing."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager, closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import stat
import time
from types import SimpleNamespace

import httpx

from app.services.daily_model_quota import DailyModelQuota
from app.services.life_acceptance_hooks import AcceptanceHooks, business_facts
from app.services.life_trial_window import LifeWindow
from app.services.trial_gate import TrialBlocked, TrialGate
from app.services.trial_wiring import TrialLifeFactories, evidence_reader, private_json

BACKEND = Path(__file__).resolve().parents[2]
MOCK_KEY = 'life-acceptance-synthetic-not-a-credential'


def save_json(path, value, *, exclusive=False):
    path = Path(path)
    if path.is_symlink():
        raise TrialBlocked('private_acceptance_file_required')
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | (os.O_EXCL if exclusive else os.O_TRUNC)
    with os.fdopen(os.open(path, flags, 0o600), 'w') as handle:
        json.dump(value, handle, sort_keys=True)
        handle.flush()
        os.fsync(handle.fileno())


def source_manifest():
    files = sorted((BACKEND / 'app').rglob('*.py')) + [BACKEND / 'scripts/life_acceptance.py']
    return {str(p.relative_to(BACKEND)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}


@contextmanager
def process_lock(directory):
    path = Path(directory) / 'worker.lock'
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TrialBlocked('worker_already_running') from None
        original = os.fstat(handle.fileno())
        def lease_valid():
            try:
                current = path.lstat()
                return (stat.S_ISREG(current.st_mode) and current.st_mode & 0o077 == 0
                        and (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino))
            except OSError:
                return False
        yield lease_valid


def validate_directory(directory):
    directory = Path(directory)
    if (directory.is_symlink() or not directory.is_dir()
            or directory.stat().st_mode & 0o077):
        raise TrialBlocked('private_acceptance_directory_required')
    directory = directory.resolve()
    if (directory / 'worker-failure.json').exists():
        raise TrialBlocked('worker_previously_failed')
    manifest = private_json(directory / 'manifest.json')
    if (manifest.get('schema_version') != 1 or manifest.get('origin') not in
            ('mock_simulated', 'real_wall_clock') or manifest.get('limits') !=
            {'seconds': 86400, 'per_group': 3, 'total': 6, 'budget_micro': 7000000,
             'max_gap': 120, 'interval': 30, 'auto_retry': 0}):
        raise TrialBlocked('acceptance_manifest_invalid')
    if private_json(directory / 'source-manifest.json') != source_manifest():
        raise TrialBlocked('frozen_source_changed')
    expected = hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest()
    if private_json(directory / 'manifest-binding.json') != {'sha256': expected}:
        raise TrialBlocked('acceptance_manifest_changed')
    # Never open a production application DB, including through symlinks/hardlinks.
    for name in ('private.db', 'shared.db', 'trial.db', 'daily.db'):
        p = directory / name
        if not p.is_file() or p.is_symlink() or p.stat().st_mode & 0o077 or p.stat().st_nlink != 1:
            raise TrialBlocked('original_isolated_database_required')
    return directory, manifest


def record_usage(directory, kind, *, usage=None, status=None):
    value = {'kind': kind, 'http_status': status, 'usage': None}
    if isinstance(usage, dict):
        keys = ('prompt_tokens', 'completion_tokens', 'total_tokens')
        if (all(type(usage.get(k)) is int and usage[k] >= 0 for k in keys)
                and usage['prompt_tokens'] + usage['completion_tokens'] == usage['total_tokens']):
            value['usage'] = {k: usage[k] for k in keys}
    with closing(sqlite3.connect(Path(directory) / 'usage.db')) as db:
        with db:
            db.execute('CREATE TABLE IF NOT EXISTS usage (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)')
            db.execute('INSERT INTO usage(data) VALUES(?)', (json.dumps(value, sort_keys=True),))
    (Path(directory) / 'usage.db').chmod(0o600)


class UsageTransport(httpx.AsyncBaseTransport):
    """Retain only reported token counters; never response text, URL or headers."""
    def __init__(self, delegate, directory, kind):
        self.delegate, self.directory, self.kind = delegate, directory, kind

    async def handle_async_request(self, request):
        try:
            response = await self.delegate.handle_async_request(request)
            body = bytearray()
            try:
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 1024 * 1024:
                        raise TrialBlocked('response_too_large')
            finally:
                await response.aclose()
            try:
                data = json.loads(body)
                usage = data.get('usage') if isinstance(data, dict) else None
            except (ValueError, TypeError):
                usage = None
            record_usage(self.directory, self.kind, usage=usage, status=response.status_code)
            return httpx.Response(response.status_code,
                                  headers={k: v for k, v in response.headers.items()
                                           if k.lower() not in ('content-encoding', 'content-length', 'transfer-encoding')},
                                  content=bytes(body), request=request)
        except BaseException:
            record_usage(self.directory, self.kind)
            raise

    async def aclose(self):
        await self.delegate.aclose()


def mock_delegate(directory, kind, scenario, shared_ids):
    def handle(request):
        if scenario == 'timeout':
            raise httpx.ReadTimeout('synthetic')
        body = {'activity': 'rest', 'reason': '合成演练休息'} if kind == 'private_life' else {
            'lines': [{'character_id': int(cid), 'text': '合成演练看风景。', 'item_ids': []}
                      for cid in shared_ids]}
        if scenario == 'bad-json':
            body = {'invalid': True}
        usage = {'prompt_tokens': 500, 'completion_tokens': 30, 'total_tokens': 530}
        if scenario == 'bad-usage':
            usage['total_tokens'] = 1
        return httpx.Response(200, json={'model': 'qwen3.8-flash',
            'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant',
                'content': json.dumps(body, ensure_ascii=False)}}], 'usage': usage})
    return UsageTransport(httpx.MockTransport(handle), directory, kind)


def journal(directory, report):
    path = Path(directory) / 'observations.jsonl'
    with os.fdopen(os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600), 'a') as handle:
        handle.write(json.dumps(report, sort_keys=True) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    save_json(Path(directory) / 'last-report.json', report)


def audit(directory):
    """Independent read-only audit; no constructors that create grants or tables."""
    directory, manifest = validate_directory(directory)
    facts = business_facts(directory)
    with closing(sqlite3.connect((directory / 'window.db').as_uri() + '?mode=ro', uri=True)) as db:
        state = json.loads(db.execute('SELECT data FROM state WHERE id=1').fetchone()[0])
        observations = [(r[0], json.loads(r[1])) for r in db.execute('SELECT at,data FROM observations ORDER BY seq')]
        integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
    with closing(sqlite3.connect((directory / 'trial.db').as_uri() + '?mode=ro', uri=True)) as db:
        attempts = db.execute('SELECT kind,state,reserve_micro,started_at,presence,daily_id FROM attempts ORDER BY rowid').fetchall()
        policy, gate_state = db.execute('SELECT policy,state FROM batch WHERE id=1').fetchone()
        policy = json.loads(policy)
        integrity = integrity if db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok' else 'failed'
    expected_binding = {'policy_sha256': hashlib.sha256(json.dumps(policy, sort_keys=True).encode()).hexdigest(),
                        'ledger': str(directory / 'trial.db'), 'window': str(directory / 'window.db'),
                        'origin': manifest['origin']}
    binding_ok = (state['binding'] == expected_binding and
                  private_json(directory / 'trial.db.life-window-binding.json') == expected_binding)
    quota_path = (directory / 'daily.db' if manifest['origin'] == 'mock_simulated' else
                  Path(manifest['live_daily_quota_path']))
    with closing(sqlite3.connect(quota_path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        binding = db.execute('SELECT path,policy_digest FROM acceptance_authorizations WHERE ref=?',
                             (policy['authorization_ref'],)).fetchone()
        binding_ok = binding_ok and binding == (str(directory / 'trial.db'), expected_binding['policy_sha256'])
        daily_groups = db.execute('SELECT day,count(*) FROM model_attempts GROUP BY day').fetchall()
        linked = [db.execute('SELECT outcome,http_status FROM model_attempts WHERE id=?', (r[5],)).fetchone()
                  for r in attempts]
        daily_ok = (all(n <= 30 for _day, n in daily_groups) and len({r[5] for r in attempts}) == len(attempts)
                    and all(r == ('response_received', 200) for r in linked)
                    and db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok')
    stopped = []
    for kind, table in [('private', 'life_runtime_automatic'), ('shared', 'life_dialogue_automatic')]:
        with closing(sqlite3.connect((directory / (kind + '.db')).as_uri() + '?mode=ro', uri=True)) as db:
            flags = db.execute('SELECT enabled FROM ' + table).fetchall()
            stopped.append(len(flags) == 1 and flags[0][0] == 0)
    rows = [json.loads(line) for line in (directory / 'observations.jsonl').read_text().splitlines() if line]
    ordered = all(b[0] >= a[0] for a, b in zip(observations, observations[1:]))
    gap = max([0] + [r[1]['ended_at'] - r[0] for r in observations] +
              [max(b[0], b[1]['ended_at']) - a[1]['ended_at']
               for a, b in zip(observations, observations[1:])])
    span = observations[-1][1]['ended_at'] - observations[0][0] if observations else 0
    counts = {kind: sum(r[0] == kind for r in attempts) for kind in ('private_life', 'shared_life')}
    tokens, values = None, []
    if (directory / 'usage.db').is_file():
        with closing(sqlite3.connect((directory / 'usage.db').as_uri() + '?mode=ro', uri=True)) as db:
            values = [json.loads(r[0]) for r in db.execute('SELECT data FROM usage ORDER BY seq')]
        tokens = {k: sum(r['usage'][k] for r in values if r['usage'] is not None)
                  for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')}
    stopped_stable = not state['work_stopped'] or facts == state['stopped_facts']
    journal_ok = (bool(rows) and len(rows) >= state['scans']
                  and all(r['evidence_origin'] == manifest['origin'] for r in rows)
                  and all(b['last_observed_at'] >= a['last_observed_at'] for a, b in zip(rows, rows[1:])))
    passed = (state['status'] == 'passed' and integrity == 'ok' and ordered and span >= 86400
              and gap <= 120 and policy['ends_at'] - policy['starts_at'] == 86400
              and policy['starts_at'] == manifest['starts_at'] and binding_ok and daily_ok
              and state['first_observed_at'] == observations[0][0]
              and counts == {'private_life': 3, 'shared_life': 3}
              and len(attempts) == 6 and all(r[1] == 'succeeded' for r in attempts)
              and sum(r[2] for r in attempts) <= 7000000
              and facts['private_events'] == facts['shared_events'] == 3
              and stopped_stable and not state['in_flight'] and gate_state == 'stopped'
              and all(stopped) and journal_ok and rows[-1]['status'] == 'passed'
              and len(values) == 6 and all(r['usage'] is not None for r in values))
    return {'status': state['status'], 'audit_passed': passed, 'evidence_origin': manifest['origin'],
            'real_acceptance_passed': passed and manifest['origin'] == 'real_wall_clock',
            'observed_span_seconds': span, 'max_interval_seconds': gap, 'ordered': ordered,
            'sqlite_integrity': integrity, 'operation_counts': counts,
            'business_events': {k: facts[k] for k in ('private_events', 'shared_events')},
            'counts_constant_after_stop': stopped_stable, 'unknown_attempts': sum(r[1] in ('unknown', 'in_flight') for r in attempts),
            'policies_stopped': all(stopped), 'original_approval_binding_verified': binding_ok,
            'daily_limit_and_request_links_verified': daily_ok,
            'reserved_micro': sum(r[2] for r in attempts), 'reported_tokens': tokens,
            'failure_code': state['failure_code'], 'journal_rows': len(rows),
            'journal_sha256': hashlib.sha256((directory / 'observations.jsonl').read_bytes()).hexdigest()}


async def execute(directory, *, simulated=False, until=86400, stop_requested=lambda: False):
    directory, manifest = validate_directory(directory)
    if simulated != (manifest['origin'] == 'mock_simulated'):
        raise TrialBlocked('execution_origin_mismatch')
    with process_lock(directory) as lease_valid:
        existing = None
        if (directory / 'window.db').is_file():
            with closing(sqlite3.connect((directory / 'window.db').as_uri() + '?mode=ro', uri=True)) as db:
                existing = json.loads(db.execute('SELECT data FROM state WHERE id=1').fetchone()[0])
            if existing['status'] in ('passed', 'failed', 'stopped'):
                return audit(directory)
        clock_value = [manifest['starts_at'] if existing is None or existing['last_observed_at'] is None
                       else existing['last_observed_at'] + 30]
        clock = (lambda: clock_value[0]) if simulated else time.time
        quota_path = directory / 'daily.db'
        if not simulated:
            approval = private_json(directory / 'live-authorization.json')
            if (approval.get('approved_for_real_model_calls') is not True
                    or approval.get('phase') != 'life_24h' or approval.get('budget_micro') != 7000000
                    or approval.get('max_requests') != 6 or approval.get('per_group') != 3
                    or approval.get('seconds') != 86400
                    or approval.get('authorization_ref') != manifest['authorization_ref']
                    or approval.get('owner_sha256') != hashlib.sha256(manifest['scope']['owner'].encode()).hexdigest()
                    or manifest.get('live_daily_quota_path') != '/opt/wanwu-partner/data/daily-model-requests.db'):
                raise TrialBlocked('explicit_live_authorization_required')
            if (existing is None or existing['first_observed_at'] is None) and (
                    approval.get('first_observed_pair_confirmed') is not True
                    or type(approval.get('observer_confirmed_at')) is not int
                    or not 0 <= int(time.time()) - approval['observer_confirmed_at'] <= 60):
                raise TrialBlocked('fresh_owner_observation_required')
            quota_path = Path(manifest['live_daily_quota_path'])
        quota = DailyModelQuota(quota_path, 30, clock=clock)
        gate = TrialGate(directory / 'trial.db', quota, clock=clock)
        if (gate.policy['authorization_ref'] != manifest['authorization_ref']
                or gate.policy['mode'] != 'life' or gate.policy['starts_at'] != manifest['starts_at']):
            raise TrialBlocked('original_life_approval_required')
        if gate.policy['ends_at'] != manifest['starts_at'] + 86400:
            raise TrialBlocked('original_life_approval_required')
        key = MOCK_KEY if simulated else os.environ.get('PARTNER_ACCEPTANCE_MAAS_KEY', '')
        from app.services.trial_admission import live_evidence_reader
        reader = live_evidence_reader(directory / 'evidence.json', gate, clock=clock)
        if simulated:
            from app.services.life_acceptance_simulation import synthetic_evidence
            def reader(kind):
                at = manifest['starts_at'] if manifest.get('scenario') == 'stale-proof' else int(clock())
                return synthetic_evidence(gate, kind, at)
        delegate = lambda kind: (mock_delegate(directory, kind, manifest.get('scenario'),
                                               manifest['scope']['shared_character_ids']) if simulated else
                                 UsageTransport(httpx.AsyncHTTPTransport(retries=0), directory, kind))
        hooks = None
        try:
            if (existing and existing['work_stopped'] and existing['operation_count'] == 6
                    and gate.summary()['unknown'] == 0
                    and gate.summary()['counts'] == {'private_life': 3, 'shared_life': 3}):
                # Observation-only recovery cannot make a new model request and
                # does not need a refreshed paid-dispatch proof or credential.
                def no_dispatch(*_a, **_kw):
                    raise TrialBlocked('observation_only_no_dispatch')
                factories = SimpleNamespace(gate=gate, reader=reader, adapter=no_dispatch)
            else:
                factories = TrialLifeFactories(gate, reader, key, delegate_factory=delegate)
            hooks = AcceptanceHooks(directory, factories, manifest['scope'], stop_requested=stop_requested)
            args = (directory / 'window.db', factories, hooks.prepare, hooks.observe, hooks.stop)
            window = (LifeWindow(*args, origin=manifest['origin']) if existing else
                      LifeWindow.create(*args, origin=manifest['origin']))
            while True:
                if not lease_valid():
                    result = window.fail(window_state(window), 'worker_lock_lost')
                elif private_json(directory / 'source-manifest.json') != source_manifest():
                    result = window.fail(window_state(window), 'frozen_source_changed')
                elif stop_requested():
                    result = window.stop()
                elif not lease_valid():
                    result = window.fail(window_state(window), 'worker_lock_lost')
                else:
                    result = await window.tick()
                journal(directory, result)
                if result['status'] in ('passed', 'failed', 'stopped'):
                    return audit(directory)
                if stop_requested():
                    result = window.stop()
                    journal(directory, result)
                    return audit(directory)
                if simulated:
                    if int(clock()) - manifest['starts_at'] >= until:
                        return result
                    clock_value[0] += 151 if manifest.get('scenario') == 'gap' else 30
                else:
                    await asyncio.sleep(30)
        except BaseException:
            try:
                gate.stop('acceptance_worker_failed')
            except TrialBlocked:
                pass
            if hooks is not None:
                hooks.stop()
            raise
        finally:
            if hooks is not None:
                hooks.close()


def window_state(window):
    with window.connect() as db:
        return window.state(db)


def run(directory, *, simulated=False, until=86400):
    stop = [False]
    previous = {}
    for sig in (signal.SIGTERM, signal.SIGINT):
        previous[sig] = signal.signal(sig, lambda *_: stop.__setitem__(0, True))
    try:
        try:
            return asyncio.run(execute(directory, simulated=simulated, until=until,
                                       stop_requested=lambda: stop[0]))
        except Exception as error:
            if (not isinstance(error, TrialBlocked)
                    or str(error) not in ('worker_already_running', 'execution_origin_mismatch')):
                persist_startup_failure(directory, failure_type=type(error).__name__)
            raise
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)


def persist_startup_failure(directory, *, failure_type='TrialBlocked'):
    """Stop only this original life ledger; never repair/recreate a failed run."""
    directory = Path(directory)
    if not directory.is_dir() or directory.is_symlink() or directory.stat().st_mode & 0o077:
        return
    trial = directory / 'trial.db'
    if trial.is_symlink() or not trial.is_file():
        return
    with closing(sqlite3.connect(trial.resolve().as_uri() + '?mode=rw', uri=True)) as db:
        row = db.execute('SELECT policy FROM batch WHERE id=1').fetchone()
        if not row or json.loads(row[0]).get('mode') != 'life':
            return
        with db:
            db.execute("UPDATE batch SET state='stopped' WHERE id=1")
    window = directory / 'window.db'
    if window.is_file() and not window.is_symlink():
        with closing(sqlite3.connect(window.resolve().as_uri() + '?mode=rw', uri=True)) as db:
            state = json.loads(db.execute('SELECT data FROM state WHERE id=1').fetchone()[0])
            if state['status'] not in ('passed', 'failed', 'stopped'):
                state.update(status='failed', failure_code='worker_startup_validation_failed')
                with db:
                    db.execute('UPDATE state SET data=? WHERE id=1', (json.dumps(state, sort_keys=True),))
    if not (directory / 'worker-failure.json').exists():
        save_json(directory / 'worker-failure.json', {'status': 'failed',
                  'code': 'worker_startup_validation_failed', 'failure_type': failure_type,
                  'automatic_retries': 0}, exclusive=True)
