"""Visible opt-in leases, shared frequency and stop/restart races."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select

from app.core.database import engine
from app.living import life_runtime as rt
from app.living.rules import LivingError
from tests.auth_helpers import TEST_USER_ID as OWNER
from tests.test_life_runtime_api import preview, permission, queue  # noqa: F401
from tests.test_life_automatic import enable, tick, no_network  # noqa: F401


def watch(client, url, lease=None, enabled=True, revision=1):
    return client.put(url + '/viewing/' + (lease or str(uuid4())),
        json={'expected_revision': revision, 'enabled': enabled})


def setup(client, url):
    assert client.put(url + '/permission', json=permission()).status_code == 200
    assert enable(client, url).status_code == 200


def test_explicit_lease_never_schedules_and_get_does_not_renew(client, preview):
    url, sid, clock, runtime = preview
    assert watch(client, url).status_code == 409
    setup(client, url)
    lease = str(uuid4()); response = watch(client, url, lease)
    assert response.json() == {'lease_id': lease, 'expires_at': clock[0] + 75}
    assert response.headers['cache-control'] == 'private, no-store'
    assert runtime.snapshot(OWNER, sid).tasks == ()
    clock[0] += 75
    assert client.get(url).json()['automatic']['viewing_until'] == 0
    tick(runtime)
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 1


def test_two_offline_rounds_then_viewing_does_not_consume_offline_quota(client, preview):
    url, sid, clock, runtime = preview; setup(client, url)
    tick(runtime); clock[0] += 600; tick(runtime); clock[0] += 600; tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 2
    assert watch(client, url).status_code == 200
    tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 3
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 2
    clock[0] += 600; tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 3
    with engine.connect() as conn:
        assert conn.execute(select(rt.calls)).all() == []


def test_multi_tab_and_multi_worker_share_ten_minute_interval(client, preview):
    url, sid, clock, runtime = preview; setup(client, url)
    a, b = str(uuid4()), str(uuid4())
    watch(client, url, a); watch(client, url, b)
    with ThreadPoolExecutor(max_workers=3) as pool:
        list(pool.map(lambda _: runtime.schedule_automatic(), range(3)))
    assert len(runtime.dispatched_tasks()) == 1
    tick(runtime); clock[0] += 599
    watch(client, url, a); watch(client, url, b); tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 1
    watch(client, url, a, enabled=False)
    assert runtime.snapshot(OWNER, sid).automatic.viewing_until > clock[0]
    clock[0] += 1; tick(runtime)
    assert len(runtime.read_events(OWNER, sid)) == 2
    assert runtime.snapshot(OWNER, sid).automatic.today_count == 0


def test_close_before_open_and_late_renewal_cannot_resurrect(client, preview):
    url, sid, _, runtime = preview; setup(client, url)
    lease = str(uuid4())
    assert watch(client, url, lease, enabled=False).status_code == 200
    assert watch(client, url, lease).status_code == 409
    assert watch(client, url, lease, enabled=False).status_code == 200
    assert runtime.snapshot(OWNER, sid).automatic.viewing_until == 0
    assert watch(client, url).status_code == 200


def test_stop_cancels_viewing_automatic_but_not_manual(client, preview):
    url, sid, clock, runtime = preview; setup(client, url)
    watch(client, url); runtime.schedule_automatic()
    tid = runtime.snapshot(OWNER, sid).tasks[0].id
    claimed = runtime.claim(OWNER, sid, tid)
    enable(client, url, revision=1, enabled=False)
    runtime.execute_step(OWNER, sid, tid, claimed.token, {'activity': 'rest', 'reason': 'late'})
    assert runtime.read_task(OWNER, sid, tid).state == 'cancelled'
    assert runtime.read_events(OWNER, sid) == []
    clock[0] += 600; manual = queue(client, url)
    enable(client, url, revision=2); enable(client, url, revision=3, enabled=False)
    assert runtime.read_task(OWNER, sid, manual).state == 'queued'


def test_new_permission_invalidates_leases_and_old_revision_cannot_renew(client, preview):
    url, sid, _, runtime = preview; setup(client, url)
    lease = str(uuid4()); watch(client, url, lease)
    client.put(url + '/permission', json=permission(True, 1))
    enable(client, url, revision=2)
    assert runtime.snapshot(OWNER, sid).automatic.viewing_until == 0
    assert watch(client, url, lease).status_code == 409
    assert watch(client, url, lease, revision=3).status_code == 409
    assert watch(client, url, revision=3).status_code == 200


def test_reopen_preserves_expiry_without_extending_it(client, preview):
    url, sid, clock, runtime = preview; setup(client, url)
    watch(client, url); until = clock[0] + 75
    reopened_engine = create_engine(str(engine.url), connect_args={'check_same_thread': False})
    try:
        reopened = rt.LifeRuntime(reopened_engine, lambda: clock[0]); reopened.initialize()
        assert reopened.snapshot(OWNER, sid).automatic.viewing_until == until
        clock[0] = until
        tick(reopened)
        assert reopened.snapshot(OWNER, sid).automatic.today_count == 1
    finally:
        reopened_engine.dispose()


def test_viewing_dispatch_marker_and_task_roll_back_together(client, preview, monkeypatch):
    url, sid, _, runtime = preview; setup(client, url); watch(client, url)
    monkeypatch.setattr(runtime, '_write_automatic', lambda *_: (_ for _ in ()).throw(LivingError('storage_unavailable', 'synthetic')))
    runtime.schedule_automatic()
    assert runtime.snapshot(OWNER, sid).tasks == ()
    with engine.connect() as conn:
        assert conn.execute(select(rt.automatic_tasks)).all() == []


@pytest.mark.parametrize('payload', [
    {'enabled': 'true', 'expected_revision': 1}, {'enabled': True, 'expected_revision': True},
    {'enabled': True, 'expected_revision': 1, 'expires_at': 9999999999},
])
def test_rejects_client_clock_and_non_strict_values(client, preview, payload):
    url, _, _, _ = preview
    assert client.put(url + '/viewing/' + str(uuid4()), json=payload).status_code == 422


def test_access_origin_and_production_gates(client, preview, monkeypatch):
    from app.core.config import get_settings
    url, sid, _, runtime = preview; setup(client, url)
    with pytest.raises(LivingError):
        runtime.save_viewing('another-owner', sid, str(uuid4()), 1, True)
    monkeypatch.setattr(runtime, 'origin', 'real_provider')
    response = watch(client, url)
    assert response.status_code == 500
    assert response.json()['error']['code'] == 'corrupt_state'
    monkeypatch.setattr(get_settings(), 'app_env', 'production')
    assert watch(client, url).status_code == 404
