"""Plan one independently authorized automatic-dialogue batch; no model requests."""
import argparse
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import sqlite3
import time

from sqlalchemy import create_engine
from sqlalchemy.engine import URL

from app.living.gathering_automatic import AutomaticDialogueStore, automatic, sessions, links, viewers, receipts, limits
from app.living.life_provider import RESERVE_MICRO
from app.living.rules import LivingError
from app.living.store import metadata


def amount(raw):
    try:
        if len(raw) > 30:
            raise ValueError()
        number = Decimal(raw) * 1000000
        if not number.is_finite() or not 0 <= number <= 1000000000 or number != number.to_integral_value():
            raise ValueError()
        return int(number)
    except (ValueError, InvalidOperation, OverflowError):
        raise argparse.ArgumentTypeError('金额须为0至1000元、最多6位小数') from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--owner', required=True)
    parser.add_argument('--space', required=True)
    parser.add_argument('--characters', nargs=2, type=int, required=True)
    parser.add_argument('--rounds', type=int, choices=range(1, 11), required=True)
    parser.add_argument('--project-cap-yuan', type=amount, required=True)
    parser.add_argument('--space-cap-yuan', type=amount, required=True)
    parser.add_argument('--authorization-ref')
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    path = args.database.expanduser().resolve()
    if not path.is_file():
        parser.error('必须选择已存在的数据库，不创建新库')
    if args.execute and not args.authorization_ref:
        parser.error('执行需要本批新的明确费用授权编号')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as conn:
        row = conn.execute('SELECT state_json FROM life_gatherings WHERE id=?', (args.space,)).fetchone()
        if not row:
            parser.error('共同空间不存在')
        group = json.loads(row[0])
        if group.get('closed') or args.owner not in group['members']:
            parser.error('主人不是当前成员')
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        committed = conn.execute('SELECT COALESCE(SUM(used_rounds),0) FROM life_dialogue_auto_sessions').fetchone()[0] * RESERVE_MICRO if sessions.name in tables else 0
        space_used = conn.execute('SELECT COALESCE(SUM(used_rounds),0) FROM life_dialogue_auto_sessions WHERE group_id=?', (args.space,)).fetchone()[0] * RESERVE_MICRO if sessions.name in tables else 0
        allocated_sql = 'SELECT COALESCE(SUM(CASE WHEN stopped=0 AND expires_at>? THEN max_rounds ELSE used_rounds END),0) FROM life_dialogue_auto_sessions'
        allocated = conn.execute(allocated_sql, (int(time.time()),)).fetchone()[0]*RESERVE_MICRO if sessions.name in tables else 0
        space_allocated = conn.execute(allocated_sql+' WHERE group_id=?', (int(time.time()), args.space)).fetchone()[0]*RESERVE_MICRO if sessions.name in tables else 0
    plan = dict(mode='execute' if args.execute else 'read_only', rounds=args.rounds,
        batch_cap_micro=args.rounds*RESERVE_MICRO, project_committed_micro=committed, space_committed_micro=space_used,
        project_cap_micro=args.project_cap_yuan, space_cap_micro=args.space_cap_yuan,
        project_allocated_micro=allocated, space_allocated_micro=space_allocated,
        within_declared_limits=(allocated+args.rounds*RESERVE_MICRO <= args.project_cap_yuan
            and space_allocated+args.rounds*RESERVE_MICRO <= args.space_cap_yuan),
        valid_for_hours=24, enables_automatic=False, model_requests=0)
    if args.execute:
        engine = create_engine(URL.create('sqlite', database=str(path)), connect_args={'check_same_thread': False})
        try:
            metadata.create_all(engine, tables=[sessions, automatic, links, viewers, receipts, limits])
            plan['session_id'] = AutomaticDialogueStore(engine).authorize_session(args.owner, args.space,
                args.characters, args.rounds, args.authorization_ref,
                project_cap_micro=args.project_cap_yuan, space_cap_micro=args.space_cap_yuan)
        finally:
            engine.dispose()
    print(json.dumps(plan, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except LivingError as exc:
        print(json.dumps(exc.as_dict(), ensure_ascii=False))
        raise SystemExit(1) from None
    except (sqlite3.Error, OSError, ValueError):
        print(json.dumps({'error': {'code': 'automatic_batch_rejected', 'message': '批次未登记；请核对空间、参与许可、已有批次和累计额度。'}}, ensure_ascii=False))
        raise SystemExit(1) from None
