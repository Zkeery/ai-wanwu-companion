"""Offline motion production from an existing image and hand-authored rig."""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.motion_builder import MotionBuildError, build_motion_pack


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--rig", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(build_motion_pack(args.source, args.rig, args.output, write=args.write)))
        return 0
    except (MotionBuildError, OSError, ValueError):
        print(json.dumps({"error": {"code": "motion_build_failed", "message": "动作制作未完成，请核对源图、标注和输出目录"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
