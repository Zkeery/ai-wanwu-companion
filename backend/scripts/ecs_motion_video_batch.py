"""Explicit ECS video batch: frozen source, pre-reserved cost, no generation retries.

This is an operator entrypoint, never a public route or a background consumer.
Generation produces private candidates only. Binding needs a separate review.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
ENDPOINT = 'https://maas-api.antdigital.com/api/v1/services/aigc/video-generation/video-synthesis'
TASKS = 'https://maas-api.antdigital.com/api/v1/tasks'
MODEL = 'wan3.0-video-prime'
ACTIVITIES = ('walk', 'rest', 'observe')


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def save_private(path: Path, value: dict) -> None:
    temporary = path.with_suffix('.tmp')
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as out:
        json.dump(value, out)
        out.flush(); os.fsync(out.fileno())
    temporary.replace(path)


def validate(plan: dict) -> None:
    if (plan.get('model') != MODEL or plan.get('endpoint') != ENDPOINT or plan.get('task_endpoint') != TASKS
            or plan.get('requests_max') != 3 or plan.get('automatic_retries') != 0
            or Decimal(str(plan.get('cap_cny'))) != Decimal('7')
            or Decimal(str(plan.get('price_cny_per_second'))) != Decimal('0.45')
            or plan.get('price_verified_on') != datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
            or [x.get('activity') for x in plan.get('activities', [])] != list(ACTIVITIES)
            or not re.fullmatch(r'[a-f0-9]{64}', plan.get('source_sha256', ''))):
        raise ValueError('frozen_plan_invalid')
    for item in plan['activities']:
        if (item.get('parameters') != {'resolution': '480P', 'ratio': '1:1', 'duration': 5, 'generate_audio': False}
                or not isinstance(item.get('prompt'), str)
                or digest(item['prompt'].encode()) != item.get('prompt_sha256')):
            raise ValueError('frozen_request_invalid')


class Batch:
    def __init__(self, plan_file: Path, approval_file: Path, root: Path):
        raw = plan_file.read_bytes(); self.plan = json.loads(raw); validate(self.plan)
        self.approval = json.loads(approval_file.read_bytes())
        if (self.approval.get('confirmed') is not True or self.approval.get('cap_cny') != 7
                or self.approval.get('requests_max') != 3 or self.approval.get('automatic_retries') != 0
                or self.approval.get('activities') != list(ACTIVITIES)
                or self.approval.get('plan_sha256') != digest(raw)
                or self.approval.get('source_sha256') != self.plan['source_sha256']):
            raise ValueError('current_batch_not_authorized')
        self.root = root
        if root.is_symlink(): raise ValueError('unsafe_work_directory')
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path = root / 'budget.db'
        if self.path.is_symlink(): raise ValueError('unsafe_ledger')
        with self.db() as db:
            db.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS calls (activity TEXT PRIMARY KEY, state TEXT NOT NULL, '
                       'reserved_micro INTEGER NOT NULL, task_id TEXT, quota_id TEXT, started REAL NOT NULL, updated REAL NOT NULL)')
            known = dict(db.execute('SELECT key,value FROM meta'))
            if known and (known.get('plan') != digest(raw) or known.get('approval') != digest(approval_file.read_bytes())):
                raise ValueError('ledger_belongs_to_another_grant')
            db.execute('INSERT OR IGNORE INTO meta VALUES (?,?)', ('plan', digest(raw)))
            db.execute('INSERT OR IGNORE INTO meta VALUES (?,?)', ('approval', digest(approval_file.read_bytes())))
        os.chmod(self.path, 0o600)

    def db(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row; db.execute('PRAGMA synchronous=FULL')
        return db

    def status(self):
        with self.db() as db:
            rows = [dict(x) for x in db.execute('SELECT * FROM calls ORDER BY started')]
            stopped = db.execute("SELECT value FROM meta WHERE key='stopped'").fetchone()
        return {'calls': rows, 'reserved_cny': sum(x['reserved_micro'] for x in rows) / 1_000_000,
                'cap_cny': 7, 'stopped': stopped[0] if stopped else None,
                'actual_bill_verified': False, 'automatic_retries': 0}

    def stop(self, reason):
        with self.db() as db:
            db.execute("INSERT OR IGNORE INTO meta VALUES ('stopped',?)", (reason,))

    def update(self, activity, state, task_id=None, quota_id=None):
        with self.db() as db:
            db.execute('UPDATE calls SET state=?,task_id=coalesce(?,task_id),quota_id=coalesce(?,quota_id),updated=? WHERE activity=?',
                       (state, task_id, quota_id, time.time(), activity))

    def source(self):
        path = Path(self.plan['source_file'])
        if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 10 * 1024 * 1024:
            raise ValueError('source_invalid')
        raw = path.read_bytes()
        if digest(raw) != self.plan['source_sha256'] or raw[:8] != b'\x89PNG\r\n\x1a\n':
            raise ValueError('source_changed')
        return raw

    def submit(self, activity, key, client, quota):
        validate(self.plan); raw = self.source()
        if activity not in ACTIVITIES or not key: raise ValueError('submission_invalid')
        with self.db() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM meta WHERE key='stopped'").fetchone(): raise ValueError('batch_stopped')
            rows = db.execute('SELECT activity,state,reserved_micro FROM calls').fetchall()
            index = len(rows)
            if (index >= 3 or activity != ACTIVITIES[index] or any(x['state'] != 'downloaded' for x in rows)
                    or sum(x['reserved_micro'] for x in rows) + 2_250_000 > 7_000_000):
                raise ValueError('generation_replay_or_out_of_order')
            now = time.time()
            db.execute('INSERT INTO calls VALUES (?,?,?,NULL,NULL,?,?)', (activity, 'submitting', 2_250_000, now, now))
        # Both ledgers are durable before sending; a crash or unknown response never grants a retry.
        attempt = None
        try:
            attempt = quota.reserve(); self.update(activity, 'submitting', quota_id=attempt)
            item = self.plan['activities'][index]
            body = {'model': MODEL, 'input': {'prompt': item['prompt'], 'media': [
                {'type': 'first_frame', 'url': 'data:image/png;base64,' + base64.b64encode(raw).decode()}]},
                'parameters': item['parameters']}
            response = client.post(ENDPOINT, json=body, headers={'Authorization': 'Bearer ' + key, 'X-DashScope-Async': 'enable'})
            quota.finish(attempt, response.status_code)
            if response.status_code not in (200, 201, 202):
                self.update(activity, 'rejected'); self.stop('generation_http_' + str(response.status_code)); return self.status()
            result = response.json(); task_id = result.get('output', {}).get('task_id')
            if not isinstance(task_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', task_id):
                raise ValueError('task_receipt_invalid')
            save_private(self.root / (activity + '-submit-private.json'), result)
            self.update(activity, 'queued', task_id=task_id)
        except Exception:
            if attempt: quota.finish(attempt, None)
            self.update(activity, 'unknown'); self.stop('generation_outcome_unknown')
        return self.status()

    def poll(self, activity, key, client):
        with self.db() as db: row = db.execute('SELECT * FROM calls WHERE activity=?', (activity,)).fetchone()
        if row is None or row['state'] not in ('queued', 'running', 'succeeded') or not row['task_id']:
            raise ValueError('no_pollable_task')
        response = client.get(TASKS + '/' + row['task_id'], headers={'Authorization': 'Bearer ' + key})
        if response.status_code != 200: raise ValueError('task_query_failed')
        result = response.json(); output = result.get('output', {})
        if output.get('task_id') != row['task_id']: raise ValueError('task_identity_changed')
        state = output.get('task_status')
        states = {'PENDING': 'queued', 'RUNNING': 'running', 'SUCCEEDED': 'succeeded',
                  'FAILED': 'failed', 'CANCELED': 'cancelled', 'CANCELLED': 'cancelled', 'UNKNOWN': 'unknown'}
        if state not in states: raise ValueError('task_status_invalid')
        save_private(self.root / (activity + '-result-private.json'), result)
        self.update(activity, states[state])
        if states[state] in ('failed', 'cancelled', 'unknown'): self.stop('provider_' + states[state])
        return states[state]

    def download(self, activity, client):
        with self.db() as db: row = db.execute('SELECT * FROM calls WHERE activity=?', (activity,)).fetchone()
        if row is None or row['state'] != 'succeeded': raise ValueError('video_not_ready')
        result = json.loads((self.root / (activity + '-result-private.json')).read_bytes())
        url = result.get('output', {}).get('video_url'); parsed = urlsplit(url) if isinstance(url, str) else None
        if (not parsed or parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port not in (None, 443)
                or not parsed.hostname or not any(parsed.hostname.endswith('.' + host) for host in ('aliyuncs.com', 'zkobjects.com'))):
            self.stop('video_download_origin_unverified'); raise ValueError('video_url_invalid')
        target = self.root / (activity + '-candidate.mp4')
        if target.exists(): raise ValueError('candidate_already_exists')
        temporary = target.with_suffix('.part')
        try:
            with client.stream('GET', url) as response:
                if response.status_code != 200: raise ValueError('video_download_failed')
                size = 0
                with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as out:
                    for chunk in response.iter_bytes():
                        size += len(chunk)
                        if size > 10 * 1024 * 1024: raise ValueError('video_too_large')
                        out.write(chunk)
                    out.flush(); os.fsync(out.fileno())
            data = temporary.read_bytes()
            if len(data) < 12 or data[4:8] != b'ftyp': raise ValueError('video_format_invalid')
            temporary.rename(target)
            self.update(activity, 'downloaded')
            return {'activity': activity, 'bytes': len(data), 'sha256': digest(data), 'state': 'needs_review'}
        except Exception:
            temporary.unlink(missing_ok=True); self.stop('candidate_download_failed'); raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--plan', required=True, type=Path)
    parser.add_argument('--approval', type=Path)
    parser.add_argument('--work', type=Path)
    parser.add_argument('--submit', choices=ACTIVITIES)
    parser.add_argument('--poll', choices=ACTIVITIES)
    parser.add_argument('--download', choices=ACTIVITIES)
    args = parser.parse_args()
    try:
        plan = json.loads(args.plan.read_bytes()); validate(plan)
        if not any((args.submit, args.poll, args.download)):
            print(json.dumps({'state': 'validated', 'network_calls': 0, 'max_generation_posts': 3,
                              'expected_cny': 6.75, 'cap_cny': 7, 'model': MODEL})); return 0
        if sum(bool(x) for x in (args.submit, args.poll, args.download)) != 1 or not args.approval or not args.work:
            raise ValueError('choose_one_explicit_action')
        batch = Batch(args.plan, args.approval, args.work)
        from app.core.config import get_settings
        from app.core.database import SessionLocal
        from app.services.motion_bindings import owned_character, source_digest
        from app.services.daily_model_quota import DailyModelQuota
        settings = get_settings()
        with SessionLocal() as db:
            ch = owned_character(db, plan['character_id'], plan['owner_id'])
            if (Path(settings.upload_dir) / ch.image_path).resolve() != Path(plan['source_file']).resolve() or source_digest(ch) != plan['source_sha256']:
                raise ValueError('current_partner_changed')
        quota = DailyModelQuota(Path(os.environ['PARTNER_DAILY_QUOTA_DB']), int(os.environ['PARTNER_DAILY_REQUEST_LIMIT']))
        with httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False,
                          transport=httpx.HTTPTransport(retries=0), trust_env=False) as client:
            result = (batch.submit(args.submit, settings.model_api_key, client, quota) if args.submit else
                      batch.poll(args.poll, settings.model_api_key, client) if args.poll else batch.download(args.download, client))
        print(json.dumps(result)); return 0
    except Exception as exc:
        print(json.dumps({'state': 'stopped', 'error_type': type(exc).__name__, 'automatic_retry': False})); return 1


if __name__ == '__main__':
    raise SystemExit(main())
