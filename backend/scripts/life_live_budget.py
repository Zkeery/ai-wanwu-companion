"""Inspect or set an explicitly approved cap for the isolated life pilot.

Read-only by default. This local operator command never makes a model request.
"""
from __future__ import annotations

import argparse
from decimal import Decimal, DecimalException
import os
from pathlib import Path
import time
from uuid import UUID

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'c16-life-live-preview'
MAX_MONEY = 10**12


def micro_yuan(raw: str) -> int:
    try:
        amount = Decimal(raw)
        micro = amount * 1_000_000
        if not amount.is_finite() or micro != micro.to_integral_value() or not 0 <= micro <= MAX_MONEY:
            raise ValueError()
        return int(micro)
    except (DecimalException, ValueError):
        raise argparse.ArgumentTypeError('请输入非负人民币金额，最多六位小数') from None


def main() -> None:
    parser = argparse.ArgumentParser(description='隔离自主生活试用额度；默认只核对，不修改')
    parser.add_argument('--space-id', required=True)
    parser.add_argument('--project-yuan', required=True, type=micro_yuan)
    parser.add_argument('--space-yuan', required=True, type=micro_yuan)
    parser.add_argument('--authorization-ref', required=True, help='新的具体费用授权记录编号，不填密钥')
    parser.add_argument('--apply', action='store_true', help='在确认授权后写入额度')
    args = parser.parse_args()

    # The command chooses its own isolated target, never the caller's default DB.
    os.environ.update({
        'APP_ENV': 'test', 'DATABASE_URL': f'sqlite:///{STATE / "preview.db"}',
        'UPLOAD_DIR': str(STATE / 'uploads'), 'LIFE_RUNTIME_PREVIEW_ENABLED': 'true',
        'LIFE_LIVE_PLANNER_PREVIEW_ENABLED': 'true',
    })
    from sqlalchemy import inspect, select
    from app.core.config import get_settings
    from app.core.database import engine
    from app.living.life_provider import RESERVE_MICRO
    from app.living.life_runtime import LifeRuntime, MAX_MONEY as RUNTIME_MAX_MONEY, mode_marker
    from app.living.store import spaces
    assert MAX_MONEY == RUNTIME_MAX_MONEY
    settings = get_settings()
    if settings.app_env != 'test' or not (settings.life_runtime_preview_enabled and
                                          settings.life_live_planner_preview_enabled):
        parser.error('仅隔离测试环境中的真实规划试用可管理额度')
    try:
        sid = str(UUID(args.space_id))
    except ValueError:
        parser.error('space-id 必须是 UUID')
    if args.project_yuan < args.space_yuan or args.space_yuan < RESERVE_MICRO:
        parser.error('项目额度须不小于空间额度，空间额度须足够预留至少一次模型请求')
    if not args.authorization_ref.strip() or len(args.authorization_ref) > 120:
        parser.error('需填写有效且不含密钥的授权记录编号')

    with engine.connect() as conn:
        if not inspect(conn).has_table(mode_marker.name):
            parser.error('数据库尚未初始化为真实规划模式')
        marker = conn.execute(select(mode_marker.c.origin).where(mode_marker.c.name == 'runtime')).scalar_one_or_none()
        if marker != 'real_provider':
            parser.error('数据库不是已标记的真实规划隔离库')
        mode = conn.execute(select(spaces.c.mode).where(spaces.c.id == sid)).scalar_one_or_none()
        if mode != 'private':
            parser.error('空间不存在或不是私人空间')

    print(f'空间 {sid}；项目上限 {Decimal(args.project_yuan) / 1_000_000:.6f} 元；'
          f'空间上限 {Decimal(args.space_yuan) / 1_000_000:.6f} 元；授权记录 {args.authorization_ref}')
    if not args.apply:
        print('只读核对完成；额度未修改，模型未调用')
        return
    runtime = LifeRuntime(engine, lambda: int(time.time()), origin='real_provider')
    runtime.set_limit('project', args.project_yuan, args.authorization_ref)
    runtime.set_limit('space:' + sid, args.space_yuan, args.authorization_ref)
    print('两级额度已写入；模型未调用')


if __name__ == '__main__':
    main()
