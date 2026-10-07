"""Explicit offline import. Dry-run by default; never generates assets."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--character-id", required=True, type=int)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--pack-dir", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--activity", choices=("rest", "walk", "observe"))
    args = parser.parse_args()
    from sqlalchemy.exc import SQLAlchemyError
    from app.core.database import SessionLocal
    from app.models.models import CharacterMotionAsset, CharacterActivityMotionAsset
    from app.services.motion_bindings import MotionBindingError, import_motion_pack, import_activity_motion_pack
    try:
        with SessionLocal() as db:
            # Table creation is reserved for the explicitly requested write mode.
            if args.apply:
                (CharacterActivityMotionAsset if args.activity else CharacterMotionAsset).__table__.create(
                    db.get_bind(), checkfirst=True)
            result = (import_activity_motion_pack(db, args.character_id, args.owner_id, args.pack_dir,
                                                  args.activity, apply=args.apply) if args.activity else
                      import_motion_pack(db, args.character_id, args.owner_id, args.pack_dir, apply=args.apply))
        print(json.dumps(result))
        return 0
    except MotionBindingError as exc:
        print(json.dumps({"error": {"code": exc.code, "message": str(exc)}}, ensure_ascii=False))
        return 1
    except (SQLAlchemyError, OSError):
        print(json.dumps({"error": {"code": "motion_import_unavailable", "message": "动作导入环境暂不可用"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
