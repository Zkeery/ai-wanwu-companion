"""Network-forbidden scheduling checks; substitute output is not live AI evidence."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import json
import subprocess
import sys
from uuid import uuid4

import pytest
from sqlalchemy import select, update

from app.core.database import engine
from app.living.gathering_automatic import AutomaticDialogueStore, automatic, sessions, viewers, consume_once, day_number
from app.living.gathering_dialogue import grants, tasks
from app.living.life_provider import RESERVE_MICRO
from app.living.rules import LivingError
from tests.test_gathering_dialogue import ready, result, catalog, UID  # noqa: F401
from tests.test_gatherings import command, member


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))


@pytest.fixture
def prepared(ready):
    _, clock, group, ids, _ = ready
    return AutomaticDialogueStore(engine, lambda: clock[0]), clock, group, ids


def fund(prepared, rounds=4, auth=None):
    s, _, g, ids = prepared
    with engine.connect() as c:
        project_used = s._budget(c)['committed_micro']
        space_used = s._budget(c, g['id'])['committed_micro']
    return s.authorize_session(UID, g['id'], ids, rounds, auth or str(uuid4()),
        project_cap_micro=project_used+rounds*RESERVE_MICRO, space_cap_micro=space_used+rounds*RESERVE_MICRO)


def enable(prepared, sid, rid=None):
    s, _, g, _ = prepared
    return s.configure(UID, g['id'], rid or str(uuid4()), s.status(UID, g['id'])['revision'], True, sid)


class Client:
    def __init__(self):
        self.facts = []

    async def exchange(self, facts):
        self.facts.append(facts)
        return result([p['character_id'] for p in facts['participants']])


def tick(s, client):
    asyncio.run(consume_once(s, lambda: client, catalog))


def test_default_off_and_single_round_grant_cannot_fund_automatic(prepared, ready):
    s, _, g, _ = prepared
    assert s.status(UID, g['id'])['authorization'] is None
    with pytest.raises(LivingError):
        enable(prepared, ready[-1])
    client = Client()
    tick(s, client)
    assert client.facts == []
    fund(prepared)
    tick(s, client)
    assert client.facts == [] and not s.status(UID, g['id'])['enabled']


def test_cadence_offline_daily_cap_viewers_and_following_history(prepared):
    s, clock, g, _ = prepared
    sid = fund(prepared)
    enable(prepared, sid)
    client = Client()
    tick(s, client)
    first = s.read(UID, g['id'])['exchanges'][0]['id']
    clock[0] += 599
    tick(s, client)
    assert len(client.facts) == 1
    clock[0] += 1
    tick(s, client)
    assert client.facts[1]['recent_exchanges'][0]['event_id'] == first
    clock[0] += 600
    tick(s, client)
    assert len(client.facts) == 2 and s.status(UID, g['id'])['today_count'] == 2
    for _ in range(2):
        s.viewing(UID, g['id'], str(uuid4()), True)
    tick(s, client)
    tick(s, client)
    assert len(client.facts) == 3 and s.status(UID, g['id'])['today_count'] == 2
    clock[0] += 600
    tick(s, client)
    assert len(client.facts) == 3  # Both leases expired: daily offline cap still applies.
    clock[0] = (day_number(clock[0])+1)*86400-8*3600
    tick(s, client)
    current = s.status(UID, g['id'])
    assert len(client.facts) == 4 and current['today_count'] == 1
    assert not current['enabled'] and current['stop_reason'] == 'completed'
    assert 'PRIVATE_' not in json.dumps(client.facts)
    with engine.connect() as c:
        assert s._budget(c)['committed_micro'] == 4*RESERVE_MICRO


def test_concurrent_claim_and_restart_do_not_redeliver(prepared):
    s, clock, g, _ = prepared
    enable(prepared, fund(prepared))
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: s.claim_next(), range(4)))
    task = next(t for t in claims if t)
    assert sum(t is not None for t in claims) == 1
    script = '''
import json, sys
from sqlalchemy import create_engine
from app.living.gathering_automatic import AutomaticDialogueStore
s=AutomaticDialogueStore(create_engine(sys.argv[1]),lambda:int(sys.argv[4]))
print(json.dumps({'claim':s.claim_next(),'status':s.status(sys.argv[2],sys.argv[3])}))
'''
    child = subprocess.run([sys.executable, '-c', script, str(engine.url), UID, g['id'], str(clock[0])],
                           capture_output=True, text=True, timeout=20, check=True)
    parsed = json.loads(child.stdout)
    assert parsed['claim'] is None and parsed['status']['last_task_id'] == task['id']
    clock[0] += 61
    tick(s, Client())
    current = s.status(UID, g['id'])
    assert not current['enabled'] and current['stop_reason'] == 'interrupted'
    assert s.read(UID, g['id'])['tasks'][0]['state'] == 'failed'
    assert current['authorization'] is None


@pytest.mark.parametrize('failure', ['factory', 'provider', 'format'])
def test_failure_stops_batch_without_retry(prepared, failure):
    s, clock, g, _ = prepared
    sid = fund(prepared)
    enable(prepared, sid)
    calls = []
    class Broken:
        async def exchange(self, facts):
            calls.append(facts)
            if failure == 'provider':
                raise TimeoutError('PRIVATE_SECRET_NEVER_LOG')
            return {'lines': []}
    def factory():
        if failure == 'factory':
            raise ValueError('PRIVATE_KEY_NEVER_LOG')
        return Broken()
    asyncio.run(consume_once(s, factory, catalog))
    clock[0] += 1000
    asyncio.run(consume_once(s, factory, catalog))
    status = s.status(UID, g['id'])
    assert not status['enabled'] and status['authorization'] is None
    assert len(calls) == (0 if failure == 'factory' else 1)
    with pytest.raises(LivingError): enable(prepared, sid)
    assert 'PRIVATE_' not in json.dumps(s.read(UID, g['id']))


@pytest.mark.parametrize('change', ['pause', 'recall', 'consent', 'space', 'join'])
def test_inflight_change_never_publishes_or_continues(prepared, change):
    s, clock, g, ids = prepared
    enable(prepared, fund(prepared))
    class Changed:
        async def exchange(self, facts):
            current = s.status(UID, g['id'])
            if change == 'pause':
                s.configure(UID, g['id'], str(uuid4()), current['revision'], False)
            elif change == 'recall': command(s, g, 'recall', character_id=ids[0])
            elif change == 'consent': command(s, g, 'dialogue_consent', character_id=ids[0], enabled=False)
            elif change == 'space': command(s, g, 'dialogue_space', enabled=False)
            else: member(s, g, 'new-member')
            return result(ids)
    tick(s, Changed())
    assert not s.read(UID, g['id'])['exchanges']
    assert not s.status(UID, g['id'])['enabled']
    clock[0] += 600
    client = Client(); tick(s, client)
    assert client.facts == []


def test_pause_replay_and_resume_preserve_frequency_and_budget(prepared):
    s, clock, g, _ = prepared
    sid = fund(prepared)
    rid = str(uuid4())
    enabled = enable(prepared, sid, rid)
    client = Client(); tick(s, client)
    paused = s.configure(UID, g['id'], str(uuid4()), enabled['revision'], False)
    replay = s.configure(UID, g['id'], rid, 0, True, sid)
    assert replay['revision'] == paused['revision'] and not replay['enabled']
    enable(prepared, sid)
    tick(s, client)
    assert len(client.facts) == 1
    assert s.status(UID, g['id'])['today_count'] == 1
    clock[0] += 600
    tick(s, client)
    assert len(client.facts) == 2


def test_manual_single_round_blocked_only_while_automatic_enabled(prepared, ready):
    s, _, g, ids = prepared
    current = enable(prepared, fund(prepared))
    with pytest.raises(LivingError): s.prepare(UID, g['id'], str(uuid4()), g['revision'], ids, ready[-1])
    s.configure(UID, g['id'], str(uuid4()), current['revision'], False)
    task, fresh = s.prepare(UID, g['id'], str(uuid4()), g['revision'], ids, ready[-1])
    assert fresh and task['dispatched'] == 0


def test_expiry_and_both_cumulative_limits_stop_new_work(prepared):
    from app.living.gathering_automatic import limits
    s, clock, g, _ = prepared
    sid = fund(prepared)
    enable(prepared, sid)
    with engine.begin() as c:
        c.execute(update(limits).where(limits.c.scope == 'project').values(cap_micro=0))
    client = Client(); tick(s, client)
    assert not client.facts and s.status(UID, g['id'])['stop_reason'] == 'budget_exhausted'
    sid = fund(prepared)
    enable(prepared, sid)
    clock[0] += 86401
    tick(s, client)
    assert not client.facts and s.status(UID, g['id'])['stop_reason'] == 'expired'


def test_viewer_end_is_terminal_and_does_not_end_other_page(prepared):
    s, clock, g, _ = prepared
    a, b = str(uuid4()), str(uuid4())
    s.viewing(UID, g['id'], a, False)  # Pagehide arrives before an earlier heartbeat.
    assert s.viewing(UID, g['id'], a, True)['active'] is False
    s.viewing(UID, g['id'], b, True)
    with engine.connect() as c:
        active = c.execute(select(viewers.c.viewer_id).where(viewers.c.closed == 0, viewers.c.expires_at > clock[0])).scalars().all()
    assert active == [b]


def test_members_may_pause_but_cannot_use_or_read_other_batch(prepared):
    s, _, g, _ = prepared
    g = member(s, g, 'guest')
    prepared = s, prepared[1], g, prepared[3]
    sid = fund(prepared)
    assert s.status('guest', g['id'])['authorization'] is None
    with pytest.raises(LivingError): s.configure('guest', g['id'], str(uuid4()), 0, True, sid)
    current = enable(prepared, sid)
    assert not s.configure('guest', g['id'], str(uuid4()), current['revision'], False)['enabled']
    for operation in [lambda: s.status('outsider', g['id']), lambda: s.viewing('outsider', g['id'], str(uuid4()), True)]:
        with pytest.raises(LivingError): operation()


def test_authorization_replay_does_not_reset_usage_and_rejects_changed_caps(prepared):
    s, _, g, ids = prepared
    auth = str(uuid4()); sid = fund(prepared, 2, auth)
    enable(prepared, sid); tick(s, Client())
    assert s.authorize_session(UID, g['id'], ids, 2, auth,
        project_cap_micro=2*RESERVE_MICRO, space_cap_micro=2*RESERVE_MICRO) == sid
    assert s.status(UID, g['id'])['authorization']['used_rounds'] == 1
    with pytest.raises(LivingError):
        s.authorize_session(UID, g['id'], ids, 2, auth, project_cap_micro=3*RESERVE_MICRO, space_cap_micro=2*RESERVE_MICRO)


def test_api_is_authenticated_bounded_and_allows_pause_when_feature_is_off(prepared, client, anon, monkeypatch):
    from app.api import gatherings
    s, _, g, _ = prepared
    monkeypatch.setattr(gatherings, 'automatic_store', s)
    monkeypatch.setattr(gatherings, 'automatic_available', lambda: False)
    url = f"/api/v1/gatherings/{g['id']}/dialogue/automatic"
    assert anon.get(url).status_code == 401
    assert client.get(url).json()['available'] is False
    sid = fund(prepared)
    body = dict(request_id=str(uuid4()), expected_revision=0, enabled=True, session_id=sid)
    assert client.post(url, json=body).status_code == 409
    assert client.post(url, json={**body, 'enabled':'true'}).status_code == 422
    monkeypatch.setattr(gatherings, 'automatic_available', lambda: True)
    response = client.post(url, json=body)
    assert response.status_code == 200 and response.json()['enabled']
    assert 'no-store' in response.headers['cache-control']
    monkeypatch.setattr(gatherings, 'automatic_available', lambda: False)
    pause = client.post(url, json=dict(request_id=str(uuid4()), expected_revision=1, enabled=False))
    assert pause.status_code == 200 and not pause.json()['enabled']
    assert client.put(f"/api/v1/gatherings/{g['id']}/dialogue/viewer", json=dict(viewer_id=str(uuid4()),active=True)).status_code == 200


def test_cancelled_execution_is_unknown_and_never_replayed(prepared):
    s, clock, g, _ = prepared
    enable(prepared, fund(prepared))
    class Cancelled:
        async def exchange(self, facts):
            raise asyncio.CancelledError()
    with pytest.raises(asyncio.CancelledError): tick(s, Cancelled())
    assert s.read(UID, g['id'])['tasks'][0]['state'] == 'unknown'
    clock[0] += 600
    client = Client(); tick(s, client)
    assert client.facts == [] and not s.status(UID, g['id'])['enabled']


@pytest.mark.parametrize('scope', ['project', 'space'])
def test_batch_cannot_be_issued_above_either_declared_ceiling(prepared, scope):
    s, _, g, ids = prepared
    with pytest.raises(LivingError) as error:
        s.authorize_session(UID, g['id'], ids, 2, str(uuid4()),
            project_cap_micro=RESERVE_MICRO if scope == 'project' else 2*RESERVE_MICRO,
            space_cap_micro=RESERVE_MICRO if scope == 'space' else 2*RESERVE_MICRO)
    assert error.value.code == 'budget_exhausted'
    assert s.status(UID, g['id'])['authorization'] is None


def test_permission_removed_before_tick_closes_without_spending(prepared):
    s, _, g, ids = prepared
    enable(prepared, fund(prepared))
    command(s, g, 'recall', character_id=ids[0])
    client = Client(); tick(s, client)
    assert client.facts == [] and s.status(UID, g['id'])['stop_reason'] == 'permission_changed'
    with engine.connect() as c:
        assert s._budget(c)['committed_micro'] == 0


def test_worker_lifecycle_starts_only_when_available_and_is_cancelled(client, monkeypatch):
    from fastapi import FastAPI
    from app import main
    from app.api import gatherings
    from app.living import gathering_automatic
    started, stopped = [], []
    async def worker(store, factory):
        started.append(store)
        try:
            await asyncio.Event().wait()
        finally:
            stopped.append(store)
    monkeypatch.setattr(gathering_automatic, 'consume', worker)
    monkeypatch.setattr(gatherings, 'automatic_available', lambda: True)
    async def run():
        async with main.lifespan(FastAPI()):
            await asyncio.sleep(0)
    asyncio.run(run())
    assert len(started) == len(stopped) == 1
    monkeypatch.setattr(gatherings, 'automatic_available', lambda: False)
    asyncio.run(run())
    assert len(started) == 1


def test_configuration_requires_persistent_storage_and_correct_provider(tmp_path):
    from app.core.config import Settings
    from app.living.life_provider import BASE_URL
    base = dict(_env_file=None, gathering_dialogue_automatic_enabled=True, gathering_dialogue_enabled=True,
                model_api_key='synthetic-no-network', model_base_url=BASE_URL,
                database_url=f'sqlite:///{tmp_path / "settings.db"}')
    assert Settings(**base).gathering_dialogue_automatic_enabled
    for change in [dict(database_url='sqlite:///:memory:'), dict(gathering_dialogue_enabled=False),
                   dict(model_api_key=''), dict(model_base_url='https://invalid.example')]:
        with pytest.raises(ValueError): Settings(**{**base, **change})


def test_operator_plan_is_read_only_and_execution_is_one_shot(prepared):
    import hashlib
    from pathlib import Path
    s, _, g, ids = prepared
    # The independent CLI must use the same explicit fixture clock as its stored scene.
    path = Path(engine.url.database)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    runner = 'import time; time.time=lambda:1800000000; from scripts.manage_shared_automatic import main; main()'
    args = [sys.executable, '-c', runner, '--database', str(path), '--owner', UID,
        '--space', g['id'], '--characters', *map(str,ids), '--rounds', '2', '--project-cap-yuan', '2.2912', '--space-cap-yuan', '2.2912']
    planned = subprocess.run(args, capture_output=True, text=True, timeout=20, check=True)
    assert json.loads(planned.stdout)['mode'] == 'read_only'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    execute = args + ['--execute', '--authorization-ref', 'synthetic-cli-only-batch']
    first = subprocess.run(execute, capture_output=True, text=True, timeout=20, check=True)
    second = subprocess.run(execute, capture_output=True, text=True, timeout=20, check=True)
    assert json.loads(first.stdout)['session_id'] == json.loads(second.stdout)['session_id']
    assert json.loads(second.stdout)['model_requests'] == 0
    with engine.connect() as c:
        assert len(c.execute(select(sessions)).all()) == 1
        assert not c.execute(select(automatic)).all()


def test_other_spaces_unspent_allocation_is_reserved_in_project_ceiling(prepared):
    from app.core.database import SessionLocal
    from app.models.models import Character
    from tests.test_gatherings import create
    s, _, _, ids = prepared
    fund(prepared, 4)
    with SessionLocal() as db:
        source = db.get(Character, ids[0])
        other_ids = []
        for name in ['其他杯子','其他苹果']:
            ch = Character(object_id=source.object_id, owner_id=UID, name=name, persona='',opening_line='',status='ready')
            db.add(ch); db.flush(); other_ids.append(ch.id)
        db.commit()
    other = create(s)
    for cid in other_ids:
        other = command(s, other, 'visit', character_id=cid)
        other = command(s, other, 'dialogue_consent', character_id=cid, enabled=True)
    other = command(s, other, 'dialogue_space', enabled=True)
    with pytest.raises(LivingError):
        s.authorize_session(UID, other['id'], other_ids, 2, str(uuid4()),
            project_cap_micro=2*RESERVE_MICRO, space_cap_micro=2*RESERVE_MICRO)
    sid = s.authorize_session(UID, other['id'], other_ids, 2, str(uuid4()),
        project_cap_micro=6*RESERVE_MICRO, space_cap_micro=2*RESERVE_MICRO)
    assert sid and s.status(UID, other['id'])['authorization']['used_rounds'] == 0


def test_owner_removal_revokes_active_schedule_and_visibility(prepared):
    s, clock, g, ids = prepared
    g = member(s, g, 'next-manager')
    g = command(s, g, 'transfer', member_id='next-manager')
    updated = s, clock, g, ids
    enable(updated, fund(updated))
    command(s, g, 'remove', uid='next-manager', member_id=UID)
    client = Client(); tick(s, client)
    assert client.facts == []
    with pytest.raises(LivingError): s.status(UID, g['id'])
    assert not s.status('next-manager', g['id'])['enabled']


def test_catalog_failure_consumes_at_most_one_attempt_and_never_initializes_provider(prepared):
    s, _, g, _ = prepared
    enable(prepared, fund(prepared))
    def forbidden():
        pytest.fail('client must not be initialized')
    async def broken_catalog():
        raise TimeoutError('synthetic catalog outage')
    asyncio.run(consume_once(s, forbidden, broken_catalog))
    asyncio.run(consume_once(s, forbidden, broken_catalog))
    assert not s.status(UID, g['id'])['enabled']
    with engine.connect() as c:
        assert s._budget(c)['committed_micro'] == RESERVE_MICRO
