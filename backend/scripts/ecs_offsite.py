"""Explicitly authorized, bounded scheduled transfer of verified local archives."""
from __future__ import annotations

import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time

from scripts import ecs_cloud_backup as cloud
from scripts import ecs_maintenance as local
from scripts import ecs_runtime as runtime
from scripts.check_full_flow_recovery import load_snapshot

AUTHORIZATION = Path('/etc/ai-companion/cloud-schedule.json')
LEDGER = 'cloud-schedule.db'
MAX_CALLS_PER_ATTEMPT = 4


def money(value) -> Decimal:
    if not isinstance(value, str):
        raise ValueError('invalid_money')
    try:
        result = Decimal(value)
        if not result.is_finite() or not 0 < result <= 1000 or result.as_tuple().exponent < -6:
            raise ValueError('invalid_money')
        return result
    except InvalidOperation:
        raise ValueError('invalid_money') from None


def authorization(path: Path, env: dict, now: int) -> tuple[dict, str]:
    if env.get('CLOUD_SCHEDULE_ENABLED') != 'true':
        raise ValueError('cloud_schedule_disabled')
    path = runtime.safe_path(path)
    if not path.is_file() or path.stat().st_mode & 0o077 or path.stat().st_size > 8192:
        raise ValueError('private_authorization_required')
    raw = path.read_bytes()
    grant = json.loads(raw)
    if (not isinstance(grant, dict) or grant.get('schema_version') != 1
            or grant.get('project') != 'AI万物伙伴' or grant.get('approved') is not True
            or not isinstance(grant.get('approval_ref'), str) or not grant['approval_ref'].strip()
            or grant['approval_ref'] != env.get('CLOUD_BACKUP_AUTHORIZATION_REF')
            or grant.get('region') != 'cn-beijing' or grant.get('bucket') != env.get('TOS_BUCKET')
            or env.get('TOS_REGION') != 'cn-beijing'
            or env.get('TOS_BACKUP_ENABLED') != 'true'
            or env.get('TOS_ENDPOINT') != 'https://tos-cn-beijing.volces.com'
            or not env.get('TOS_ACCESS_KEY_ID') or not env.get('TOS_SECRET_ACCESS_KEY')
            or not re.fullmatch(r'[a-z0-9][a-z0-9-]{1,61}[a-z0-9]', grant.get('bucket', ''))):
        raise ValueError('approval_or_cloud_inputs_invalid')
    for name in ('issued_at', 'expires_at', 'max_uploads', 'max_total_archive_bytes', 'max_archive_bytes'):
        if type(grant.get(name)) is not int:
            raise ValueError('invalid_grant_bounds')
    if (not 0 < grant['issued_at'] <= now < grant['expires_at']
            or grant['expires_at'] - grant['issued_at'] > 31 * 86400
            or not 1 <= grant['max_uploads'] <= 31
            or not 1 <= grant['max_archive_bytes'] <= cloud.MAX_BYTES
            or not grant['max_archive_bytes'] <= grant['max_total_archive_bytes'] <= 31 * cloud.MAX_BYTES):
        raise ValueError('expired_or_invalid_grant_bounds')
    for name in ('cost_basis_ref', 'retention_review_ref'):
        if not isinstance(grant.get(name), str) or not grant[name].strip() or len(grant[name]) > 200:
            raise ValueError('cost_and_retention_review_required')
    if money(grant.get('unit_reserved_cny')) > money(grant.get('budget_cny')):
        raise ValueError('insufficient_budget')
    return grant, hashlib.sha256(raw).hexdigest()


def connect(root: Path) -> sqlite3.Connection:
    path = runtime.safe_path(root / LEDGER)
    if not path.exists():
        with path.open('x'):
            os.chmod(path, 0o600)
    if path.stat().st_mode & 0o077:
        raise ValueError('private_ledger_required')
    db = sqlite3.connect(path, timeout=5)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA synchronous=FULL')
    db.execute('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), grant_sha256 TEXT NOT NULL)')
    db.execute("""CREATE TABLE IF NOT EXISTS attempts (
        run_id TEXT PRIMARY KEY, archive_sha256 TEXT NOT NULL, archive_bytes INTEGER NOT NULL,
        reserved_cny TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('attempted','unknown','verified')),
        sdk_calls INTEGER NOT NULL DEFAULT 0 CHECK(sdk_calls BETWEEN 0 AND 4),
        started_at INTEGER NOT NULL, finished_at INTEGER)""")
    db.commit()
    return db


def latest_archive(root: Path, now: int) -> tuple[dict, Path]:
    records = local.runs(root)
    latest = max(records, key=lambda r: (r['started_at'], r.get('finished_at', 0),
                                        r['state'] != 'verified'), default=None)
    if (latest is None or latest['state'] != 'verified'
            or not 0 <= now - latest['finished_at'] <= 24 * 3600):
        raise ValueError('fresh_verified_backup_required')
    directory = runtime.safe_path(root / latest['run_id'])
    load_snapshot(directory / 'snapshot', 'app.db', True)
    archive = runtime.safe_path(directory / 'snapshot.tar')
    if (not archive.is_file() or not 0 < archive.stat().st_size <= cloud.MAX_BYTES
            or cloud.digest(archive) != latest.get('archive_sha256')):
        raise ValueError('archive_changed')
    return latest, archive


class MeteredClient:
    def __init__(self, client, db, run_id):
        self.client, self.db, self.run_id = client, db, run_id

    def __getattr__(self, name):
        if name not in ('get_bucket_acl', 'get_bucket_policy', 'put_object', 'get_object'):
            raise AttributeError(name)
        def request(*args, **kwargs):
            with self.db:
                row = self.db.execute('SELECT sdk_calls,state FROM attempts WHERE run_id=?', (self.run_id,)).fetchone()
                if row is None or row['state'] != 'attempted' or row['sdk_calls'] >= MAX_CALLS_PER_ATTEMPT:
                    raise ValueError('cloud_request_limit_reached')
                self.db.execute('UPDATE attempts SET sdk_calls=sdk_calls+1 WHERE run_id=?', (self.run_id,))
            return getattr(self.client, name)(*args, **kwargs)
        return request


def dispatch(root: Path, grant_path: Path, env: dict, *, now: int | None = None) -> dict:
    now = int(time.time()) if now is None else now
    grant, fingerprint = authorization(grant_path, env, now)
    root = local.private_directory(root)
    with local.exclusive(root, '.cloud-schedule.lock'), local.exclusive(root, '.backup.lock'):
        run, archive = latest_archive(root, now)
        size = archive.stat().st_size
        if size > grant['max_archive_bytes']:
            raise ValueError('single_archive_limit')
        db = connect(root)
        client = None
        try:
            with db:
                existing = db.execute('SELECT grant_sha256 FROM metadata WHERE id=1').fetchone()
                if existing and existing['grant_sha256'] != fingerprint:
                    raise ValueError('grant_changed_do_not_reset_ledger')
                if not existing:
                    db.execute('INSERT INTO metadata VALUES(1,?)', (fingerprint,))
                attempts = list(db.execute('SELECT * FROM attempts'))
                if any(r['state'] != 'verified' for r in attempts):
                    raise ValueError('unknown_attempt_requires_operator_review')
                same = next((r for r in attempts if r['run_id'] == run['run_id']), None)
                if same:
                    if same['archive_sha256'] != run['archive_sha256']:
                        raise ValueError('same_run_archive_changed')
                    return {'state': 'verified', 'reused': True, 'new_cloud_requests': 0}
                reserved = sum((Decimal(r['reserved_cny']) for r in attempts), Decimal('0'))
                if (len(attempts) >= grant['max_uploads']
                        or sum(r['archive_bytes'] for r in attempts) + size > grant['max_total_archive_bytes']
                        or reserved + money(grant['unit_reserved_cny']) > money(grant['budget_cny'])):
                    raise ValueError('cloud_grant_exhausted')
                # Full conservative cost, bytes and one attempt committed before SDK initialization.
                db.execute('INSERT INTO attempts VALUES(?,?,?,?,?,0,?,NULL)',
                           (run['run_id'], run['archive_sha256'], size, grant['unit_reserved_cny'], 'attempted', now))
            try:
                client, acl = cloud.cloud_client(env, grant['approval_ref'])
                if archive.stat().st_size != size or cloud.digest(archive) != run['archive_sha256']:
                    raise ValueError('archive_changed_before_cloud')
                metered = MeteredClient(client, db, run['run_id'])
                cloud.private_bucket(metered, grant['bucket'])
                if archive.stat().st_size != size or cloud.digest(archive) != run['archive_sha256']:
                    raise ValueError('archive_changed_before_upload')
                receipt = root / run['run_id'] / 'cloud-transfer.json'
                result = cloud.upload(metered, acl, grant['bucket'], archive, receipt)
                if (result.get('upload_and_download_verified') is not True
                        or result.get('archive_sha256') != run['archive_sha256']):
                    raise ValueError('transfer_not_verified')
                with db:
                    db.execute("UPDATE attempts SET state='verified',finished_at=? WHERE run_id=?", (now, run['run_id']))
            except Exception:
                with db:
                    db.execute("UPDATE attempts SET state='unknown',finished_at=? WHERE run_id=?", (now, run['run_id']))
            row = db.execute('SELECT state,sdk_calls FROM attempts WHERE run_id=?', (run['run_id'],)).fetchone()
            return {'state': row['state'], 'reused': False, 'sdk_calls': row['sdk_calls'],
                    'reserved_cny': grant['unit_reserved_cny'], 'automatic_retries': 0,
                    'actual_bill_verified': False}
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    pass
            db.close()


def status(root: Path) -> dict:
    root = local.private_directory(root)
    path = runtime.safe_path(root / LEDGER)
    if not path.exists():
        return {'state': 'not_started', 'attempts': 0, 'reserved_cny': '0', 'new_cloud_requests': 0}
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        db.row_factory = sqlite3.Row
        rows = list(db.execute('SELECT state,reserved_cny,sdk_calls FROM attempts'))
    if not rows:
        return {'state': 'not_started', 'attempts': 0, 'reserved_cny': '0', 'new_cloud_requests': 0}
    return {'state': 'blocked_unknown' if any(r['state'] != 'verified' for r in rows) else 'verified',
            'attempts': len(rows), 'verified': sum(r['state'] == 'verified' for r in rows),
            'sdk_calls': sum(r['sdk_calls'] for r in rows),
            'reserved_cny': str(sum((Decimal(r['reserved_cny']) for r in rows), Decimal('0'))),
            'new_cloud_requests': 0, 'actual_bill_verified': False}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('dispatch', 'status'))
    args = parser.parse_args()
    try:
        if args.mode == 'status':
            result = status(local.BACKUPS)
        else:
            if os.environ.get('CLOUD_SCHEDULE_ENABLED') != 'true':
                raise ValueError('disabled')
            runtime.mounted_volume(runtime.DATA_ROOT, os.environ.get('DATA_VOLUME_ID', ''))
            result = dispatch(local.BACKUPS, AUTHORIZATION, dict(os.environ))
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result['state'] in ('verified', 'not_started') else 1
    except Exception:
        print(json.dumps({'error': {'code': 'scheduled_offsite_backup_blocked',
                                   'message': '异地备份未执行或已停批；核对独立授权、最新快照和持久账，勿重置或自动重传。'}},
                         ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
