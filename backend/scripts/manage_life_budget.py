"""Preview/apply explicit cumulative life caps, or close a space's unused cap.

Existing database required. Default read-only; no model calls or user opt-in.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sqlite3
import time

from scripts.life_live_budget import micro_yuan


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--space-id', required=True)
    parser.add_argument('--project-yuan', type=micro_yuan)
    parser.add_argument('--space-yuan', type=micro_yuan)
    parser.add_argument('--freeze-space', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--expected-state')
    parser.add_argument('--request-id')
    parser.add_argument('--authorization-ref')
    args = parser.parse_args()
    if not args.database.is_absolute() or args.database.is_symlink() or not args.database.is_file():
        parser.error('database须为明确的已有数据库绝对路径，不能是符号链接')
    if args.freeze_space:
        if args.project_yuan is not None or args.space_yuan is not None:
            parser.error('freeze-space不能同时指定新上限')
    elif args.project_yuan is None or args.space_yuan is None:
        parser.error('设置额度须同时指定项目及空间累计上限')
    if args.apply and not all((args.expected_state, args.request_id, args.authorization_ref)):
        parser.error('apply需要只读方案摘要、独立请求ID和本次具体授权编号')
    # ORM imports must not select or create the server's default database. These
    # process-local settings do not modify .env or enable any worker/provider.
    os.environ.update({'APP_ENV': 'development', 'DATABASE_URL': 'sqlite:///' + str(args.database.resolve()),
        'LIFE_RUNTIME_ENABLED': 'false', 'LIFE_RUNTIME_PREVIEW_ENABLED': 'false',
        'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'false', 'LIFE_SIMULATION_ENABLED': 'false'})
    from app.living.rules import LivingError
    # URI mode prevents accidental creation; ro also enforces the default in SQLite.
    uri = args.database.resolve().as_uri() + ('?mode=rw' if args.apply else '?mode=ro')
    def connection():
        conn = sqlite3.connect(uri, uri=True, timeout=5)
        conn.execute('PRAGMA foreign_keys=ON')
        return conn
    engine = None
    try:
        from sqlalchemy import create_engine
        from app.living.life_runtime import LifeRuntime
        from app.living.life_budget_admin import apply, preview
        engine = create_engine('sqlite://', creator=connection)
        runtime = LifeRuntime(engine, lambda: int(time.time()), origin='real_provider')
        desired = dict(action='freeze-space' if args.freeze_space else 'set',
                       project_cap=args.project_yuan, space_cap=args.space_yuan)
        if args.apply:
            plan, replayed = apply(runtime, args.owner_id, args.space_id, **desired,
                request_id=args.request_id, authorization_ref=args.authorization_ref, expected_state=args.expected_state)
            state = 'replayed' if replayed else 'applied'
        else:
            plan = preview(runtime, args.owner_id, args.space_id, **desired)
            state = 'planned'
        print(json.dumps({'state': state, 'amount_unit': 'micro_yuan', 'plan': plan.model_dump(),
                          'model_requests': 0, 'permission_changed': False,
                          'receipt_only': state == 'replayed',
                          'message': '仅返回历史回执，未再次修改当前额度' if state == 'replayed'
                          else '未开启用户许可或调用模型'}, ensure_ascii=False))
    except LivingError as exc:
        print(json.dumps({'error': {'code': exc.code, 'message': exc.message}}, ensure_ascii=False))
        raise SystemExit(2) from None
    except Exception:
        print(json.dumps({'error': {'code': 'budget_admin_unavailable',
                                   'message': '额度维护暂不可用，未确认写入；请使用同一请求核对'}}, ensure_ascii=False))
        raise SystemExit(2) from None
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == '__main__':
    main()
