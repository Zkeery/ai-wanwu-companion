"""Read-only plan by default. One real exchange requires new explicit authorization."""
import argparse
import asyncio
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
DATABASE = PROJECT / '.runtime/c160-review/check.db'
ROOT = PROJECT / '.runtime/r44'
GROUP = 'bb5b04ad-68db-4c8f-a5eb-442d006f13ee'
CHARACTERS = [3, 4]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--authorization-ref')
    args = parser.parse_args()
    if args.execute and not (args.authorization_ref and 8 <= len(args.authorization_ref) <= 120):
        parser.error('执行需要本批新费用授权编号，不填密钥')
    with sqlite3.connect(f'file:{DATABASE}?mode=ro', uri=True) as conn:
        rows = conn.execute('SELECT id, owner_id, name, status, current_space_id FROM characters WHERE id IN (3,4) ORDER BY id').fetchall()
        saved = conn.execute('SELECT state_json FROM life_gatherings WHERE id=?', (GROUP,)).fetchone()
        if len(rows) != 2 or not rows[0][1] or rows[0][1] != rows[1][1] or any(r[3] != 'ready' for r in rows) or not saved:
            raise RuntimeError('本人两位伙伴或共同住处未就绪')
        owner = rows[0][1]
        group = json.loads(saved[0])
        if group['closed'] or group['manager'] != owner:
            raise RuntimeError('共同住处已变化')
        if len(group['members']) != 1 or group['companions']:
            raise RuntimeError('需使用当前本人空共同住处，不改动其他成员或现有来访')
    plan = dict(group_id=GROUP, characters=[dict(id=r[0], name=r[2]) for r in rows], model='qwen3.8-flash',
        max_requests=1, budget_yuan='1.20', images=0, sends='在场名字、预设性格标签、场景及物件；不含私人聊天、记忆与自定义性格',
        restores='本轮结束后两位伙伴回原私人住处，关闭本轮参与许可', new_model_requests=0, state='planned')
    if not args.execute:
        print(json.dumps(plan, ensure_ascii=False)); return
    ROOT.mkdir(parents=True, exist_ok=True)
    receipt = ROOT / 'real-execution.json'
    plan['authorization_ref'] = args.authorization_ref
    with receipt.open('x') as target:
        json.dump(dict(plan, state='claimed'), target, ensure_ascii=False)
    from scripts import check_candidate_review as qa
    from app.core.database import engine
    from app.living.gatherings import GatheringStore
    from app.living.gathering_dialogue import DialogueStore, MaaSDialogueAdapter, run_exchange, grants
    from app.living.life_live_planner import check_current_catalog
    from app.living.life_provider import BASE_URL, RESERVE_MICRO
    from sqlalchemy import update
    from dotenv import dotenv_values
    qa.flow.generate = qa.flow.dotenv_values = qa.reject_generation
    values = dotenv_values(PROJECT / 'backend/.env')
    if values.get('MODEL_BASE_URL') != BASE_URL or not values.get('MODEL_API_KEY'):
        raise RuntimeError('本项目模型配置未就绪；未调用')
    if RESERVE_MICRO > 1_200_000:
        raise RuntimeError('价格超出本轮上限；未调用')
    asyncio.run(check_current_catalog())
    store, dialogue = GatheringStore(engine), DialogueStore(engine)
    original_enabled = group.get('dialogue_enabled', False)
    grant_id = None
    started = time.monotonic()
    def command(payload):
        current = store.read(owner, GROUP)
        return store.command(owner, GROUP, str(uuid4()), current['revision'], payload)
    class Counted(MaaSDialogueAdapter):
        async def exchange(self, facts):
            plan['new_model_requests'] += 1
            receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
            return await super().exchange(facts)
    try:
        for cid in CHARACTERS:
            command(dict(action='visit', character_id=cid))
            command(dict(action='dialogue_consent', character_id=cid, enabled=True))
        command(dict(action='dialogue_space', enabled=True))
        grant_id = dialogue.authorize(owner, GROUP, CHARACTERS, args.authorization_ref)
        current = store.read(owner, GROUP)
        task, fresh = dialogue.prepare(owner, GROUP, str(uuid4()), current['revision'], CHARACTERS, grant_id)
        if not fresh:
            raise RuntimeError('任务重复，不能重新发送')
        plan.update(state='running', task_id=task['id'])
        asyncio.run(run_exchange(dialogue, task, lambda: Counted(values['MODEL_API_KEY'])))
    finally:
        if grant_id:
            with dialogue.transaction() as conn:
                conn.execute(update(grants).where(grants.c.id == grant_id).values(used=1))
        for cid in CHARACTERS:
            current = store.read(owner, GROUP)
            if any(c['id'] == cid and c['owner_id'] == owner for c in current['companions']):
                command(dict(action='recall', character_id=cid))
        command(dict(action='dialogue_space', enabled=original_enabled))
        plan.update(state='finished', elapsed_seconds=round(time.monotonic()-started,3),
            result=dialogue.read(owner, GROUP), reserved_micro=RESERVE_MICRO if plan['new_model_requests'] else 0,
            actual_charge='unverified')
        receipt.write_text(json.dumps(plan, ensure_ascii=False, indent=2))
    print(json.dumps(plan, ensure_ascii=False))


if __name__ == '__main__':
    main()
