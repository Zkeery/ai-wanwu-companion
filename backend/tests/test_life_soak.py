"""Meaningful soak-harness checks: recovery, elapsed-time honesty and isolation."""
import json
import time

import pytest

from scripts import check_life_soak as soak


@pytest.fixture
def run_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(soak, 'RUNS', tmp_path)
    return tmp_path / 'run'


def test_multi_day_soak_and_independent_process(run_dir, monkeypatch):
    # Child CLI enforces the real project directory; invoke its equivalent
    # verifier against the same newly isolated DB inside this test instead.
    checks = []
    def verify(path, now, expected):
        runtime = soak.open_kernel(path, lambda: now)
        try:
            assert soak.facts(runtime, json.loads((path/'state.json').read_text())['sid']) == expected
            checks.append(now)
        finally:
            runtime.engine.dispose()
    monkeypatch.setattr(soak, 'subprocess_check', verify)
    result = soak.accelerated(run_dir, 3)
    assert result['status'] == 'passed' and result['simulated_days'] == 3
    assert result['facts']['tasks'] == result['facts']['events'] == 25
    assert result['facts']['offline_tasks'] == 7
    assert result['facts']['min_interval'] == 600
    assert len(checks) == result['engine_reopens'] == 3
    assert result['provider_requests'] == result['cost'] == 0
    with pytest.raises(FileExistsError):
        soak.accelerated(run_dir, 1)


def test_resume_retains_deadline_and_does_not_call_elapsed_a_pass(run_dir, monkeypatch):
    state = soak.seed(run_dir, 'wall-clock', 10)
    state['started_at'] = int(time.time()) - 86401
    state['deadline'] = int(time.time()) - 1
    original_deadline = state['deadline']
    soak.save(run_dir/'state.json', state)
    monkeypatch.setattr(soak, 'subprocess_check', lambda *_: None)
    result = soak.wall_clock(run_dir, 86400, resume=True, poll_seconds=.01)
    assert result['deadline'] == original_deadline
    assert result['status'] == 'completed_with_gaps' and result['scans'] == 0
    assert result['facts']['events'] == 0
    assert result['largest_observation_gap_seconds'] >= 86400
    with pytest.raises(ValueError):
        soak.wall_clock(run_dir, 86400, resume=True)


def test_network_and_path_guards(run_dir):
    import socket
    with soak.no_network(), pytest.raises(AssertionError, match='forbids network'):
        socket.socket().connect(('127.0.0.1', 1))
    with pytest.raises(ValueError):
        soak.checked_run(run_dir.parent/'outside'/'nested')
    run_dir.symlink_to(run_dir.parent/'target')
    with pytest.raises(ValueError):
        soak.checked_run(run_dir)


def test_missing_database_cannot_be_silently_recreated_on_resume(run_dir):
    soak.seed(run_dir, 'wall-clock', 86400)
    (run_dir/'soak.db').unlink()
    with pytest.raises(ValueError, match='missing DB'):
        soak.wall_clock(run_dir, resume=True)
    assert not (run_dir/'soak.db').exists()
