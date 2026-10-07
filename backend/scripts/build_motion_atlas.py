"""Validate/build three local candidate activity packs from one 4x3 atlas."""
import argparse
import json
from pathlib import Path

from app.services.motion_atlas import atlas_prompt, build_motion_atlas
from app.services.motion_sheet import MotionSheetError


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--atlas", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--prompt", action="store_true")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    if args.prompt:
        print(atlas_prompt())
        return 0
    if not all((args.source, args.atlas, args.output)):
        parser.error("--source, --atlas and --output are required")
    try:
        print(json.dumps(build_motion_atlas(args.source, args.atlas, args.output, write=args.write)))
        return 0
    except (MotionSheetError, OSError, ValueError):
        print(json.dumps({"error": {"code": "invalid_motion_atlas", "message": "原图、姿态总图或输出目录不符合约定"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
