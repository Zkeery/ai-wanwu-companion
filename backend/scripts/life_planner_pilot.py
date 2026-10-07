"""C1.5: dry-run by default; real read-only planning needs explicit authorization."""
from __future__ import annotations

import argparse
import asyncio
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import time

import httpx

BACKEND = Path(__file__).resolve().parents[1]
PROJECT = BACKEND.parent
sys.path.insert(0, str(BACKEND))

from app.living import life_planning as planning
from app.living.life_planner import make_prompt, SYSTEM
from app.living import life_provider as provider
from app.living.rules import LivingError

SID = '00000000-0000-4000-8000-000000000015'
ITEM = '00000000-0000-4000-8000-000000000016'
CAP_MICRO = 4_000_000
DB = PROJECT / '.runtime' / 'c15-life-pilot' / 'pilot.db'


def cases():
    result = []
    for number, (name, activity, hour) in enumerate([
        ('day-observe', 'observe', 12), ('night-rest', 'rest', 23), ('empty-walk', 'walk', 12)
    ], 1):
        observed = int(datetime(2026, 9, 23, hour - 8, tzinfo=timezone.utc).timestamp())
        facts = planning.Facts(owner_id='c15-synthetic-owner', space_id=SID, companion_id='c15-synthetic-cup',
            scene_type='home', scene_revision=0, companion_status='ready', current_space_id=SID,
            location_epoch=1, items=(planning.VisibleItem(id=ITEM, kind='tree', x=.3, y=.4),) if activity == 'observe' else (),
            rain=False, sound=False, season='autumn', season_revision=0, observed_at=observed)
        permission = planning.Permission(owner_id=facts.owner_id, space_id=SID, companion_id=facts.companion_id,
            revision=1, enabled=True, activities=(activity,))
        basis = planning.make_basis(facts, permission, plan_id=f'00000000-0000-4000-8000-{number:012d}',
            request_id=f'00000000-0000-4000-9000-{number:012d}')
        result.append((name, make_prompt(facts, permission), facts, permission, basis))
    return result


def manifest():
    return {'version': 'c15-v1', 'model': provider.MODEL, 'endpoint': provider.BASE_URL,
        'prompt_sha256': hashlib.sha256(SYSTEM.encode()).hexdigest(),
        'cases': [{'case_id': name, 'input_sha256': hashlib.sha256(prompt.user.encode()).hexdigest()}
                  for name, prompt, *_ in cases()],
        'source_sha256': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in
            [Path(__file__), Path(provider.__file__), BACKEND / 'app/living/life_planner.py', BACKEND / 'app/living/life_planning.py']},
        'reserve_per_call_micro': provider.RESERVE_MICRO, 'total_reserved_micro': provider.RESERVE_MICRO * 3,
        'budget_micro': CAP_MICRO, 'retries': 0, 'requested_output_tokens': provider.REQUEST_OUTPUT,
        'billing_input_limit': provider.INPUT_LIMIT, 'billing_output_limit': provider.OUTPUT_LIMIT,
        'mode': 'read_only_candidate_validation', 'requires_explicit_approval': True}


class PilotLedger:
    def __init__(self, path: Path, approval_ref: str, *, origin='real_eval'):
        if not isinstance(approval_ref, str) or not approval_ref.strip() or len(approval_ref) > 200:
            raise LivingError('approval_required', '首轮4元预算需要明确人工授权引用')
        if origin not in ('real_eval', 'offline_contract'):
            raise ValueError('invalid origin')
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self.origin = origin
        spec = json.dumps(manifest(), sort_keys=True)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('CREATE TABLE IF NOT EXISTS batch (id INTEGER PRIMARY KEY CHECK(id=1), spec TEXT, approval TEXT, origin TEXT)')
            db.execute('CREATE TABLE IF NOT EXISTS attempts (case_id TEXT PRIMARY KEY, state TEXT NOT NULL, reserved INTEGER NOT NULL, result TEXT, created TEXT NOT NULL)')
            saved = db.execute('SELECT spec, approval, origin FROM batch WHERE id=1').fetchone()
            if saved is None:
                db.execute('INSERT INTO batch VALUES (1,?,?,?)', (spec, approval_ref, origin))
            elif saved != (spec, approval_ref, origin):
                raise LivingError('manifest_conflict', '批次配置或授权已变化，不能复用原批次')

    def connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def claim(self, case_id):
        names = [case[0] for case in cases()]
        if case_id not in names:
            raise LivingError('invalid_request', '不在已确认的三条样例内')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('SELECT case_id,state,reserved FROM attempts').fetchall()
            if any(row[1] != 'passed' for row in rows):
                raise LivingError('batch_stopped', '已有失败或未知请求，停止本批，不重发')
            if any(row[0] == case_id for row in rows):
                return False
            if case_id != names[len(rows)] or len(rows) >= 3 or sum(row[2] for row in rows) + provider.RESERVE_MICRO > CAP_MICRO:
                raise LivingError('budget_exhausted', '请求顺序或预算上限不允许继续')
            db.execute('INSERT INTO attempts VALUES (?, ?, ?, NULL, ?)',
                (case_id, 'reserved', provider.RESERVE_MICRO, datetime.now(timezone.utc).isoformat()))
            return True

    def finish(self, case_id, state, result):
        if state not in ('passed', 'failed'):
            raise ValueError('invalid result')
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            changed = db.execute('UPDATE attempts SET state=?,result=? WHERE case_id=? AND state=?',
                (state, json.dumps(result, ensure_ascii=False), case_id, 'reserved')).rowcount
            if changed != 1:
                raise LivingError('conflict', '请求结果不能覆盖或补造')

    def report(self):
        with self.connect() as db:
            rows = db.execute('SELECT case_id,state,reserved,result FROM attempts ORDER BY created,case_id').fetchall()
        return {'origin': self.origin, 'reserved_micro': sum(row[2] for row in rows),
            'attempts': [{'case_id': row[0], 'state': row[1], 'reserved_micro': row[2],
                          'result': json.loads(row[3]) if row[3] else None} for row in rows]}


async def run_batch(ledger, adapter):
    for name, prompt, facts, permission, basis in cases():
        if not ledger.claim(name):
            continue
        started = time.monotonic()
        result = {'origin': ledger.origin, 'case_id': name, 'billing': 'reserved_unknown'}
        try:
            reply = await adapter.plan(prompt)
            result.update(asdict(reply))
            planning.review_candidate(reply.candidate, basis=basis, facts=facts, permission=permission)
        except asyncio.CancelledError:
            # The durable reservation survives cancellation and forbids re-dispatch.
            raise
        except Exception as exc:
            result['error_code'] = exc.code if isinstance(exc, LivingError) else 'provider_error'
            result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
            ledger.finish(name, 'failed', result)
            break
        result['elapsed_ms'] = round((time.monotonic() - started) * 1000)
        ledger.finish(name, 'passed', result)
    return ledger.report()


async def execute(approval_ref, db_path: Path | None = None):
    # Validate authorization before loading credentials or making even free requests.
    db = db_path or DB
    ledger = PilotLedger(db, approval_ref)
    from app.core.config import get_settings
    settings = get_settings()
    if settings.model_base_url != provider.BASE_URL or settings.chat_model != provider.MODEL or not settings.model_api_key.strip():
        raise LivingError('configuration_error', '本项目模型配置与已确认方案不一致')
    async with httpx.AsyncClient(timeout=12, trust_env=False, follow_redirects=False) as client:
        response = await client.get(provider.CATALOG_URL)
        response.raise_for_status()
        checked = provider.verify_catalog(response.json())
    result = await run_batch(ledger, provider.MaaSPlannerAdapter(settings.model_api_key))
    result['price_check'] = checked
    destination = db.with_suffix('.result.json')
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'result_path': str(destination), 'attempts': len(result['attempts']),
                      'reserved_micro': result['reserved_micro']}, ensure_ascii=False))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--approval-ref', default='')
    parser.add_argument('--db', default=str(DB))
    args = parser.parse_args()
    if not args.execute:
        print(json.dumps(manifest(), ensure_ascii=False, indent=2))
        return
    try:
        asyncio.run(execute(args.approval_ref, Path(args.db)))
    except (LivingError, httpx.HTTPError, ValueError, sqlite3.Error, OSError):
        print('首轮未完成：授权、价格、配置或已保存状态未通过核对；未自动重试。', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
