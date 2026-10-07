"""Bounded, private Beijing TOS transfer of complete verified snapshots.

Offline archive operations are separate from explicitly authorized cloud I/O.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import tarfile
from uuid import uuid4

from scripts.ecs_runtime import safe_path
from scripts.check_full_flow_recovery import load_snapshot

MAX_BYTES = 1024 ** 3
PREFIX = 'ai-companion-backups/'


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def inventory(manifest: dict) -> set[str]:
    names = {'app.db', 'manifest.json'}
    names.update('uploads/' + name for name in manifest['files'])
    state = manifest['runtime_state']
    names.update('ledger/' + name for name in (state['ledger'] or {}))
    names.update(state['state_files'])
    for name in names:
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name or str(path) != name:
            raise ValueError('unsafe_manifest_path')
    return names


def pack(snapshot: Path, archive: Path) -> dict:
    snapshot, archive = safe_path(snapshot), safe_path(archive)
    if archive.exists() or archive.is_relative_to(snapshot) or not archive.parent.is_dir():
        raise ValueError('new_archive_required')
    manifest, _ = load_snapshot(snapshot, 'app.db', True)
    names = inventory(manifest)
    total = sum((snapshot / name).stat().st_size for name in names)
    if total > MAX_BYTES - 1024 * 1024:
        raise ValueError('archive_too_large')
    with archive.open('xb') as output:
        os.chmod(archive, 0o600)
        with tarfile.open(fileobj=output, mode='w') as tar:
            for name in sorted(names):
                item = safe_path(snapshot / name)
                if not item.is_file() or not item.is_relative_to(snapshot):
                    raise ValueError('unsafe_snapshot')
                info = tar.gettarinfo(str(item), arcname=name)
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mode = 0o600
                with item.open('rb') as data:
                    tar.addfile(info, data)
    load_snapshot(snapshot, 'app.db', True)
    if archive.stat().st_size > MAX_BYTES:
        raise ValueError('archive_too_large')
    return {'archive_sha256': digest(archive), 'members': len(names), 'cloud_requests': 0}


def unpack(archive: Path, expected_sha256: str, target: Path) -> dict:
    archive, target = safe_path(archive), safe_path(target)
    if (not re.fullmatch(r'[0-9a-f]{64}', expected_sha256)
            or archive.stat().st_size > MAX_BYTES or digest(archive) != expected_sha256
            or target.exists() or not target.parent.is_dir()):
        raise ValueError('archive_or_target_invalid')
    with tarfile.open(archive, 'r:') as tar:
        members = []
        seen = set()
        total = 0
        for member in tar:
            if len(members) >= 100000:
                raise ValueError('too_many_archive_members')
            name = PurePosixPath(member.name)
            total += member.size
            if (not member.isfile() or member.name in seen or name.is_absolute() or '..' in name.parts
                    or '\\' in member.name or str(name) != member.name or total > MAX_BYTES):
                raise ValueError('unsafe_archive')
            seen.add(member.name)
            members.append(member)
        if 'manifest.json' not in seen:
            raise ValueError('manifest_missing')
        info = tar.getmember('manifest.json')
        if info.size > 8 * 1024 * 1024:
            raise ValueError('manifest_too_large')
        stream = tar.extractfile(info)
        manifest = json.load(stream)
        if seen != inventory(manifest):
            raise ValueError('unexpected_archive_members')
        target.mkdir(mode=0o700)
        (target / 'uploads').mkdir(mode=0o700)
        if manifest['runtime_state']['ledger'] is not None:
            (target / 'ledger').mkdir(mode=0o700)
        for member in members:
            output = target / member.name
            output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            data = tar.extractfile(member)
            with output.open('xb') as destination:
                os.chmod(output, 0o600)
                for block in iter(lambda: data.read(1024 * 1024), b''):
                    destination.write(block)
    load_snapshot(target, 'app.db', True)
    return {'unpacked_snapshot_verified': True, 'members': len(seen), 'cloud_requests': 0}


def cloud_client(env: dict, reference: str):
    if (env.get('TOS_BACKUP_ENABLED') != 'true' or not reference.strip()
            or env.get('CLOUD_BACKUP_AUTHORIZATION_REF') != reference
            or env.get('TOS_REGION') != 'cn-beijing'
            or env.get('TOS_ENDPOINT') != 'https://tos-cn-beijing.volces.com'
            or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', env.get('TOS_BUCKET', ''))
            or not env.get('TOS_ACCESS_KEY_ID') or not env.get('TOS_SECRET_ACCESS_KEY')):
        raise ValueError('cloud_backup_not_authorized_or_configured')
    # This is a maintenance process; no SDK debug or raw HTTP logging is allowed.
    logging.disable(logging.CRITICAL)
    import tos
    client = tos.TosClientV2(env['TOS_ACCESS_KEY_ID'], env['TOS_SECRET_ACCESS_KEY'],
                             env['TOS_ENDPOINT'], env['TOS_REGION'], max_retry_count=0,
                             connection_time=10, socket_timeout=30, max_connections=2,
                             enable_verify_ssl=True)
    return client, tos.ACLType.ACL_Private


def private_bucket(client, bucket: str) -> None:
    acl = client.get_bucket_acl(bucket)
    if not acl.owner or not acl.owner.id or not acl.grants or any(
            getattr(grant.grantee.type, 'value', grant.grantee.type) != 'CanonicalUser'
            or grant.grantee.id != acl.owner.id for grant in acl.grants):
        raise ValueError('bucket_must_be_owner_only')
    try:
        policy = client.get_bucket_policy(bucket)
    except Exception as error:
        if getattr(error, 'status_code', None) == 404 and getattr(error, 'code', '') == 'NoSuchBucketPolicy':
            return
        raise ValueError('bucket_policy_not_verified') from None
    # Strict candidate: no bucket policy. IAM grants are managed separately.
    if getattr(policy, 'policy', '').strip() not in ('', '{}'):
        raise ValueError('bucket_policy_not_allowed')


def download(client, bucket: str, key: str, expected_sha256: str, target: Path) -> dict:
    target = safe_path(target)
    if (not re.fullmatch(re.escape(PREFIX) + r'[0-9a-f]{32}\.tar', key)
            or not re.fullmatch(r'[0-9a-f]{64}', expected_sha256)
            or target.exists() or not target.parent.is_dir()):
        raise ValueError('download_target_invalid')
    result = client.get_object(bucket, key)
    if type(result.content_length) is not int or not 0 < result.content_length <= MAX_BYTES:
        raise ValueError('download_too_large')
    total = 0
    with target.open('xb') as out:
        os.chmod(target, 0o600)
        for block in iter(lambda: result.read(1024 * 1024), b''):
            total += len(block)
            if total > MAX_BYTES or total > result.content_length:
                raise ValueError('download_too_large')
            out.write(block)
    if total != result.content_length or digest(target) != expected_sha256:
        raise ValueError('download_checksum_failed')
    return {'download_verified': True, 'archive_sha256': expected_sha256, 'bytes': total}


def upload(client, private_acl, bucket: str, archive: Path, receipt: Path) -> dict:
    archive, receipt = safe_path(archive), safe_path(receipt)
    if not 0 < archive.stat().st_size <= MAX_BYTES or receipt.exists() or not receipt.parent.is_dir():
        raise ValueError('upload_or_receipt_invalid')
    checksum = digest(archive)
    validation = receipt.with_name(receipt.name + '.validation')
    unpack(archive, checksum, validation)
    shutil.rmtree(validation)
    # Exclusive durable intent is saved BEFORE the first put; interruption is unknown.
    record = {'state': 'attempted', 'key': PREFIX + uuid4().hex + '.tar',
              'archive_sha256': checksum, 'automatic_retries': 0, 'bucket': bucket}
    with receipt.open('x', encoding='utf8') as out:
        os.chmod(receipt, 0o600)
        json.dump(record, out)
        out.flush()
        os.fsync(out.fileno())
    with archive.open('rb') as source:
        client.put_object(bucket, record['key'], content=source, content_length=archive.stat().st_size,
                          content_type='application/x-tar', acl=private_acl, forbid_overwrite=True,
                          content_sha256=checksum, cache_control='private, no-store')
    # A successful PUT alone is insufficient; reread into an exclusive local artifact.
    verification = receipt.with_name(receipt.name + '.download')
    verified = download(client, bucket, record['key'], checksum, verification)
    record.update(state='verified', bytes=verified['bytes'])
    temporary = receipt.with_name(receipt.name + '.verified')
    with temporary.open('x', encoding='utf8') as out:
        os.chmod(temporary, 0o600)
        json.dump(record, out)
        out.flush()
        os.fsync(out.fileno())
    temporary.replace(receipt)
    verification.unlink()
    return {'upload_and_download_verified': True, 'archive_sha256': checksum, 'automatic_retries': 0}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    package = sub.add_parser('pack')
    package.add_argument('--snapshot', required=True, type=Path)
    package.add_argument('--archive', required=True, type=Path)
    extract = sub.add_parser('unpack')
    extract.add_argument('--archive', required=True, type=Path)
    extract.add_argument('--sha256', required=True)
    extract.add_argument('--target', required=True, type=Path)
    push = sub.add_parser('upload')
    push.add_argument('--archive', required=True, type=Path)
    push.add_argument('--receipt', required=True, type=Path)
    pull = sub.add_parser('download')
    pull.add_argument('--key', required=True)
    pull.add_argument('--sha256', required=True)
    pull.add_argument('--target', required=True, type=Path)
    for command in (push, pull):
        command.add_argument('--approval-ref', required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'pack':
            result = pack(args.snapshot, args.archive)
        elif args.mode == 'unpack':
            result = unpack(args.archive, args.sha256, args.target)
        else:
            client, acl = cloud_client(dict(os.environ), args.approval_ref)
            try:
                bucket = os.environ['TOS_BUCKET']
                private_bucket(client, bucket)
                result = upload(client, acl, bucket, args.archive, args.receipt) if args.mode == 'upload' else download(
                    client, bucket, args.key, args.sha256, args.target)
            finally:
                client.close()
        print(json.dumps(result))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'ecs_cloud_backup_failed',
                                   'message': '云备份未通过；检查独立授权、私有桶、完整快照和未知尝试回执。'}}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
