"""One approved real-life acceptance request in the existing 3050/8048 review.

Default: inspect only, without reading credentials, changing data or networking.
Never creates a budget without --execute and a concrete authorization reference.
"""
import argparse
import asyncio
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / '.runtime' / 'c169'
DATABASE = PROJECT / '.runtime' / 'c160-review' / 'check.db'
SPACE = '5cdc8bd2-c97d-4e54-befd-34cc6f584ceb'
CHARACTER = 4
CAP = 1_200_000


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--authorization-ref')
    args = parser.parse_args()
    if args.execute and not (args.authorization_ref and 8 <= len(args.authorization_ref) <= 120):
        parser.error('执行需要本次已确认的费用授权记录编号，不填密钥')
    with sqlite3.connect(f'file:{DATABASE}?mode=ro', uri=True) as conn:
        row = conn.execute('SELECT owner_id FROM characters WHERE id=?', (CHARACTER,)).fetchone()
        if row is None:
            raise RuntimeError('本人4号伙伴不存在')
    plan = {'character_id': CHARACTER, 'space_id': SPACE, 'model': 'qwen3.8-flash',
            'max_requests': 1, 'budget_yuan': '1.20', 'image_requests': 0,
            'activities': ['rest', 'walk'], 'automatic': False,
            'reason': '现有空间无可观察物件；只在休息与散步中选择',
            'state': 'planned', 'new_model_requests': 0}
    if not args.execute:
        print(json.dumps(plan, ensure_ascii=False))
        return

    # Claim the single execution before grants, tasks or external calls. Unknown
    # outcomes retain this receipt; rerunning this command is always rejected.
    ROOT.mkdir(parents=True, exist_ok=True)
    receipt = ROOT / 'real-execution.json'
    with receipt.open('x') as target:
        json.dump({**plan, 'state': 'claimed', 'authorization_ref': args.authorization_ref}, target)

    from scripts import check_candidate_review as qa
    from app.api.life_runtime import live_runtime as runtime
    from app.living.life_live_planner import run_real_planner, check_current_catalog
    from app.living.life_provider import MaaSPlannerAdapter, BASE_URL, RESERVE_MICRO
    from app.living.life_runtime import limits
    from sqlalchemy import select
    from dotenv import dotenv_values
    qa.flow.generate = qa.flow.dotenv_values = qa.reject_generation
    owner = row[0]
    runtime.initialize()
    state = runtime.snapshot(owner, SPACE)
    if state.tasks or state.permission.enabled or (state.automatic and state.automatic.enabled):
        raise RuntimeError('空间已有生活任务或许可，不能覆盖；未调用模型')
    budget = runtime.read_budget(owner, SPACE)
    if budget.cap or budget.committed:
        raise RuntimeError('空间已有预算，不能复用；未调用模型')
    with runtime.engine.connect() as conn:
        if any(json.loads(payload)['cap'] > 0 for payload in conn.execute(select(limits.c.payload)).scalars()):
            raise RuntimeError('项目存在其他预算，不能覆盖；未调用模型')
    values = dotenv_values(PROJECT / 'backend' / '.env')
    if values.get('MODEL_BASE_URL') != BASE_URL or not values.get('MODEL_API_KEY'):
        raise RuntimeError('本项目规划配置未就绪；未调用模型')
    if not RESERVE_MICRO <= CAP < 2 * RESERVE_MICRO:
        raise RuntimeError('预算无法确保最多一次请求')
    asyncio.run(check_current_catalog())
    tid = str(uuid4())
    runtime.save_permission(owner, SPACE, str(uuid4()), state.permission.revision, True, ('rest', 'walk'))
    runtime.schedule(owner, SPACE, tid, 'viewing')
    plan.update(state='running', task_id=tid, authorization_ref=args.authorization_ref)
    receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    started = time.monotonic()
    class CountedAdapter(MaaSPlannerAdapter):
        async def plan(self, prompt):
            plan['new_model_requests'] += 1
            receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
            return await super().plan(prompt)
    try:
        runtime.set_limit('project', CAP, args.authorization_ref)
        runtime.set_limit('space:' + SPACE, CAP, args.authorization_ref)
        asyncio.run(run_real_planner(runtime, owner, SPACE, tid,
                    lambda: CountedAdapter(values['MODEL_API_KEY'])))
    finally:
        final_budget = runtime.read_budget(owner, SPACE)
        # Keep all unsettled costs reserved; remove unused spending authority.
        runtime.set_limit('space:' + SPACE, final_budget.committed, args.authorization_ref + '-closed')
        runtime.set_limit('project', final_budget.committed, args.authorization_ref + '-closed')
        result = runtime.snapshot(owner, SPACE).model_dump(mode='json')
        plan.update(state='finished', elapsed_seconds=round(time.monotonic() - started, 3),
                    snapshot=result, budget=runtime.read_budget(owner, SPACE).model_dump(mode='json'))
        receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    print(json.dumps({'state': result['tasks'][0]['state'], 'activity': result['tasks'][0]['activity'],
                      'elapsed_seconds': plan['elapsed_seconds']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
