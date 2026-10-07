"""Create/revoke private login invitations. Never print credential values."""
import argparse
import json
import os
from pathlib import Path
import stat

from sqlalchemy.engine import make_url

from app.core.config import get_settings


def main() -> int:
    parser = argparse.ArgumentParser(description="私密邀请码维护；明文仅写私有文件")
    parser.add_argument("action", choices=["create", "revoke"])
    parser.add_argument("--user-id", help="可选：为既有账号签发；撤销时必填")
    parser.add_argument("--days", type=int, default=30)
    args = parser.parse_args()
    settings = get_settings()
    if settings.auth_mode != "invite":
        parser.error("AUTH_MODE must be invite")
    if args.action == "revoke" and not args.user_id:
        parser.error("revoke requires --user-id")
    database = make_url(settings.database_url)
    if database.get_backend_name() != "sqlite" or not database.database or database.database == ":memory:":
        parser.error("persistent SQLite is required")
    root = Path(database.database).parent / "private-invites"
    if root.is_symlink():
        parser.error("private directory must not be a symlink")
    root.mkdir(mode=0o700, exist_ok=True)
    if stat.S_IMODE(root.stat().st_mode) & 0o077:
        parser.error("private directory must have mode 0700")
    from app.core.database import SessionLocal
    from app.services.invites import provision, revoke
    output = None
    try:
        with SessionLocal() as db:
            if args.action == "revoke":
                revoke(db, args.user_id)
                print(json.dumps({"revoked": True, "user_id": args.user_id}))
                return 0
            code, user_id = provision(db, days=args.days, user_id=args.user_id)
            from uuid import uuid4
            output = root / f"{uuid4()}.json"
            fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                json.dump({"user_id": user_id, "code": code, "valid_days": args.days}, file)
                file.flush()
                os.fsync(file.fileno())
            db.commit()
            print(json.dumps({"created": True, "user_id": user_id, "private_file": str(output)}))
        return 0
    except Exception:
        if output is not None:
            output.unlink(missing_ok=True)
        print(json.dumps({"error": {"code": "invite_operation_failed", "message": "邀请码操作失败，未回显敏感详情"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
