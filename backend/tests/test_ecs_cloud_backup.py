import io
import json
import sqlite3
import tarfile
from types import SimpleNamespace

import pytest

from scripts import ecs_cloud_backup as cloud
from scripts import ecs_runtime as runtime


@pytest.fixture
def archive(tmp_path):
    source = tmp_path / 'source'
    (source / 'uploads').mkdir(parents=True)
    (source / 'ledger').mkdir()
    with sqlite3.connect(source / 'app.db') as db:
        db.execute('CREATE TABLE synthetic (id INTEGER PRIMARY KEY)')
        db.execute('INSERT INTO synthetic VALUES (1)')
    (source / 'uploads/a.txt').write_text('synthetic asset')
    (source / 'ledger/j.json').write_text('{"state":"waiting"}')
    (source / 'state.json').write_text('{"enabled":false}')
    snapshot = tmp_path / 'snapshot'
    runtime.capture_data(source, snapshot)
    (snapshot / '.env').write_text('SYNTHETIC_SECRET=not-for-export')
    target = tmp_path / 'backup.tar'
    result = cloud.pack(snapshot, target)
    return target, result['archive_sha256']


def test_archive_round_trip_only_complete_data(archive, tmp_path):
    path, checksum = archive
    target = tmp_path / 'unpacked'
    assert cloud.unpack(path, checksum, target)['unpacked_snapshot_verified']
    assert not (target / '.env').exists()
    assert (target / 'ledger/j.json').read_text() == '{"state":"waiting"}'
    assert path.stat().st_mode & 0o077 == 0


@pytest.mark.parametrize('fault', ['checksum', 'overwrite', 'traversal', 'symlink', 'duplicate'])
def test_unsafe_archives_refused_before_creation(archive, tmp_path, fault):
    path, checksum = archive
    target = tmp_path / 'unpacked'
    if fault == 'checksum':
        checksum = '0' * 64
    elif fault == 'overwrite':
        target.mkdir()
    else:
        path = tmp_path / 'malicious.tar'
        with tarfile.open(path, 'w') as tar:
            member = tarfile.TarInfo('../escape' if fault == 'traversal' else 'manifest.json')
            if fault == 'symlink':
                member.type = tarfile.SYMTYPE
                member.linkname = '/private'
                tar.addfile(member)
            else:
                member.size = 2
                tar.addfile(member, io.BytesIO(b'{}'))
                if fault == 'duplicate':
                    tar.addfile(member, io.BytesIO(b'{}'))
        checksum = cloud.digest(path)
    with pytest.raises(ValueError):
        cloud.unpack(path, checksum, target)
    assert not (tmp_path / 'escape').exists()
    assert target.exists() == (fault == 'overwrite')


def test_unauthorized_cloud_does_not_initialize_sdk():
    with pytest.raises(ValueError):
        cloud.cloud_client({}, 'unapproved')


@pytest.mark.parametrize('fault', ['', 'group', 'other_owner', 'policy', 'unknown_policy'])
def test_bucket_private_checks(fault):
    class MissingPolicy(Exception):
        status_code = 404
        code = 'NoSuchBucketPolicy'
    owner = 'synthetic-owner'
    grantee = SimpleNamespace(type='Group' if fault == 'group' else 'CanonicalUser',
                              id='other' if fault == 'other_owner' else owner)
    client = SimpleNamespace(get_bucket_acl=lambda bucket: SimpleNamespace(owner=SimpleNamespace(id=owner),
                                                                           grants=[SimpleNamespace(grantee=grantee)]))
    def policy(bucket):
        if fault == 'unknown_policy':
            raise RuntimeError('unknown')
        if fault == 'policy':
            return SimpleNamespace(policy='{"Statement":[{"Effect":"Allow","Principal":"*"}]}')
        raise MissingPolicy()
    client.get_bucket_policy = policy
    if fault:
        with pytest.raises(ValueError):
            cloud.private_bucket(client, 'synthetic-bucket')
    else:
        cloud.private_bucket(client, 'synthetic-bucket')


class MemoryClient:
    def __init__(self, fail=False, corrupt=False):
        self.puts = 0
        self.fail = fail
        self.corrupt = corrupt
    def put_object(self, bucket, key, **kwargs):
        self.puts += 1
        self.arguments = kwargs.copy()
        self.body = kwargs['content'].read()
        if self.fail:
            raise RuntimeError('unknown put')
    def get_object(self, bucket, key):
        body = self.body + b'corrupt' if self.corrupt else self.body
        source = io.BytesIO(body)
        return SimpleNamespace(content_length=len(body), read=source.read)


def test_upload_private_no_overwrite_verified(archive, tmp_path):
    path, checksum = archive
    client = MemoryClient()
    receipt = tmp_path / 'receipt.json'
    assert cloud.upload(client, 'private', 'synthetic-bucket', path, receipt)['upload_and_download_verified']
    assert client.puts == 1
    assert client.arguments['acl'] == 'private'
    assert client.arguments['forbid_overwrite'] is True
    assert json.loads(receipt.read_text())['state'] == 'verified'
    with pytest.raises(ValueError):
        cloud.upload(client, 'private', 'synthetic-bucket', path, receipt)
    assert client.puts == 1


@pytest.mark.parametrize('fault', ['unknown', 'corrupt'])
def test_unknown_upload_keeps_attempt_no_retry(archive, tmp_path, fault):
    path, checksum = archive
    client = MemoryClient(fail=fault == 'unknown', corrupt=fault == 'corrupt')
    receipt = tmp_path / 'receipt.json'
    with pytest.raises((ValueError, RuntimeError)):
        cloud.upload(client, 'private', 'synthetic-bucket', path, receipt)
    assert client.puts == 1
    assert json.loads(receipt.read_text())['state'] == 'attempted'
    with pytest.raises(ValueError):
        cloud.upload(client, 'private', 'synthetic-bucket', path, receipt)
    assert client.puts == 1


def test_arbitrary_file_cannot_be_uploaded(tmp_path):
    path = tmp_path / 'not-a-snapshot'
    path.write_text('synthetic configuration')
    client = MemoryClient()
    with pytest.raises(tarfile.ReadError):
        cloud.upload(client, 'private', 'synthetic-bucket', path, tmp_path / 'receipt.json')
    assert client.puts == 0


def test_download_known_hash_size_and_no_overwrite(archive, tmp_path):
    path, checksum = archive
    client = MemoryClient()
    client.body = path.read_bytes()
    target = tmp_path / 'downloaded.tar'
    key = cloud.PREFIX + 'a' * 32 + '.tar'
    assert cloud.download(client, 'synthetic-bucket', key, checksum, target)['download_verified']
    with pytest.raises(ValueError):
        cloud.download(client, 'synthetic-bucket', key, checksum, target)
    with pytest.raises(ValueError):
        cloud.download(client, 'synthetic-bucket', '../other', checksum, tmp_path / 'new.tar')
