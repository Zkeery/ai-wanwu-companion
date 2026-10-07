"""Recovery, idempotency and editing through the real API; no paid models."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
from uuid import uuid4

import pytest

from app.core.database import SessionLocal
from app.models.models import PhotoRequest
from app.services.model_client import ModelClient, ModelError


def upload(client, image, key=None):
    return client.post('/api/v1/photos', files={'file': ('cup.png', image, 'image/png')},
                       headers={'Idempotency-Key': key} if key else {})


def test_recognition_receipt_replay_never_calls_model_twice(client, png_header, monkeypatch):
    calls = []
    original = ModelClient.recognize
    def recognize(self, image):
        calls.append(1)
        return original(self, image)
    monkeypatch.setattr(ModelClient, 'recognize', recognize)
    key = str(uuid4())
    first = upload(client, png_header, key)
    assert first.status_code == 201
    assert upload(client, png_header, key).json() == first.json()
    assert len(calls) == 1
    receipt = client.get('/api/v1/photos/requests/' + key).json()
    assert receipt == {'status': 'ready', 'photo': first.json()}
    assert upload(client, png_header + b'different', key).status_code == 409
    assert len(calls) == 1


def test_inflight_recognition_has_one_owner(client, png_header, monkeypatch):
    entered, release = Event(), Event()
    original = ModelClient.recognize
    def recognize(self, image):
        entered.set()
        assert release.wait(5)
        return original(self, image)
    monkeypatch.setattr(ModelClient, 'recognize', recognize)
    key = str(uuid4())
    with ThreadPoolExecutor() as pool:
        first = pool.submit(upload, client, png_header, key)
        assert entered.wait(5)
        try:
            assert upload(client, png_header, key).status_code == 409
            assert client.get('/api/v1/photos/requests/' + key).json()['status'] == 'running'
        finally:
            release.set()
        assert first.result().status_code == 201


def test_failed_receipt_is_not_automatically_replayed(client, png_header, monkeypatch):
    calls = []
    def fail(self, image):
        calls.append(1)
        raise ModelError('test')
    monkeypatch.setattr(ModelClient, 'recognize', fail)
    key = str(uuid4())
    assert upload(client, png_header, key).status_code == 502
    assert upload(client, png_header, key).status_code == 409
    assert client.get('/api/v1/photos/requests/' + key).json()['status'] == 'failed'
    assert len(calls) == 1


def test_corrected_object_and_rename_persist(client, png_header, parse_sse, monkeypatch):
    oid = upload(client, png_header).json()['objects'][0]['id']
    assert client.get(f'/api/v1/characters/by-object/{oid}').json() is None
    labels = []
    original = ModelClient.generate_persona
    def generate(self, label):
        labels.append(label)
        return original(self, label)
    monkeypatch.setattr(ModelClient, 'generate_persona', generate)
    response = client.post('/api/v1/characters', json={'object_id': oid, 'label': '  一盆薄荷  '})
    events = parse_sse(response.text)
    ch = next(data for event, data in events if event == 'done')
    assert labels == ['一盆薄荷']
    assert next(data for event, data in events if event == 'started')['character_id'] == ch['id']
    assert client.get(f'/api/v1/characters/by-object/{oid}').json() == ch
    cid = ch['id']
    assert client.patch(f'/api/v1/characters/{cid}', json={'name': '  小薄荷  '}).json()['name'] == '小薄荷'
    assert client.get(f'/api/v1/characters/{cid}').json()['name'] == '小薄荷'
    assert client.get('/api/v1/characters').json()[0]['name'] == '小薄荷'


@pytest.mark.parametrize('label', [' ', 'x' * 101])
def test_invalid_correction_is_rejected_before_model(client, png_header, label):
    oid = upload(client, png_header).json()['objects'][0]['id']
    assert client.post('/api/v1/characters', json={'object_id': oid, 'label': label}).status_code == 422
    assert client.get(f'/api/v1/characters/by-object/{oid}').json() is None


@pytest.mark.parametrize('name', ['', '  ', 'x' * 41])
def test_invalid_name_rejected(client, name):
    assert client.patch('/api/v1/characters/1', json={'name': name}).status_code == 422


def test_generation_reservation_prevents_concurrent_model_calls(client, png_header, monkeypatch):
    oid = upload(client, png_header).json()['objects'][0]['id']
    entered, release = Event(), Event()
    original = ModelClient.generate_persona
    def generate(self, label):
        entered.set()
        assert release.wait(5)
        return original(self, label)
    monkeypatch.setattr(ModelClient, 'generate_persona', generate)
    with ThreadPoolExecutor() as pool:
        first = pool.submit(client.post, '/api/v1/characters', json={'object_id': oid, 'label': '杯子'})
        assert entered.wait(5)
        try:
            second = client.post('/api/v1/characters', json={'object_id': oid, 'label': '不应覆盖'})
            assert second.status_code == 409
            current = client.get(f'/api/v1/characters/by-object/{oid}').json()
            assert current['status'] == 'generating'
            assert client.patch(f"/api/v1/characters/{current['id']}", json={'name': '早了'}).status_code == 409
        finally:
            release.set()
        assert 'event: done' in first.result().text


def test_restart_recovers_unfinished_receipt():
    from fastapi.testclient import TestClient
    from app.main import app
    from tests.auth_helpers import TEST_TOKEN, TEST_USER_ID
    key = str(uuid4())
    with SessionLocal() as db:
        db.add(PhotoRequest(id=key, owner_id=TEST_USER_ID, digest='0' * 64, status='running'))
        db.commit()
    with TestClient(app, headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as client:
        assert client.get('/api/v1/photos/requests/' + key).json()['status'] == 'failed'


@pytest.mark.parametrize('data,mime', [(b'\x89PNG\r\n\x1a\n', 'image/png'),
                                     (b'RIFF0000WEBP', 'image/webp'),
                                     (b'0000ftypheic', 'image/heic'),
                                     (b'\xff\xd8\xff', 'image/jpeg')])
def test_vision_payload_matches_validated_image_type(monkeypatch, data, mime):
    payloads = []
    def capture(self, payload, settings):
        payloads.append(payload)
        return '[]'
    monkeypatch.setattr(ModelClient, '_post_chat_completions', capture)
    from app.core.config import get_settings
    # This test checks MIME encoding, independent of a developer's provider opts.
    ModelClient()._call_vision(data, get_settings().model_copy(update={"vision_enable_thinking": None}))
    url = payloads[0]['messages'][0]['content'][1]['image_url']['url']
    assert url.startswith(f'data:{mime};base64,')


def test_rename_updates_real_smoke_self_introduction_without_rewriting_history(client, png_header):
    from app.models.models import Character, Message
    from tests.auth_helpers import TEST_USER_ID
    oid = upload(client, png_header).json()['objects'][0]['id']
    # Literal text observed in the approved real smoke, replayed without a model call.
    greeting = '你好，我是米圆，会安静地用圆滚滚的把手环住热饮，陪你慢慢暖起来。'
    with SessionLocal() as db:
        ch = Character(object_id=oid, owner_id=TEST_USER_ID, name='米圆', persona='温润安静', opening_line=greeting, status='ready')
        db.add(ch)
        db.flush()
        cid = ch.id
        db.add(Message(character_id=cid, role='assistant', content=greeting))
        db.commit()
    renamed = client.patch(f'/api/v1/characters/{cid}', json={'name': '冒烟小杯'}).json()
    assert renamed['opening_line'] == greeting.replace('我是米圆', '我是冒烟小杯')
    assert renamed['persona'] == '温润安静'
    assert client.get(f'/api/v1/characters/{cid}/messages').json()[0]['content'] == greeting
