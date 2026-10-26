"""Subprocess acceptance of real kernels with synthetic HTTP and virtual time."""
import asyncio
import fcntl
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import signal

import pytest

from app.services.life_acceptance_simulation import prepare
from app.services.life_acceptance_worker import execute, audit

BACKEND = Path(__file__).resolve().parents[1]
CLI = BACKEND / 'scripts/life_acceptance.py'


@pytest.fixture(autouse=True)
def network_forbidden(monkeypatch):
    def deny(*_a, **_kw):
        raise AssertionError('TEST_NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)


def command(directory, mode='simulate', *extra):
    result = subprocess.run([sys.executable, str(CLI), mode, '--directory', str(directory), *extra],
                            cwd=BACKEND, capture_output=True, text=True, timeout=90)
    assert not result.stderr, result.stderr[-1000:]
    value = json.loads(result.stdout)
    assert 'synthetic-owner' not in result.stdout and '合成演练' not in result.stdout
    return result.returncode, value


def attempts(directory):
    with sqlite3.connect(directory / 'trial.db') as db:
        return db.execute('SELECT kind,state,reserve_micro FROM attempts ORDER BY rowid').fetchall()


def test_full_window_cli_survives_new_process_and_independent_readonly_audit(tmp_path):
    directory = tmp_path / 'run'
    code, first = command(directory, 'simulate', '--until', '660')
    assert code == 0 and first['status'] == 'running' and first['operation_count'] == 4
    code, final = command(directory, 'resume-simulated')
    assert code == 0 and final['status'] == 'passed' and final['audit_passed']
    assert final['evidence_origin'] == 'mock_simulated' and not final['real_acceptance_passed']
    assert final['observed_span_seconds'] == 86400 and final['max_interval_seconds'] == 30
    assert final['operation_counts'] == {'private_life': 3, 'shared_life': 3}
    assert final['business_events'] == {'private_events': 3, 'shared_events': 3}
    assert final['reserved_micro'] == 6873600 and final['counts_constant_after_stop']
    assert final['policies_stopped'] and final['original_approval_binding_verified']
    assert final['daily_limit_and_request_links_verified']
    assert final['reported_tokens'] == {'prompt_tokens': 3000, 'completion_tokens': 180, 'total_tokens': 3180}
    before = attempts(directory)
    assert command(directory, 'resume-simulated')[1] == final
    assert attempts(directory) == before
    hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
    assert command(directory, 'audit')[1] == final
    assert hashes == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in directory.iterdir() if p.is_file()}
    with sqlite3.connect(directory / 'private.db') as db:
        assert db.execute("SELECT count(*) FROM life_runtime_tasks WHERE state='done'").fetchone()[0] == 3
    with sqlite3.connect(directory / 'shared.db') as db:
        assert db.execute("SELECT count(*) FROM life_dialogue_tasks WHERE state='done'").fetchone()[0] == 3
    with sqlite3.connect(directory / 'usage.db') as db:
        stored = ''.join(r[0] for r in db.execute('SELECT data FROM usage'))
    assert '合成演练' not in stored and 'synthetic-not-a-credential' not in stored
    assert 'http' not in stored.replace('http_status', '')


@pytest.mark.parametrize('scenario,expected_calls', [
    ('timeout', 1), ('bad-json', 1), ('bad-usage', 1), ('stale-proof', 4), ('gap', 2),
])
def test_first_failure_stops_both_groups_and_never_retries(tmp_path, scenario, expected_calls):
    directory = tmp_path / scenario
    code, value = command(directory, 'simulate', '--scenario', scenario)
    assert code == 2 and value['status'] == 'failed'
    assert not value['audit_passed'] and not value['real_acceptance_passed']
    rows = attempts(directory)
    assert len(rows) == expected_calls
    second = command(directory, 'resume-simulated')[1]
    assert second == value and attempts(directory) == rows
    assert not value['operation_counts']['private_life'] > 3
    assert not value['operation_counts']['shared_life'] > 3


def test_process_lock_does_not_stop_the_existing_worker(tmp_path):
    directory = tmp_path / 'locked'
    prepare(directory)
    with (directory / 'worker.lock').open('w') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        code, value = command(directory, 'resume-simulated', '--until', '0')
        assert code == 2 and value['code'] == 'worker_already_running'
    assert attempts(directory) == []
    with sqlite3.connect(directory / 'trial.db') as db:
        assert db.execute('SELECT state FROM batch').fetchone()[0] == 'active'


def test_interrupted_inflight_work_is_unknown_and_not_replayed(tmp_path):
    directory = tmp_path / 'interrupted'
    command(directory, 'simulate', '--until', '0')
    with sqlite3.connect(directory / 'window.db') as db:
        state = json.loads(db.execute('SELECT data FROM state').fetchone()[0])
        state['in_flight'] = {'kind': 'private_life', 'operation_sha256': 'a' * 64}
        db.execute('UPDATE state SET data=?', (json.dumps(state),))
    rows = attempts(directory)
    code, report = command(directory, 'resume-simulated')
    assert code == 2 and report['failure_code'] == 'interrupted_work_unknown'
    assert attempts(directory) == rows
    assert command(directory, 'resume-simulated')[1] == report


def test_extra_owner_in_isolated_database_blocks_before_any_request(tmp_path):
    directory = tmp_path / 'owner'
    prepare(directory)
    with sqlite3.connect(directory / 'private.db') as db:
        db.execute("UPDATE characters SET owner_id='different-owner' WHERE id=6")
    code, result = command(directory, 'resume-simulated')
    assert code == 2 and result['code'] == 'isolated_character_scope_mismatch'
    assert attempts(directory) == []
    with sqlite3.connect(directory / 'trial.db') as db:
        assert db.execute('SELECT state FROM batch').fetchone()[0] == 'stopped'


def test_simulation_cannot_enter_live_command_or_overwrite_original_records(tmp_path):
    directory = tmp_path / 'simulation'
    prepare(directory)
    before = (directory / 'trial.db').read_bytes()
    code, result = command(directory, 'run-approved')
    assert code == 2 and result['code'] == 'execution_origin_mismatch'
    assert attempts(directory) == [] and (directory / 'trial.db').read_bytes() == before
    assert command(directory, 'simulate')[0] == 2
    assert (directory / 'trial.db').read_bytes() == before


def test_source_manifest_change_is_terminal_and_cannot_be_reset(tmp_path):
    directory = tmp_path / 'source'
    command(directory, 'simulate', '--until', '0')
    saved = (directory / 'source-manifest.json').read_bytes()
    (directory / 'source-manifest.json').write_text('{}')
    code, result = command(directory, 'resume-simulated')
    assert code == 2 and result['code'] == 'frozen_source_changed'
    before = attempts(directory)
    (directory / 'source-manifest.json').write_bytes(saved)
    code, result = command(directory, 'resume-simulated')
    assert code == 2 and result['code'] == 'worker_previously_failed'
    assert attempts(directory) == before
    with sqlite3.connect(directory / 'window.db') as db:
        assert json.loads(db.execute('SELECT data FROM state').fetchone()[0])['status'] == 'failed'


def test_operator_stop_before_dispatch_is_durable_and_stops_both_policies(tmp_path):
    directory = tmp_path / 'stopped'
    prepare(directory)
    value = asyncio.run(execute(directory, simulated=True, stop_requested=lambda: True))
    assert value['status'] == 'stopped' and value['counts_constant_after_stop']
    assert value['operation_counts'] == {'private_life': 0, 'shared_life': 0}
    assert audit(directory) == value


def test_observation_only_recovery_needs_no_new_paid_dispatch_proof(tmp_path, monkeypatch):
    directory = tmp_path / 'observe-only'
    assert command(directory, 'simulate', '--until', '1260')[1]['work_stopped']
    before = attempts(directory)
    def never_read(*_a, **_kw):
        raise AssertionError('NO_NEW_PAID_PROOF_OR_DISPATCH_ALLOWED')
    monkeypatch.setattr('app.services.life_acceptance_simulation.synthetic_evidence', never_read)
    result = asyncio.run(execute(directory, simulated=True, until=1320))
    assert result['status'] == 'running' and result['operation_count'] == 6
    assert attempts(directory) == before


def test_live_preparation_rejects_missing_approval_before_any_source_or_credentials(tmp_path):
    from app.services.life_acceptance_setup import prepare_approved
    from app.services.trial_gate import TrialBlocked
    approval = tmp_path / 'not-approved.json'
    approval.write_text(json.dumps({'approved_for_real_model_calls': False}))
    approval.chmod(0o600)
    target = tmp_path / 'must-not-be-created'
    with pytest.raises(TrialBlocked, match='explicit_live_authorization_required'):
        prepare_approved(target, approval, tmp_path / 'missing-evidence.json')
    assert not target.exists()


def test_replaced_lock_is_failure_before_dispatch_and_both_policies_stop(tmp_path):
    directory = tmp_path / 'lost-lock'
    prepare(directory)
    def replace_lock():
        lock = directory / 'worker.lock'
        lock.unlink()
        lock.write_text('')
        lock.chmod(0o600)
        return False
    result = asyncio.run(execute(directory, simulated=True, stop_requested=replace_lock))
    assert result['status'] == 'failed' and result['failure_code'] == 'worker_lock_lost'
    assert result['policies_stopped'] and attempts(directory) == []


def test_sigterm_closes_both_policies_without_restarting_or_new_requests(tmp_path):
    directory = tmp_path / 'signal-stop'
    process = subprocess.Popen([sys.executable, str(CLI), 'simulate', '--directory', str(directory)],
                               cwd=BACKEND, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 15
        while not (directory / 'last-report.json').is_file():
            assert process.poll() is None
            assert time.monotonic() < deadline
            time.sleep(0.02)
        process.send_signal(signal.SIGTERM)
        out, err = process.communicate(timeout=30)
        value = json.loads(out)
        assert not err and process.returncode == 2
        assert value['status'] == 'stopped' and value['policies_stopped']
        before = attempts(directory)
        assert command(directory, 'resume-simulated')[1] == value
        assert attempts(directory) == before
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


def test_business_mutation_after_stop_is_rejected_without_new_dispatch(tmp_path):
    directory = tmp_path / 'stopped-mutation'
    assert command(directory, 'simulate', '--until', '1260')[1]['work_stopped']
    before = attempts(directory)
    with sqlite3.connect(directory / 'private.db') as db:
        db.execute("UPDATE life_runtime_events SET payload=payload || ' ' WHERE rowid=(SELECT min(rowid) FROM life_runtime_events)")
    code, value = command(directory, 'resume-simulated')
    assert code == 2 and value['status'] == 'failed'
    assert value['failure_code'] == 'business_changed_after_stop' and not value['audit_passed']
    assert not value['counts_constant_after_stop'] and attempts(directory) == before


def test_unreadable_business_state_on_recovery_leaves_a_terminal_failure(tmp_path):
    directory = tmp_path / 'invalid-business'
    command(directory, 'simulate', '--until', '1260')
    before = attempts(directory)
    with sqlite3.connect(directory / 'private.db') as db:
        db.execute("UPDATE life_runtime_events SET payload='{}' WHERE rowid=(SELECT min(rowid) FROM life_runtime_events)")
    code, result = command(directory, 'resume-simulated')
    assert code == 2 and result['status'] == 'blocked'
    assert attempts(directory) == before
    with sqlite3.connect(directory / 'window.db') as db:
        assert json.loads(db.execute('SELECT data FROM state').fetchone()[0])['status'] == 'failed'
    record = json.loads((directory / 'worker-failure.json').read_text())
    assert record['status'] == 'failed' and record['failure_type'].isidentifier()
    assert command(directory, 'resume-simulated')[1]['code'] == 'worker_previously_failed'


def test_fee_approval_alone_does_not_fabricate_owner_presence(tmp_path):
    from app.services.life_acceptance_setup import prepare_approved
    from app.services.trial_gate import TrialBlocked
    approval = tmp_path / 'fee-only.json'
    approval.write_text(json.dumps({'approved_for_real_model_calls': True, 'phase': 'life_24h',
        'budget_micro': 7000000, 'max_requests': 6, 'per_group': 3, 'seconds': 86400,
        'authorization_ref': 'life-new-unexecuted-fixture', 'private_character_id': 6,
        'shared_character_ids': [4, 6]}))
    approval.chmod(0o600)
    target = tmp_path / 'must-not-create'
    with pytest.raises(TrialBlocked, match='fresh_owner_observation_required'):
        prepare_approved(target, approval, tmp_path / 'not-read-evidence.json')
    assert not target.exists()


def test_stop_during_private_request_does_not_dispatch_shared_group(tmp_path, monkeypatch):
    import httpx
    import app.services.life_acceptance_worker as worker
    directory = tmp_path / 'stop-in-request'
    prepare(directory)
    stopped = [False]
    original = worker.mock_delegate
    def delegate(*args):
        transport = original(*args)
        class SignalDuringRequest(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request):
                stopped[0] = True
                return await transport.handle_async_request(request)
            async def aclose(self):
                await transport.aclose()
        return SignalDuringRequest()
    monkeypatch.setattr(worker, 'mock_delegate', delegate)
    value = asyncio.run(execute(directory, simulated=True, stop_requested=lambda: stopped[0]))
    assert value['status'] == 'stopped' and value['policies_stopped']
    assert value['operation_counts'] == {'private_life': 1, 'shared_life': 0}
    assert value['business_events'] == {'private_events': 1, 'shared_events': 0}
    assert command(directory, 'resume-simulated')[1] == value
