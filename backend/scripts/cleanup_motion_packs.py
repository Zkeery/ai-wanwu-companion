"""Only process persisted deletion tasks; dry-run by default."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    from sqlalchemy import inspect
    from sqlalchemy.exc import SQLAlchemyError
    from app.core.database import SessionLocal
    from app.models.models import MotionCleanupTask
    from app.services.motion_cleanup import cleanup_pending_motion
    try:
        with SessionLocal() as db:
            if not inspect(db.get_bind()).has_table(MotionCleanupTask.__tablename__):
                print(json.dumps({"inspected": 0, "removed": 0, "apply": args.apply}))
                return 0
            print(json.dumps(cleanup_pending_motion(db, apply=args.apply)))
        return 0
    except (SQLAlchemyError, OSError):
        print(json.dumps({"error": {"code": "motion_cleanup_unavailable", "message": "动作清理环境暂不可用"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
