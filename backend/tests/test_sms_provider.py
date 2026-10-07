"""SMS adapter, bounded reservations and authentication recovery; no real network."""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from threading import Barrier

import httpx
import pytest

from app.core.config import Settings
from app.core.database import SessionLocal, engine
from app.models.models import SmsDailyQuota, VerificationCode
from app.services import sms
from app.services.sms_volcengine import HOST, VolcengineSmsProvider


def configured(**changes):
    values = dict(sms_provider='volcengine', sms_live_enabled=True, sms_access_key_id='synthetic-ak',
                  sms_secret_access_key='synthetic-sk', sms_account='A-test', sms_sign='测试签名',
                  sms_template_id='ST_test', sms_daily_limit=2, dev_sms_fixed_code='')
    values.update(changes)
    return Settings(_env_file=None, **values)


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('network forbidden'))
    monkeypatch.setattr(sms, 'get_settings', lambda: configured())


def provider(handler, settings=None):
    def factory(**kwargs):
        assert kwargs['follow_redirects'] is False and kwargs['trust_env'] is False
        assert kwargs['timeout'].read <= 15
        return httpx.Client(transport=httpx.MockTransport(handler), **kwargs)
    return VolcengineSmsProvider(settings or configured(), factory)


def accepted():
    return {'ResponseMetadata': {'RequestId': 'request-test'}, 'Result': {'MessageID': ['message-test']}}


def test_signed_single_recipient_request_has_no_sdk_retry_or_global_credentials():
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url.host == HOST and request.url.scheme == 'https'
        assert dict(request.url.params) == {'Action': 'SendSms', 'Version': '2020-01-01'}
        assert 'Credential=synthetic-ak/' in request.headers['authorization']
        assert '/cn-north-1/volcSMS/request' in request.headers['authorization']
        assert 'SignedHeaders=content-type;host;x-content-sha256;x-date' in request.headers['authorization']
        body = json.loads(request.content)
        assert body['PhoneNumbers'] == '13900000701'
        assert body['Sign'] == '测试签名' and body['SmsAccount'] == 'A-test'
        assert json.loads(body['TemplateParam']) == {'code': '123456'}
        return httpx.Response(200, json=accepted())
    provider(handler).send_code('13900000701', '123456')
    assert len(calls) == 1


@pytest.mark.parametrize('change', [dict(sms_live_enabled=False), dict(sms_access_key_id=''),
    dict(sms_secret_access_key=''), dict(sms_template_id=''), dict(sms_daily_limit=0),
    dict(sms_timeout_seconds=float('inf')), dict(sms_timeout_seconds=16)])
def test_disabled_or_incomplete_never_opens_client(change):
    def forbidden(**_):
        pytest.fail('client must not be created')
    with pytest.raises(sms.SmsError) as error:
        VolcengineSmsProvider(configured(**change), forbidden).send_code('13900000701', '123456')
    assert error.value.code == 'sms_unavailable'


@pytest.mark.parametrize('body', [{}, {'ResponseMetadata': {}},
    {'ResponseMetadata': {}, 'Result': {'MessageID': []}},
    {'ResponseMetadata': {}, 'Result': {'MessageID': ['a', 'b']}},
    {'ResponseMetadata': {}, 'Result': {'MessageID': [1]}}])
def test_malformed_success_is_unknown_and_never_retried(body):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json=body)
    with pytest.raises(sms.SmsError) as error:
        provider(handler).send_code('13900000701', '123456')
    assert error.value.code == 'sms_unknown' and len(calls) == 1


@pytest.mark.parametrize('failure', ['timeout', 'http', 'oversize', 'reject', 'init'])
def test_errors_are_redacted_and_do_not_retry(failure):
    calls = []
    marker = 'never-show-provider-private-content'
    def handler(request):
        calls.append(request)
        if failure == 'timeout':
            raise httpx.ReadTimeout(marker)
        if failure == 'http':
            return httpx.Response(503, text=marker)
        if failure == 'oversize':
            return httpx.Response(200, content=b'x' * 65537)
        return httpx.Response(200, json={'ResponseMetadata': {'Error': {'Code': 'RE:0003', 'Message': marker}}})
    sender = provider(handler)
    if failure == 'init':
        sender.client_factory = lambda **_: (_ for _ in ()).throw(RuntimeError(marker))
    with pytest.raises(sms.SmsError) as error:
        sender.send_code('13900000701', '123456')
    assert error.value.code == ('sms_unavailable' if failure == 'init' else 'sms_rejected' if failure == 'reject' else 'sms_unknown')
    assert marker not in str(error.value) and '13900000701' not in str(error.value)
    assert len(calls) == (0 if failure == 'init' else 1)


def test_login_keeps_send_limits_and_code_is_consumed_once():
    sender = sms.MockSmsProvider()
    with SessionLocal() as db:
        sms.issue_code('13900000701', db, sender)
        code = sender.sent[0][1]
        assert sms.verify_code('13900000701', code, db) == 'ok'
        assert sms.verify_code('13900000701', code, db) != 'ok'
        with pytest.raises(sms.SmsError) as error:
            sms.issue_code('13900000701', db, sender)
        assert error.value.code == 'rate_limited'
        record = db.query(VerificationCode).one()
        assert record.send_count == 1
        record.last_sent_at -= timedelta(minutes=2)
        record.send_count = 10
        db.commit()
        with pytest.raises(sms.SmsError, match='今天发送次数'):
            sms.issue_code('13900000701', db, sender)
    assert len(sender.sent) == 1


def test_global_budget_is_durable_and_unknown_is_not_refunded():
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        raise httpx.ReadTimeout('private')
    sender = provider(handler)
    for phone in ('13900000701', '13900000702'):
        with SessionLocal() as db, pytest.raises(sms.SmsError) as error:
            sms.issue_code(phone, db, sender)
        assert error.value.code == 'sms_unknown'
    with SessionLocal() as db:
        with pytest.raises(sms.SmsError) as error:
            sms.issue_code('13900000703', db, sender)
        assert error.value.code == 'sms_budget_exhausted'
        code = json.loads(calls[0]['TemplateParam'])['code']
        assert sms.verify_code('13900000701', code, db) == 'ok'
        assert db.query(SmsDailyQuota).one().used == 2
    script = "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); print(db.execute('SELECT used FROM sms_daily_quotas').fetchone()[0])"
    result = subprocess.run([sys.executable, '-c', script, engine.url.database], capture_output=True, text=True, timeout=10, check=True)
    assert result.stdout.strip() == '2' and len(calls) == 2


def test_explicit_rejection_invalidates_code_but_keeps_counts():
    codes = []
    def handler(request):
        codes.append(json.loads(json.loads(request.content)['TemplateParam'])['code'])
        return httpx.Response(200, json={'ResponseMetadata': {'Error': {'Code': 'RE:0003'}}})
    with SessionLocal() as db:
        with pytest.raises(sms.SmsError) as error:
            sms.issue_code('13900000701', db, provider(handler))
        assert error.value.code == 'sms_rejected'
        assert sms.verify_code('13900000701', codes[0], db) != 'ok'
        assert db.query(SmsDailyQuota).one().used == 1


def test_concurrent_phone_requests_only_send_once(monkeypatch):
    barrier = Barrier(2)
    original = sms.new_verification_code
    def synchronized_code():
        barrier.wait(timeout=5)
        return original()
    monkeypatch.setattr(sms, 'new_verification_code', synchronized_code)
    sender = sms.MockSmsProvider()
    sender.requires_budget = True
    def issue(_):
        with SessionLocal() as db:
            try:
                sms.issue_code('13900000701', db, sender)
                return 'sent'
            except sms.SmsError as error:
                return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(issue, range(2)))
    assert results.count('sent') == 1 and len(sender.sent) == 1
    with SessionLocal() as db:
        assert db.query(SmsDailyQuota).one().used == 1


def test_configured_sender_stays_pending_until_real_acceptance():
    from app.services.release_readiness import assess
    from pathlib import Path
    report = assess(configured(), {}, Path(__file__).resolve().parents[2])
    assert next(c for c in report['checks'] if c['id'] == 'sms_provider')['status'] == 'pending'
    assert not report['ready_for_release']


def test_concurrent_code_consumption_only_succeeds_once(monkeypatch):
    sender = sms.MockSmsProvider()
    with SessionLocal() as db:
        sms.issue_code('13900000701', db, sender)
    code = sender.sent[0][1]
    barrier, original = Barrier(2), sms.hash_code
    def synchronized_hash(value):
        barrier.wait(timeout=5)
        return original(value)
    monkeypatch.setattr(sms, 'hash_code', synchronized_hash)
    def consume(_):
        with SessionLocal() as db:
            return sms.verify_code('13900000701', code, db)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(consume, range(2)))
    assert results.count('ok') == 1


def test_production_requires_complete_real_sms_config_and_no_previews():
    from pydantic import ValidationError
    safe = dict(app_env='production', model_api_key='synthetic', model_base_url='https://example.invalid/v1',
                image_base_url='', dev_auth_token='', dev_sms_fixed_code='', legacy_claim_user_id='')
    assert configured(**safe).app_env == 'production'
    with pytest.raises(ValidationError, match='sms_configuration'):
        configured(**safe, sms_live_enabled=False)
    with pytest.raises(ValidationError, match='life_preview'):
        configured(**safe, life_runtime_preview_enabled=True)


def test_provider_selection_uses_only_project_configuration(monkeypatch):
    from app.api import deps
    deps.set_sms_provider(None)
    monkeypatch.setattr(deps, 'get_settings', lambda: configured())
    assert isinstance(deps.get_sms_provider(), VolcengineSmsProvider)
    monkeypatch.setattr(deps, 'get_settings', lambda: configured(sms_provider='mock', sms_live_enabled=False))
    assert isinstance(deps.get_sms_provider(), sms.MockSmsProvider)


def test_api_unavailable_and_unknown_are_503_without_private_details(anon):
    from app.api.deps import set_sms_provider
    class Failing:
        def send_code(self, *_):
            raise RuntimeError('private-provider-error')
    set_sms_provider(Failing())
    try:
        response = anon.post('/api/v1/auth/code', json={'phone': '13900000701'})
        assert response.status_code == 503
        assert response.json()['error']['code'] == 'sms_unknown'
        assert 'private-provider-error' not in response.text
    finally:
        set_sms_provider(None)
