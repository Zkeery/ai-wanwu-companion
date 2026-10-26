"""Whole primary flow with synthetic data and no provider network access."""
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.database import engine
from app.main import app
from app.scene_agent import chat as agent_chat
from tests.auth_helpers import TEST_TOKEN
from tests.test_scene_agent_runtime import Scripted


@pytest.mark.parametrize('agent_enabled', [False, True])
def test_upload_generate_save_chat_reopen(client, anon, png_header, parse_sse, monkeypatch, agent_enabled):
    settings = get_settings()
    assert settings.use_mock
    monkeypatch.setattr(settings, 'scene_agent_enabled', agent_enabled)
    adapter = Scripted({'type': 'finish', 'reply': '这是隔离测试回复。'})
    monkeypatch.setattr(agent_chat, 'ProviderAdapter', lambda: adapter)
    key = str(uuid4())
    uploaded = client.post('/api/v1/photos', files={'file': ('test-cup.png', png_header, 'image/png')},
                           headers={'Idempotency-Key': key})
    assert uploaded.status_code == 201
    photo = uploaded.json()
    oid = photo['objects'][0]['id']
    generated = client.post('/api/v1/characters', json={'object_id': oid, 'label': photo['objects'][0]['label']})
    assert generated.status_code == 200
    events = parse_sse(generated.text)
    assert events[-1][0] == 'done'
    character = events[-1][1]
    cid = character['id']
    assert character['status'] == 'ready'
    image_url = '/uploads/' + character['image_path']
    image = client.get(image_url)
    assert image.status_code == 200 and image.content
    assert anon.get(image_url).status_code == 401
    saved = client.put(f'/api/v1/characters/{cid}', json={'name': '主流程测试伙伴'})
    assert saved.status_code == 200 and saved.json()['name'] == '主流程测试伙伴'
    # No residence selection is required before the first conversation.
    sent = client.post(f'/api/v1/characters/{cid}/chat',
                       json={'message': '你好，这是离线验收。', 'request_id': str(uuid4())})
    assert sent.status_code == 200
    assert parse_sse(sent.text)[-1][0] == 'done'
    history = client.get(f'/api/v1/characters/{cid}/messages').json()
    assert [m['role'] for m in history] == ['user', 'assistant']
    engine.dispose()
    with TestClient(app, headers={'Authorization': f'Bearer {TEST_TOKEN}'}) as reopened:
        restored = reopened.get(f'/api/v1/characters/{cid}').json()
        assert restored['name'] == '主流程测试伙伴'
        assert restored['image_path'] == character['image_path']
        assert reopened.get(image_url).content == image.content
        assert reopened.get(f'/api/v1/characters/{cid}/messages').json() == history
        assert len(reopened.get('/api/v1/characters').json()) == 1
        assert reopened.get('/api/v1/photos/requests/' + key).json()['status'] == 'ready'
        assert reopened.get(f'/api/v1/characters/by-object/{oid}').json()['id'] == cid
    assert len(adapter.calls) == (1 if agent_enabled else 0)
