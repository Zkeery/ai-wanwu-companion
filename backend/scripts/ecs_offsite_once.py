"""One authorized Beijing TOS copy; no capture, overwrite, deletion or retry."""
from __future__ import annotations

import argparse
from decimal import Decimal
import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import time
from uuid import uuid4

from scripts.ecs_backup_once import load_engine
from scripts import ecs_offsite_costs as costs

MAX_BYTES = 128 * 1024 * 1024
MAX_TOTAL = 7 * MAX_BYTES
ENGINE_SHA = '2a35a3de60d11f009c23aaabab6cc967000ec31a489ae3c923c4e19051f1417b'
PREFIX = 'wanwu-partner-offsite/'


def private_bucket(client, bucket: str) -> None:
    # Keep this adapter independent of legacy archive formats and application imports.
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
    if getattr(policy, 'policy', '').strip() not in ('', '{}'):
        raise ValueError('bucket_policy_not_allowed')


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path: Path, data: dict, *, exclusive: bool = False) -> None:
    target = path if exclusive else path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    with target.open('x', encoding='utf8') as stream:
        target.chmod(0o600)
        json.dump(data, stream, ensure_ascii=False, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    if not exclusive:
        target.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_dir(path: Path) -> None:
    if path.is_symlink():
        raise ValueError('unsafe_directory')
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.stat().st_mode & 0o077:
        raise ValueError('directory_not_private')


def authorize(config: dict, now: int) -> None:
    if (config.get('enabled') is not True or config.get('approved') is not True
            or not config.get('approval_ref') or config.get('expires_at', 0) <= now
            or config.get('region') != 'cn-beijing'
            or config.get('endpoint') != 'https://tos-cn-beijing.volces.com'
            or not re.fullmatch(r'wanwu-partner-[a-z0-9-]{3,45}', config.get('bucket', ''))
            or config.get('max_uploads') != 7
            or config.get('max_bytes') != MAX_BYTES
            or config.get('max_total_bytes') != MAX_TOTAL
            or config.get('budget_cny') != '1.00'
            or config.get('reserve_cny_per_attempt') != '0.14'
            or config.get('cost_reference_verified') is not True
            or config.get('retention_reviewed') is not True):
        raise ValueError('offsite_not_authorized')


def client_factory(config: dict, credentials: dict):
    if not credentials.get('access_key_id') or not credentials.get('secret_access_key'):
        raise ValueError('offsite_credentials_missing')
    logging.disable(logging.CRITICAL)
    import tos
    from importlib.metadata import version
    if version('tos') != '2.9.3':
        raise ValueError('unexpected_tos_sdk_version')
    return tos.TosClientV2(
        credentials['access_key_id'], credentials['secret_access_key'],
        config['endpoint'], config['region'],
        security_token=credentials.get('security_token'), max_retry_count=0,
        connection_time=10, socket_timeout=30, max_connections=2,
        enable_verify_ssl=True,
    ), tos.ACLType.ACL_Private


def newest(root: Path, now: int) -> tuple[Path, dict]:
    candidates = []
    for folder in (root / 'backups/scheduled').glob('run-*'):
        if not re.fullmatch(r'run-[0-9a-f]{32}', folder.name) or folder.is_symlink():
            continue
        receipt = folder / 'scheduled-result.json'
        if not receipt.is_file() or receipt.is_symlink():
            continue
        data = json.loads(receipt.read_text())
        if data.get('state') == 'verified' and data.get('restore_verified') is True:
            candidates.append((receipt.stat().st_mtime, folder, data))
    if not candidates:
        raise ValueError('verified_snapshot_missing')
    stamp, folder, data = max(candidates, key=lambda x: x[0])
    if stamp > now + 120 or now - stamp > 26 * 3600:
        raise ValueError('verified_snapshot_stale')
    archive = folder / 'snapshot.tar'
    if (archive.is_symlink() or not archive.is_file()
            or not 0 < archive.stat().st_size <= MAX_BYTES
            or digest(archive) != data.get('archive_sha256')
            or data.get('engine_sha256') != ENGINE_SHA):
        raise ValueError('snapshot_integrity_failed')
    return archive, data


def copy_once(root: Path, engine, config: dict, credentials: dict, *,
              factory=client_factory, now: int | None = None) -> dict:
    fixed_now = now
    clock = lambda: int(time.time()) if fixed_now is None else fixed_now
    now = clock()
    authorize(config, now)  # No SDK initialization or cloud request before authorization.
    policy = costs.policy(root)
    if not policy['allowed']:
        return {'state': 'blocked', **policy}
    area = root / 'private/offsite-backup'
    private_dir(area)
    fd = os.open(area / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (area / 'review-required.json').exists():
            return {'state': 'blocked', 'reason': 'previous_failure_requires_review'}
        archive, source = newest(root, now)
        run_id = source['run_id']
        if run_id != archive.parent.name:
            raise ValueError('run_identity_mismatch')
        attempt = area / run_id
        if attempt.exists():
            result_path = attempt / 'result.json'
            if result_path.is_file():
                prior = json.loads(result_path.read_text())
                expected = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
                if prior.get('state') in ('verified', 'uploaded_metadata_verified') and prior.get('approval_sha256') == expected:
                    return {'state': 'already_verified', 'run_id': run_id, 'network_requests': 0}
            return {'state': 'blocked', 'reason': 'same_snapshot_already_attempted'}
        attempts = list(area.glob('run-*'))
        sizes = []
        reserved = Decimal('0')
        approval_sha = hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()
        for prior in attempts:
            intent = json.loads((prior / 'intent.json').read_text())
            if intent['approval_sha256'] != approval_sha:
                raise ValueError('approval_changed_requires_review')
            sizes.append(intent['bytes'])
            reserved += Decimal(intent['reserved_cny'])
        if len(attempts) >= 7 or sum(sizes) + archive.stat().st_size > MAX_TOTAL:
            return {'state': 'blocked', 'reason': 'offsite_retention_review_required'}
        if reserved + Decimal(config['reserve_cny_per_attempt']) > Decimal(config['budget_cny']):
            return {'state': 'blocked', 'reason': 'offsite_budget_review_required'}
        for prior in attempts:
            receipt_path = prior / 'result.json'
            if (not receipt_path.is_file() or receipt_path.is_symlink()
                    or json.loads(receipt_path.read_text()).get('state') not in ('verified', 'uploaded_metadata_verified')):
                return {'state': 'blocked', 'reason': 'previous_attempt_unknown_requires_review'}
        spending = costs.check(root, config, clock())
        if not spending['allowed']:
            return {'state': 'blocked', **spending}
        attempt.mkdir(mode=0o700)
        intent = {'state': 'attempted', 'run_id': run_id, 'attempted_at': now,
                  'bytes': archive.stat().st_size, 'archive_sha256': source['archive_sha256'],
                  'key': PREFIX + run_id.removeprefix('run-') + '.tar',
                  'bucket': config['bucket'], 'automatic_retries': 0,
                  'reserved_cny': config['reserve_cny_per_attempt'],
                  'approval_sha256': approval_sha,
                  'verification_mode': 'metadata', 'cost_control_version': 1,
                  **{k: v for k, v in spending.items() if k != 'allowed'}}
        save(attempt / 'intent.json', intent, exclusive=True)
        client = None
        try:
            before = engine.restore(archive, attempt / 'before-upload-restore', intent['archive_sha256'])
            if before.get('state') != 'restored_verified':
                raise ValueError('source_restore_failed')
            def recheck():
                authorize(config, clock())
                fresh = costs.check(root, config, clock(), own_run=run_id)
                if (not fresh['allowed'] or fresh.get('balance_evidence_sha256') != spending['balance_evidence_sha256']
                        or fresh.get('policy_sha256') != spending['policy_sha256']):
                    raise ValueError('spending_observation_changed_or_expired')
                if archive.stat().st_size != intent['bytes'] or digest(archive) != intent['archive_sha256']:
                    raise ValueError('source_archive_changed')
            recheck()
            client, private_acl = factory(config, credentials)
            private_bucket(client, config['bucket'])
            recheck()
            with archive.open('rb') as stream:
                uploaded = client.put_object(config['bucket'], intent['key'], content=stream,
                                  content_length=intent['bytes'], content_type='application/x-tar',
                                  acl=private_acl, forbid_overwrite=True,
                                  content_sha256=intent['archive_sha256'], cache_control='private, no-store',
                                  meta={'wanwu-archive-sha256': intent['archive_sha256']})
            # HEAD does not retrieve the archive body. Do not fall back to GET on
            # a missing field, provider error or unsupported metadata response.
            response = client.head_object(config['bucket'], intent['key'])
            etag = getattr(uploaded, 'etag', None)
            metadata = getattr(response, 'meta', None)
            if (type(getattr(response, 'content_length', None)) is not int
                    or response.content_length != intent['bytes']
                    or not isinstance(etag, str) or not etag
                    or getattr(response, 'etag', None) != etag
                    or not isinstance(metadata, dict)
                    or metadata.get('wanwu-archive-sha256') != intent['archive_sha256']):
                raise ValueError('remote_metadata_mismatch')
            result = {**intent, 'state': 'uploaded_metadata_verified', 'verified_at': clock(),
                      'metadata_verified': True, 'local_restore_verified': True,
                      'download_verified': False, 'independent_restore_verified': False,
                      'remote_restore_verified': False, 'full_download_bytes': 0,
                      'local_databases': before.get('databases'), 'production_overwritten': False}
            save(attempt / 'result.json', result, exclusive=True)
            save(area / 'state.json', result)
            return result
        except Exception as error:
            failure = {'state': 'failed', 'run_id': run_id, 'error_type': type(error).__name__,
                       'automatic_retries': 0, 'evidence_preserved': True}
            save(attempt / 'failure.json', failure, exclusive=True)
            save(area / 'review-required.json', failure, exclusive=True)
            return failure
        finally:
            if client is not None and callable(getattr(client, 'close', None)):
                try:
                    client.close()
                except Exception:
                    pass  # A close error must not replace the durable outcome.


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--credentials', required=True, type=Path)
    parser.add_argument('--engine', required=True, type=Path)
    parser.add_argument('--preflight-only', action='store_true',
                        help='Check local approval/spending gate without SDK, credentials or transfer')
    args = parser.parse_args()
    try:
        for path in [args.config]:
            if path.is_symlink() or path.stat().st_mode & 0o077:
                raise ValueError('private_config_required')
        config = json.loads(args.config.read_text())
        authorize(config, int(time.time()))
        gate = costs.check(args.root, config, int(time.time()))
        if args.preflight_only or not gate['allowed']:
            result = {'state': 'preflight_passed' if gate['allowed'] else 'blocked',
                      'network_requests': 0,
                      **{k: v for k, v in gate.items() if k in ('allowed', 'reason')}}
        else:
            if args.credentials.is_symlink() or args.credentials.stat().st_mode & 0o077:
                raise ValueError('private_config_required')
            engine = load_engine(args.engine, ENGINE_SHA)
            result = copy_once(args.root, engine, config, json.loads(args.credentials.read_text()))
    except Exception as error:
        result = {'state': 'blocked', 'error_type': type(error).__name__}
    # Never print SDK exception text, credentials or the archive's contents.
    print(json.dumps({k: v for k, v in result.items() if k in {
        'state', 'reason', 'error_type', 'run_id', 'download_verified',
        'independent_restore_verified', 'automatic_retries', 'network_requests', 'metadata_verified'}}))
    return 0 if result['state'] in ('uploaded_metadata_verified', 'already_verified', 'preflight_passed') else 2


if __name__ == '__main__':
    raise SystemExit(main())
