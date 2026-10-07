import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
from types import SimpleNamespace

import pytest

from scripts import ecs_offsite as offsite
from scripts import ecs_maintenance as local
from scripts import ecs_cloud_backup as cloud


class MissingPolicy(Exception):
    status_code = 404
    code = 'NoSuchBucketPolicy'


class FakeCloud:
    def __init__(self, *, fail=None, corrupt=False, public=False):
        self.calls = []
        self.fail, self.corrupt, self.public = fail, corrupt, public
        self.closed = False
        self.objects = {}

    def get_bucket_acl(self, bucket):
        self.calls.append('acl')
        if self.fail == 'acl':
            raise RuntimeError('synthetic-sensitive-error')
        return SimpleNamespace(owner=SimpleNamespace(id='owner'), grants=[
            SimpleNamespace(grantee=SimpleNamespace(type='Group' if self.public else 'CanonicalUser', id='owner'))])

    def get_bucket_policy(self, bucket):
        self.calls.append('policy')
        raise MissingPolicy()

    def put_object(self, bucket, key, **options):
        self.calls.append('put')
        assert options['forbid_overwrite'] is True
        assert options['acl'] == 'synthetic-private-acl'
        self.objects[key] = options['content'].read()
        if self.fail == 'put':
            raise RuntimeError('synthetic-sensitive-error')

    def get_object(self, bucket, key):
        self.calls.append('get')
        body = self.objects[key] + (b'changed' if self.corrupt else b'')
        stream = io.BytesIO(body)
        return SimpleNamespace(content_length=len(body), read=stream.read)

    def close(self):
        self.closed = True


@pytest.fixture(autouse=True)
def no_real_network(monkeypatch):
    import socket
    monkeypatch.setattr(socket.socket, 'connect', lambda *_: pytest.fail('real network forbidden'))


@pytest.fixture
def setup(tmp_path, monkeypatch):
    now = 100000
    monkeypatch.setattr(local.time, 'time', lambda: now)
    source, root = tmp_path / 'source', tmp_path / 'backups'
    source.mkdir(mode=0o700)
    root.mkdir(mode=0o700)
    (source / 'uploads').mkdir()
    (source / 'ledger').mkdir()
    with sqlite3.connect(source / 'app.db') as db:
        db.execute('create table records(id integer primary key)')
        db.execute('insert into records values(1)')
    (source / 'uploads' / 'image.bin').write_bytes(b'synthetic-image')
    (source / 'ledger' / 'state.json').write_text('{"origin":"synthetic"}')
    (source / 'state.json').write_text('{"calls":0}')
    monkeypatch.setattr(local.shutil, 'disk_usage', lambda _: SimpleNamespace(free=20*local.GIB))
    record = local.backup_once(source, root)
    grant = dict(schema_version=1, project='AI万物伙伴', approved=True,
                 approval_ref='synthetic-approved-ref', bucket='synthetic-bucket', region='cn-beijing',
                 issued_at=now-1, expires_at=now+86400, max_uploads=3,
                 max_archive_bytes=1024**2, max_total_archive_bytes=3*1024**2,
                 unit_reserved_cny='0.10', budget_cny='0.30',
                 cost_basis_ref='synthetic-quote', retention_review_ref='synthetic-retention')
    path = tmp_path / 'authorization.json'
    path.write_text(json.dumps(grant))
    path.chmod(0o600)
    env = dict(CLOUD_SCHEDULE_ENABLED='true', TOS_BACKUP_ENABLED='true',
               CLOUD_BACKUP_AUTHORIZATION_REF=grant['approval_ref'], TOS_BUCKET=grant['bucket'],
               TOS_REGION='cn-beijing', TOS_ENDPOINT='https://tos-cn-beijing.volces.com',
               TOS_ACCESS_KEY_ID='synthetic-ak', TOS_SECRET_ACCESS_KEY='synthetic-sk')
    client = FakeCloud()
    def initialize(_env, _reference):
        # Persisted reservation MUST precede SDK initialization and first request.
        state = offsite.status(root)
        assert state['attempts'] >= 1 and state['state'] == 'blocked_unknown'
        return client, 'synthetic-private-acl'
    monkeypatch.setattr(cloud, 'cloud_client', initialize)
    return SimpleNamespace(source=source, root=root, path=path, env=env, now=now,
                           record=record, grant=grant, client=client)


def write_grant(setup, **changes):
    setup.grant.update(changes)
    setup.path.write_text(json.dumps(setup.grant))


def dispatch(setup):
    return offsite.dispatch(setup.root, setup.path, setup.env, now=setup.now)


def test_verified_transfer_is_once_across_reopen(setup):
    result = dispatch(setup)
    assert result['state'] == 'verified' and result['sdk_calls'] == 4
    assert setup.client.calls == ['acl', 'policy', 'put', 'get']
    assert setup.client.closed
    result2 = dispatch(setup)
    assert result2 == dict(state='verified', reused=True, new_cloud_requests=0)
    assert len(setup.client.calls) == 4
    status = offsite.status(setup.root)
    assert status['attempts'] == status['verified'] == 1
    assert status['reserved_cny'] == '0.10' and status['actual_bill_verified'] is False
    assert (setup.root / setup.record['run_id'] / 'cloud-transfer.json').is_file()
    child = subprocess.run([sys.executable, '-c',
                            'import json,sys;from pathlib import Path;from scripts.ecs_offsite import status;print(json.dumps(status(Path(sys.argv[1]))))',
                            str(setup.root)], capture_output=True, text=True, timeout=10, check=True)
    recovered = json.loads(child.stdout)
    assert recovered['attempts'] == recovered['verified'] == 1
    assert recovered['reserved_cny'] == '0.10' and recovered['sdk_calls'] == 4


@pytest.mark.parametrize('change', [
    {'approved': False}, {'expires_at': 100000}, {'issued_at': 100001},
    {'expires_at': 4000000}, {'project': 'other'}, {'bucket': 'other-bucket'},
    {'approval_ref': 'different'}, {'retention_review_ref': ''}, {'cost_basis_ref': ''},
    {'max_uploads': 0}, {'max_uploads': True}, {'max_archive_bytes': 0},
    {'max_total_archive_bytes': 0}, {'unit_reserved_cny': 'NaN'},
    {'unit_reserved_cny': '0'}, {'budget_cny': '0.01'},
])
def test_invalid_approval_refused_before_ledger_or_cloud(setup, change):
    write_grant(setup, **change)
    with pytest.raises(ValueError):
        dispatch(setup)
    assert setup.client.calls == []
    assert not (setup.root / offsite.LEDGER).exists()


@pytest.mark.parametrize('change', [
    {'CLOUD_SCHEDULE_ENABLED': 'false'}, {'TOS_BACKUP_ENABLED': 'false'},
    {'TOS_ENDPOINT': 'http://tos-cn-beijing.volces.com'}, {'TOS_REGION': 'other'},
    {'CLOUD_BACKUP_AUTHORIZATION_REF': 'other'}, {'TOS_ACCESS_KEY_ID': ''},
])
def test_disabled_or_wrong_destination_no_cloud(setup, change):
    setup.env.update(change)
    with pytest.raises(ValueError):
        dispatch(setup)
    assert not setup.client.calls


def test_authorization_cannot_change_budget_on_reopen(setup):
    assert dispatch(setup)['state'] == 'verified'
    write_grant(setup, budget_cny='0.60')
    with pytest.raises(ValueError, match='grant_changed'):
        dispatch(setup)
    assert offsite.status(setup.root)['reserved_cny'] == '0.10'
    assert len(setup.client.calls) == 4


@pytest.mark.parametrize('boundary', ['uploads', 'money', 'bytes'])
def test_exhausted_caps_reject_next_archive(setup, boundary):
    if boundary == 'uploads':
        write_grant(setup, max_uploads=1)
    elif boundary == 'money':
        write_grant(setup, budget_cny='0.10')
    else:
        size = (setup.root / setup.record['run_id'] / 'snapshot.tar').stat().st_size
        write_grant(setup, max_archive_bytes=size, max_total_archive_bytes=size)
    assert dispatch(setup)['state'] == 'verified'
    second = local.backup_once(setup.source, setup.root, now=setup.now+1)
    setup.now += 1
    assert second['state'] == 'verified'
    with pytest.raises(ValueError, match='exhausted'):
        dispatch(setup)
    assert len(setup.client.calls) == 4
    assert offsite.status(setup.root)['attempts'] == 1


@pytest.mark.parametrize('fault', ['put', 'acl', 'corrupt', 'public'])
def test_failure_unknown_stops_batch_without_retry_or_release(setup, fault):
    setup.client.fail = fault if fault in ('put', 'acl') else None
    setup.client.corrupt = fault == 'corrupt'
    setup.client.public = fault == 'public'
    result = dispatch(setup)
    assert result['state'] == 'unknown'
    assert result['reserved_cny'] == '0.10'
    before = list(setup.client.calls)
    with pytest.raises(ValueError, match='unknown_attempt'):
        dispatch(setup)
    assert setup.client.calls == before
    assert offsite.status(setup.root)['state'] == 'blocked_unknown'
    assert 'synthetic-sensitive-error' not in json.dumps(result)


def test_sdk_initialization_failure_preserves_reservation(setup, monkeypatch):
    monkeypatch.setattr(cloud, 'cloud_client', lambda *_: (_ for _ in ()).throw(RuntimeError('synthetic-private-key')))
    result = dispatch(setup)
    assert result['state'] == 'unknown' and result['sdk_calls'] == 0
    assert offsite.status(setup.root)['reserved_cny'] == '0.10'


@pytest.mark.parametrize('fault', ['archive', 'stale', 'latest_failed', 'future'])
def test_bad_local_source_never_initializes_sdk(setup, fault):
    if fault == 'archive':
        (setup.root / setup.record['run_id'] / 'snapshot.tar').write_bytes(b'corrupt')
    elif fault == 'stale':
        setup.now += 86401
        write_grant(setup, expires_at=setup.now+1)
    elif fault == 'future':
        setup.now -= 1
        write_grant(setup, issued_at=setup.now-1)
    else:
        record = dict(run_id='a'*32, state='failed', started_at=setup.now+1, finished_at=setup.now+1)
        local.save_json(setup.root / ('run-'+'a'*32+'.json'), record)
    with pytest.raises(ValueError):
        dispatch(setup)
    assert not setup.client.calls
    assert not (setup.root / offsite.LEDGER).exists()


def test_competing_local_backup_lock_blocks_cloud(setup):
    with local.exclusive(setup.root, '.backup.lock'):
        with pytest.raises(ValueError, match='already_running'):
            dispatch(setup)
    assert not setup.client.calls


def test_interruption_before_external_call_is_durable(setup, monkeypatch):
    monkeypatch.setattr(cloud, 'cloud_client', lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    with pytest.raises(KeyboardInterrupt):
        dispatch(setup)
    assert offsite.status(setup.root)['state'] == 'blocked_unknown'
    with pytest.raises(ValueError, match='unknown_attempt'):
        dispatch(setup)
    assert not setup.client.calls


def test_meter_prevents_fifth_request(setup):
    db = offsite.connect(setup.root)
    with db:
        db.execute('insert into attempts values(?,?,?,?,?,0,?,NULL)',
                   ('a'*32, 'b'*64, 1, '0.10', 'attempted', setup.now))
    metered = offsite.MeteredClient(setup.client, db, 'a'*32)
    for _ in range(4):
        metered.get_bucket_acl('synthetic-bucket')
    with pytest.raises(ValueError, match='request_limit'):
        metered.get_bucket_acl('synthetic-bucket')
    assert len(setup.client.calls) == 4
    db.close()


def test_status_read_only_never_initializes_cloud(setup, monkeypatch):
    monkeypatch.setattr(cloud, 'cloud_client', lambda *_: pytest.fail('status must not initialize SDK'))
    assert offsite.status(setup.root)['state'] == 'not_started'
    assert not (setup.root / offsite.LEDGER).exists()
    db = offsite.connect(setup.root)
    db.close()
    assert offsite.status(setup.root)['state'] == 'not_started'


def test_cli_disabled_never_checks_or_sends(setup, monkeypatch, capsys):
    monkeypatch.setattr('sys.argv', ['ecs_offsite', 'dispatch'])
    monkeypatch.setenv('CLOUD_SCHEDULE_ENABLED', 'false')
    monkeypatch.setattr(offsite.runtime, 'mounted_volume', lambda *_: pytest.fail('disabled must stop first'))
    assert offsite.main() == 1
    result = json.loads(capsys.readouterr().out)
    assert result['error']['code'] == 'scheduled_offsite_backup_blocked'
    assert not setup.client.calls


def test_template_cannot_authorize_schedule(setup):
    project = Path(__file__).resolve().parents[2]
    template = project / 'deploy/ecs/cloud-schedule.authorization.example.json'
    with pytest.raises(ValueError):
        offsite.authorization(template, setup.env, setup.now)
    assert not setup.client.calls
    unit = (project / 'deploy/ecs/ai-companion-offsite.service').read_text()
    assert 'Type=oneshot' in unit and 'Restart=' not in unit
    assert 'systemctl stop' not in unit and 'ecs_offsite dispatch' in unit


def test_archive_changed_during_sdk_init_is_not_sent(setup, monkeypatch):
    def change_archive(*_):
        (setup.root / setup.record['run_id'] / 'snapshot.tar').write_bytes(b'changed-after-reservation')
        return setup.client, 'synthetic-private-acl'
    monkeypatch.setattr(cloud, 'cloud_client', change_archive)
    result = dispatch(setup)
    assert result['state'] == 'unknown' and result['sdk_calls'] == 0
    assert setup.client.calls == []
    assert offsite.status(setup.root)['reserved_cny'] == '0.10'


def test_different_transfer_checksum_cannot_publish_verified(setup, monkeypatch):
    monkeypatch.setattr(cloud, 'upload', lambda *_: dict(upload_and_download_verified=True, archive_sha256='0'*64))
    result = dispatch(setup)
    assert result['state'] == 'unknown' and result['sdk_calls'] == 2
    assert setup.client.calls == ['acl', 'policy']
