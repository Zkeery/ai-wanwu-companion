import json
from uuid import uuid4

import pytest
from sqlalchemy import insert, select, update, delete

from app.core.config import get_settings
from app.core.database import engine
from app.living import life_runtime as rt
from app.living.store import spaces
from tests.auth_helpers import TEST_USER_ID
from tests.test_life_runtime_api import preview, permission, queue  # noqa: F401


def test_completed_history_pages_without_skipping_when_new_work_arrives(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission(activities=['rest']))
    ids = []
    for _ in range(25):
        tid = queue(client, url); ids.append(tid)
        runtime.run_fixture(TEST_USER_ID, sid, tid)
        clock[0] += 601
    first = client.get(url + '/history')
    assert first.status_code == 200
    page = first.json()
    assert [t['id'] for t in page['tasks']] == list(reversed(ids))[:20]
    assert first.headers['cache-control'] == 'private, no-store'
    assert first.headers['vary'] == 'Authorization'
    new = queue(client, url)
    before = runtime.read_events(TEST_USER_ID, sid)
    second = client.get(url + '/history', params={'before': page['next_before']}).json()
    assert [t['id'] for t in second['tasks']] == list(reversed(ids))[-5:]
    assert second['next_before'] is None
    assert runtime.read_events(TEST_USER_ID, sid) == before
    assert runtime.read_task(TEST_USER_ID, sid, new).state == 'queued'
    assert client.get(url + '/history').json()['tasks'][0]['id'] == new
    engine.dispose()
    assert client.get(url + '/history', params={'before': page['next_before']}).json() == second
    for field in ('token', 'owner_id', 'basis', 'candidate_digest', 'authorization_ref'):
        assert field not in first.text


def test_same_second_keyset_and_empty_page(client, preview):
    url, _, _, _ = preview
    assert client.get(url + '/history').json()['tasks'] == []
    client.put(url + '/permission', json=permission())
    tid = queue(client, url)
    # Deliberately construct valid, same-second historical rows to exercise tie breaks.
    with engine.begin() as conn:
        row = dict(conn.execute(select(rt.tasks).where(rt.tasks.c.id == tid)).mappings().one())
        ids = [tid]
        for _ in range(24):
            new_id = str(uuid4()); ids.append(new_id)
            spec = json.loads(row['spec']); spec['basis']['plan_id'] = new_id; spec['basis']['request_id'] = new_id
            conn.execute(insert(rt.tasks).values(**{**row, 'id': new_id, 'spec': json.dumps(spec)}))
    page = client.get(url + '/history').json()
    next_page = client.get(url + '/history', params={'before': page['next_before']}).json()
    assert [t['id'] for t in page['tasks'] + next_page['tasks']] == sorted(ids, reverse=True)
    assert len(set(t['id'] for t in page['tasks'] + next_page['tasks'])) == 25


@pytest.mark.parametrize('before', ['', 'abc', '01:11111111-1111-4111-8111-111111111111', '-1:11111111-1111-4111-8111-111111111111', '253402300800:11111111-1111-4111-8111-111111111111', '10:bad', 'x' * 61])
def test_history_rejects_bad_cursor(client, preview, before):
    url, _, _, _ = preview
    response = client.get(url + '/history', params={'before': before})
    assert response.status_code == 422
    assert 'error' in response.json()


def test_history_scope_and_environment_gates(client, anon, preview, monkeypatch):
    url, sid, _, _ = preview
    assert anon.get(url + '/history').status_code == 401
    with engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id == sid).values(owner_id='other'))
    assert client.get(url + '/history').status_code == 404
    monkeypatch.setattr(get_settings(), 'app_env', 'production')
    assert client.get(url + '/history').status_code == 404


def test_history_preserves_event_consistency_checks(client, preview):
    url, sid, _, runtime = preview
    client.put(url + '/permission', json=permission())
    tid = queue(client, url); runtime.run_fixture(TEST_USER_ID, sid, tid)
    with engine.begin() as conn:
        conn.execute(delete(rt.events).where(rt.events.c.task_id == tid))
    response = client.get(url + '/history')
    assert response.status_code == 500
    assert response.json()['error']['code'] == 'corrupt_state'
