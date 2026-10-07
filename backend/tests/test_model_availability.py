from types import SimpleNamespace

import pytest

from app.main import app
from app.core.config import get_settings


@pytest.fixture
def paused_budget(monkeypatch):
    state = dict(authorized=True, paused=True, requests=4, requests_max=4,
                 reserved_cny=2.5072, budget_cny=2.6)
    monkeypatch.setattr(app.state, 'model_budget', SimpleNamespace(status=lambda: state), raising=False)
    return state


def test_pause_preserves_credits_and_exposes_status(client, paused_budget, monkeypatch):
    monkeypatch.setattr(get_settings(), 'generation_quota_enabled', True)
    reply = client.get('/api/v1/characters/generation-credits')
    assert reply.status_code == 200
    assert reply.json()['available'] == 5
    assert reply.json()['model_available'] is False
    assert 'AI服务已暂停' in reply.json()['unavailable_message']
    paused_budget.update(paused=False, requests=1, reserved_cny=.2)
    restored = client.get('/api/v1/characters/generation-credits').json()
    assert restored['available'] == 5
    assert restored['model_available'] is True


@pytest.mark.parametrize('path,body', [
    ('/api/v1/characters', {'object_id': 1}),
    ('/api/v1/characters/1/chat', {'content': 'hello'}),
    ('/api/v1/characters/1/recreations', {}),
    ('/api/v1/photos/1/corrections', {}),
])
def test_paused_requests_return_service_error_before_business_work(client, paused_budget, path, body):
    reply = client.post(path, json=body)
    assert reply.status_code == 503
    assert reply.json()['error']['code'] == 'model_service_paused'
    assert '连接中断' not in reply.json()['error']['message']
    assert paused_budget['requests'] == 4


def test_paused_upload_does_not_create_photo(client, anon, paused_budget):
    from app.core.database import SessionLocal
    from app.models.models import Photo
    files = {'file': ('test.png', b'not-a-real-image', 'image/png')}
    assert client.post('/api/v1/photos', files=files).status_code == 503
    assert anon.post('/api/v1/photos', files=files).status_code == 401
    with SessionLocal() as db:
        assert db.query(Photo).count() == 0
    assert client.get('/api/v1/characters').status_code == 200


def test_local_deployment_without_budget_keeps_existing_behavior(client):
    reply = client.get('/api/v1/characters/generation-credits')
    assert reply.status_code == 200
    assert 'model_available' not in reply.json()
    assert set(reply.json()) == {'enabled', 'available'}
