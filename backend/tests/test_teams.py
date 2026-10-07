"""Private team lifecycle, replay and isolation; no model calls."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from hashlib import sha256
from uuid import uuid4

import pytest
from app.core.database import SessionLocal
from app.core.security import hash_token
from app.models.models import Character, Session, Team, TeamMember, TeamSubmission, User
from tests.test_wall import shareable  # noqa: F401


@pytest.fixture
def other():
    with SessionLocal() as db:
        uid = str(uuid4())
        db.add(User(id=uid, phone="13900000089"))
        db.flush()
        db.add(Session(token_hash=hash_token("team-other"), user_id=uid,
                       expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    return {"Authorization": "Bearer team-other"}


def create(client, **kwargs):
    payload = {"request_id": str(uuid4()), "title": "甜甜小队", "theme_id": "fruit", "display_name": "小桃", **kwargs}
    r = client.post("/api/v1/teams", json=payload)
    assert r.status_code == 200, r.text
    return r.json(), payload


def invite(client, tid):
    r = client.post(f"/api/v1/teams/{tid}/invitation")
    assert r.status_code == 200, r.text
    return r.json()["token"]


def join(client, token, headers):
    return client.post("/api/v1/team-invitations/join", json={"token": token, "display_name": "小杏"}, headers=headers)


def test_create_is_private_and_replay_safe(client, anon, other):
    team, payload = create(client)
    path = f'/api/v1/teams/{team["id"]}'
    assert team["submissions"] == [] and team["member_count"] == 1
    assert anon.get(path).status_code == 401
    assert client.get(path, headers=other).status_code == 404
    assert client.get('/api/v1/teams', headers=other).json() == []
    assert client.post('/api/v1/teams', json=payload).json() == team
    assert client.post('/api/v1/teams', json={**payload, "title": "改了"}).status_code == 409
    assert client.post('/api/v1/teams', json=payload, headers=other).status_code == 404
    with SessionLocal() as db:
        assert db.query(Team).count() == 1


def test_invite_preview_is_minimal_hashed_rotated_revocable(client, anon, other):
    team, _ = create(client); tid = team['id']
    token = invite(client, tid)
    with SessionLocal() as db:
        assert db.get(Team, tid).invite_hash == sha256(token.encode()).hexdigest()
    p = anon.post('/api/v1/team-invitations/preview', json={"token": token})
    assert set(p.json()) == {'title', 'theme_id', 'creator_name', 'member_count'}
    assert p.headers['cache-control'] == 'no-store'
    assert join(client, token, other).json()['already_member'] is False
    assert join(client, token, other).json()['already_member'] is True
    assert client.post(f'/api/v1/teams/{tid}/invitation', headers=other).status_code == 403
    new = invite(client, tid)
    assert join(client, token, other).status_code == 410
    assert join(client, new, other).status_code == 200
    assert client.delete(f'/api/v1/teams/{tid}/invitation').status_code == 204
    assert join(client, new, other).status_code == 410
    assert client.get(f'/api/v1/teams/{tid}', headers=other).status_code == 200


def test_submission_explicit_owned_same_theme_and_images_private(client, anon, other, shareable):
    team, _ = create(client); path = f'/api/v1/teams/{team["id"]}'
    assert client.get(path).json()['submissions'] == []
    assert client.put(f'{path}/submissions/{shareable}', headers=other).status_code == 404
    join(client, invite(client, team['id']), other)
    assert client.put(f'{path}/submissions/{shareable}', headers=other).status_code == 404
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.put(f'{path}/submissions/{shareable}'), range(2)))
    assert all(r.status_code == 200 for r in results)
    data = client.get(path, headers=other).json()
    assert len(data['submissions']) == 1
    item = data['submissions'][0]
    assert set(item) == {'id', 'name', 'introduction', 'author_name', 'is_mine', 'image_url', 'submitted_at'}
    assert not item['is_mine'] and '/uploads/' not in str(data)
    assert anon.get(item['image_url']).status_code == 401
    image = client.get(item['image_url'], headers=other)
    assert image.status_code == 200 and image.headers['cache-control'] == 'no-store'
    assert client.delete(f'{path}/submissions/{item["id"]}', headers=other).status_code == 404
    assert anon.get('/api/v1/themes/fruit/works').json()['total'] == 0
    assert client.delete(path+'/membership', headers=other).status_code == 204
    assert client.get(item['image_url'], headers=other).status_code == 404
    assert client.delete(f'{path}/submissions/{item["id"]}').status_code == 204
    assert client.get(item['image_url']).status_code == 404
    assert client.get(f'/api/v1/characters/{shareable}').status_code == 200


@pytest.mark.parametrize('field,value', [('theme_id', None), ('status', 'generating'), ('image_path', '../secret')])
def test_invalid_submission(client, shareable, field, value):
    team, _ = create(client)
    with SessionLocal() as db:
        setattr(db.get(Character, shareable), field, value); db.commit()
    assert client.put(f'/api/v1/teams/{team["id"]}/submissions/{shareable}').status_code == 409


def test_leave_removes_own_submissions_and_rejoin_starts_empty(client, other, shareable):
    team, _ = create(client); tid = team['id']; path = f'/api/v1/teams/{tid}'
    token = invite(client, tid); join(client, token, other)
    with SessionLocal() as db:
        uid = db.query(Session).filter_by(token_hash=hash_token('team-other')).one().user_id
        db.get(Character, shareable).owner_id = uid; db.commit()
    assert client.put(f'{path}/submissions/{shareable}', headers=other).status_code == 200
    assert client.delete(path+'/membership').status_code == 409
    for _ in range(2):
        assert client.delete(path+'/membership', headers=other).status_code == 204
    assert client.get(path).json()['submissions'] == []
    assert client.get(f'/api/v1/characters/{shareable}', headers=other).status_code == 200
    join(client, token, other)
    assert client.get(path, headers=other).json()['submissions'] == []


def test_dissolve_preserves_collection_and_public_wall_blocks_replay(client, anon, other, shareable):
    team, payload = create(client); tid = team['id']; path = f'/api/v1/teams/{tid}'
    token = invite(client, tid); join(client, token, other)
    client.put(f'{path}/submissions/{shareable}')
    client.put(f'/api/v1/wall/characters/{shareable}', json={'author_name': '小桃'})
    assert client.delete(path, headers=other).status_code == 403
    for _ in range(2):
        assert client.delete(path).status_code == 204
    assert client.get(path).status_code == 404
    assert join(client, token, other).status_code == 410
    assert client.post('/api/v1/teams', json=payload).status_code == 409
    assert client.get(f'/api/v1/characters/{shareable}').status_code == 200
    assert anon.get('/api/v1/themes/fruit/works').json()['total'] == 1
    with SessionLocal() as db:
        assert db.query(TeamMember).count() == db.query(TeamSubmission).count() == 0


def test_delete_character_cascades(client, shareable):
    team, _ = create(client); path = f'/api/v1/teams/{team["id"]}'
    client.put(f'{path}/submissions/{shareable}')
    assert client.delete(f'/api/v1/characters/{shareable}').status_code == 204
    assert client.get(path).json()['submissions'] == []


@pytest.mark.parametrize('changes', [{'display_name': '13900000001'}, {'title': ''}, {'theme_id': 'missing'}, {'extra': True}])
def test_bad_input(client, changes):
    r = client.post('/api/v1/teams', json={'request_id': str(uuid4()), 'title': '小队', 'theme_id': 'fruit', 'display_name': '小桃', **changes})
    assert r.status_code in (400, 422)
