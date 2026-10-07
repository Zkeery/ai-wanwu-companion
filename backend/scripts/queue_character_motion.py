"""Submit a reviewed local activity pack for durable background binding."""
import argparse
import json
from pathlib import Path

from app.core.database import SessionLocal
from app.services.motion_bindings import MotionBindingError
from app.services.motion_preparation import submit_prepared_pack


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--character-id", type=int, required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--activity", choices=("rest", "walk", "observe"), required=True)
    parser.add_argument("--pack", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        with SessionLocal() as db:
            result = submit_prepared_pack(db, args.character_id, args.owner_id, args.pack,
                                         args.activity, apply=args.apply)
        print(json.dumps(result))
    except (MotionBindingError, OSError):
        print(json.dumps({"error": {"code": "motion_unavailable", "message": "动作素材无法入队，请核对身份与素材"}}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
