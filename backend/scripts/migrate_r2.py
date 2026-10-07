"""R2 结构迁移：给已有开发库加账号列并建新表，幂等、先备份。

用法（backend 目录）：.venv/bin/python scripts/migrate_r2.py
全新环境无需此脚本（应用启动时 create_all）；本脚本用于已有 app.db 的增量加列。
旧花园数据转换不在本脚本内：由登录后的 POST /api/v1/auth/claim 显式认领并迁移。
"""
from __future__ import annotations

import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import get_settings
from app.core.database import Base, engine
from app.living.store import LivingStore

COLUMNS = {
    "characters": [("owner_id", "VARCHAR(36)"), ("current_space_id", "VARCHAR(36)")],
    "photos": [("owner_id", "VARCHAR(36)")],
    "photo_requests": [("owner_id", "VARCHAR(36)")],
}


def main() -> int:
    settings = get_settings()
    raw = settings.database_url.replace("sqlite:///", "")
    if raw in ("", ":memory:"):
        print("数据库为内存库，无需结构迁移。")
        return 0
    db_path = Path(raw).resolve()
    if not db_path.exists():
        print(f"未找到 {db_path}，将直接建表（新环境）。")
    else:
        backup_dir = db_path.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"app-{datetime.now():%Y%m%d-%H%M%S}.db"
        shutil.copy2(db_path, backup)
        print(f"已备份到 {backup}")

    conn = sqlite3.connect(db_path)
    try:
        for table, columns in COLUMNS.items():
            existing = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
            for name, type_ in columns:
                if name not in existing:
                    conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {type_}")
                    print(f"  {table} 增加列 {name}")
                else:
                    print(f"  {table} 已有列 {name}，跳过")
        conn.commit()
    finally:
        conn.close()

    Base.metadata.create_all(bind=engine)
    LivingStore(engine).initialize()
    print("结构迁移完成；旧花园数据请在登录后调用 POST /api/v1/auth/claim 认领迁移。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
