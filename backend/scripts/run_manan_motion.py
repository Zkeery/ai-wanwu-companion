"""Single adopted character, three serial calls, fresh durable USD authorization."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import date
from decimal import Decimal
import fcntl
import hashlib
from html import escape
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
from uuid import uuid4

import httpx

from scripts import prepare_manan_motion as prepared

PROJECT = prepared.PROJECT
ROOT = prepared.ROOT
DATA = prepared.DATA
EVIDENCE = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段3/C1.75蔓蔓动作收尾'
AUTH = EVIDENCE / '本次授权.json'
QUOTA = EVIDENCE / '动作通道额度.json'
REF = 'c175-manan-motion-20261002-3calls-0.30usd'
ACTIVITIES = ('rest', 'walk', 'observe')
MODEL = 'gpt-image-2.5-sunburst'
LIMIT = 300000  # millionths of USD; unknown outcomes retain the full reserve.
RESERVE = 100000
CONTINUATION_REF = 'c175-manan-motion-20261002-manual-1'


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: dict) -> None:
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf8') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, ensure_ascii=False, indent=2, allow_nan=False)
        out.flush(); os.fsync(out.fileno())
    temporary.replace(path)


def authorization() -> dict:
    value = json.loads(AUTH.read_text(encoding='utf8'))
    if (value.get('authorization_ref') != REF or value.get('character_id') != 9
            or value.get('source_sha256') != prepared.IMAGE_SHA256
            or value.get('activities') != list(ACTIVITIES) or value.get('requests_max') != 3
            or Decimal(value.get('budget_usd', '0')) != Decimal('0.30')
            or Decimal(value.get('reservation_per_request_usd', '0')) != Decimal('0.10')
            or value.get('automatic_retries') != 0 or value.get('fallback_models') != 0
            or value.get('model_allowlist') != [MODEL] or not value.get('user_reply', '').strip()
            or value.get('motion_adoption_authorized') is not False):
        raise ValueError('fixed_authorization_required')
    plan = json.loads((ROOT / 'state.json').read_text())
    if (plan.get('source_sha256') != prepared.IMAGE_SHA256 or plan.get('max_requests') != 3
            or plan.get('source_review_sha256') != digest(prepared.REVIEW)
            or [row['activity'] for row in plan['activities']] != list(ACTIVITIES)):
        raise ValueError('prepared_plan_changed')
    return value


def key() -> str:
    from dotenv import dotenv_values
    value = dotenv_values(PROJECT / '.env', interpolate=False).get('AIHUBMIX_API_KEY', '') or ''
    if not value.strip() or any(x.isspace() for x in value):
        raise ValueError('project_motion_key_missing')
    return value


def quota_verified() -> dict:
    authorization()
    value = json.loads(QUOTA.read_text())
    secret = key()
    display = hashlib.sha256((secret[:7] + '****' + secret[-4:]).encode()).hexdigest()
    if (value.get('status') != 'opened_for_approved_batch' or value.get('authorization_ref') != REF
            or value.get('verified_on') != date.today().isoformat()
            or value.get('remaining_usd_approved') != '0.30' or value.get('unlimited') is not False
            or value.get('model_allowlist') != [MODEL] or value.get('fallback_models') != 0
            or value.get('platform_key_display_sha256') != display
            or value.get('price_verified_on') != date.today().isoformat()):
        raise ValueError('current_platform_quota_required')
    return value


def initialize() -> dict:
    authorization(); prepared.approved_source()
    if (ROOT / 'guard.db').exists() or (ROOT / 'initialized.json').exists():
        raise FileExistsError('Never recreate a motion budget')
    # Missing/corrupt ledgers remain blocking; this marker is never reset.
    with (ROOT / 'initialized.json').open('x') as out:
        os.chmod(ROOT / 'initialized.json', 0o600)
        json.dump({'authorization_ref': REF, 'authorization_sha256': digest(AUTH)}, out)
        out.flush(); os.fsync(out.fileno())
    with sqlite3.connect(ROOT / 'guard.db') as db:
        db.execute('CREATE TABLE approval (auth TEXT NOT NULL, plan TEXT NOT NULL)')
        db.execute('INSERT INTO approval VALUES (?, ?)', (digest(AUTH), digest(ROOT / 'state.json')))
        db.execute('''CREATE TABLE calls (activity TEXT PRIMARY KEY, reserve_usd_micro INTEGER NOT NULL,
            started_at INTEGER NOT NULL, outcome TEXT NOT NULL, detail TEXT NOT NULL)''')
    (ROOT / 'guard.db').chmod(0o600)
    save(ROOT / 'run-state.json', {'status': 'waiting_platform_quota', 'authorization_ref': REF})
    return status()


@contextmanager
def connect():
    authorization()
    database = ROOT / 'guard.db'
    if not database.is_file() or database.is_symlink():
        raise ValueError('original_motion_ledger_required')
    db = sqlite3.connect(database, timeout=30)
    db.row_factory = sqlite3.Row
    row = db.execute('SELECT auth, plan FROM approval').fetchone()
    if row is None or tuple(row) != (digest(AUTH), digest(ROOT / 'state.json')):
        db.close(); raise ValueError('approval_or_plan_changed')
    try:
        with db:
            yield db
    finally:
        db.close()


def claim(activity: str) -> None:
    quota_verified(); prepared.approved_source()
    with connect() as db:
        db.execute('BEGIN IMMEDIATE')
        rows = db.execute('SELECT activity, reserve_usd_micro, outcome FROM calls ORDER BY started_at, rowid').fetchall()
        if (len(rows) >= 3 or activity != ACTIVITIES[len(rows)]
                or any(row['outcome'] != 'succeeded' for row in rows)
                or sum(row['reserve_usd_micro'] for row in rows) + RESERVE > LIMIT):
            raise ValueError('motion_budget_or_sequence_stopped')
        db.execute('INSERT INTO calls VALUES (?, ?, ?, ?, ?)', (activity, RESERVE, int(time.time()), 'unknown', '{}'))


def settle(activity: str, outcome: str, detail: dict) -> None:
    if outcome not in ('succeeded', 'unknown'):
        raise ValueError('invalid_outcome')
    with connect() as db:
        changed = db.execute('UPDATE calls SET outcome=?, detail=? WHERE activity=? AND outcome=?',
                             (outcome, json.dumps(detail, allow_nan=False), activity, 'unknown')).rowcount
        if changed != 1:
            raise ValueError('call_not_reserved')


def context():
    os.environ.update(APP_ENV='test', DATABASE_URL=f'sqlite:///{DATA / "check.db"}',
                      UPLOAD_DIR=str(DATA / 'uploads'), WALK_WORKFLOW_ROOT=str(DATA / 'ledger'),
                      MOTION_GENERATION_ENABLED='false', SMS_LIVE_ENABLED='false',
                      LIFE_RUNTIME_ENABLED='false', LIFE_RUNTIME_PREVIEW_ENABLED='false',
                      LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false')
    from app.core.config import get_settings
    get_settings.cache_clear()
    from app.core.database import engine
    if engine.url.database != str(DATA / 'check.db'):
        raise ValueError('wrong_runtime_database')
    from app.services import motion_generation as generation
    return get_settings(), generation


def grant() -> dict:
    quota_verified()
    state = status()
    if state['status'] != 'waiting_platform_quota' or state['requests'] != 0:
        raise ValueError('already_granted_or_attempted')
    owner, _ = prepared.approved_source()
    from scripts.check_full_flow_recovery import capture
    backup = capture(source=DATA, snapshot=ROOT / 'before-motion', database_name='check.db', include_runtime_state=True)
    _, generation = context()
    rows = generation.authorize_activities(9, owner, expected_source_sha256=prepared.IMAGE_SHA256,
        approval_ref=REF, price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    plan = json.loads((ROOT / 'state.json').read_text())
    if {r['request_id'] for r in rows['activities']} != {r['request_id'] for r in plan['activities']}:
        raise ValueError('request_set_changed')
    save(ROOT / 'run-state.json', {'status': 'queued', 'authorization_ref': REF,
                                 'backup': backup, 'quota_sha256': digest(QUOTA)})
    return status()


def continuation_authorization() -> dict:
    value = json.loads((EVIDENCE / '人工续跑确认.json').read_text())
    if (value.get('authorization_ref') != REF or value.get('continuation_ref') != CONTINUATION_REF
            or value.get('user_reply') != '好，那就用Chrome ，继续吧'
            or value.get('confirmed_on') != date.today().isoformat()
            or value.get('character_id') != 9 or value.get('source_sha256') != prepared.IMAGE_SHA256
            or value.get('max_total_provider_requests') != 3
            or value.get('total_budget_usd') != '0.30' or value.get('automatic_retries') != 0
            or value.get('original_budget_ledger_must_be_retained') is not True
            or value.get('original_failure_evidence_must_be_retained') is not True
            or value.get('motion_adoption_authorized') is not False):
        raise ValueError('explicit_manual_continuation_required')
    return value


def verify_local_failure(owner: str) -> str:
    state = status()
    if state['status'] != 'paused_failure' or state['requests'] != 0:
        raise ValueError('not_a_zero_dispatch_local_failure')
    previous = json.loads((ROOT / 'run-state.json').read_text())
    if previous.get('error_type') != 'ValueError' or previous.get('workflow_ref', REF) != REF:
        raise ValueError('not_the_original_local_failure')
    job = hashlib.sha256((REF + ':rest').encode()).hexdigest()
    record = DATA / 'ledger' / f'approval-{job}.json'
    value = json.loads(record.read_text())
    if (value.get('state') != 'unknown' or value.get('error_code') != 'candidate_unavailable'
            or value.get('generation_requests') != 1 or value.get('owner_id') != owner
            or value.get('character_id') != 9 or value.get('activity') != 'rest'
            or value.get('source_sha256') != prepared.IMAGE_SHA256
            or any(k in value for k in ('provider_task_id', 'usage', 'candidate_sha256'))):
        raise ValueError('upstream_outcome_cannot_be_excluded')
    directory = DATA / 'ledger/jobs' / job
    if (set(p.name for p in directory.iterdir()) != {'source.image'}
            or digest(directory / 'source.image') != prepared.IMAGE_SHA256):
        raise ValueError('original_job_has_other_artifacts')
    for activity in ACTIVITIES[1:]:
        old = hashlib.sha256((REF + ':' + activity).encode()).hexdigest()
        if (DATA / 'ledger' / f'approval-{old}.json').exists() or (DATA / 'ledger/jobs' / old).exists():
            raise ValueError('sibling_already_attempted')
    for activity in ACTIVITIES:
        new = hashlib.sha256((CONTINUATION_REF + ':' + activity).encode()).hexdigest()
        if (DATA / 'ledger' / f'approval-{new}.json').exists() or (DATA / 'ledger/jobs' / new).exists():
            raise ValueError('continuation_already_attempted')
    return digest(record)


def resume() -> dict:
    """One user-confirmed recovery; never recreate the budget or erase a failure."""
    continuation_authorization(); quota_verified()
    with (ROOT / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if (ROOT / 'manual-resume.json').exists():
            raise ValueError('manual_continuation_already_consumed')
        owner, source = prepared.approved_source()
        old_record_sha = verify_local_failure(owner)
        from scripts.check_full_flow_recovery import capture
        backup = capture(source=DATA, snapshot=ROOT / 'before-manual-resume',
                         database_name='check.db', include_runtime_state=True)
        _, generation = context()
        from app.core.database import SessionLocal
        from sqlalchemy import text
        plan = json.loads((ROOT / 'state.json').read_text())
        with SessionLocal() as db:
            db.execute(text('BEGIN IMMEDIATE'))
            rows = []
            for item in plan['activities']:
                activity = item['activity']
                row = generation._by_id(db, item['request_id'])
                expected_state = 'unknown' if activity == 'rest' else 'blocked'
                expected_error = 'candidate_unavailable' if activity == 'rest' else 'batch_stopped'
                if (row is None or row.character_id != 9 or row.owner_id != owner
                        or generation._activity(row) != activity or row.state != expected_state
                        or row.error_code != expected_error or row.source_sha256 != prepared.IMAGE_SHA256
                        or row.approval_ref != REF + ':' + activity
                        or row.approval_sha256 != hashlib.sha256(row.approval_ref.encode()).hexdigest()
                        or row.prompt_sha256 != item['prompt_sha256']
                        or DATA / 'uploads' / row.source_image_path != source):
                    raise ValueError('original_request_changed')
                rows.append((row, activity))
            # Exclusive durable marker before any business transition. On interruption, stop.
            with (ROOT / 'manual-resume.json').open('x') as out:
                os.chmod(ROOT / 'manual-resume.json', 0o600)
                json.dump(dict(continuation_ref=CONTINUATION_REF,
                    authorization_sha256=digest(EVIDENCE / '人工续跑确认.json'),
                    original_run_state=json.loads((ROOT / 'run-state.json').read_text()),
                    original_workflow_sha256=old_record_sha, complete_backup=backup), out)
                out.flush(); os.fsync(out.fileno())
            if verify_local_failure(owner) != old_record_sha:
                raise ValueError('failure_changed_during_recovery')
            for row, activity in rows:
                row.approval_ref = CONTINUATION_REF + ':' + activity
                row.approval_sha256 = hashlib.sha256(row.approval_ref.encode()).hexdigest()
                row.price_verified_on = date.today().isoformat()
                row.state, row.error_code = 'queued', None
            db.commit()
        save(ROOT / 'run-state.json', dict(status='queued', authorization_ref=REF,
             workflow_ref=CONTINUATION_REF, backup=backup, quota_sha256=digest(QUOTA),
             manual_continuation_sha256=digest(EVIDENCE / '人工续跑确认.json')))
    return status()


def current_request(generation, owner: str, item: dict, state: dict) -> dict:
    if state.get('workflow_ref', REF) == REF:
        return generation.status(9, owner, activity=item['activity'])
    continuation_authorization()
    if state.get('workflow_ref') != CONTINUATION_REF:
        raise ValueError('unapproved_workflow_reference')
    from app.core.database import SessionLocal
    with SessionLocal() as db:
        row = generation._by_id(db, item['request_id'])
        if (row is None or row.character_id != 9 or row.owner_id != owner
                or row.approval_ref != CONTINUATION_REF + ':' + item['activity']
                or row.source_sha256 != prepared.IMAGE_SHA256):
            raise ValueError('continued_request_changed')
        return dict(request_id=row.id, state=row.state)


def run() -> dict:
    quota_verified()
    with (ROOT / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads((ROOT / 'run-state.json').read_text())
        if state['status'] != 'queued' or state['quota_sha256'] != digest(QUOTA):
            raise ValueError('already_attempted_or_quota_changed')
        owner, _ = prepared.approved_source()
        settings, generation = context()
        from app.services.motion_walk_aihubmix import generate, preflight
        from app.services.motion_atlas_provider import AtlasProviderError
        plan = json.loads((ROOT / 'state.json').read_text())
        state['status'] = 'running'; save(ROOT / 'run-state.json', state)
        settings.motion_generation_enabled = True
        try:
            for item in plan['activities']:
                activity = item['activity']
                current = current_request(generation, owner, item, state)
                if current['request_id'] != item['request_id'] or current['state'] != 'queued':
                    raise ValueError('current_request_not_queued')
                expected_activity = activity
                def provider(source, supplied_key, *, expected_sha256, on_task=None, activity=activity):
                    # The workflow supplies the project key; compare without exposing it.
                    if (supplied_key != key() or expected_sha256 != prepared.IMAGE_SHA256
                            or activity != expected_activity):
                        raise AtlasProviderError('source_or_key_changed')
                    preflight(source, activity=activity)
                    claim(activity)
                    upstream = {}
                    def task(task_id):
                        upstream['id'] = task_id
                        if on_task: on_task(task_id)
                    try:
                        with httpx.Client(timeout=httpx.Timeout(180, connect=10), trust_env=False, follow_redirects=False) as client:
                            image, usage = generate(source, supplied_key, expected_sha256=expected_sha256,
                                                    activity=activity, client=client, on_task=task)
                        settle(activity, 'succeeded', dict(provider_request_id=upstream.get('id'), usage=usage,
                               actual_bill_verified=False, reservation_retained=True))
                        return image, usage
                    except Exception:
                        settle(activity, 'unknown', dict(provider_request_id=upstream.get('id'), reservation_retained=True))
                        raise AtlasProviderError('provider_call_unknown') from None
                generation.process_one(request_id=item['request_id'], provider=provider)
                if generation.status(9, owner, activity=activity)['state'] != 'needs_review':
                    raise ValueError('candidate_did_not_reach_review')
            state['status'] = 'needs_review'
        except Exception as error:
            state.update(status='paused_failure', error_type=type(error).__name__)
        finally:
            settings.motion_generation_enabled = False
            save(ROOT / 'run-state.json', state)
            export()
    return status()


def export() -> dict:
    _, source = prepared.approved_source()
    target = EVIDENCE / '真实动作候选'
    target.mkdir(exist_ok=True)
    shutil.copyfile(source, target / '蔓蔓静态.png')
    cards, summary = [], []
    reference = json.loads((ROOT / 'run-state.json').read_text()).get('workflow_ref', REF)
    if reference not in (REF, CONTINUATION_REF):
        raise ValueError('unapproved_workflow_reference')
    for activity in ACTIVITIES:
        job = hashlib.sha256((reference + ':' + activity).encode()).hexdigest()
        record = DATA / 'ledger' / f'approval-{job}.json'
        candidate = DATA / 'ledger/jobs' / job / 'candidate.png'
        if not record.is_file() or not candidate.is_file():
            continue
        proof = json.loads(record.read_text())
        if digest(candidate) != proof.get('candidate_sha256'):
            raise ValueError('candidate_digest_mismatch')
        name = f'蔓蔓-{activity}.png'
        shutil.copyfile(candidate, target / name)
        title = {'rest': '休息', 'walk': '散步', 'observe': '观察'}[activity]
        cards.append(f'<article><h2>{escape(title)}</h2><div class="sprite" style="background-image:url({name})"></div>'
                     f'<details open><summary>四帧原图</summary><img src="{name}" alt="{escape(title)}四帧"></details></article>')
        summary.append(dict(activity=activity, workflow_job_id=job, candidate_sha256=digest(candidate),
                            source_sha256=prepared.IMAGE_SHA256, state=proof['state'],
                            quality_check=proof.get('quality_check'), candidate_file=name))
    save(target / '候选摘要.json', {'character_id': 9, 'adopted': False, 'candidates': summary})
    html = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>蔓蔓三类动作审阅</title><style>body{font:16px system-ui;margin:24px;background:#f3f5f1;color:#253b31}main{max-width:1120px;margin:auto}.cards{display:flex;flex-wrap:wrap;gap:20px}article{background:white;padding:20px;border-radius:16px;flex:1;min-width:220px}img{width:100%;max-width:320px}.static{max-width:220px}.sprite{width:200px;height:200px;background-size:400px 400px;background-color:#e7ebe5;animation:frames 1.2s steps(1) infinite}@keyframes frames{0%{background-position:0 0}25%{background-position:100% 0}50%{background-position:0 100%}75%{background-position:100% 100%}}</style>
<main><h1>蔓蔓 · 三类真实动作候选</h1><p>尚未采用或绑定。请核对休息全程闭眼、散步交替迈步、观察左右打量；身份与3D质感保持，无新增花盆、盆土或底座。</p><h2>已采用静态形象</h2><img class="static" src="蔓蔓静态.png" alt="已采用的蔓蔓"><div class="cards">''' + ''.join(cards) + '</div></main></html>'
    (target / 'index.html').write_text(html, encoding='utf8')
    public = ROOT.parents[1] / 'frontend/public/acceptance-real-web/manan-motion'
    # ROOT is real-web/acceptance/manan-motion; parents[1] is real-web.
    if not public.parent.is_dir():
        raise ValueError('existing_real_web_public_required')
    public.mkdir(exist_ok=True)
    for item in target.iterdir():
        if item.is_file(): shutil.copyfile(item, public / item.name)
    return {'exported_candidates': len(summary), 'adopted': False,
            'url': 'http://127.0.0.1:3059/acceptance-real-web/manan-motion/index.html'}


def status() -> dict:
    with connect() as db:
        rows = db.execute('SELECT reserve_usd_micro, outcome FROM calls').fetchall()
    state = json.loads((ROOT / 'run-state.json').read_text())
    return {'status': state['status'], 'character_id': 9, 'requests': len(rows),
            'reserved_usd': str(Decimal(sum(row['reserve_usd_micro'] for row in rows)) / 1000000),
            'budget_usd': '0.30', 'succeeded': sum(row['outcome'] == 'succeeded' for row in rows),
            'unknown': sum(row['outcome'] == 'unknown' for row in rows), 'automatic_retries': 0,
            'actual_bill_verified': False}


def adoption() -> tuple[dict, dict]:
    review = json.loads((EVIDENCE / '动作采用确认.json').read_text())
    summary_file = EVIDENCE / '真实动作候选/候选摘要.json'
    if (review.get('status') != 'accepted' or review.get('user_reply') != '可以没问题'
            or review.get('character_id') != 9 or review.get('accepted_motion_count') != 3
            or review.get('accepted_activities') != list(ACTIVITIES)
            or review.get('source_sha256') != prepared.IMAGE_SHA256
            or review.get('binding_authorized') is not True
            or review.get('new_provider_requests_authorized') != 0
            or not review.get('review_ref', '').strip()
            or review.get('reviewed_summary_sha256') != digest(summary_file)):
        raise ValueError('specific_motion_adoption_required')
    summary = json.loads(summary_file.read_text())
    if summary.get('character_id') != 9 or [c['activity'] for c in summary['candidates']] != list(ACTIVITIES):
        raise ValueError('three_exact_candidates_required')
    for candidate in summary['candidates']:
        job = hashlib.sha256((CONTINUATION_REF + ':' + candidate['activity']).encode()).hexdigest()
        if (candidate.get('workflow_job_id') != job or candidate.get('source_sha256') != prepared.IMAGE_SHA256
                or digest(DATA / 'ledger/jobs' / job / 'candidate.png') != candidate.get('candidate_sha256')):
            raise ValueError('reviewed_candidate_changed')
    return review, summary


def bind() -> dict:
    """Adopt exact reviewed sheets and bind offline; safe deterministic resumption."""
    review, summary = adoption()
    before = status()
    if before['requests'] != 3 or before['succeeded'] != 3 or before['unknown'] != 0:
        raise ValueError('completed_batch_required')
    with (ROOT / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads((ROOT / 'run-state.json').read_text())
        if (state.get('workflow_ref') != CONTINUATION_REF
                or state['status'] not in ('needs_review', 'binding', 'paused_binding', 'ready')):
            raise ValueError('candidates_not_bindable')
        owner, _ = prepared.approved_source()
        original_connect, original_connect_ex = socket.socket.connect, socket.socket.connect_ex
        def forbidden(*args, **kwargs):
            raise RuntimeError('binding_network_forbidden')
        socket.socket.connect = socket.socket.connect_ex = forbidden
        try:
            _, generation = context()
            from app.core.database import SessionLocal
            from app.models.models import MotionPreparationTask
            from app.services import character_walk_workflow as flow, motion_preparation as preparation
            def only_selected_queue(db):
                queued = db.query(MotionPreparationTask).filter_by(state='queued').all()
                if any(row.character_id != 9 or row.owner_id != owner or row.activity not in ACTIVITIES
                       or row.source_sha256 != prepared.IMAGE_SHA256 for row in queued):
                    raise ValueError('other_preparation_task_must_not_be_consumed')
            with SessionLocal() as db:
                only_selected_queue(db)
            state['status'] = 'binding'; save(ROOT / 'run-state.json', state)
            for candidate in summary['candidates']:
                flow.review(candidate['workflow_job_id'], 9, owner, decision='accept',
                    candidate_sha256=candidate['candidate_sha256'], review_ref=review['review_ref'],
                    root=DATA / 'ledger')
            for _ in range(3):
                with SessionLocal() as db:
                    only_selected_queue(db)
                    if not preparation.process_one(db):
                        break
            activities = [{'activity': a, **generation.status(9, owner, activity=a)} for a in ACTIVITIES]
            if any(a['state'] != 'ready' for a in activities):
                raise ValueError('binding_not_ready')
            after = status()
            if (after['requests'], after['reserved_usd'], after['succeeded']) != (
                    before['requests'], before['reserved_usd'], before['succeeded']):
                raise ValueError('paid_ledger_changed_during_binding')
            state.update(status='ready', review_ref=review['review_ref'], binding_network_forbidden=True)
            save(ROOT / 'run-state.json', state)
            result = dict(status='ready', character_id=9, adopted=True, activities=activities,
                          new_provider_requests=0, binding_network_forbidden=True)
            save(EVIDENCE / '真实动作候选/绑定摘要.json', result)
            return result
        except Exception as error:
            state.update(status='paused_binding', binding_error_type=type(error).__name__)
            save(ROOT / 'run-state.json', state)
            raise
        finally:
            socket.socket.connect, socket.socket.connect_ex = original_connect, original_connect_ex


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('initialize', 'grant', 'resume', 'launch', 'run', 'status', 'export', 'bind'), default='status', nargs='?')
    args = parser.parse_args()
    try:
        if args.mode == 'launch':
            quota_verified()
            if status()['status'] != 'queued': raise ValueError('already_attempted')
            state = json.loads((ROOT / 'run-state.json').read_text())
            marker = 'manual-launch.json' if state.get('workflow_ref') == CONTINUATION_REF else 'launch.json'
            with (ROOT / marker).open('x') as out:
                os.chmod(ROOT / marker, 0o600)
                json.dump({'reserved': True}, out)
            with (ROOT / 'process.log').open('a') as log:
                os.chmod(ROOT / 'process.log', 0o600)
                process = subprocess.Popen([sys.executable, '-m', 'scripts.run_manan_motion', 'run'],
                    cwd=PROJECT / 'backend', stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            save(ROOT / 'process.json', {'pid': process.pid, 'status': 'launched'})
            result = {'status': 'launched', 'pid': process.pid, 'max_requests': 3}
        else:
            result = globals()[args.mode]()
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'manan_motion_batch_stopped',
                                   'message': '动作批次未通过；请核对来源、持久授权、当日平台额度和未知回执，勿自动重试。'}}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
