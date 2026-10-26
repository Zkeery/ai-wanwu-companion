"""A02 evidence gaps: cross-owner receipts and reconnect/credit combinations only."""
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select

from app.core.config import get_settings
from app.core.database import SessionLocal, engine
from app.core.security import hash_token
from app.models.models import Character, GenerationCharge, Photo, PhotoRequest, Session, User
from app.services.model_client import ModelClient
from tests.auth_helpers import TEST_TOKEN, TEST_USER_ID


def other_client(app):
    user_id = str(uuid4())
    token = 'synthetic-boundary-' + str(uuid4())
    now = datetime.utcnow()
    with SessionLocal() as db:
        db.add(User(id=user_id, phone='gap-' + user_id))
        db.flush()
        db.add(Session(token_hash=hash_token(token), user_id=user_id, created_at=now,
                       expires_at=now + timedelta(days=1), last_seen_at=now))
        db.commit()
    return TestClient(app, headers={'Authorization': 'Bearer ' + token}), user_id


def post_photo(client, data, key):
    return client.post('/api/v1/photos', files={'file': ('synthetic-cup.png', data, 'image/png')},
                       headers={'Idempotency-Key': key})


def save_result(case_id, result):
    directory = Path(os.environ['BOUNDARY_EVIDENCE_DIR'])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / (case_id + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2))


@pytest.fixture(autouse=True)
def preserve_isolated_data(_clean_db, request, monkeypatch):
    root = Path(os.environ['BOUNDARY_RUN_DIR']).resolve()
    assert Path(engine.url.database).resolve().is_relative_to(root)
    assert Path(get_settings().upload_dir).resolve().is_relative_to(root)
    assert get_settings().use_mock and not get_settings().model_api_key
    monkeypatch.setattr(get_settings(), 'generation_quota_enabled', True)
    yield
    directory = root / 'saved-data' / request.node.name
    directory.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(engine.url.database) as source, sqlite3.connect(directory / 'app.db') as dest:
        source.backup(dest)
    upload = Path(get_settings().upload_dir)
    if upload.exists():
        shutil.copytree(upload, directory / 'uploads', dirs_exist_ok=True)
    (directory / 'provenance.json').write_text(json.dumps({
        'data': 'synthetic isolated fixture only', 'provider_requests': 0,
        'database_integrity': sqlite3.connect(directory / 'app.db').execute('PRAGMA integrity_check').fetchone()[0],
    }, indent=2))


def test_B1_other_account_cannot_read_or_replay_an_owned_photo_receipt(client, png_header, monkeypatch):
    calls = []
    original = ModelClient.recognize
    def mock_recognize(self, data):
        assert get_settings().use_mock
        calls.append(len(data))
        return original(self, data)
    monkeypatch.setattr(ModelClient, 'recognize', mock_recognize)
    key = str(uuid4())
    first = post_photo(client, png_header, key)
    assert first.status_code == 201
    photo = first.json()
    other, other_id = other_client(client.app)
    assert other.get('/api/v1/photos/requests/' + key).status_code == 404
    assert post_photo(other, png_header, key).status_code == 404
    assert other.get('/api/v1/photos/' + str(photo['id'])).status_code == 404
    assert client.get('/api/v1/photos/requests/' + key).json() == {'status': 'ready', 'photo': photo}
    assert post_photo(client, png_header, key).json() == photo
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Photo)) == 1
        receipt = db.get(PhotoRequest, key)
        assert receipt.owner_id == TEST_USER_ID and receipt.photo_id == photo['id']
        assert db.scalar(select(func.count()).select_from(PhotoRequest).where(PhotoRequest.owner_id == other_id)) == 0
    assert len(calls) == 1
    save_result('B1', {'status': 'passed', 'foreign_get_receipt': 404, 'foreign_replay_post': 404,
                      'foreign_photo_read': 404, 'recognition_mock_calls': len(calls),
                      'photos': 1, 'owner_receipt_preserved': True, 'provider_requests': 0})
    other.close()


def test_B2_reconnected_creation_keeps_one_character_charge_and_private_resources(client, png_header, parse_sse, monkeypatch):
    image_calls = []
    original = ModelClient.generate_image
    def mock_image(self, *args, **kwargs):
        assert get_settings().use_mock
        image_calls.append(1)
        return original(self, *args, **kwargs)
    monkeypatch.setattr(ModelClient, 'generate_image', mock_image)
    key = str(uuid4())
    first = post_photo(client, png_header, key)
    assert first.status_code == 201
    object_id = first.json()['objects'][0]['id']
    assert client.get('/api/v1/characters/generation-credits').json()['available'] == 5
    created = client.post('/api/v1/characters', json={'object_id': object_id})
    character = next(data for event, data in parse_sse(created.text) if event == 'done')
    cid = character['id']
    image_url = '/uploads/' + character['image_path']
    image_before = client.get(image_url)
    assert image_before.status_code == 200
    before_hash = hashlib.sha256(image_before.content).hexdigest()
    again = TestClient(client.app, headers={'Authorization': 'Bearer ' + TEST_TOKEN})
    assert again.get('/api/v1/photos/requests/' + key).json()['photo'] == first.json()
    assert again.get('/api/v1/characters/by-object/' + str(object_id)).json()['id'] == cid
    assert again.post('/api/v1/characters', json={'object_id': object_id}).status_code == 409
    assert again.get('/api/v1/characters/generation-credits').json()['available'] == 4
    other, other_id = other_client(client.app)
    for endpoint in ['/api/v1/characters/' + str(cid), '/api/v1/characters/' + str(cid) + '/messages', image_url]:
        assert other.get(endpoint).status_code == 404
    assert other.put('/api/v1/characters/' + str(cid), json={'name': '越权改名'}).status_code == 404
    assert other.post('/api/v1/characters', json={'object_id': object_id}).status_code == 404
    assert other.get('/api/v1/characters/generation-credits').json()['available'] == 5
    assert again.get('/api/v1/characters/' + str(cid)).json()['name'] == character['name']
    assert hashlib.sha256(again.get(image_url).content).hexdigest() == before_hash
    assert again.get('/api/v1/characters/' + str(cid) + '/messages').json() == []
    with SessionLocal() as db:
        assert db.scalar(select(func.count()).select_from(Character)) == 1
        charges = list(db.scalars(select(GenerationCharge)))
        assert len(charges) == 1 and charges[0].owner_id == TEST_USER_ID and charges[0].status == 'spent'
        assert db.scalar(select(func.count()).select_from(GenerationCharge).where(GenerationCharge.owner_id == other_id)) == 0
    assert image_calls == [1]
    save_result('B2', {'status': 'passed', 'duplicate_create_status': 409, 'created_characters': 1,
                      'spent_charges': 1, 'owner_credits': 4, 'other_credits': 5,
                      'foreign_image_messages_put_denied': True, 'original_image_unchanged': True,
                      'image_mock_calls': len(image_calls), 'provider_requests': 0})
    again.close(); other.close()
