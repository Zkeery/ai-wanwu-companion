import logging
from uuid import uuid4

import httpx
import pytest

from app.core.config import Settings
from app.services import model_client
from app.services.generation_errors import failure_details, record_failure
from app.services.model_client import ModelClient, ModelError
from app.services.parsers import ParseError
from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, PhotoRequest


@pytest.fixture(autouse=True)
def capture_diagnostics(caplog, monkeypatch):
    # Earlier TCP tests configure uvicorn with propagate=False; attach explicitly.
    monkeypatch.setattr(logging.getLogger('uvicorn.error'), 'handlers', [caplog.handler])


@pytest.mark.parametrize('error,reason', [
    (httpx.ConnectTimeout('secret-photo-text'), 'connection_failed'),
    (httpx.ReadTimeout('secret-photo-text'), 'response_timeout'),
    (httpx.RemoteProtocolError('secret-photo-text'), 'connection_interrupted'),
    (ParseError('secret-photo-text'), 'invalid_output'),
    (RuntimeError('secret-photo-text'), 'unknown'),
])
def test_safe_classification_without_raw_exception(error, reason, caplog):
    with caplog.at_level(logging.WARNING, logger='uvicorn.error'):
        details = record_failure('profile', 'character:1', error)
    assert details['reason'] == reason
    assert reason in caplog.text
    assert 'secret-photo-text' not in str(details) + caplog.text


def test_parse_diagnostics_keep_only_fixed_code_and_position(caplog):
    from app.services.parsers import parse_recognize
    try:
        parse_recognize('[{"label":"private-photo-description"}')
    except ParseError as error:
        with caplog.at_level(logging.WARNING, logger='uvicorn.error'):
            record_failure('recognition_concept', 'synthetic-operation', error)
    assert 'json_syntax' in caplog.text
    assert 'json_position' in caplog.text
    assert 'private-photo-description' not in caplog.text


@pytest.mark.parametrize('status,reason', [(401, 'provider_auth'), (403, 'provider_auth'), (429, 'provider_busy'), (503, 'provider_unavailable'), (400, 'provider_rejected')])
def test_http_response_and_url_are_not_exposed(status, reason, caplog):
    response = httpx.Response(status, text='private-provider-body', request=httpx.Request('POST', 'https://private.invalid/secret'))
    error = httpx.HTTPStatusError('private-key', request=response.request, response=response)
    with caplog.at_level(logging.WARNING, logger='uvicorn.error'):
        result = record_failure('image', 'character:2', error)
    assert result['reason'] == reason and result['http_status'] == status
    assert reason in caplog.text
    for secret in ['private-key', 'private.invalid', 'private-provider-body']:
        assert secret not in caplog.text + str(result)


@pytest.mark.parametrize('endpoint', ['text', 'image'])
def test_exhausted_connection_retries_preserve_safe_cause(monkeypatch, endpoint):
    settings = Settings(_env_file=None, model_api_key='synthetic', model_base_url='https://local.invalid/v1', model_max_retries=1)
    original = httpx.Client
    calls = []
    def fail(request):
        calls.append(request)
        raise httpx.ConnectTimeout('private request details')
    monkeypatch.setattr(model_client, 'get_settings', lambda: settings)
    monkeypatch.setattr(model_client.httpx, 'Client', lambda **kw: original(transport=httpx.MockTransport(fail), **kw))
    with pytest.raises(ModelError) as caught:
        if endpoint == 'text': ModelClient().generate_persona('杯子')
        else: ModelClient().generate_image('杯子', '小杯')
    assert len(calls) == 2
    assert failure_details(caught.value)['reason'] == 'connection_failed'


def test_error_event_is_sent_after_failed_status_is_saved(client, png_header, monkeypatch, parse_sse):
    photo = client.post('/api/v1/photos', files={'file': ('cup.png', png_header, 'image/png')}).json()
    oid = photo['objects'][0]['id']
    def fail(self, label):
        raise ParseError('untrusted model output')
    monkeypatch.setattr(ModelClient, 'generate_persona', fail)
    image = []
    monkeypatch.setattr(ModelClient, 'generate_image', lambda *a, **kw: image.append(True))
    events = parse_sse(client.post('/api/v1/characters', json={'object_id': oid}).text)
    event, result = events[-1]
    assert event == 'error' and result['status'] == 'failed'
    assert result['error']['code'] == 'generate_failed'
    assert result['error']['reason'] == 'invalid_output'
    saved = client.get(f'/api/v1/characters/by-object/{oid}').json()
    assert saved['id'] == result['character_id'] and saved['status'] == 'failed'
    assert not image and 'untrusted model output' not in str(result)


@pytest.mark.parametrize('error,reason,message', [
    (httpx.RemoteProtocolError('private-upstream-url'), 'connection_interrupted', '连接中断'),
    (httpx.ReadTimeout('private-upstream-url'), 'response_timeout', '响应超时'),
    (httpx.ConnectError('private-upstream-url'), 'connection_failed', '连接不上'),
    (ParseError('private-upstream-url'), 'invalid_output', '格式异常'),
])
def test_recognition_error_is_specific_saved_and_not_automatically_replayed(client, png_header, monkeypatch, error, reason, message):
    calls = []
    def fail(*args):
        calls.append(True)
        raise ModelError('private wrapper') from error
    monkeypatch.setattr(ModelClient, 'recognize', fail)
    key = str(uuid4())
    def upload():
        return client.post('/api/v1/photos', files={'file': ('cup.png', png_header, 'image/png')},
                           headers={'Idempotency-Key': key})
    response = upload()
    assert response.status_code == 502
    body = response.json()['error']
    assert body['code'] == 'recognize_failed' and body['reason'] == reason
    assert message in body['message'] and 'private' not in str(body)
    assert client.get(f'/api/v1/photos/requests/{key}').json() == {'status': 'failed', 'photo': None}
    assert upload().status_code == 409 and calls == [True]
    with SessionLocal() as db:
        assert db.get(PhotoRequest, key).status == 'failed'
        assert db.query(Photo).count() == db.query(Object).count() == db.query(Character).count() == 0


@pytest.mark.parametrize('status,reason,message', [(401, 'provider_auth', '授权'), (429, 'provider_busy', '繁忙'), (503, 'provider_unavailable', '异常')])
def test_recognition_provider_errors_do_not_expire_user_session(client, png_header, monkeypatch, status, reason, message):
    response = httpx.Response(status, text='private body', request=httpx.Request('POST', 'https://private.invalid/key'))
    def fail(*args):
        raise httpx.HTTPStatusError('private error', request=response.request, response=response)
    monkeypatch.setattr(ModelClient, 'recognize', fail)
    result = client.post('/api/v1/photos', files={'file': ('cup.png', png_header, 'image/png')})
    assert result.status_code == 502
    assert result.json()['error']['reason'] == reason
    assert message in result.json()['error']['message'] and 'private' not in result.text


def test_read_disconnect_is_not_retried_and_logs_only_safe_transport_type(monkeypatch, caplog):
    settings = Settings(_env_file=None, model_api_key='synthetic', model_base_url='https://local.invalid/v1', model_max_retries=2)
    original, calls = httpx.Client, []
    def fail(request):
        calls.append(True)
        raise httpx.RemoteProtocolError('private request details')
    monkeypatch.setattr(model_client, 'get_settings', lambda: settings)
    monkeypatch.setattr(model_client.httpx, 'Client', lambda **kw: original(transport=httpx.MockTransport(fail), **kw))
    with pytest.raises(ModelError) as caught:
        ModelClient().recognize(b'synthetic-image')
    with caplog.at_level(logging.WARNING, logger='uvicorn.error'):
        record_failure('recognition_concept', 'photo:synthetic', caught.value)
    assert calls == [True]
    assert 'remote_protocol' in caplog.text and 'private request details' not in caplog.text
