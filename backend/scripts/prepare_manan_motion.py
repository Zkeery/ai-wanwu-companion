"""Free, single-source motion plan for adopted real-web character 9.

No model/authorization/imported application execution; no business writes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sqlite3

PROJECT = Path(__file__).resolve().parents[2]
DATA = PROJECT / '.runtime/real-web/data'
ROOT = PROJECT / '.runtime/real-web/acceptance/manan-motion'
REVIEW = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段3/四项验收续跑/造型差异修订-9/两次创作人工审阅.json'
IMAGE_SHA256 = '7e2de954bf8207a8edbadc818242ca61455bc1b99f333e91363cc437e39eea70'


def approved_source(data: Path = DATA, review: Path = REVIEW) -> tuple[str, Path]:
    accepted = json.loads(review.read_text(encoding='utf8'))
    if (accepted.get('status') != 'accepted' or accepted.get('user_reply') != '采用'
            or accepted.get('accepted_character_id') != 9 or accepted.get('image_sha256') != IMAGE_SHA256):
        raise ValueError('adopted_source_required')
    with sqlite3.connect((data / 'check.db').as_uri() + '?mode=ro', uri=True) as db:
        row = db.execute('SELECT owner_id, image_path, status FROM characters WHERE id=9').fetchone()
    if not row or not row[0] or row[2] != 'ready':
        raise ValueError('source_not_ready')
    source = data / 'uploads' / row[1]
    if (any(p.is_symlink() for p in (source, *source.parents))
            or not source.resolve().is_relative_to((data / 'uploads').resolve())
            or hashlib.sha256(source.read_bytes()).hexdigest() != IMAGE_SHA256):
        raise ValueError('source_changed')
    return row[0], source


def prepare() -> dict:
    if ROOT.exists():
        raise FileExistsError('Never overwrite a prepared motion batch')
    owner, source = approved_source()
    from scripts.check_full_flow_recovery import snapshot_facts
    before = snapshot_facts(DATA, 'check.db', True)
    os.environ.update(APP_ENV='test', DATABASE_URL=f'sqlite:///{DATA / "check.db"}',
                      UPLOAD_DIR=str(DATA / 'uploads'), WALK_WORKFLOW_ROOT=str(DATA / 'ledger'),
                      MOTION_GENERATION_ENABLED='false', MODEL_API_KEY='', DEV_AUTH_TOKEN='',
                      SMS_LIVE_ENABLED='false', LIFE_RUNTIME_ENABLED='false',
                      LIFE_RUNTIME_PREVIEW_ENABLED='false', LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false')
    original_connect = socket.socket.connect
    def forbidden(*args, **kwargs):
        raise RuntimeError('network_forbidden')
    socket.socket.connect = forbidden
    try:
        from app.core.config import get_settings
        get_settings.cache_clear()
        from app.services import character_walk_workflow as flow, motion_generation as generation
        activities = []
        for activity in ('rest', 'walk', 'observe'):
            plan = flow.plan(9, owner, activity=activity)
            request = generation.status(9, owner, activity=activity)
            if plan['generation_requests'] != 0 or request['state'] != 'waiting_authorization':
                raise ValueError('fresh_unapproved_request_required')
            activities.append(dict(activity=activity, request_id=request['request_id'],
                                   state=request['state'], source_sha256=IMAGE_SHA256,
                                   prompt_sha256=plan.get('prompt_sha256'), model=plan['model']))
        # Recheck image/adoption after all reads, before writing only the private plan.
        if approved_source() != (owner, source) or snapshot_facts(DATA, 'check.db', True) != before:
            raise ValueError('source_changed')
        ROOT.mkdir(mode=0o700)
        state = dict(schema_version=1, status='prepared_without_fee_authorization', character_id=9,
                     source_sha256=IMAGE_SHA256, source_review_sha256=hashlib.sha256(REVIEW.read_bytes()).hexdigest(),
                     activities=activities, max_requests=3, proposed_reservation_usd='0.30',
                     automatic_retries=0, model_requests=0, business_writes=0,
                     price_verified=False, platform_quota_verified=False,
                     authorization_granted=False, human_motion_review_required=True)
        state['business_data_unchanged'] = True
        with (ROOT / 'state.json').open('x', encoding='utf8') as out:
            os.chmod(ROOT / 'state.json', 0o600)
            json.dump(state, out, ensure_ascii=False, indent=2)
        return dict(status=state['status'], character_id=9, requests_prepared=3,
                    model_requests=0, business_writes=0)
    finally:
        socket.socket.connect = original_connect


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('prepare', 'status'), default='status', nargs='?')
    args = parser.parse_args()
    try:
        if args.mode == 'prepare':
            result = prepare()
        else:
            approved_source()
            state = json.loads((ROOT / 'state.json').read_text())
            result = {k: state[k] for k in ('status', 'character_id', 'max_requests', 'model_requests',
                                           'authorization_granted', 'price_verified', 'platform_quota_verified')}
        print(json.dumps(result))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'manan_motion_preparation_failed',
                                   'message': '请核对已采用来源图、未消费请求和独立批次目录。'}}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
