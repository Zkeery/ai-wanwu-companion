"""Build a reviewed, activity-classified sprite pack from a 2x2 pose sheet."""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.motion_sheet import MotionSheetError, build_sheet_motion


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--sheet", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--activity", required=True, choices=("rest", "walk", "observe"))
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(build_sheet_motion(args.source, args.sheet, args.output, activity=args.activity, write=args.write)))
        return 0
    except (MotionSheetError, OSError, ValueError, Image.DecompressionBombError):
        print(json.dumps({"error": {"code": "sheet_pack_invalid", "message": "分帧动作或输出目录无法核对"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
