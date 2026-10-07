"""HTTP boundary tests use synthetic pixels and never call an image provider."""
import json
from unittest.mock import Mock

import pytest

from app.core.database import SessionLocal
from app.models.models import Character, CharacterActivityMotionAsset, MotionPreparationTask, User
from app.services import character_walk_workflow as flow
from app.services.motion_preparation import process_one
from tests.test_character_walk_workflow import case, create  # noqa: F401


@pytest.fixture
def candidate(case, monkeypatch):
    result = create(case)
    monkeypatch.setattr(flow, 'DEFAULT_ROOT', case['root'])
    forbidden = Mock(side_effect=AssertionError('HTTP must not generate or read keys'))
    monkeypatch.setattr(flow, 'generate', forbidden)
    monkeypatch.setattr(flow, 'dotenv_values', forbidden)
    return {**result, 'base': f"/api/v1/characters/{case['cid']}/motion-candidates", 'forbidden': forbidden}


def payload(c, decision='accept'):
    return {'decision': decision, 'candidate_sha256': c['candidate_sha256']}


def test_owned_list_media_review_and_duplicate_are_private(client, case, candidate):
    c = candidate; result = client.get(c['base'])
    assert result.status_code == 200 and result.headers['cache-control'] == 'private, no-store'
    item = result.json()['items'][0]
    assert set(item) == {'job_id', 'state', 'candidate_sha256', 'image_url'}
    assert str(case['root']) not in result.text and 'provider_task_id' not in result.text
    image = client.get(item['image_url'])
    assert image.status_code == 200 and image.content == case['raw']
    assert image.headers['cache-control'] == 'private, no-store'
    url = f"{c['base']}/{c['job_id']}/review"
    assert client.post(url, json=payload(c)).json()['state'] == 'queued'
    with SessionLocal() as db:
        assert process_one(db)
    assert client.post(url, json=payload(c)).json()['state'] == 'ready'
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == 1
    assert client.post(url, json=payload(c, 'reject')).status_code == 409
    c['forbidden'].assert_not_called()


@pytest.mark.parametrize('identity', ['anonymous', 'other_owner'])
def test_all_routes_reject_wrong_identity(client, anon, case, candidate, identity):
    item = client.get(candidate['base']).json()['items'][0]
    if identity == 'other_owner':
        with SessionLocal() as db:
            db.add(User(id='other', phone='13999999160')); db.flush()
            db.get(Character, case['cid']).owner_id = 'other'; db.commit()
        actor, expected = client, 404
    else:
        actor, expected = anon, 401
    assert actor.get(candidate['base']).status_code == expected
    assert actor.get(item['image_url']).status_code == expected
    assert actor.post(f"{candidate['base']}/{candidate['job_id']}/review", json=payload(candidate)).status_code == expected


def test_receipt_owner_mismatch_hides_job(client, case, candidate):
    file = case['root']/f"approval-{candidate['job_id']}.json"
    record = json.loads(file.read_text()); record['owner_id'] = 'someone-else'; file.write_text(json.dumps(record))
    assert client.get(candidate['base']).json()['items'] == []
    response = client.post(f"{candidate['base']}/{candidate['job_id']}/review", json=payload(candidate))
    assert response.status_code == 404


@pytest.mark.parametrize('change', ['source', 'candidate'])
def test_changed_pixels_cannot_be_served_or_accepted(client, case, candidate, change):
    item = client.get(candidate['base']).json()['items'][0]
    file = case['source'] if change == 'source' else case['root']/'jobs'/candidate['job_id']/'candidate.png'
    file.write_bytes(file.read_bytes()+b'changed')
    assert client.get(item['image_url']).status_code == 409
    assert client.post(f"{candidate['base']}/{candidate['job_id']}/review", json=payload(candidate)).status_code == 409
    if change == 'source':
        assert client.get(candidate['base']).json()['items'] == []


def test_rejection_persists_without_binding(client, case, candidate):
    url = f"{candidate['base']}/{candidate['job_id']}/review"
    assert client.post(url, json=payload(candidate, 'reject')).json()['state'] == 'rejected'
    assert client.get(candidate['base']).json()['items'][0]['state'] == 'rejected'
    assert client.post(url, json=payload(candidate, 'reject')).json()['state'] == 'rejected'
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == 0


@pytest.mark.parametrize('body', [{'decision': 'auto', 'candidate_sha256': 'a'*64},
    {'decision': 'accept', 'candidate_sha256': 'bad'},
    {'decision': 'accept', 'candidate_sha256': 'a'*64, 'owner_id': 'other'}])
def test_rejects_invalid_request_contract(client, candidate, body):
    result = client.post(f"{candidate['base']}/{candidate['job_id']}/review", json=body)
    assert result.status_code == 422 and set(result.json()) == {'error'}


def test_pagination_ignores_legacy_receipts_and_checks_cursor(client, case, candidate):
    file = case['root']/f"approval-{candidate['job_id']}.json"
    original = json.loads(file.read_text()); file.unlink()
    for n in range(22):
        job = f'{n:064x}'; flow._save(case['root'], {**original, 'job_id': job})
    (case['root']/('approval-'+'f'*64+'.json')).write_text('{"provider":"aihubmix"}')
    first = client.get(candidate['base']).json()
    assert len(first['items']) == 20 and first['next_cursor'] == f'{19:064x}'
    second = client.get(candidate['base'], params={'cursor': first['next_cursor']}).json()
    assert len(second['items']) == 2 and second['next_cursor'] is None
    assert client.get(candidate['base'], params={'cursor': '../bad'}).status_code == 422


def test_busy_and_preparation_failure_are_recoverable(client, case, candidate, monkeypatch):
    url = f"{candidate['base']}/{candidate['job_id']}/review"
    with flow._lock(case['root'], candidate['job_id']):
        assert client.post(url, json=payload(candidate)).json()['error']['code'] == 'job_busy'
    original = flow.build_sheet_motion
    monkeypatch.setattr(flow, 'build_sheet_motion', Mock(side_effect=ValueError('private detail')))
    response = client.post(url, json=payload(candidate))
    assert response.status_code == 503 and 'private detail' not in response.text
    assert client.get(candidate['base']).json()['items'][0]['state'] == 'reviewed'
    monkeypatch.setattr(flow, 'build_sheet_motion', original)
    assert client.post(url, json=payload(candidate)).json()['state'] == 'queued'
    candidate['forbidden'].assert_not_called()


def test_failed_worker_can_resume_existing_accepted_candidate(client, case, candidate):
    url = f"{candidate['base']}/{candidate['job_id']}/review"
    assert client.post(url, json=payload(candidate)).json()['state'] == 'queued'
    with SessionLocal() as db:
        task = db.get(MotionPreparationTask, (case['cid'], 'walk'))
        task.state, task.attempts, task.error_code = 'failed', 3, 'temporary_error'
        db.commit()
    assert client.get(candidate['base']).json()['items'][0]['state'] == 'reviewed'
    assert client.post(url, json=payload(candidate)).json()['state'] == 'queued'
    with SessionLocal() as db:
        assert db.get(MotionPreparationTask, (case['cid'], 'walk')).attempts == 0
    candidate['forbidden'].assert_not_called()
