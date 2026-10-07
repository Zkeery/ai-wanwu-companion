"""Dry-run or submit a reviewed atlas for all three private activity slots."""
import argparse
import json
from pathlib import Path

from app.core.database import SessionLocal
from app.services.character_motion_atlas import prepare_character_atlas
from app.services.motion_bindings import MotionBindingError
from app.services.motion_sheet import MotionSheetError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--character-id", type=int, required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--atlas", type=Path, required=True)
    parser.add_argument("--reviewed-sha256")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply and not args.reviewed_sha256:
        parser.error("--apply requires --reviewed-sha256")
    try:
        with SessionLocal() as db:
            result = prepare_character_atlas(db, args.character_id, args.owner_id, args.atlas,
                apply=args.apply, reviewed_sha256=args.reviewed_sha256)
        print(json.dumps(result))
        return 0
    except (MotionBindingError, MotionSheetError, OSError, ValueError) as exc:
        code = exc.code if isinstance(exc, MotionBindingError) else "invalid_motion_atlas"
        print(json.dumps({"error": {"code": code, "message": "动作总图无法接入，请核对本人伙伴、已审素材与现有动作"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
