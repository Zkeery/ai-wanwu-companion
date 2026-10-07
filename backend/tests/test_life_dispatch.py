"""Confirmed durable dispatch, transport independence and restart accounting."""
import asyncio
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select

from app.living.life_live_planner import run_real_planner
from app.living.life_planner import call_id_for
from app.living.life_provider import RESERVE_MICRO
from app.living.life_runtime import LifeRuntime, dispatches
from app.living.life_worker import consume_once
from tests.test_life_live_planner import OWNER, Client, allocate, catalog, ledger, setup  # noqa: F401
from tests.test_life_runtime import stamp


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail('dispatch tests must not call external providers')
    monkeypatch.setattr('socket.socket.connect', forbidden)


def executor(kernel, client):
    async def execute(owner, sid, tid):
        await run_real_planner(kernel, owner, sid, tid, lambda: client, catalog)
    return execute


def test_only_explicitly_confirmed_work_is_consumed_once_after_restart(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid); client = Client()
    asyncio.run(consume_once(kernel, executor(kernel, client)))
    assert client.calls == 0
    assert not kernel.snapshot(OWNER, sid).tasks[0].dispatch_requested
    kernel.request_dispatch(OWNER, sid, tid)
    kernel.request_dispatch(OWNER, sid, tid)
    with kernel.engine.connect() as conn:
        assert len(conn.execute(select(dispatches)).all()) == 1
    for _ in range(3):
        assert kernel.snapshot(OWNER, sid).tasks[0].state == 'queued'
    reopened_engine = create_engine(str(kernel.engine.url), connect_args={'check_same_thread': False})
    reopened = LifeRuntime(reopened_engine, lambda: stamp(), origin='real_provider')
    reopened.initialize()
    asyncio.run(consume_once(reopened, executor(reopened, client)))
    asyncio.run(consume_once(reopened, executor(reopened, client)))
    assert client.calls == 1
    assert reopened.snapshot(OWNER, sid).tasks[0].state == 'done'
    assert len(reopened.read_events(OWNER, sid)) == 1
    assert reopened.read_budget(OWNER, sid).committed == RESERVE_MICRO
    reopened_engine.dispose()


def test_zero_budget_dispatch_has_no_provider_call(setup):
    kernel, sid, tid = setup; client = Client()
    kernel.request_dispatch(OWNER, sid, tid)
    asyncio.run(consume_once(kernel, executor(kernel, client)))
    assert client.calls == 0 and ledger(kernel) == []
    assert kernel.snapshot(OWNER, sid).tasks[0].error_code == 'budget_exhausted'


def test_slow_request_does_not_block_reads_and_another_consumer_cannot_duplicate(setup):
    kernel, sid, tid = setup; allocate(kernel, sid)
    kernel.request_dispatch(OWNER, sid, tid)
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        class Slow(Client):
            async def plan(self, prompt):
                started.set(); await release.wait()
                return await super().plan(prompt)
        client = Slow()
        worker = asyncio.create_task(consume_once(kernel, executor(kernel, client)))
        await started.wait()
        assert kernel.snapshot(OWNER, sid).tasks[0].state == 'running'
        kernel.request_dispatch(OWNER, sid, tid)
        await consume_once(kernel, executor(kernel, client))
        release.set(); await worker
        assert client.calls == 1
        assert kernel.snapshot(OWNER, sid).tasks[0].state == 'done'
    asyncio.run(scenario())


def test_pause_discards_a_late_model_result_without_releasing_unknown_cost(setup):
    kernel, sid, tid = setup; allocate(kernel, sid)
    kernel.request_dispatch(OWNER, sid, tid)
    class Pausing(Client):
        async def plan(self, prompt):
            kernel.save_permission(OWNER, sid, str(uuid4()), 1, False, ('rest', 'walk'))
            return await super().plan(prompt)
    client = Pausing()
    asyncio.run(consume_once(kernel, executor(kernel, client)))
    assert client.calls == 1
    assert kernel.snapshot(OWNER, sid).tasks[0].state == 'cancelled'
    assert kernel.read_events(OWNER, sid) == []
    assert ledger(kernel)[0]['outcome'] == 'unknown'


def test_restart_after_unknown_dispatch_does_not_resend(setup):
    kernel, sid, tid = setup; allocate(kernel, sid)
    kernel.request_dispatch(OWNER, sid, tid)
    task = kernel.claim(OWNER, sid, tid)
    kernel.reserve_call(OWNER, sid, tid, task.token, call_id_for(tid), RESERVE_MICRO)
    recovered = LifeRuntime(kernel.engine, lambda: stamp() + 61, origin='real_provider')
    recovered.initialize(); client = Client()
    asyncio.run(consume_once(recovered, executor(recovered, client)))
    assert client.calls == 0
    assert recovered.snapshot(OWNER, sid).tasks[0].state == 'failed'
    assert recovered.read_budget(OWNER, sid).committed == RESERVE_MICRO
    assert recovered.read_events(OWNER, sid) == []


def test_shutdown_during_provider_request_preserves_unknown_reservation(setup):
    kernel, sid, tid = setup; allocate(kernel, sid)
    kernel.request_dispatch(OWNER, sid, tid)
    async def scenario():
        started = asyncio.Event()
        class Slow(Client):
            async def plan(self, prompt):
                self.calls += 1; started.set(); await asyncio.Event().wait()
        client = Slow()
        worker = asyncio.create_task(consume_once(kernel, executor(kernel, client)))
        await started.wait(); worker.cancel()
        with pytest.raises(asyncio.CancelledError):
            await worker
        assert client.calls == 1
        assert ledger(kernel)[0]['outcome'] == 'unknown'
        assert kernel.snapshot(OWNER, sid).tasks[0].state == 'failed'
        await consume_once(kernel, executor(kernel, client))
        assert client.calls == 1
    asyncio.run(scenario())


def test_unexpected_executor_failure_records_safe_failure(setup, caplog):
    kernel, sid, tid = setup
    kernel.request_dispatch(OWNER, sid, tid)
    async def broken(*_args):
        raise RuntimeError('synthetic-private-provider-body')
    asyncio.run(consume_once(kernel, broken))
    assert kernel.snapshot(OWNER, sid).tasks[0].state == 'failed'
    assert 'synthetic-private-provider-body' not in caplog.text
    assert 'life_dispatch_execution_unavailable' in caplog.text


def test_http_accepts_without_executing_and_enforces_scope_and_payload(client, setup, monkeypatch):
    from app.api import life_runtime as api
    from app.api.deps import get_current_user
    from app.core.config import get_settings
    from app.main import app
    from app.models.models import User
    from app.living.life_provider import BASE_URL, MODEL
    kernel, sid, tid = setup
    settings = get_settings()
    for name, value in [('app_env', 'test'), ('life_runtime_preview_enabled', True),
                        ('life_live_planner_preview_enabled', True), ('model_base_url', BASE_URL),
                        ('chat_model', MODEL), ('model_api_key', 'synthetic-test-only')]:
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(api, 'live_runtime', kernel)
    app.dependency_overrides[get_current_user] = lambda: User(id=OWNER, phone='13900000914')
    url = f'/api/v1/living/spaces/{sid}/life-runtime/tasks/{tid}/dispatch'
    try:
        for _ in range(2):
            response = client.post(url, json={})
            assert response.status_code == 202
            assert response.json()['tasks'][0]['dispatch_requested'] is True
            assert response.json()['tasks'][0]['state'] == 'queued'
        assert ledger(kernel) == []
        assert client.post(url, json={'candidate': {'activity': 'walk'}}).status_code == 422
        app.dependency_overrides[get_current_user] = lambda: User(id='another', phone='13900000915')
        assert client.post(url, json={}).status_code == 404
        monkeypatch.setattr(settings, 'app_env', 'production')
        assert client.post(url, json={}).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_paused_task_is_not_enqueued(setup):
    kernel, sid, tid = setup
    kernel.save_permission(OWNER, sid, str(uuid4()), 1, False, ('rest', 'walk'))
    kernel.request_dispatch(OWNER, sid, tid)
    assert kernel.dispatched_tasks() == []
    assert kernel.snapshot(OWNER, sid).tasks[0].state == 'cancelled'
