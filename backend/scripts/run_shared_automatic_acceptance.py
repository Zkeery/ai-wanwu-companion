"""Trusted maintenance for the user-approved 2026-10-01 two-round / 3-yuan batch.

No model is called here: only the explicitly started persistent service dispatches.
The receipt blocks reseeding; status is read-only. Do not reuse this authorization.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

from sqlalchemy import create_engine, select, update
from app.living.gathering_automatic import AutomaticDialogueStore, sessions, limits
from app.living.gatherings import visits
from app.living.life_provider import RESERVE_MICRO

PROJECT = Path(__file__).resolve().parents[2]
DATABASE = PROJECT / '.runtime/c160-review/check.db'
ROOT = PROJECT / '.runtime/r49-real-automatic'
RECEIPT = ROOT / 'execution.json'
GROUP = 'bb5b04ad-68db-4c8f-a5eb-442d006f13ee'
IDS = [3, 4]
AUTHORIZATION = 'r49-20261001-user-approved-2-rounds-max-3-yuan'


def save(value):
    ROOT.mkdir(exist_ok=True, mode=0o700)
    temporary = ROOT / 'execution.tmp'
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f, ensure_ascii=False)
    os.replace(temporary, RECEIPT)


def read_status():
    receipt = json.loads(RECEIPT.read_text())
    with sqlite3.connect(DATABASE.as_uri() + '?mode=ro', uri=True) as conn:
        conn.row_factory = sqlite3.Row
        batch = conn.execute('SELECT * FROM life_dialogue_auto_sessions WHERE id=?', (receipt['session_id'],)).fetchone()
        setting = conn.execute('SELECT * FROM life_dialogue_automatic WHERE group_id=?', (GROUP,)).fetchone()
        rows = conn.execute('SELECT t.* FROM life_dialogue_tasks t JOIN life_dialogue_auto_tasks l ON l.task_id=t.id WHERE l.session_id=? ORDER BY t.created_at,t.id', (receipt['session_id'],)).fetchall()
        group = json.loads(conn.execute('SELECT state_json FROM life_gatherings WHERE id=?', (GROUP,)).fetchone()[0])
        evidence = []
        for row in rows:
            result = json.loads(row['result_json']) if row['result_json'] else None
            event = next((e for e in group['events'] if result is not None and e.get('lines') == result
                          and row['created_at'] <= e['at'] <= row['created_at']+60), None)
            evidence.append(dict(id=row['id'], state=row['state'], created_at=row['created_at'], dispatched=bool(row['dispatched']),
                                 error_code=row['error_code'], event_id=event['id'] if event else None,
                                 event_at=event['at'] if event else None,
                                 recent_exchange_ids=[e['event_id'] for e in json.loads(row['facts_json']).get('recent_exchanges', [])]))
        return dict(phase=receipt['phase'], session_id=receipt['session_id'], used_rounds=batch['used_rounds'],
                    committed_micro=batch['used_rounds']*RESERVE_MICRO, stopped=bool(batch['stopped']),
                    enabled=bool(setting['enabled']) if setting else False,
                    next_at=setting['next_at'] if setting else None,
                    stop_reason=setting['stop_reason'] if setting else None,
                    today_count=setting['today_count'] if setting else 0,
                    tasks=evidence,
                    visitors=list(group['companions']), dialogue_enabled=group['dialogue_enabled'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['prepare', 'start', 'status', 'finish'])
    args = parser.parse_args()
    if args.phase == 'status':
        print(json.dumps(read_status(), ensure_ascii=False)); return
    if not DATABASE.is_file():
        raise ValueError('Existing project database required')
    engine = create_engine(f'sqlite:///{DATABASE}', connect_args={'check_same_thread': False})
    store = AutomaticDialogueStore(engine)
    def command(owner, payload):
        with engine.connect() as conn:
            _, revision = store.load(conn, GROUP)
        return store.command(owner, GROUP, str(uuid4()), revision, payload)
    if args.phase == 'prepare':
        if RECEIPT.exists():
            raise ValueError('Batch already prepared; never reseed')
        with engine.connect() as conn:
            group, _ = store.load(conn, GROUP)
            if group['closed'] or group['companions'] or len(group['members']) != 1:
                raise ValueError('Original membership or locations changed')
            owner = group['manager']
            if conn.execute(select(visits.c.character_id).where(visits.c.character_id.in_(IDS))).first():
                raise ValueError('Participants already away from home')
            if conn.execute(select(sessions.c.id)).first():
                raise ValueError('Automatic authorization is no longer empty')
        receipt = dict(phase='preparing', created_at=int(time.time()), owner=owner,
                       original_dialogue_enabled=group['dialogue_enabled'], authorization_ref=AUTHORIZATION,
                       start_request_id=str(uuid4()), start_revision=0)
        save(receipt)
        for cid in IDS:
            command(owner, dict(action='visit', character_id=cid))
            command(owner, dict(action='dialogue_consent', character_id=cid, enabled=True))
        command(owner, dict(action='dialogue_space', enabled=True))
        receipt['session_id'] = store.authorize_session(owner, GROUP, IDS, 2, AUTHORIZATION,
                                                       project_cap_micro=3000000, space_cap_micro=3000000)
        receipt['start_revision'] = store.status(owner, GROUP)['revision']
        receipt['phase'] = 'prepared'; save(receipt)
    else:
        receipt = json.loads(RECEIPT.read_text()); owner = receipt['owner']
        if args.phase == 'start':
            if receipt['phase'] != 'prepared':
                raise ValueError('Use status; do not start a previously started batch')
            receipt.update(phase='starting', started_at=int(time.time())); save(receipt)
            store.configure(owner, GROUP, receipt['start_request_id'], receipt['start_revision'], True, receipt['session_id'])
            receipt['phase'] = 'running'; save(receipt)
        else:
            status = store.status(owner, GROUP)
            if status['enabled']:
                store.configure(owner, GROUP, str(uuid4()), status['revision'], False)
            with store.transaction() as conn:
                conn.execute(update(sessions).where(sessions.c.id == receipt['session_id']).values(stopped=1))
                used = store._budget(conn)['committed_micro']
                space_used = store._budget(conn, GROUP)['committed_micro']
                for scope, cap in [('project', used), ('space:' + GROUP, space_used)]:
                    conn.execute(update(limits).where(limits.c.scope == scope).values(cap_micro=cap))
            for cid in IDS:
                with engine.connect() as conn:
                    group, _ = store.load(conn, GROUP)
                if str(cid) in group['companions']:
                    command(owner, dict(action='recall', character_id=cid))
            command(owner, dict(action='dialogue_space', enabled=receipt['original_dialogue_enabled']))
            receipt.update(phase='finished', finished_at=int(time.time())); save(receipt)
    engine.dispose()
    print(json.dumps(read_status(), ensure_ascii=False))


if __name__ == '__main__':
    main()
