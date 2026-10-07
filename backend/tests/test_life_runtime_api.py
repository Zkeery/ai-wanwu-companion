from uuid import uuid4
import json
import sqlite3

import pytest
from sqlalchemy import insert, select, update
from sqlalchemy.exc import SQLAlchemyError

from app.core.config import get_settings
from app.core.database import engine
from app.living import life_runtime as rt
from app.living.store import spaces
from tests.auth_helpers import TEST_USER_ID


@pytest.fixture
def preview(client, ready_character_id, monkeypatch):
    from app.api.life_runtime import runtime
    from app.api.living import living_store
    from tests.test_life_planning import stamp
    monkeypatch.setattr(get_settings(), 'app_env', 'test')
    monkeypatch.setattr(get_settings(), 'life_runtime_preview_enabled', True)
    rt.metadata.drop_all(engine); runtime.initialize()
    clock = [stamp()]
    monkeypatch.setattr(living_store, 'clock', lambda: clock[0])
    created = client.post('/api/v1/living/spaces', json={'scene_type': 'home', 'mode': 'private', 'companion_id': str(ready_character_id)})
    sid = created.json()['id']
    client.put(f'/api/v1/characters/{ready_character_id}/location', json={'space_id': sid})
    yield f'/api/v1/living/spaces/{sid}/life-runtime', sid, clock, runtime
    rt.metadata.drop_all(engine)


def permission(enabled=True, revision=0, activities=None):
    return {'request_id': str(uuid4()), 'expected_revision': revision, 'enabled': enabled,
            'activities': ['rest', 'walk', 'observe'] if activities is None else activities}


def queue(client, url):
    response = client.post(url + '/tasks', json={'request_id': str(uuid4())})
    assert response.status_code == 200, response.text
    return response.json()['tasks'][0]['id']


def test_full_save_queue_refresh_run_pause_and_redaction(client, preview):
    url, sid, _, runtime = preview
    first = client.get(url)
    assert first.json()['permission'] == {'enabled': False, 'activities': [], 'revision': 0}
    assert first.json()['tasks'] == []
    assert first.headers['cache-control'] == 'private, no-store'
    assert first.headers['vary'] == 'Authorization'
    p = permission()
    assert client.put(url + '/permission', json=p).status_code == 200
    assert client.put(url + '/permission', json=p).json()['permission']['revision'] == 1
    tid = queue(client, url)
    assert client.get(url).json()['tasks'][0]['state'] == 'queued'
    r = client.post(url + f'/tasks/{tid}/run', json={})
    assert r.status_code == 200 and r.json()['tasks'][0]['state'] == 'done'
    assert r.json()['tasks'][0]['activity'] == 'walk'
    assert client.post(url + f'/tasks/{tid}/run', json={}).json() == r.json()
    for field in ('token', 'lease_until', 'facts_digest', 'owner_id', 'authorization_ref', 'candidate_digest'):
        assert field not in r.text
    paused = client.put(url + '/permission', json=permission(False, 1))
    assert paused.json()['permission']['enabled'] is False
    assert paused.json()['tasks'][0]['state'] == 'done'
    engine.dispose()
    assert client.get(url).json() == paused.json()
    assert len(runtime.read_events(TEST_USER_ID, sid)) == 1


def test_pause_cancels_queued_work_and_refresh_never_runs(client, preview):
    url, sid, _, runtime = preview
    client.put(url + '/permission', json=permission())
    tid = queue(client, url)
    for _ in range(3):
        assert client.get(url).json()['tasks'][0]['state'] == 'queued'
    assert runtime.read_events(TEST_USER_ID, sid) == []
    client.put(url + '/permission', json=permission(False, 1))
    assert client.post(url + f'/tasks/{tid}/run', json={}).json()['tasks'][0]['state'] == 'cancelled'
    assert runtime.read_events(TEST_USER_ID, sid) == []


@pytest.mark.parametrize('endpoint,payload', [
    ('/permission', {**permission(), 'owner_id': 'other'}),
    ('/permission', {**permission(), 'enabled': 'true'}),
    ('/permission', {**permission(), 'activities': ['rest', 'rest']}),
    ('/permission', {**permission(), 'activities': ['delete']}),
    ('/tasks', {'request_id': str(uuid4()), 'source': 'offline'}),
    ('/tasks', {'request_id': str(uuid4()), 'now': 1}),
])
def test_strict_requests(client, preview, endpoint, payload):
    url, _, _, _ = preview
    response = client.put(url + endpoint, json=payload) if endpoint == '/permission' else client.post(url + endpoint, json=payload)
    assert response.status_code == 422


def test_client_cannot_submit_candidates_lease_or_budget(client, preview):
    url, _, _, _ = preview
    client.put(url + '/permission', json=permission())
    tid = queue(client, url)
    for payload in ({'activity': 'walk'}, {'candidate': {'activity': 'delete'}}, {'token': str(uuid4())}, {'max_cost': 100}):
        assert client.post(url + f'/tasks/{tid}/run', json=payload).status_code == 422
    assert client.get(url).json()['tasks'][0]['state'] == 'queued'


def test_anonymous_cross_owner_and_environment_gates(client, anon, preview, monkeypatch):
    url, sid, _, _ = preview
    assert anon.get(url).status_code == 401
    with engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id == sid).values(owner_id='another'))
    for method, endpoint, body in [('get', '', None), ('put', '/permission', permission()), ('post', '/tasks', {'request_id': str(uuid4())}), ('post', f'/tasks/{uuid4()}/run', {})]:
        response = getattr(client, method)(url + endpoint, **({'json': body} if body is not None else {}))
        assert response.status_code == 404
        assert response.headers['cache-control'] == 'private, no-store'
    for environment in ('development', 'production'):
        monkeypatch.setattr(get_settings(), 'app_env', environment)
        assert client.get(url).status_code == 404
    monkeypatch.setattr(get_settings(), 'app_env', 'test')
    monkeypatch.setattr(get_settings(), 'life_runtime_preview_enabled', False)
    assert client.get(url).status_code == 404


def test_empty_observe_scope_fails_without_fake_event(client, preview):
    url, sid, _, runtime = preview
    client.put(url + '/permission', json=permission(activities=['observe']))
    tid = queue(client, url)
    result = client.post(url + f'/tasks/{tid}/run', json={}).json()
    assert result['tasks'][0]['state'] == 'failed' and result['tasks'][0]['activity'] is None
    assert runtime.read_events(TEST_USER_ID, sid) == []


def test_running_recovery_and_expired_plan(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission())
    tid = queue(client, url)
    task = runtime.claim(TEST_USER_ID, sid, tid)
    assert client.get(url).json()['tasks'][0]['retry_at'] == task.lease_until
    assert client.post(url + f'/tasks/{tid}/run', json={}).status_code == 409
    clock[0] += 60
    assert client.post(url + f'/tasks/{tid}/run', json={}).json()['tasks'][0]['state'] == 'done'
    clock[0] += 600
    tid = queue(client, url)
    clock[0] += 600
    assert client.post(url + f'/tasks/{tid}/run', json={}).json()['tasks'][0]['state'] == 'cancelled'


def test_read_is_bounded_and_corrupt_event_is_not_hidden(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission())
    for _ in range(23):
        tid = queue(client, url)
        assert client.post(url + f'/tasks/{tid}/run', json={}).status_code == 200
        clock[0] += 600
    records = client.get(url).json()['tasks']
    assert len(records) == 20 and len(runtime.read_events(TEST_USER_ID, sid)) == 23
    with engine.begin() as conn:
        conn.execute(update(rt.events).where(rt.events.c.task_id == records[0]['id']).values(payload='{}'))
    assert client.get(url).status_code == 500


def test_storage_error_has_no_raw_diagnostic(client, preview, monkeypatch):
    from app.living.store import LivingStore
    url, _, _, _ = preview
    def fail(*args, **kwargs):
        raise SQLAlchemyError('private diagnostic')
    monkeypatch.setattr(LivingStore, '_row', fail)
    response = client.get(url)
    assert response.status_code == 503 and 'private diagnostic' not in response.text


def test_preview_backup_preserves_legacy_rows_and_images(tmp_path):
    from scripts.c13_life_preview import backup_before_schema, database_facts
    db = tmp_path / 'preview.db'
    uploads = tmp_path / 'uploads'; uploads.mkdir()
    (uploads / 'fixture.png').write_bytes(b'synthetic-asset')
    with sqlite3.connect(db) as conn:
        conn.execute('CREATE TABLE legacy (id INTEGER PRIMARY KEY, body TEXT)')
        conn.execute("INSERT INTO legacy VALUES (1, 'preserve me')")
    before = backup_before_schema(tmp_path)
    assert before is not None and json.loads((before / 'manifest.json').read_text())['verified']
    with sqlite3.connect(db) as source, sqlite3.connect(before / 'preview.db') as restored:
        assert database_facts(source) == database_facts(restored)
    assert (before / 'uploads' / 'fixture.png').read_bytes() == b'synthetic-asset'
