"""Atomic local budget administration; no credentials or provider requests."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import uuid4

import pytest
from sqlalchemy import select, text

from app.living.life_budget_admin import apply, preview
from app.living.life_runtime import LifeRuntime, budget_changes, limits, mode_marker
from app.living.life_provider import RESERVE_MICRO
from app.living.rules import LivingError
from tests.test_life_live_planner import OWNER, setup  # noqa: F401


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('budget management cannot call providers')
    monkeypatch.setattr('socket.socket.connect', forbidden)


def proposal(kernel, sid, **changes):
    values = dict(project_cap=3_600_000, space_cap=2_400_000)
    values.update(changes)
    return preview(kernel, OWNER, sid, **values)


def save(kernel, sid, plan, **changes):
    values = dict(request_id=str(uuid4()), authorization_ref='synthetic-' + str(uuid4()),
        expected_state=plan.expected_state, action=plan.action,
        project_cap=plan.after.project_cap if plan.action == 'set' else None,
        space_cap=plan.after.space_cap if plan.action == 'set' else None)
    values.update(changes)
    return apply(kernel, OWNER, sid, **values)


def test_preview_leaves_file_and_permissions_untouched(setup):
    kernel, sid, _ = setup
    path = Path(kernel.engine.url.database)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    before = kernel.snapshot(OWNER, sid)
    plan = proposal(kernel, sid)
    assert plan.before.project_cap == plan.before.space_cap == 0
    assert plan.after.space_cap == 2_400_000
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest
    assert kernel.snapshot(OWNER, sid) == before
    with kernel.engine.connect() as conn:
        assert not conn.execute(select(budget_changes)).all()
        assert not conn.execute(select(limits)).all()


def test_set_both_caps_once_and_preserve_permission(setup):
    kernel, sid, _ = setup
    permission = kernel.read_permission(OWNER, sid)
    plan = proposal(kernel, sid)
    result, replayed = save(kernel, sid, plan)
    assert result == plan and not replayed
    current = proposal(kernel, sid).before
    assert (current.project_cap, current.space_cap) == (3_600_000, 2_400_000)
    assert kernel.read_permission(OWNER, sid) == permission


def test_second_write_failure_rolls_back_first_cap_and_receipt(setup):
    kernel, sid, _ = setup
    plan = proposal(kernel, sid)
    with kernel.engine.begin() as conn:
        conn.exec_driver_sql("CREATE TRIGGER reject_space_limit BEFORE INSERT ON life_runtime_limits "
                            "WHEN NEW.scope != 'project' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END")
    with pytest.raises(LivingError, match='暂时无法保存'):
        save(kernel, sid, plan)
    with kernel.engine.connect() as conn:
        assert not conn.execute(select(limits)).all()
        assert not conn.execute(select(budget_changes)).all()


def test_concurrent_different_requests_cannot_both_apply_stale_preview(setup):
    kernel, sid, _ = setup
    plan = proposal(kernel, sid)
    def run(_):
        try:
            save(kernel, sid, plan)
            return 'applied'
        except LivingError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(run, range(2)))
    assert sorted(outcomes) == ['applied', 'conflict']


def test_preview_digest_binds_the_reviewed_amount_and_action(setup):
    kernel, sid, _ = setup
    plan = proposal(kernel, sid)
    with pytest.raises(LivingError, match='重新核对方案'):
        save(kernel, sid, plan, project_cap=4_800_000)
    with pytest.raises(LivingError, match='重新核对方案'):
        save(kernel, sid, plan, action='freeze-space', project_cap=None, space_cap=None)
    assert kernel.read_budget(OWNER, sid).cap == 0


def test_unknown_reservation_invalidates_preview_and_cannot_be_refunded(setup):
    kernel, sid, tid = setup
    save(kernel, sid, proposal(kernel, sid))
    plan = proposal(kernel, sid)
    task = kernel.claim(OWNER, sid, tid)
    kernel.reserve_call(OWNER, sid, tid, task.token, str(uuid4()), RESERVE_MICRO)
    with pytest.raises(LivingError, match='已变化'):
        save(kernel, sid, plan)
    with pytest.raises(LivingError, match='不能低于'):
        proposal(kernel, sid, space_cap=0)
    frozen = preview(kernel, OWNER, sid, action='freeze-space')
    assert frozen.after.space_cap == RESERVE_MICRO
    assert frozen.after.project_cap == 3_600_000
    save(kernel, sid, frozen)
    assert kernel.read_budget(OWNER, sid).cap == kernel.read_budget(OWNER, sid).committed == RESERVE_MICRO


def test_freeze_then_replay_old_grant_does_not_reopen_allowance(setup):
    kernel, sid, _ = setup
    original = proposal(kernel, sid)
    ident, reference = str(uuid4()), 'synthetic-approval-once'
    save(kernel, sid, original, request_id=ident, authorization_ref=reference)
    frozen = preview(kernel, OWNER, sid, action='freeze-space')
    save(kernel, sid, frozen)
    result, replayed = save(kernel, sid, original, request_id=ident, authorization_ref=reference)
    assert replayed and result == original
    assert kernel.read_budget(OWNER, sid).cap == 0
    with pytest.raises(LivingError, match='已使用'):
        save(kernel, sid, proposal(kernel, sid), authorization_ref=reference)
    with pytest.raises(LivingError, match='同一请求'):
        save(kernel, sid, proposal(kernel, sid), request_id=ident)


def test_changed_owner_or_wrong_source_rejected(setup):
    kernel, sid, _ = setup
    with pytest.raises(LivingError):
        preview(kernel, 'another-owner', sid, project_cap=100, space_cap=100)
    offline = LifeRuntime(kernel.engine, kernel.clock, origin='offline_fixture')
    with pytest.raises(LivingError, match='真实运行库'):
        proposal(offline, sid)
    with kernel.engine.begin() as conn:
        conn.execute(mode_marker.update().values(origin='offline_fixture'))
    with pytest.raises(LivingError, match='真实运行库'):
        proposal(kernel, sid)


@pytest.mark.parametrize('changes', [
    {'project_cap': -1}, {'space_cap': True}, {'space_cap': 2.4}, {'space_cap': 10**12 + 1},
    {'project_cap': 1, 'space_cap': 2}, {'action': 'unknown'},
])
def test_invalid_caps_do_not_write(setup, changes):
    kernel, sid, _ = setup
    with pytest.raises(LivingError):
        proposal(kernel, sid, **changes)
    assert kernel.read_budget(OWNER, sid).cap == 0


def test_old_database_can_be_previewed_but_not_silently_migrated(setup):
    kernel, sid, _ = setup
    budget_changes.drop(kernel.engine)
    plan = proposal(kernel, sid)
    with pytest.raises(LivingError, match='尚未更新'):
        save(kernel, sid, plan)
    with kernel.engine.connect() as conn:
        assert not conn.execute(text("SELECT name FROM sqlite_master WHERE name='life_runtime_budget_changes'")).first()


def cli(path, sid, *extra):
    # Separate process and SQLite connections; synthetic settings avoid local credentials.
    env = {**os.environ, 'APP_ENV': 'test', 'MODEL_API_KEY': '', 'LIFE_RUNTIME_ENABLED': 'false',
           'LIFE_RUNTIME_PREVIEW_ENABLED': 'false', 'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'false'}
    return subprocess.run([sys.executable, '-m', 'scripts.manage_life_budget', '--database', str(path),
        '--owner-id', OWNER, '--space-id', sid, *extra], capture_output=True, text=True, env=env, timeout=20)


def test_cli_read_apply_freeze_and_restart_replay(setup):
    kernel, sid, _ = setup
    path = Path(kernel.engine.url.database)
    caps = ['--project-yuan', '3.6', '--space-yuan', '2.4']
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    inspected = cli(path, sid, *caps)
    assert inspected.returncode == 0, inspected.stdout + inspected.stderr
    plan = json.loads(inspected.stdout)
    assert plan['state'] == 'planned'
    assert before == hashlib.sha256(path.read_bytes()).hexdigest()
    args = [*caps, '--apply', '--expected-state', plan['plan']['expected_state'],
            '--request-id', str(uuid4()), '--authorization-ref', 'synthetic-cli-approved']
    assert json.loads(cli(path, sid, *args).stdout)['state'] == 'applied'
    frozen = json.loads(cli(path, sid, '--freeze-space').stdout)
    result = cli(path, sid, '--freeze-space', '--apply', '--expected-state', frozen['plan']['expected_state'],
                 '--request-id', str(uuid4()), '--authorization-ref', 'synthetic-cli-close')
    assert json.loads(result.stdout)['state'] == 'applied'
    replay = json.loads(cli(path, sid, *args).stdout)
    assert replay['state'] == 'replayed' and replay['receipt_only']
    assert kernel.read_budget(OWNER, sid).cap == 0
    assert json.loads(cli(path, sid, *caps).stdout)['plan']['before']['space_cap'] == 0


def test_cli_missing_file_and_bad_database_fail_without_creation_or_traceback(tmp_path):
    missing = tmp_path / 'missing.db'
    result = cli(missing, str(uuid4()), '--freeze-space')
    assert result.returncode == 2 and not missing.exists()
    broken = tmp_path / 'broken.db'
    broken.write_text('synthetic-private-db-content')
    result = cli(broken, str(uuid4()), '--freeze-space')
    assert result.returncode == 2 and 'Traceback' not in result.stderr
    assert 'synthetic-private-db-content' not in result.stdout + result.stderr


@pytest.mark.parametrize('value', ['NaN', 'Infinity', '1e999999999', '-1', '0.0000001'])
def test_cli_invalid_money_is_bounded_and_has_no_traceback(setup, value):
    kernel, sid, _ = setup
    result = cli(Path(kernel.engine.url.database), sid, '--project-yuan', value, '--space-yuan', '1.2')
    assert result.returncode == 2 and 'Traceback' not in result.stderr
    assert kernel.read_budget(OWNER, sid).cap == 0
