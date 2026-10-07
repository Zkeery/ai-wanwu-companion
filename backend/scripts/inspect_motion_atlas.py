"""Inspect an atlas offline. Exit 0 means needs human review; 2 means rejected."""
import argparse
import json
from pathlib import Path

from app.services.motion_atlas_quality import inspect_atlas
from app.services.motion_sheet import MotionSheetError


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas", type=Path, required=True)
    parser.add_argument("--expected-background", choices=("transparent",))
    args = parser.parse_args()
    try:
        result = inspect_atlas(args.atlas, expected_background=args.expected_background)
    except MotionSheetError:
        result = {"state": "rejected", "error": {"code": "invalid_atlas", "message": "Invalid atlas image"}}
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    raise SystemExit(2 if result["state"] == "rejected" else 0)


if __name__ == "__main__":
    main()
