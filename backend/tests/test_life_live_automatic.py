"""Real-mode scheduling with a network-forbidden provider substitute, never live calls."""
import asyncio
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, update

from app.living.life_live_planner import run_real_planner
from app.living.life_provider import RESERVE_MICRO
from app.living.life_runtime import LifeRuntime, automatic
from app.living.life_worker import consume_once
from app.living.rules import LivingError
from tests.test_life_live_planner import OWNER, Client, catalog, setup  # noqa: F401


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


@pytest.fixture
def prepared(setup):
    kernel, sid, _ = setup
    clock = [kernel.clock() + 600]
    kernel.clock = lambda: clock[0]
    kernel.save_permission(OWNER, sid, str(uuid4()), 1, True, ('rest', 'walk'))
    return kernel, sid, clock


def fund(kernel, sid, rounds=3):
    for scope in ('project', 'space:' + sid):
        kernel.set_limit(scope, RESERVE_MICRO * rounds, 'synthetic-automatic-test-only')


def enable(kernel, sid):
    kernel.save_automatic(OWNER, sid, str(uuid4()), 0, True)


def tick(kernel, client):
    async def execute(owner, sid, tid):
        await run_real_planner(kernel, owner, sid, tid, lambda: client, catalog)
    asyncio.run(consume_once(kernel, execute))


def test_default_off_and_both_budgets_required(prepared):
    kernel, sid, _ = prepared
    for funded_scope in (None, 'project'):
        if funded_scope:
            kernel.set_limit(funded_scope, RESERVE_MICRO, 'synthetic-test-only')
        with pytest.raises(LivingError) as error:
            enable(kernel, sid)
        assert error.value.code == 'budget_exhausted'
        assert not kernel.snapshot(OWNER, sid).automatic.enabled
    fund(kernel, sid)
    client = Client()
    tick(kernel, client)
    assert client.calls == 0 and kernel.dispatched_tasks() == []


def test_concurrent_scan_restart_interval_and_daily_cap(prepared):
    kernel, sid, clock = prepared
    fund(kernel, sid)
    enable(kernel, sid)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda _: kernel.schedule_automatic(), range(3)))
    assert len(kernel.dispatched_tasks()) == 1
    new_engine = create_engine(str(kernel.engine.url), connect_args={'check_same_thread': False})
    try:
        reopened = LifeRuntime(new_engine, lambda: clock[0], origin='real_provider')
        reopened.initialize()
        client = Client()
        tick(reopened, client)
        assert client.calls == 1
        event = reopened.read_events(OWNER, sid)[0]
        assert event.origin == 'real_provider' and event.reason == '在允许的庭院里散步'
        assert reopened.snapshot(OWNER, sid).current_activity.task_id == event.task_id
        clock[0] += 599
        tick(reopened, client)
        assert client.calls == 1
        clock[0] += 1
        tick(reopened, client)
        clock[0] += 600
        tick(reopened, client)
        assert client.calls == 2 and reopened.snapshot(OWNER, sid).automatic.today_count == 2
        assert reopened.read_budget(OWNER, sid).committed == RESERVE_MICRO * 2
        check = subprocess.run([sys.executable, '-c', '''
import json, sys
from sqlalchemy import create_engine
from app.living.life_runtime import LifeRuntime
kernel = LifeRuntime(create_engine(sys.argv[1]), lambda: int(sys.argv[4]), origin='real_provider')
kernel.initialize()
snapshot = kernel.snapshot(sys.argv[2], sys.argv[3])
print(json.dumps({'enabled': snapshot.automatic.enabled, 'count': snapshot.automatic.today_count,
                  'events': len(kernel.read_events(sys.argv[2], sys.argv[3])),
                  'committed': kernel.read_budget(sys.argv[2], sys.argv[3]).committed}))
''', str(kernel.engine.url), OWNER, sid, str(clock[0])], capture_output=True, text=True, timeout=20, check=True)
        assert json.loads(check.stdout) == dict(enabled=True, count=2, events=2, committed=RESERVE_MICRO * 2)
        clock[0] += 86400 * 3
        tick(reopened, client)
        assert client.calls == 3 and reopened.snapshot(OWNER, sid).automatic.today_count == 1
    finally:
        new_engine.dispose()


def test_exhausted_or_unknown_budget_waits_without_more_tasks(prepared):
    kernel, sid, clock = prepared
    fund(kernel, sid, 1)
    enable(kernel, sid)
    client = Client(fail=True)
    tick(kernel, client)
    previous = kernel.snapshot(OWNER, sid).tasks
    clock[0] += 600
    tick(kernel, client)
    snapshot = kernel.snapshot(OWNER, sid)
    assert client.calls == 1 and snapshot.tasks == previous
    assert snapshot.automatic.enabled and snapshot.automatic.budget_available is False
    assert kernel.read_budget(OWNER, sid).committed == RESERVE_MICRO
    kernel.save_automatic(OWNER, sid, str(uuid4()), 1, False)
    assert not kernel.snapshot(OWNER, sid).automatic.enabled


def test_stop_during_provider_discards_late_result(prepared):
    kernel, sid, clock = prepared
    fund(kernel, sid)
    enable(kernel, sid)
    class PausingClient(Client):
        async def plan(self, prompt):
            kernel.save_automatic(OWNER, sid, str(uuid4()), 1, False)
            return await super().plan(prompt)
    client = PausingClient()
    tick(kernel, client)
    clock[0] += 600
    tick(kernel, client)
    assert client.calls == 1 and kernel.read_events(OWNER, sid) == []
    assert kernel.snapshot(OWNER, sid).tasks[0].state == 'cancelled'
    assert kernel.read_budget(OWNER, sid).committed == RESERVE_MICRO


def test_permission_change_cancels_queue_and_invalidates_real_viewing(prepared):
    kernel, sid, _ = prepared
    fund(kernel, sid)
    enable(kernel, sid)
    lease = str(uuid4())
    kernel.save_viewing(OWNER, sid, lease, 1, True)
    kernel.schedule_automatic()
    kernel.save_permission(OWNER, sid, str(uuid4()), 2, True, ('rest',))
    client = Client()
    tick(kernel, client)
    assert client.calls == 0
    assert not kernel.snapshot(OWNER, sid).automatic.enabled
    assert kernel.snapshot(OWNER, sid).automatic.viewing_until == 0
    with pytest.raises(LivingError):
        kernel.save_viewing(OWNER, sid, lease, 1, True)


def test_offline_policy_cannot_be_consumed_in_real_mode(prepared):
    kernel, sid, _ = prepared
    fund(kernel, sid)
    enable(kernel, sid)
    with kernel.engine.begin() as conn:
        value = json.loads(conn.execute(select(automatic.c.payload)).scalar_one())
        value['origin'] = 'offline_fixture'
        conn.execute(update(automatic).values(payload=json.dumps(value)))
    kernel.schedule_automatic()
    assert kernel.dispatched_tasks() == []
    with pytest.raises(LivingError) as error:
        kernel.snapshot(OWNER, sid)
    assert error.value.code == 'corrupt_state'


def test_real_viewing_after_daily_cap_expires_and_does_not_backfill(prepared):
    kernel, sid, clock = prepared
    fund(kernel, sid, 4)
    enable(kernel, sid)
    client = Client()
    tick(kernel, client)
    clock[0] += 600
    tick(kernel, client)
    clock[0] += 600
    tick(kernel, client)
    assert client.calls == 2
    lease = str(uuid4())
    until = kernel.save_viewing(OWNER, sid, lease, 1, True).expires_at
    tick(kernel, client)
    snapshot = kernel.snapshot(OWNER, sid)
    assert client.calls == 3 and snapshot.current_activity.source == 'viewing'
    assert snapshot.automatic.today_count == 2
    check = subprocess.run([sys.executable, '-c', '''
import sys
from sqlalchemy import create_engine
from app.living.life_runtime import LifeRuntime
kernel = LifeRuntime(create_engine(sys.argv[1]), lambda: int(sys.argv[4]), origin='real_provider')
kernel.initialize()
print(kernel.snapshot(sys.argv[2], sys.argv[3]).automatic.viewing_until)
''', str(kernel.engine.url), OWNER, sid, str(clock[0])], capture_output=True, text=True, timeout=20, check=True)
    assert int(check.stdout) == until
    clock[0] = until
    assert kernel.snapshot(OWNER, sid).automatic.viewing_until == 0
    clock[0] += 600
    tick(kernel, client)
    assert client.calls == 3 and kernel.read_budget(OWNER, sid).committed == RESERVE_MICRO * 3


def test_real_multi_tab_and_worker_share_interval_and_budget(prepared):
    kernel, sid, clock = prepared
    fund(kernel, sid, 2)
    enable(kernel, sid)
    a, b = str(uuid4()), str(uuid4())
    kernel.save_viewing(OWNER, sid, a, 1, True)
    kernel.save_viewing(OWNER, sid, b, 1, True)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda _: kernel.schedule_automatic(), range(3)))
    client = Client()
    tick(kernel, client)
    clock[0] += 599
    kernel.save_viewing(OWNER, sid, a, 1, True)
    kernel.save_viewing(OWNER, sid, b, 1, True)
    tick(kernel, client)
    assert client.calls == 1
    kernel.save_viewing(OWNER, sid, a, 1, False)
    clock[0] += 1
    tick(kernel, client)
    snapshot = kernel.snapshot(OWNER, sid)
    assert client.calls == 2 and snapshot.automatic.today_count == 0
    assert snapshot.automatic.budget_available is False
    until = snapshot.automatic.viewing_until
    with pytest.raises(LivingError) as error:
        kernel.save_viewing(OWNER, sid, b, 1, True)
    assert error.value.code == 'budget_exhausted'
    assert kernel.snapshot(OWNER, sid).automatic.viewing_until == until
    kernel.save_viewing(OWNER, sid, b, 1, False)
    assert kernel.snapshot(OWNER, sid).automatic.viewing_until == 0
    clock[0] += 600
    tick(kernel, client)
    assert client.calls == 2


def test_real_close_before_open_and_budget_revocation_cannot_extend_lease(prepared):
    kernel, sid, clock = prepared
    fund(kernel, sid)
    enable(kernel, sid)
    closed = str(uuid4())
    kernel.save_viewing(OWNER, sid, closed, 1, False)
    with pytest.raises(LivingError):
        kernel.save_viewing(OWNER, sid, closed, 1, True)
    active = str(uuid4())
    until = kernel.save_viewing(OWNER, sid, active, 1, True).expires_at
    kernel.set_limit('project', 0, 'synthetic-revoke')
    with pytest.raises(LivingError) as error:
        kernel.save_viewing(OWNER, sid, active, 1, True)
    assert error.value.code == 'budget_exhausted'
    clock[0] = until
    client = Client()
    tick(kernel, client)
    assert client.calls == 0 and kernel.snapshot(OWNER, sid).automatic.viewing_until == 0
