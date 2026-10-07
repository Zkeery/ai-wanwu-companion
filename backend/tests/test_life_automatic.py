"""Opt-in offline scheduling; no external calls or wall-clock waits."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, update

from app.core.config import get_settings
from app.core.database import engine
from app.living import life_runtime as rt
from app.living.life_worker import consume_once
from app.living.rules import LivingError
from app.living.store import spaces
from app.models.models import Character
from tests.auth_helpers import TEST_USER_ID as OWNER
from tests.test_life_runtime_api import preview, permission, queue  # noqa: F401


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def fail(*_args, **_kwargs):
        pytest.fail('automatic tests must not call external providers')
    monkeypatch.setattr('socket.socket.connect', fail)


def enable(client, url, revision=0, enabled=True, request_id=None):
    return client.put(url + '/automatic', json={'request_id': request_id or str(uuid4()),
        'expected_revision': revision, 'enabled': enabled})


def tick(runtime):
    async def execute(owner, sid, tid):
        runtime.run_fixture(owner, sid, tid)
    asyncio.run(consume_once(runtime, execute))


def test_default_read_only_and_explicit_opt_in_idempotency(client, preview):
    url, sid, _, runtime = preview
    for _ in range(3):
        assert client.get(url).json()['automatic'] == dict(enabled=False, revision=0, next_at=0, today_count=0, daily_limit=2, viewing_until=0, budget_available=None)
        tick(runtime)
    assert runtime.snapshot(OWNER, sid).tasks == ()
    assert enable(client, url).status_code == 409
    client.put(url + '/permission', json=permission())
    request_id = str(uuid4())
    for _ in range(2):
        response = enable(client, url, request_id=request_id)
        assert response.status_code == 200
        assert response.json()['automatic']['revision'] == 1
        assert response.json()['tasks'] == []
    assert enable(client, url, enabled=False, request_id=request_id).status_code == 409
    assert enable(client, url).status_code == 409
    tick(runtime); tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 1
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 1
    assert response.headers['cache-control'] == 'private, no-store'


def test_interval_daily_cap_and_next_day_without_backfill(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission()); enable(client, url)
    tick(runtime); clock[0] += 599; tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 1
    clock[0] += 1; tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 2
    clock[0] += 600; tick(runtime)
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 2
    clock[0] += 86400 * 3; tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 3
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 1
    with engine.connect() as conn:
        assert conn.execute(select(rt.calls)).all() == []


def test_stop_cancels_pending_and_permission_change_requires_opt_in_again(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission()); enable(client, url)
    runtime.schedule_automatic()
    task = runtime.snapshot(OWNER, sid).tasks[0]
    claimed = runtime.claim(OWNER, sid, task.id)
    assert enable(client, url, revision=1, enabled=False).status_code == 200
    assert runtime.read_task(OWNER, sid, task.id).state == 'cancelled'
    runtime.execute_step(OWNER, sid, task.id, claimed.token, {'activity': 'rest', 'reason': 'late fixture'})
    assert runtime.read_events(OWNER, sid) == []
    clock[0] += 600
    enable(client, url, revision=2)
    client.put(url + '/permission', json=permission(False, 1))
    client.put(url + '/permission', json=permission(True, 2))
    tick(runtime)
    assert not runtime.snapshot(OWNER, sid).automatic.enabled
    assert len(runtime.snapshot(OWNER, sid).tasks) == 1


def test_does_not_take_over_unconfirmed_manual_work_or_run_when_away(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission()); manual = queue(client, url); enable(client, url)
    tick(runtime)
    assert runtime.read_task(OWNER, sid, manual).state == 'queued'
    assert not runtime.snapshot(OWNER, sid).tasks[0].dispatch_requested
    client.put(url + '/permission', json=permission(True, 1)); enable(client, url, revision=2)
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == int(runtime.snapshot(OWNER, sid).companion_id)).values(current_space_id=None))
    clock[0] += 600; tick(runtime)
    assert len(runtime.snapshot(OWNER, sid).tasks) == 1
    assert runtime.read_events(OWNER, sid) == []


def test_concurrent_scanners_and_reopened_database_do_not_duplicate(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission()); enable(client, url)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda _: runtime.schedule_automatic(), range(3)))
    assert len(runtime.dispatched_tasks()) == 1
    reopened_engine = create_engine(str(engine.url), connect_args={'check_same_thread': False})
    reopened = rt.LifeRuntime(reopened_engine, lambda: clock[0]); reopened.initialize()
    tick(reopened)
    assert len(reopened.read_events(OWNER, sid)) == 1
    assert reopened.snapshot(OWNER, sid).automatic.enabled
    reopened_engine.dispose()


def test_queue_dispatch_and_next_check_roll_back_together(client, preview, monkeypatch):
    url, sid, _, runtime = preview
    client.put(url + '/permission', json=permission()); enable(client, url)
    original = runtime._write_automatic
    monkeypatch.setattr(runtime, '_write_automatic', lambda *_: (_ for _ in ()).throw(LivingError('storage_unavailable', 'synthetic')))
    runtime.schedule_automatic()
    assert runtime.snapshot(OWNER, sid).tasks == ()
    assert runtime.dispatched_tasks() == []
    monkeypatch.setattr(runtime, '_write_automatic', original)
    tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 1


def test_anonymous_cross_owner_production_and_live_gates(client, anon, preview, monkeypatch):
    url, sid, _, runtime = preview
    payload = {'request_id': str(uuid4()), 'expected_revision': 0, 'enabled': True}
    assert anon.put(url + '/automatic', json=payload).status_code == 401
    monkeypatch.setattr(runtime, 'origin', 'real_provider')
    response = enable(client, url)
    assert response.status_code == 503
    assert response.json()['error']['code'] == 'configuration_error'
    runtime.schedule_automatic()
    monkeypatch.setattr(runtime, 'origin', 'offline_fixture')
    with engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id == sid).values(owner_id='another'))
    assert enable(client, url).status_code == 404
    monkeypatch.setattr(get_settings(), 'app_env', 'production')
    assert enable(client, url).status_code == 404


@pytest.mark.parametrize('change', [{'enabled': 'true'}, {'expected_revision': True}, {'budget': 1}, {'source': 'viewing'}])
def test_strict_automatic_input(client, preview, change):
    url, _, _, _ = preview
    response = client.put(url + '/automatic', json={'request_id': str(uuid4()), 'expected_revision': 0, 'enabled': True, **change})
    assert response.status_code == 422


def test_failed_rounds_count_and_night_only_rest(client, preview):
    from tests.test_life_planning import stamp
    url, sid, clock, runtime = preview
    clock[0] = stamp(23)
    client.put(url + '/permission', json=permission(activities=['walk'])); enable(client, url)
    tick(runtime)
    assert runtime.snapshot(OWNER, sid).tasks[0].state == 'failed'
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 1
    assert runtime.read_events(OWNER, sid) == []


def test_corrupt_automatic_policy_is_rejected(client, preview):
    url, sid, _, runtime = preview
    client.put(url + '/permission', json=permission()); enable(client, url)
    with engine.begin() as conn:
        conn.execute(update(rt.automatic).where(rt.automatic.c.space_id == sid).values(payload='{}'))
    assert client.get(url).status_code == 500
    runtime.schedule_automatic()
    with engine.connect() as conn:
        assert conn.execute(select(rt.tasks)).all() == []
