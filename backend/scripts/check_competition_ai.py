"""Read-only R6.1 review plan. --execute requires a new four-call authorization.

Uses the existing review database, two owned companions and a real timed match.
Garden waits 300 seconds plus 180 seconds for voting; this script never votes.
Never generates images, audio or extra retries. A receipt cannot
be reused, including after a process crash. Run from backend/.
"""
import argparse
import asyncio
import json
import sqlite3
import time
from pathlib import Path
from uuid import uuid4, uuid5, NAMESPACE_URL

PROJECT = Path(__file__).resolve().parents[2]
DATABASE = PROJECT / '.runtime/c160-review/check.db'


def wait_for_completion(store, owner, match_id):
    while True:
        current = store.read(owner, match_id)
        if current['status'] == 'completed':
            return
        if current['status'] not in ('running', 'voting'):
            raise RuntimeError('比赛状态变化，停止本批')
        time.sleep(min(5, max(1, current['end_at'] - time.time())))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--authorization-ref')
    parser.add_argument('--kind', choices=('observe', 'garden', 'leaves'), default='observe')
    args = parser.parse_args()
    if args.execute and not (args.authorization_ref and 8 <= len(args.authorization_ref) <= 80
                             and all(c.isalnum() or c in '-_' for c in args.authorization_ref)):
        parser.error('执行需要本批新授权编号，只使用字母、数字、横线，不填密钥')
    with sqlite3.connect(f'file:{DATABASE}?mode=ro', uri=True) as conn:
        people = conn.execute('SELECT id,owner_id,name,status FROM characters WHERE id IN (3,4) ORDER BY id').fetchall()
        if len(people) != 2 or people[0][1] != people[1][1] or any(p[3] != 'ready' for p in people):
            raise RuntimeError('本人两位伙伴尚未就绪，未调用')
        for row in conn.execute('SELECT state_json FROM life_competitions'):
            match = json.loads(row[0])
            if match['status'] in ('running', 'voting') and any(str(p[0]) in match['participants']
                    and match['participants'][str(p[0])]['status'] != 'withdrawn' for p in people):
                raise RuntimeError('伙伴仍在其他比赛中，未调用')
    owner = people[0][1]
    plan = dict(state='planned', kind=args.kind, characters=[dict(id=p[0], name=p[2]) for p in people],
        max_requests=4, strategy_requests=2, reflection_requests=2, budget_yuan='4.80',
        duration_seconds=480 if args.kind == 'garden' else 180,
        new_model_requests=0, actual_charge='unverified',
        shares='当前有效性格描述（含已保存的自定义和主次）、本场公开信息及本人已核验行动与赛果；不含私人聊天、记忆或心情',
        images=0, audio=0, retries=0, failure_policy='首个失败停止，未完赛则取消；已结算不回滚奖励')
    if not args.execute:
        print(json.dumps(plan, ensure_ascii=False)); return

    from scripts import check_candidate_review as qa  # Isolates all other providers.
    from app.core.database import engine
    from app.living.competitions import CompetitionStore
    from app.living.competition_ai import CompetitionAIStore, CompetitionAdapter, run_suggestion
    from app.living.life_provider import BASE_URL, RESERVE_MICRO
    from app.living.life_live_planner import check_current_catalog
    from dotenv import dotenv_values
    qa.flow.generate = qa.flow.dotenv_values = qa.reject_generation
    values = dotenv_values(PROJECT / 'backend/.env')
    if values.get('MODEL_BASE_URL') != BASE_URL or not values.get('MODEL_API_KEY') or RESERVE_MICRO * 4 > 4_800_000:
        raise RuntimeError('项目配置或本批费用上限不符，未调用')
    asyncio.run(check_current_catalog())
    root = PROJECT / '.runtime/r61'
    root.mkdir(parents=True, exist_ok=True)
    receipt = root / (args.authorization_ref + '.json')
    with receipt.open('x') as target:
        json.dump(dict(plan, state='claimed'), target, ensure_ascii=False)
    receipt.chmod(0o600)
    match_id = str(uuid5(NAMESPACE_URL, 'aiwwb-r61-' + args.authorization_ref))
    plan.update(match_id=match_id, authorization_ref=args.authorization_ref)
    store, ai = CompetitionStore(engine), CompetitionAIStore(engine)
    def save():
        receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    def command(action, **kwargs):
        return store.command(owner, match_id, str(uuid4()), dict(action=action, **kwargs))
    class Counted(CompetitionAdapter):
        async def suggest(self, facts):
            if plan['new_model_requests'] >= 4:
                raise RuntimeError('本批调用上限已到')
            plan['new_model_requests'] += 1
            save()
            return await super().suggest(facts)
    def suggest(cid, phase):
        grant = ai.authorize(owner, match_id, cid, phase, f'{args.authorization_ref}-{cid}-{phase}')
        task, fresh = ai.prepare(owner, match_id, cid, phase, str(uuid4()), grant)
        if not fresh:
            raise RuntimeError('重复任务，不能再次发送')
        asyncio.run(run_suggestion(ai, task, lambda: Counted(values['MODEL_API_KEY'])))
        status = ai.status(owner, match_id)
        if next(t for t in status['tasks'] if t['id'] == task['id'])['state'] != 'done':
            raise RuntimeError('本轮未完成，停止本批')
    created = False
    try:
        store.create(owner, match_id, args.kind, '本场体验'); created = True
        for p in people:
            command('register', character_id=p[0])
        plan['state'] = 'strategy'; save()
        for p in people:
            suggest(p[0], 'strategy')
        command('start')
        plan['state'] = 'running'; save()
        wait_for_completion(store, owner, match_id)
        plan['state'] = 'reflection'; save()
        for p in people:
            suggest(p[0], 'reflection')
        plan['state'] = 'done'
    except Exception:
        plan['state'] = 'stopped'
        if created:
            current = store.read(owner, match_id)
            if current['status'] not in ('completed', 'cancelled'):
                command('cancel')
        raise RuntimeError('本批已停止；核对持久化任务，不可重跑相同授权') from None
    finally:
        plan['reserved_micro'] = plan['new_model_requests'] * RESERVE_MICRO
        if created:
            plan['tasks'] = ai.status(owner, match_id)['tasks']
        save()
    print(json.dumps({k: plan[k] for k in ('state', 'match_id', 'new_model_requests', 'reserved_micro', 'actual_charge')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
