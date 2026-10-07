"""Correction drafts preserve old companions, are idempotent and never call models."""
from uuid import uuid4

from app.core.database import SessionLocal
from app.models.models import Character, Photo, PhotoRequest, User
from app.services.model_client import ModelClient
from tests.auth_helpers import TEST_USER_ID


def source_photo(character_id):
    with SessionLocal() as db:
        return db.get(Character, character_id).object.photo_id


def test_correction_is_idempotent_recoverable_and_keeps_original(client, ready_character_id, monkeypatch, parse_sse):
    photo_id = source_photo(ready_character_id)
    key = str(uuid4())
    def forbidden(*args):
        raise AssertionError('correction preparation must not call a model')
    with monkeypatch.context() as patch:
        patch.setattr(ModelClient, 'recognize', forbidden)
        patch.setattr(ModelClient, 'generate_concept', forbidden)
        first = client.post(f'/api/v1/photos/{photo_id}/corrections', headers={'Idempotency-Key': key})
        second = client.post(f'/api/v1/photos/{photo_id}/corrections', headers={'Idempotency-Key': key})
    assert first.status_code == second.status_code == 201
    assert first.json() == second.json() and first.json()['id'] != photo_id
    assert client.get(f'/api/v1/photos/requests/{key}').json()['photo'] == first.json()
    copied = first.json()['objects'][0]
    events = parse_sse(client.post('/api/v1/characters', json={'object_id': copied['id'], 'label': '纠正的茶壶', 'visual_features': '绿色方形'}).text)
    assert events[-1][0] == 'done' and events[-1][1]['id'] != ready_character_id
    original = client.get(f'/api/v1/characters/{ready_character_id}').json()
    assert original['status'] == 'ready' and original['name'] == '测试杯'
    with SessionLocal() as db:
        assert db.get(Character, ready_character_id).object.label == '合成杯子'
        assert db.query(Photo).count() == 2


def test_correction_requires_valid_key_and_owned_source(client, anon, ready_character_id):
    photo_id = source_photo(ready_character_id)
    path = f'/api/v1/photos/{photo_id}/corrections'
    assert client.post(path).status_code == 400
    assert client.post(path, headers={'Idempotency-Key': 'bad'}).status_code == 400
    assert anon.post(path, headers={'Idempotency-Key': str(uuid4())}).status_code == 401
    with SessionLocal() as db:
        db.add(User(id='other-correction-user', phone='13800000999'))
        db.flush()
        db.get(Photo, photo_id).owner_id = 'other-correction-user'
        db.commit()
    assert client.post(path, headers={'Idempotency-Key': str(uuid4())}).status_code == 404


def test_correction_key_cannot_reuse_upload_or_foreign_receipt(client, ready_character_id):
    photo_id = source_photo(ready_character_id)
    key = str(uuid4())
    with SessionLocal() as db:
        db.add(PhotoRequest(id=key, owner_id=TEST_USER_ID, digest='upload-digest', status='ready', photo_id=photo_id))
        db.commit()
    assert client.post(f'/api/v1/photos/{photo_id}/corrections', headers={'Idempotency-Key': key}).status_code == 409
    with SessionLocal() as db:
        db.add(User(id='other-key-user', phone='13800000998'))
        db.flush()
        db.get(PhotoRequest, key).owner_id = 'other-key-user'
        db.commit()
    assert client.post(f'/api/v1/photos/{photo_id}/corrections', headers={'Idempotency-Key': key}).status_code == 404
    with SessionLocal() as db:
        assert db.query(Photo).count() == 1
