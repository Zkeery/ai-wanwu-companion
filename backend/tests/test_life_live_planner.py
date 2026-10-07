"""Real-provider provenance, zero-budget safety and one-shot isolated execution."""
import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, insert, select, update

from app.core.config import BASE_DIR, Settings
from app.core.database import Base
from app.living.life_live_planner import run_real_planner
from app.living.life_provider import RESERVE_MICRO, Reply
from app.living.life_runtime import LifeRuntime, calls, events, mode_marker, tasks
from app.living.rules import LivingError
from app.living.store import metadata as living_metadata
from app.models.models import Character, Object, Photo, User
from tests.test_life_runtime import stamp

OWNER = 'live-fixture-owner'


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError('C1.6 tests must not access the network')
    monkeypatch.setattr('socket.socket.connect', forbidden)


@pytest.fixture
def setup(tmp_path):
    db = tmp_path / 'live.db'
    engine = create_engine('sqlite:///' + str(db), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    living_metadata.create_all(engine)
    kernel = LifeRuntime(engine, lambda: stamp(), origin='real_provider')
    kernel.initialize()
    with engine.begin() as conn:
        conn.execute(insert(User).values(id=OWNER, phone='13900000914'))
        conn.execute(insert(Photo).values(id=1, filename='fixture.png', status='done', owner_id=OWNER))
        conn.execute(insert(Object).values(id=1, photo_id=1, label='合成杯子'))
        conn.execute(insert(Character).values(id=1, object_id=1, owner_id=OWNER, name='合成伙伴',
            persona='仅用于隔离试用', opening_line='你好', status='ready', location_epoch=1))
    sid = str(uuid4())
    kernel.store.create_space(OWNER, sid, 'home', 'private', '1')
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == 1).values(current_space_id=sid))
    kernel.save_permission(OWNER, sid, str(uuid4()), 0, True, ('rest', 'walk'))
    task = kernel.schedule(OWNER, sid, str(uuid4()))
    yield kernel, sid, task.spec.basis.plan_id
    engine.dispose()


class Client:
    def __init__(self, fail=False):
        self.calls = 0
        self.prompts = []
        self.fail = fail

    async def plan(self, prompt):
        self.calls += 1
        self.prompts.append(prompt)
        if self.fail:
            raise LivingError('provider_error', 'synthetic provider failure')
        return Reply({'activity': 'walk', 'reason': '在允许的庭院里散步'},
                     '{"activity":"walk"}', 'qwen3.8-flash', None, None)


async def catalog():
    return {'model': 'qwen3.8-flash', 'reserve_micro': RESERVE_MICRO}


def allocate(kernel, sid):
    kernel.set_limit('project', RESERVE_MICRO, 'synthetic-test-only')
    kernel.set_limit('space:' + sid, RESERVE_MICRO, 'synthetic-test-only')


def ledger(kernel):
    with kernel.engine.connect() as conn:
        return [json.loads(row.payload) for row in conn.execute(select(calls.c.payload))]


def test_zero_budget_stops_before_catalog_or_provider(setup):
    kernel, sid, tid = setup
    async def unexpected():
        pytest.fail('catalog must not be read without a budget')
    result = asyncio.run(run_real_planner(kernel, OWNER, sid, tid,
        lambda: pytest.fail('provider must not initialize'), unexpected))
    assert result.state == 'failed' and result.result.error_code == 'budget_exhausted'
    assert ledger(kernel) == [] and kernel.read_events(OWNER, sid) == []


def test_one_real_labelled_step_is_persisted_and_never_dispatched_twice(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    client = Client()
    result = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: client, catalog))
    assert result.state == 'done'
    assert result.spec.origin == result.result.event.origin == 'real_provider'
    assert kernel.snapshot(OWNER, sid).origin == 'real_provider'
    assert len(kernel.read_events(OWNER, sid)) == client.calls == 1
    assert client.prompts[0].origin == 'real_provider'
    assert OWNER not in client.prompts[0].user and sid not in client.prompts[0].user
    assert ledger(kernel)[0]['origin'] == 'real_provider'
    assert ledger(kernel)[0]['outcome'] == 'unknown'
    assert kernel.read_budget(OWNER, sid).committed == RESERVE_MICRO
    replay = asyncio.run(run_real_planner(kernel, OWNER, sid, tid,
        lambda: pytest.fail('no second provider call'), catalog))
    assert replay == result
    reopened = LifeRuntime(kernel.engine, lambda: stamp(), origin='real_provider')
    reopened.initialize()
    assert reopened.read_task(OWNER, sid, tid) == result
    with kernel.engine.connect() as conn:
        assert conn.execute(select(mode_marker.c.origin)).scalar_one() == 'real_provider'


def test_provider_failure_retains_unknown_reservation_without_retry(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    client = Client(fail=True)
    result = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: client, catalog))
    assert result.state == 'failed' and result.result.error_code == 'provider_error'
    assert client.calls == 1 and kernel.read_events(OWNER, sid) == []
    assert ledger(kernel)[0]['outcome'] == 'unknown'
    asyncio.run(run_real_planner(kernel, OWNER, sid, tid,
        lambda: pytest.fail('no retry'), catalog))
    assert client.calls == 1


@pytest.mark.parametrize('code', ['provider_read_timeout', 'provider_connect_timeout', 'provider_write_timeout',
                                 'provider_pool_timeout', 'provider_connect_error', 'provider_transport_error',
                                 'provider_deadline', 'provider_http_401', 'provider_http_429', 'provider_http_502',
                                 'invalid_response'])
def test_provider_diagnostics_persist_without_retry_or_private_text(setup, code):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    class Failing(Client):
        async def plan(self, prompt):
            self.calls += 1
            raise LivingError(code, 'PRIVATE_PROVIDER_BODY must not be retained')
    client = Failing()
    value = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: client, catalog))
    assert value.result.error_code == code and client.calls == 1
    assert ledger(kernel)[0]['outcome'] == 'unknown' and ledger(kernel)[0]['actual_cost'] is None
    reopened = LifeRuntime(kernel.engine, kernel.clock, origin='real_provider')
    assert reopened.read_task(OWNER, sid, tid).result.error_code == code
    assert 'PRIVATE_PROVIDER_BODY' not in value.model_dump_json()
    asyncio.run(run_real_planner(reopened, OWNER, sid, tid, lambda: pytest.fail('no retry'), catalog))
    assert client.calls == 1


def test_pricing_diagnostic_before_dispatch_releases_only_unused_reservation(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    async def failed_catalog():
        raise LivingError('pricing_unverified', 'PRIVATE_CATALOG_DETAILS')
    value = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: pytest.fail('no provider'), failed_catalog))
    assert value.result.error_code == 'pricing_unverified'
    assert ledger(kernel)[0]['actual_cost'] == 0
    assert 'PRIVATE_CATALOG_DETAILS' not in value.model_dump_json()


def test_unknown_error_code_and_raw_exception_text_are_not_persisted(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    class Failing(Client):
        async def plan(self, prompt):
            raise LivingError('provider_http_502_PRIVATE_SECRET', 'PRIVATE_BODY')
    value = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, Failing, catalog))
    assert value.result.error_code == 'worker_error'
    assert 'PRIVATE_' not in value.model_dump_json()


def test_pause_during_catalog_check_cancels_without_model_dispatch(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    async def pause():
        kernel.save_permission(OWNER, sid, str(uuid4()), 1, False, ('rest', 'walk'))
        return await catalog()
    result = asyncio.run(run_real_planner(kernel, OWNER, sid, tid,
        lambda: pytest.fail('paused task cannot dispatch'), pause))
    assert result.state == 'cancelled'
    assert ledger(kernel)[0]['actual_cost'] == 0
    assert kernel.read_events(OWNER, sid) == []


def test_real_and_offline_modes_cannot_reuse_each_others_database(setup):
    kernel, sid, tid = setup
    with pytest.raises(LivingError, match='模式'):
        LifeRuntime(kernel.engine, lambda: stamp()).initialize()
    with pytest.raises(LivingError, match='不能使用离线'):
        kernel.run_fixture(OWNER, sid, tid)
    assert kernel.read_task(OWNER, sid, tid).state == 'queued'


def test_real_mode_rejects_existing_offline_preview_data(tmp_path):
    engine = create_engine('sqlite:///' + str(tmp_path / 'offline.db'))
    offline = LifeRuntime(engine, lambda: stamp())
    offline.initialize()
    offline.set_limit('project', RESERVE_MICRO, 'synthetic-test-only')
    with pytest.raises(LivingError, match='离线'):
        LifeRuntime(engine, lambda: stamp(), origin='real_provider').initialize()
    engine.dispose()


def test_live_preview_settings_require_isolated_test_paths():
    runtime = BASE_DIR.parent / '.runtime'
    options = dict(app_env='test', life_runtime_preview_enabled=True,
                   life_live_planner_preview_enabled=True)
    safe = Settings(_env_file=None, **options,
                    database_url='sqlite:///' + str(runtime / 'life-live.db'),
                    upload_dir=str(runtime / 'life-live-uploads'))
    assert safe.life_live_planner_preview_enabled
    with pytest.raises(ValueError, match='isolated_test_runtime'):
        Settings(_env_file=None, **options,
                 database_url='sqlite:///' + str(BASE_DIR / 'data' / 'app.db'),
                 upload_dir=str(runtime / 'life-live-uploads'))
    with pytest.raises(ValueError, match='isolated_test_runtime'):
        Settings(_env_file=None, **options,
                 database_url='sqlite:///' + str(runtime / 'life-live.db'),
                 upload_dir=str(BASE_DIR / 'data' / 'uploads'))


def test_live_http_flow_uses_real_label_and_zero_budget(client, setup, monkeypatch):
    from app.api import life_runtime as api
    from app.api.deps import get_current_user
    from app.core.config import get_settings
    from app.main import app
    from app.living.life_provider import BASE_URL, MODEL

    kernel, sid, tid = setup
    settings = get_settings()
    for name, value in (('app_env', 'test'), ('life_runtime_preview_enabled', True),
                        ('life_live_planner_preview_enabled', True),
                        ('model_base_url', BASE_URL), ('chat_model', MODEL),
                        ('model_api_key', 'synthetic-test-only')):
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(api, 'live_runtime', kernel)
    app.dependency_overrides[get_current_user] = lambda: User(id=OWNER, phone='13900000914')
    url = f'/api/v1/living/spaces/{sid}/life-runtime'
    try:
        initial = client.get(url)
        assert initial.status_code == 200 and initial.json()['origin'] == 'real_provider'
        empty = client.post(url + f'/tasks/{tid}/run', json={})
        assert empty.status_code == 200, empty.json()
        assert empty.json()['tasks'][0]['state'] == 'failed'
        assert ledger(kernel) == []

        allocate(kernel, sid)
        later = LifeRuntime(kernel.engine, lambda: stamp() + 600, origin='real_provider')
        monkeypatch.setattr(api, 'live_runtime', later)
        next_task = client.post(url + '/tasks', json={'request_id': str(uuid4())})
        assert next_task.status_code == 200
        next_id = next_task.json()['tasks'][0]['id']
        fake = Client()
        async def dispatch(runtime, owner, space_id, task_id, _factory):
            return await run_real_planner(runtime, owner, space_id, task_id, lambda: fake, catalog)
        monkeypatch.setattr(api, 'run_real_planner', dispatch)
        response = client.post(url + f'/tasks/{next_id}/run', json={})
        assert response.status_code == 200 and fake.calls == 1
        assert response.json()['origin'] == 'real_provider'
        assert response.json()['tasks'][0]['state'] == 'done'
    finally:
        app.dependency_overrides.pop(get_current_user, None)


@pytest.mark.parametrize('case_id,activity,hour', [
    ('day-observe', 'observe', 12), ('night-rest', 'rest', 23), ('empty-walk', 'walk', 12),
])
def test_archived_real_reply_reaches_saved_scene_and_survives_restart(tmp_path, case_id, activity, hour):
    """Replay archived model output; this is not a new provider request or quality verdict."""
    archive = Path(__file__).resolve().parents[2] / 'docs/PRD/版本/V1.2/验收证据/阶段3/C1.32真实生活规划新批次/真实结果.json'
    attempt = next(row for row in json.loads(archive.read_text())['attempts'] if row['case_id'] == case_id)
    assert attempt['state'] == 'passed' and attempt['result']['origin'] == 'real_eval'
    candidate = dict(attempt['result']['candidate'])
    database = tmp_path / 'archived-replay.db'
    engine = create_engine('sqlite:///' + str(database), connect_args={'check_same_thread': False})
    Base.metadata.create_all(engine)
    living_metadata.create_all(engine)
    kernel = LifeRuntime(engine, lambda: stamp(23, hour), origin='real_provider')
    kernel.initialize()
    with engine.begin() as conn:
        conn.execute(insert(User).values(id=OWNER, phone='13900000914'))
        conn.execute(insert(Photo).values(id=1, filename='fixture.png', status='done', owner_id=OWNER))
        conn.execute(insert(Object).values(id=1, photo_id=1, label='合成杯子'))
        conn.execute(insert(Character).values(id=1, object_id=1, owner_id=OWNER, name='合成伙伴',
            persona='仅用于归档回复重放', opening_line='你好', status='ready', location_epoch=1))
    sid = str(uuid4())
    kernel.store.create_space(OWNER, sid, 'home', 'private', '1')
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == 1).values(current_space_id=sid))
    if activity == 'observe':
        scene = kernel.store.execute(OWNER, sid, str(uuid4()), 0,
            {'action': 'place', 'kind': 'tree', 'x': .3, 'y': .4})
        candidate['target_id'] = scene['items'][0]['id']  # Map the archived fixture tree into this fresh space.
    kernel.save_permission(OWNER, sid, str(uuid4()), 0, True, (activity,))
    tid = kernel.schedule(OWNER, sid, str(uuid4())).spec.basis.plan_id
    kernel.set_limit('project', RESERVE_MICRO, 'archived-replay-only')
    kernel.set_limit('space:' + sid, RESERVE_MICRO, 'archived-replay-only')
    reply = Reply(candidate, json.dumps(candidate, ensure_ascii=False), 'qwen3.8-flash', None, None)
    replay = Client()
    async def plan(_prompt):
        replay.calls += 1
        return reply
    replay.plan = plan
    result = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: replay, catalog))
    assert result.state == 'done' and result.result.event.reason == candidate['reason']
    assert replay.calls == 1
    snapshot = kernel.snapshot(OWNER, sid)
    assert snapshot.origin == 'real_provider'
    assert snapshot.tasks[0].reason == candidate['reason']
    assert snapshot.current_activity.activity == activity
    assert snapshot.current_activity.task_id == tid
    assert kernel.history(OWNER, sid).tasks[0].reason == candidate['reason']
    asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: replay, catalog))
    assert replay.calls == 1
    engine.dispose()
    reopened_engine = create_engine('sqlite:///' + str(database), connect_args={'check_same_thread': False})
    reopened = LifeRuntime(reopened_engine, lambda: stamp(23, hour), origin='real_provider')
    reopened.initialize()
    assert reopened.snapshot(OWNER, sid).tasks[0].reason == candidate['reason']
    assert reopened.history(OWNER, sid).tasks[0].reason == candidate['reason']
    reopened_engine.dispose()


def test_old_completed_event_without_reason_still_reads(setup):
    kernel, sid, tid = setup
    allocate(kernel, sid)
    fake = Client()
    result = asyncio.run(run_real_planner(kernel, OWNER, sid, tid, lambda: fake, catalog))
    assert result.state == 'done'
    with kernel.engine.begin() as conn:
        saved_task = json.loads(conn.execute(select(tasks.c.result).where(tasks.c.id == tid)).scalar_one())
        saved_event = json.loads(conn.execute(select(events.c.payload).where(events.c.task_id == tid)).scalar_one())
        saved_task['event'].pop('reason')
        saved_event.pop('reason')
        conn.execute(update(tasks).where(tasks.c.id == tid).values(result=json.dumps(saved_task)))
        conn.execute(update(events).where(events.c.task_id == tid).values(payload=json.dumps(saved_event)))
    assert kernel.snapshot(OWNER, sid).tasks[0].reason is None
    assert kernel.history(OWNER, sid).tasks[0].reason is None
