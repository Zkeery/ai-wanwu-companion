"""No-network diagnostics must not imply a real SMS acceptance or leak inputs."""
import json
import socket
import sys
from unittest.mock import Mock

import pytest

from app.core.config import Settings
from app.services import sms_readiness
from app.services.release_readiness import assess


def config(**changes):
    values = dict(app_env='test', sms_provider='volcengine', sms_live_enabled=True,
                  sms_access_key_id='private-test-ak', sms_secret_access_key='private-test-sk',
                  sms_account='private-test-account', sms_sign='private-test-sign',
                  sms_template_id='private-test-template', sms_daily_limit=1,
                  sms_timeout_seconds=10)
    values.update(changes)
    return Settings(_env_file=None, **values)


def by_id(checks):
    return {c['id']: c for c in checks}


def test_real_sdk_signing_is_offline_and_cannot_certify_live_delivery(monkeypatch, tmp_path):
    pytest.importorskip('volcengine.auth.SignerV4')
    import sqlalchemy
    from app.services.sms_volcengine import VolcengineSmsProvider

    forbidden = Mock(side_effect=AssertionError('network/database/sender forbidden'))
    monkeypatch.setattr(socket, 'socket', forbidden)
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    monkeypatch.setattr(sqlalchemy, 'create_engine', forbidden)
    monkeypatch.setattr(VolcengineSmsProvider, 'send_code', forbidden)
    report = assess(config(), {}, tmp_path)
    checks = by_id(report['checks'])
    assert checks['sms_local_signer']['status'] == 'pass'
    assert checks['sms_provider']['status'] == 'pending'
    assert not report['ready_for_release']
    assert len(checks) == len(report['checks'])
    forbidden.assert_not_called()
    serialized = json.dumps(report)
    for value in ('private-test-ak', 'private-test-sk', 'private-test-account',
                  'private-test-sign', 'private-test-template', 'Authorization'):
        assert value not in serialized


@pytest.mark.parametrize('changes,ident', [
    ({'sms_provider': 'mock'}, 'sms_provider_selection'),
    ({'sms_live_enabled': False}, 'sms_live_switch'),
    ({'sms_access_key_id': ' '}, 'sms_access_key'),
    ({'sms_secret_access_key': ''}, 'sms_secret_key'),
    ({'sms_account': ''}, 'sms_account'),
    ({'sms_sign': ''}, 'sms_sign'),
    ({'sms_template_id': ''}, 'sms_template'),
    ({'sms_daily_limit': 0}, 'sms_daily_limit'),
    ({'sms_daily_limit': 10001}, 'sms_daily_limit'),
    ({'sms_timeout_seconds': 0}, 'sms_timeout'),
    ({'sms_timeout_seconds': 16}, 'sms_timeout'),
    ({'sms_timeout_seconds': float('nan')}, 'sms_timeout'),
    ({'sms_timeout_seconds': float('inf')}, 'sms_timeout'),
])
def test_each_missing_input_blocks_overall_sms(monkeypatch, changes, ident):
    monkeypatch.setattr(sms_readiness, '_synthetic_signature_available', lambda: True)
    checks = by_id(sms_readiness.assess_sms(config(**changes)))
    assert checks[ident]['status'] == 'blocked'
    assert checks['sms_provider']['status'] == 'blocked'


def test_missing_optional_sdk_is_a_blocker_not_a_crash(monkeypatch):
    monkeypatch.setitem(sys.modules, 'volcengine.auth.SignerV4', None)
    checks = by_id(sms_readiness.assess_sms(config()))
    assert checks['sms_local_signer']['status'] == 'blocked'
    assert checks['sms_provider']['status'] == 'blocked'


def test_signing_uses_only_invented_credentials_and_redacts_exception(monkeypatch):
    module = pytest.importorskip('volcengine.auth.SignerV4')
    marker = 'never-print-private-sdk-error'
    seen = []

    def fail(request, credentials):
        seen.append(credentials)
        assert request.body == '{"offline_preflight":true}'
        raise RuntimeError(marker)

    monkeypatch.setattr(module.SignerV4, 'sign', fail)
    checks = sms_readiness.assess_sms(config())
    assert len(seen) == 1
    assert seen[0].ak == 'offline-preflight-ak'
    assert seen[0].sk == 'offline-preflight-sk'
    assert by_id(checks)['sms_provider']['status'] == 'blocked'
    assert marker not in json.dumps(checks)


def test_unsigned_sdk_result_is_not_a_pass(monkeypatch):
    module = pytest.importorskip('volcengine.auth.SignerV4')
    monkeypatch.setattr(module.SignerV4, 'sign', lambda request, credentials: None)
    checks = by_id(sms_readiness.assess_sms(config()))
    assert checks['sms_local_signer']['status'] == 'blocked'
    assert checks['sms_provider']['status'] == 'blocked'
