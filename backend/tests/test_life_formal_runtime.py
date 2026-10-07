"""Formal entry and lifecycle; every provider is an offline test double."""
import asyncio
import json
import os
import subprocess
import sys
from uuid import uuid4

import pytest
from sqlalchemy import update

from app.core.config import Settings, get_settings
from app.living.life_provider import BASE_URL, MODEL
from app.living.store import spaces
from app.models.models import User
from app.services.release_readiness import assess
from tests.test_life_live_planner import OWNER, setup  # noqa: F401


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail('formal runtime tests must not access the network')
    monkeypatch.setattr('socket.socket.connect', forbidden)


def config(**changes):
    options = dict(_env_file=None, life_runtime_enabled=True, model_base_url=BASE_URL,
                   chat_model=MODEL, model_api_key='synthetic-only', database_url='sqlite:///formal-test.db')
    options.update(changes)
    return Settings(**options)


@pytest.mark.parametrize('changes,code', [
    ({'life_runtime_preview_enabled': True}, 'conflicts_with_preview'),
    ({'life_simulation_enabled': True}, 'conflicts_with_preview'),
    ({'life_live_planner_preview_enabled': True}, 'conflicts_with_preview'),
    ({'database_url': 'sqlite:///:memory:'}, 'persistent_sqlite'),
    ({'database_url': 'sqlite:///file:test?mode=memory&uri=true'}, 'persistent_sqlite'),
    ({'database_url': 'postgresql://localhost/test'}, 'persistent_sqlite'),
    ({'model_api_key': ''}, 'planner_configuration'),
    ({'chat_model': 'unapproved'}, 'planner_configuration'),
    ({'model_base_url': 'https://example.invalid/v1'}, 'planner_configuration'),
])
def test_invalid_formal_configuration_fails_before_runtime(changes, code):
    with pytest.raises(ValueError, match=code):
        config(**changes)


def test_production_accepts_formal_switch_without_accepting_previews():
    settings = config(app_env='production', dev_auth_token='', dev_sms_fixed_code='', legacy_claim_user_id='',
        generation_quota_enabled=True, sms_provider='volcengine', sms_live_enabled=True,
        sms_access_key_id='synthetic', sms_secret_access_key='synthetic', sms_account='synthetic',
        sms_sign='synthetic', sms_template_id='synthetic', sms_daily_limit=1)
    assert settings.life_runtime_active and not settings.life_runtime_preview_enabled


@pytest.fixture
def formal(client, setup, monkeypatch):
    from app.api import life_runtime as api
    from app.api.deps import get_current_user
    from app.main import app
    kernel, sid, tid = setup
    for key, value in dict(app_env='development', life_runtime_enabled=True, life_runtime_preview_enabled=False,
            life_live_planner_preview_enabled=False, model_base_url=BASE_URL, chat_model=MODEL,
            model_api_key='synthetic-only').items():
        monkeypatch.setattr(get_settings(), key, value)
    monkeypatch.setattr(api, 'live_runtime', kernel)
    monkeypatch.setattr(api.runtime, 'snapshot', lambda *args: pytest.fail('formal mode used offline runtime'))
    app.dependency_overrides[get_current_user] = lambda: User(id=OWNER, phone='13900000914')
    yield api, kernel, f'/api/v1/living/spaces/{sid}/life-runtime', sid, tid
    app.dependency_overrides.pop(get_current_user, None)


def test_formal_read_dispatch_zero_budget_and_pause(client, formal):
    api, kernel, url, sid, tid = formal
    before = client.get(url)
    assert before.status_code == 200 and before.json()['origin'] == 'real_provider'
    assert before.headers['cache-control'] == 'private, no-store'
    assert client.post(url + f'/tasks/{tid}/dispatch', json={}).status_code == 202
    from app.living.life_worker import consume_once
    async def execute(owner, space_id, task_id):
        await api.execute_requested(kernel, owner, space_id, task_id)
    asyncio.run(consume_once(kernel, execute))
    result = client.get(url).json()
    assert result['tasks'][0]['error_code'] == 'budget_exhausted'
    assert kernel.read_events(OWNER, sid) == []
    assert kernel.read_budget(OWNER, sid).committed == 0
    paused = client.put(url + '/permission', json={'request_id': str(uuid4()), 'expected_revision': 1,
        'enabled': False, 'activities': ['rest', 'walk']})
    assert paused.status_code == 200 and not paused.json()['permission']['enabled']


def test_formal_scope_and_disabled_entry(client, formal, monkeypatch):
    _, kernel, url, sid, tid = formal
    from app.api.deps import get_current_user
    from app.main import app
    app.dependency_overrides.pop(get_current_user)
    assert client.get(url, headers={'Authorization': 'Bearer invalid'}).status_code == 401
    app.dependency_overrides[get_current_user] = lambda: User(id=OWNER, phone='13900000914')
    with kernel.engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id == sid).values(owner_id='another-owner'))
    assert client.get(url).status_code == 404
    assert client.post(url + f'/tasks/{tid}/dispatch', json={}).status_code == 404
    monkeypatch.setattr(get_settings(), 'life_runtime_enabled', False)
    assert client.get(url).status_code == 404


def test_formal_lifespan_starts_and_cancels_one_worker(client, formal, monkeypatch):
    from app.main import app, lifespan
    from app.living import life_worker
    api, kernel, *_ = formal
    async def scenario():
        started, stopped = asyncio.Event(), asyncio.Event()
        async def consume(selected, execute):
            assert selected is kernel and selected.origin == 'real_provider'
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        monkeypatch.setattr(life_worker, 'consume', consume)
        async with lifespan(app):
            await asyncio.wait_for(started.wait(), 2)
        assert stopped.is_set()
    asyncio.run(scenario())


def test_formal_startup_initializes_marked_database_across_processes(tmp_path):
    db, uploads = tmp_path / 'formal.db', tmp_path / 'uploads'
    env = {**os.environ, 'APP_ENV': 'development', 'DATABASE_URL': 'sqlite:///' + str(db),
        'UPLOAD_DIR': str(uploads), 'LIFE_RUNTIME_ENABLED': 'true', 'LIFE_RUNTIME_PREVIEW_ENABLED': 'false',
        'LIFE_SIMULATION_ENABLED': 'false', 'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'false',
        'MODEL_BASE_URL': BASE_URL, 'CHAT_MODEL': MODEL, 'MODEL_API_KEY': 'synthetic-only',
        'MOTION_GENERATION_ENABLED': 'false'}
    script = '''
import socket
def forbidden(*args, **kwargs):
    raise AssertionError('no network')
socket.socket.connect = forbidden
import json
from sqlalchemy import text
from app.main import app
from app.core.database import engine
with engine.connect() as conn:
    print(json.dumps({'origin': conn.execute(text("SELECT origin FROM life_runtime_mode WHERE name='runtime'")).scalar_one(),
                      'tasks': conn.execute(text('SELECT count(*) FROM life_runtime_tasks')).scalar_one()}))
'''
    outputs = [subprocess.run([sys.executable, '-c', script], env=env, capture_output=True,
                             text=True, check=True, timeout=20) for _ in range(2)]
    assert [json.loads(r.stdout) for r in outputs] == [{'origin': 'real_provider', 'tasks': 0}] * 2


@pytest.mark.parametrize('backend_on,frontend_value,status', [
    (True, 'true', 'pending'), (True, '', 'blocked'), (False, 'true', 'blocked'),
    (False, 'false', 'pending'), (True, '${FLAG}', 'blocked'),
])
def test_release_preflight_detects_formal_entry_mismatch(tmp_path, backend_on, frontend_value, status):
    report = assess(config(life_runtime_enabled=backend_on),
                    {'NEXT_PUBLIC_LIFE_RUNTIME_ENABLED': frontend_value}, tmp_path)
    assert next(c for c in report['checks'] if c['id'] == 'life_runtime_entry')['status'] == status
    assert not report['ready_for_release']
