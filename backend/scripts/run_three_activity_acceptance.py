"""C1.73 approved three-call batch. Default status is read-only; never auto-reviews."""
import argparse
from datetime import date
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

from dotenv import dotenv_values
from sqlalchemy import text

PROJECT = Path(__file__).resolve().parents[2]
WORK = PROJECT / '.runtime/c173-real-three-activities'
EVIDENCE = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段3/C1.73三类动作自动请求/真实批次'
AUTHORIZATION = EVIDENCE / '本次授权.json'
BATCH = WORK / 'batch.json'
ACTIVITIES = ('rest', 'walk', 'observe')
SOURCE_SHA = '7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c'
APPROVAL = 'c173-real-three-activities-20261001'

# Fixed project-local review database, blank global keys, no background model worker.
from scripts import check_candidate_review as qa  # noqa: E402
from app.services import motion_generation as generation  # noqa: E402
from app.core.config import get_settings  # noqa: E402


def save(value):
    temporary = WORK / 'batch.tmp'
    with temporary.open('w', encoding='utf-8') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, ensure_ascii=False)
        output.flush(); os.fsync(output.fileno())
    temporary.replace(BATCH)


def approved():
    value = json.loads(AUTHORIZATION.read_text())
    if (value['approval_ref'] != APPROVAL or value['source_sha256'] != SOURCE_SHA
            or value['max_client_requests'] != 3 or value['automatic_retries'] != 0
            or value['budget_usd'] != .30 or value['platform_remaining_after_setting_usd'] != .30
            or value['platform_limit_verified'] is not True or value['platform_unlimited_quota'] is not False
            or value['platform_fallback_models'] != 0 or value['price_verified_on'] != date.today().isoformat()
            or value['user_confirmation'] != '嗯 确认'):
        raise ValueError('approved_batch_changed')
    key = dotenv_values(PROJECT / '.env', interpolate=False).get('AIHUBMIX_API_KEY')
    if (not isinstance(key, str) or len(key) < 16
            or hashlib.sha256((key[:7] + '****' + key[-4:]).encode()).hexdigest()
                != value['platform_key_display_sha256']):
        raise ValueError('project_key_mismatch')
    return value


def prepare():
    approved()
    WORK.mkdir(mode=0o700, exist_ok=False)
    with qa.SessionLocal() as db:
        source = db.get(qa.Character, 4)
        if source is None or not source.owner_id or source.owner_id == qa.OWNER or source.status != 'ready':
            raise ValueError('source_character_changed')
        original = qa.ROOT / 'uploads' / source.image_path
        raw = original.read_bytes()
        if hashlib.sha256(raw).hexdigest() != SOURCE_SHA:
            raise ValueError('source_character_changed')
        filename = 'c173-real-three-activities-apple.jpg'
        target = qa.ROOT / 'uploads' / filename
        with target.open('xb') as output:
            os.chmod(target, 0o600); output.write(raw)
        photo = qa.Photo(filename=filename, owner_id=source.owner_id, status='done')
        db.add(photo); db.flush()
        obj = qa.Object(photo_id=photo.id, label='新伙伴三类动作真实验收')
        db.add(obj); db.flush()
        character = qa.Character(object_id=obj.id, owner_id=source.owner_id, status='ready',
            image_path=filename, name='苹果伙伴·三类动作验收', persona=source.persona,
            opening_line='来看看我休息、散步和观察的样子。')
        db.add(character); db.flush()
        generation.register_request(db, character)
        cid, owner = character.id, character.owner_id
        save({'phase': 'preparing', 'character_id': cid, 'owner_id': owner, 'attempts': []})
        db.commit()
    plans = {activity: qa.flow.plan(cid, owner, activity=activity) for activity in ACTIVITIES}
    assert all(plan['source_sha256'] == SOURCE_SHA for plan in plans.values())
    states = generation.authorize_activities(cid, owner, expected_source_sha256=SOURCE_SHA,
        approval_ref=APPROVAL, price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    batch = json.loads(BATCH.read_text())
    batch.update(phase='queued', requests={item['activity']: item['request_id'] for item in states['activities']},
                 prompt_sha256={activity: plan['prompt_sha256'] for activity, plan in plans.items()})
    save(batch)
    return {'prepared': True, 'character_id': cid, 'states': states['activities'], 'actual_model_calls': 0}


def start():
    approved()
    batch = json.loads(BATCH.read_text())
    if batch['phase'] != 'queued':
        raise ValueError('batch_not_startable')
    with (WORK / 'launch.json').open('x', encoding='utf-8') as output:
        os.chmod(output.name, 0o600)
        json.dump({'reserved': True}, output)
    batch['phase'] = 'starting'; save(batch)
    process = subprocess.Popen([sys.executable, '-m', 'scripts.run_three_activity_acceptance', '_run'],
        cwd=PROJECT / 'backend', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    with (WORK / 'process.json').open('w') as output:
        os.chmod(output.name, 0o600); json.dump({'pid': process.pid}, output)
    return {'started': True, 'pid': process.pid, 'max_requests': 3}


def stop_pending(batch):
    with generation.SessionLocal() as db:
        db.execute(text('BEGIN IMMEDIATE'))
        for rid in batch['requests'].values():
            row = generation._by_id(db, rid)
            if row is not None and row.owner_id == batch['owner_id'] and row.state == 'queued':
                row.state, row.error_code = 'blocked', 'batch_stopped'
        db.commit()
    batch['phase'] = 'stopped'; save(batch)


def run():
    with (WORK / 'run.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        batch = json.loads(BATCH.read_text())
        if batch['phase'] != 'starting' or batch['attempts']:
            raise ValueError('batch_already_started')
        batch['phase'] = 'running'; save(batch)
        try:
            approved()
            get_settings().motion_generation_enabled = True  # This short-lived process only.
            for activity in ACTIVITIES:
                approved()
                current = generation.status(batch['character_id'], batch['owner_id'], activity=activity)
                plan = qa.flow.plan(batch['character_id'], batch['owner_id'], activity=activity)
                if (current['state'] != 'queued' or current['request_id'] != batch['requests'][activity]
                        or plan['source_sha256'] != SOURCE_SHA
                        or plan['prompt_sha256'] != batch['prompt_sha256'][activity]):
                    raise ValueError('batch_conditions_changed')
                batch['attempts'].append(activity); save(batch)
                if not generation.process_one(request_id=batch['requests'][activity]):
                    raise ValueError('request_not_processed')
                state = generation.status(batch['character_id'], batch['owner_id'], activity=activity)
                if state['state'] != 'needs_review':
                    stop_pending(batch)
                    return status()
            batch['phase'] = 'needs_review'; save(batch)
            return export()
        except Exception:
            stop_pending(batch)
            return status()
        finally:
            get_settings().motion_generation_enabled = False


def status():
    if not BATCH.exists():
        return {'phase': 'not_prepared', 'actual_model_calls': 0}
    batch = json.loads(BATCH.read_text())
    values = generation.activities_status(batch['character_id'], batch['owner_id'])['activities']
    calls = 0
    for activity in ACTIVITIES:
        job = hashlib.sha256(f'{APPROVAL}:{activity}'.encode()).hexdigest()
        file = qa.flow.DEFAULT_ROOT / f'approval-{job}.json'
        if file.exists():
            calls += json.loads(file.read_text()).get('generation_requests', 0)
    complete = all(item['state'] == 'ready' for item in values)
    return {'phase': 'completed' if complete else batch['phase'], 'character_id': batch['character_id'], 'activities': values,
            'actual_model_calls': calls, 'attempted_activities': batch['attempts'],
            'max_requests': 3, 'human_review_required': any(item['state'] == 'needs_review' for item in values)}


def export():
    result = status()
    batch = json.loads(BATCH.read_text())
    items = []
    for activity in ACTIVITIES:
        job = hashlib.sha256(f'{APPROVAL}:{activity}'.encode()).hexdigest()
        file = qa.flow.DEFAULT_ROOT / f'approval-{job}.json'
        if not file.exists():
            continue
        record = json.loads(file.read_text())
        item = {key: record[key] for key in ('state', 'activity', 'source_sha256', 'prompt_sha256',
                'candidate_sha256', 'generation_requests', 'provider_task_id', 'usage', 'error_code',
                'actual_bill_verified') if key in record}
        candidate = qa.flow.DEFAULT_ROOT / 'jobs' / job / 'candidate.png'
        if candidate.is_file():
            raw = candidate.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == record['candidate_sha256']
            (EVIDENCE / f'{activity}-真实候选.png').write_bytes(raw)
        items.append(item)
    (EVIDENCE / '真实执行结果.json').write_text(json.dumps({**result, 'results': items}, ensure_ascii=False, indent=2))
    if all(item['state'] == 'needs_review' for item in result['activities']):
        source, _ = qa.flow._current(batch['character_id'], batch['owner_id'])
        assert hashlib.sha256(source.read_bytes()).hexdigest() == SOURCE_SHA
        (EVIDENCE / 'reference-已确认原图.jpg').write_bytes(source.read_bytes())
        figures = ''.join(f'<figure><h2>{label}</h2><a href="{kind}-真实候选.png"><img src="{kind}-真实候选.png" alt="{label}四姿态"></a><figcaption>{meaning}</figcaption></figure>'
            for kind, label, meaning in [('rest', '休息', '四帧持续闭眼，放松休息。'),
                ('walk', '散步', '左右脚交替迈步，手臂自然摆动。'),
                ('observe', '观察', '左右转头与目光变化，四处打量。')])
        html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>新伙伴三类真实动作 · 候选审阅</title><style>body{margin:0;padding:24px;background:#f7f3ec;color:#342b30;font:16px/1.6 system-ui}header,main,aside{max-width:1500px;margin:auto}h1{font-size:26px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-top:20px}figure{margin:0;padding:16px;background:white;border:1px solid #dfd5c8;border-radius:18px}h2{margin:0 0 12px;font-size:22px}img{display:block;width:100%;height:auto;border-radius:12px}figcaption{margin-top:12px}a{color:inherit}input{margin:0 8px 0 0}#checker:checked~main img{background-color:white;background-image:linear-gradient(45deg,#e7e7e7 25%,transparent 25%),linear-gradient(-45deg,#e7e7e7 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e7e7e7 75%),linear-gradient(-45deg,transparent 75%,#e7e7e7 75%);background-size:24px 24px;background-position:0 0,0 12px,12px -12px,-12px 0}aside{margin-top:22px;display:flex;align-items:center;gap:18px}aside img{max-width:160px}small{color:#705f65}@media(max-width:800px){body{padding:16px}main{grid-template-columns:1fr}h1{font-size:22px}}</style><header><h1>苹果伙伴 · 三类真实动作候选</h1><p>三次生成已结束。请看形象是否一致、四个姿态是否完整，以及每类动作含义是否符合。</p><small>这页只供看图，不会接受候选或产生新费用。确认后再绑定和验证播放。</small></header><input id="checker" type="checkbox" checked><label for="checker">棋盘格背景（检查透明边缘）</label><main>' + figures + '</main><aside><img src="reference-已确认原图.jpg" alt="已确认参考图"><div>已确认参考图<br><small>本批复用此图，没有新增静态生图调用。</small></div></aside></html>'
        (EVIDENCE / '真实候选对照.html').write_text(html, encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', nargs='?', default='status', choices=['prepare', 'start', '_run', 'status', 'export'])
    args = parser.parse_args()
    try:
        result = {'prepare': prepare, 'start': start, '_run': run, 'status': status, 'export': export}[args.phase]()
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        print(json.dumps({'error': {'code': 'three_activity_batch_unavailable',
                                   'message': '批次已保留；请核对授权与状态，不自动重发。'}}, ensure_ascii=False))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
