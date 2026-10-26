import hashlib
import io
import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from scripts import ecs_offsite_once as offsite
from scripts import ecs_ops_notify as notify

NOW = 1792300000
RUN = 'run-' + '1' * 32


@pytest.mark.parametrize('job_result', ['success', 'exit-code', 'timeout', 'missing'])
def test_collect_reports_offsite_job_failure_while_backup_is_fresh(tmp_path, monkeypatch, job_result):
    source(tmp_path)
    private = tmp_path / 'private'
    (private / 'offsite-backup').mkdir(parents=True)
    (private / 'offsite-authorization.json').write_text(json.dumps({'enabled': True}))
    (private / 'offsite-backup/state.json').write_text(json.dumps({'verified_at': NOW}))

    def unit(name):
        if name == 'wanwu-partner-offsite-backup.service':
            if job_result == 'missing':
                raise notify.subprocess.CalledProcessError(1, ['systemctl', 'show'])
            return {'ActiveState': 'inactive', 'Result': job_result}
        return {'ActiveState': 'active', 'Result': 'success'}

    class HealthyConnection:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def wrap_socket(self, *args, **kwargs):
            return self

    monkeypatch.setattr(notify, 'service', unit)
    monkeypatch.setattr(notify.urllib.request, 'urlopen', lambda *a, **k: HealthyConnection())
    monkeypatch.setattr(notify.socket, 'create_connection', lambda *a, **k: HealthyConnection())
    monkeypatch.setattr(notify.ssl, 'create_default_context', HealthyConnection)
    monkeypatch.setattr(notify.shutil, 'disk_usage', lambda *a: SimpleNamespace(total=10**10, free=5*10**9))
    expiry = notify.dt.datetime.fromtimestamp(NOW + 72 * 3600, notify.dt.timezone.utc)
    monkeypatch.setattr(notify.subprocess, 'check_output',
                        lambda *a, **k: 'notAfter=' + expiry.strftime('%b %d %H:%M:%S %Y GMT'))
    assert notify.collect(tmp_path, now=NOW) == ([] if job_result == 'success' else ['OFFSITE_REVIEW'])


def config():
    return {'enabled': True, 'approved': True, 'approval_ref': 'synthetic-only',
            'expires_at': NOW + 3600, 'region': 'cn-beijing',
            'endpoint': 'https://tos-cn-beijing.volces.com', 'bucket': 'wanwu-partner-test',
            'max_uploads': 7, 'max_bytes': offsite.MAX_BYTES,
            'max_total_bytes': offsite.MAX_TOTAL, 'cost_reference_verified': True,
            'retention_reviewed': True, 'budget_cny': '1.00', 'reserve_cny_per_attempt': '0.14'}


def source(tmp_path, *, content=b'archive-fixture', run=RUN):
    private = tmp_path / 'private'
    private.mkdir(mode=0o700, exist_ok=True)
    policy = {'schema_version': 1, 'enabled': True, 'minimum_remaining_cny': '0.50',
              'max_balance_age_seconds': 900, 'verification_mode': 'metadata', 'allow_full_download': False}
    balance = {'schema_version': 1, 'source': 'volcengine_console_readonly',
               'approval_sha256': offsite.costs.approval_sha(config()), 'evidence_ref': 'synthetic-only',
               'checked_at': NOW, 'valid_until': NOW + 900, 'available_balance_cny': '1.00',
               'unbilled_reviewed': True, 'unbilled_cost_cny': '0.00'}
    for name, data in [(offsite.costs.POLICY_FILE, policy), (offsite.costs.BALANCE_FILE, balance)]:
        path = private / name
        path.write_text(json.dumps(data))
        path.chmod(0o600)
    folder = tmp_path / 'backups/scheduled' / run
    folder.mkdir(parents=True, mode=0o700)
    archive = folder / 'snapshot.tar'
    archive.write_bytes(content)
    receipt = {'state': 'verified', 'restore_verified': True, 'run_id': run,
               'engine_sha256': offsite.ENGINE_SHA,
               'archive_sha256': hashlib.sha256(content).hexdigest()}
    path = folder / 'scheduled-result.json'
    path.write_text(json.dumps(receipt))
    os.utime(path, (NOW, NOW))
    return archive


class Engine:
    def __init__(self):
        self.restores = []

    def restore(self, archive, target, checksum):
        assert offsite.digest(archive) == checksum
        assert not target.exists()
        target.mkdir()
        self.restores.append(target)
        return {'state': 'restored_verified', 'databases': 5}


class Client:
    def __init__(self, *, corrupt=False, public=False, timeout=False):
        self.calls = []
        self.content = None
        self.corrupt, self.public, self.timeout = corrupt, public, timeout

    def get_bucket_acl(self, bucket):
        self.calls.append('acl')
        kind = 'Group' if self.public else 'CanonicalUser'
        return SimpleNamespace(owner=SimpleNamespace(id='owner'), grants=[
            SimpleNamespace(grantee=SimpleNamespace(type=kind, id='owner'))])

    def get_bucket_policy(self, bucket):
        self.calls.append('policy')
        return SimpleNamespace(policy='{}')

    def put_object(self, bucket, key, **kwargs):
        self.calls.append('put')
        assert kwargs['forbid_overwrite'] is True
        if self.timeout:
            raise TimeoutError('sensitive raw provider message must not escape')
        self.content = kwargs['content'].read()
        self.meta = kwargs['meta']
        return SimpleNamespace(etag='synthetic-etag')

    def head_object(self, bucket, key):
        self.calls.append('head')
        return SimpleNamespace(content_length=len(self.content), etag='synthetic-etag',
                               meta={} if self.corrupt else self.meta)

    def get_object(self, bucket, key):
        self.calls.append('get')
        content = self.content
        if self.corrupt:
            content = bytes([content[0] ^ 1]) + content[1:]
        stream = io.BytesIO(content)
        return SimpleNamespace(content_length=len(content), read=stream.read)


def test_unapproved_never_initializes_client(tmp_path):
    c = config()
    c['approved'] = False
    with pytest.raises(ValueError, match='offsite_not_authorized'):
        offsite.copy_once(tmp_path, Engine(), c, {}, factory=lambda *_: pytest.fail('network'), now=NOW)
    assert not (tmp_path / 'private').exists()


@pytest.mark.parametrize('field,value', [('region', 'cn-hongkong'), ('expires_at', NOW),
                                       ('max_uploads', 8), ('budget_cny', '10.00')])
def test_authorization_boundaries(field, value):
    c = config()
    c[field] = value
    with pytest.raises(ValueError):
        offsite.authorize(c, NOW)


def test_corrupt_local_snapshot_stops_before_cloud(tmp_path):
    archive = source(tmp_path)
    archive.write_bytes(b'changed')
    with pytest.raises(ValueError, match='snapshot_integrity_failed'):
        offsite.copy_once(tmp_path, Engine(), config(), {}, factory=lambda *_: pytest.fail('network'), now=NOW)


def test_metadata_upload_local_restore_and_no_replay(tmp_path):
    archive = source(tmp_path)
    preserved = archive.read_bytes()
    client, engine = Client(), Engine()
    first = offsite.copy_once(tmp_path, engine, config(), {}, factory=lambda *_: (client, 'private'), now=NOW)
    assert first['state'] == 'uploaded_metadata_verified'
    assert first['download_verified'] is False and first['remote_restore_verified'] is False
    assert first['local_restore_verified'] is True
    assert len(engine.restores) == 1
    assert client.calls == ['acl', 'policy', 'put', 'head']
    assert archive.read_bytes() == preserved
    second = offsite.copy_once(tmp_path, engine, config(), {}, factory=lambda *_: pytest.fail('replay'), now=NOW)
    assert second['state'] == 'already_verified'
    intent = json.loads((tmp_path / 'private/offsite-backup' / RUN / 'intent.json').read_text())
    assert intent['reserved_cny'] == '0.14'


@pytest.mark.parametrize('kwargs,expected_calls', [({'public': True}, ['acl']),
                                                ({'timeout': True}, ['acl', 'policy', 'put']),
                                                ({'corrupt': True}, ['acl', 'policy', 'put', 'head'])])
def test_failure_preserved_and_future_batches_blocked(tmp_path, kwargs, expected_calls):
    archive = source(tmp_path)
    original = offsite.digest(archive)
    client = Client(**kwargs)
    result = offsite.copy_once(tmp_path, Engine(), config(), {}, factory=lambda *_: (client, 'private'), now=NOW)
    assert result['state'] == 'failed'
    assert 'sensitive' not in json.dumps(result)
    assert client.calls == expected_calls
    assert offsite.digest(archive) == original
    assert (tmp_path / 'private/offsite-backup' / RUN / 'intent.json').is_file()
    assert offsite.copy_once(tmp_path, Engine(), config(), {},
                             factory=lambda *_: pytest.fail('retry'), now=NOW)['reason'] == 'previous_failure_requires_review'


def webhook():
    return {'enabled': True, 'approved': True, 'approval_ref': 'synthetic-only',
            'group_name': '万物伙伴运维通知群', 'signing_secret': 'synthetic-sign-secret',
            'webhook': 'https://open.feishu.cn/open-apis/bot/v2/hook/' + 'a' * 32}


def test_initial_health_silent_fault_dedup_and_recovery(tmp_path):
    area = tmp_path / 'notify'
    sent = []
    sender = lambda c, p: sent.append(p)
    assert notify.notify_once(area, webhook(), [], sender=sender, now=NOW)['network_requests'] == 0
    assert notify.notify_once(area, webhook(), ['BACKUP_STALE'], sender=sender, now=NOW + 1)['state'] == 'sent'
    assert notify.notify_once(area, webhook(), ['BACKUP_STALE'], sender=sender, now=NOW + 2)['network_requests'] == 0
    assert notify.notify_once(area, webhook(), [], sender=sender, now=NOW + 3)['state'] == 'sent'
    assert len(sent) == 2
    assert 'BACKUP_STALE' in sent[0]['content']['text']
    assert '恢复' in sent[1]['content']['text']
    assert 'synthetic-sign-secret' not in json.dumps(sent)
    assert 'webhook' not in json.dumps(sent)


def test_unknown_delivery_does_not_retry_or_claim_recovery(tmp_path):
    def timeout(c, p):
        raise TimeoutError('contains secret provider response')
    area = tmp_path / 'notify'
    result = notify.notify_once(area, webhook(), ['BACKEND_DOWN'], sender=timeout, now=NOW)
    assert result['state'] == 'unknown_or_failed'
    result = notify.notify_once(area, webhook(), [], sender=lambda *_: pytest.fail('retry'), now=NOW + 1)
    assert result == {'state': 'delivery_review_required', 'network_requests': 0}


def test_process_interruption_leaves_intent_no_automatic_replay(tmp_path):
    def interrupted(c, p):
        raise SystemExit('simulated termination')
    area = tmp_path / 'notify'
    with pytest.raises(SystemExit):
        notify.notify_once(area, webhook(), ['DISK_LOW'], sender=interrupted, now=NOW)
    assert notify.notify_once(area, webhook(), ['DISK_LOW'],
                               sender=lambda *_: pytest.fail('replay'), now=NOW + 1)['state'] == 'delivery_review_required'


def test_notification_rejects_raw_content_and_unapproved_destination(tmp_path):
    with pytest.raises(ValueError, match='unrecognized_alarm_code'):
        notify.notify_once(tmp_path / 'n', webhook(), ['personal message or token'], sender=lambda *_: pytest.fail('sent'))
    c = webhook()
    c['webhook'] = 'https://example.com/collect'
    with pytest.raises(ValueError, match='feishu_not_authorized'):
        notify.notify_once(tmp_path / 'n', c, [], sender=lambda *_: pytest.fail('sent'))


def test_daily_delivery_cap(tmp_path):
    area, sent = tmp_path / 'notify', []
    for index in range(24):
        result = notify.notify_once(area, webhook(), ['DRILL_FAULT'] if index % 2 == 0 else [],
                                    sender=lambda c, p: sent.append(p), now=NOW + index)
        assert result['state'] == 'sent'
    assert notify.notify_once(area, webhook(), ['DRILL_FAULT'], sender=lambda *_: pytest.fail('cap'),
                               now=NOW + 24)['state'] == 'daily_delivery_cap'
    assert len(sent) == 24


def test_cloud_retention_cap_never_deletes_or_contacts_cloud(tmp_path):
    source(tmp_path)
    area = tmp_path / 'private/offsite-backup'
    area.mkdir(parents=True, mode=0o700)
    approval = hashlib.sha256(json.dumps(config(), sort_keys=True).encode()).hexdigest()
    for number in range(2, 9):
        folder = area / ('run-' + str(number) * 32)
        folder.mkdir()
        (folder / 'intent.json').write_text(json.dumps({'bytes': 100, 'approval_sha256': approval,
                                                       'reserved_cny': '0.14'}))
    result = offsite.copy_once(tmp_path, Engine(), config(), {},
                               factory=lambda *_: pytest.fail('retention exceeded'), now=NOW)
    assert result['reason'] == 'offsite_retention_review_required'
    assert len(list(area.glob('run-*'))) == 7


def test_changed_approval_requires_review_before_new_upload(tmp_path):
    source(tmp_path)
    client = Client()
    offsite.copy_once(tmp_path, Engine(), config(), {}, factory=lambda *_: (client, 'private'), now=NOW)
    source(tmp_path, run='run-' + '2' * 32)
    os.utime(tmp_path / 'backups/scheduled' / ('run-' + '2' * 32) / 'scheduled-result.json', (NOW + 1, NOW + 1))
    changed = config()
    changed['bucket'] = 'wanwu-partner-another'
    with pytest.raises(ValueError, match='approval_changed_requires_review'):
        offsite.copy_once(tmp_path, Engine(), changed, {}, factory=lambda *_: pytest.fail('new destination'), now=NOW + 1)


def test_valid_http_status_does_not_hide_feishu_business_failure(monkeypatch):
    class Response:
        status = 200
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def read(self, size):
            return b'{"code":19021,"msg":"signature mismatch"}'
    opener = SimpleNamespace(open=lambda *args, **kwargs: Response())
    monkeypatch.setattr(notify.urllib.request, 'build_opener', lambda *args: opener)
    with pytest.raises(ValueError, match='feishu_business_failure'):
        notify.deliver(webhook(), {'msg_type': 'text', 'content': {'text': 'synthetic'}})


def test_nonempty_bucket_policy_blocks_upload(tmp_path):
    source(tmp_path)
    client = Client()
    client.get_bucket_policy = lambda _: SimpleNamespace(policy='{"Statement":[{"Principal":"*"}]}')
    result = offsite.copy_once(tmp_path, Engine(), config(), {}, factory=lambda *_: (client, 'private'), now=NOW)
    assert result['state'] == 'failed'
    assert 'put' not in client.calls
