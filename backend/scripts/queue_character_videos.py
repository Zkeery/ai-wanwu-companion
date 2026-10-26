"""Offline three-video validation/delivery. Dry-run by default; no generation."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--character-id', type=int, required=True)
    p.add_argument('--owner-id', required=True)
    for a in ('rest', 'walk', 'observe'):
        p.add_argument('--' + a, type=Path, required=True)
    mode = p.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--stage-candidates', action='store_true')
    p.add_argument('--review-file', type=Path)
    args = p.parse_args(argv)
    from app.core.database import SessionLocal
    from app.services.character_motion_video import ACTIVITIES, prepare_character_videos
    from app.services.motion_bindings import MotionBindingError
    from app.services.trial_wiring import private_json
    try:
        review = private_json(args.review_file) if args.review_file else None
        with SessionLocal() as db:
            videos = {a: getattr(args, a) for a in ACTIVITIES}
            if args.stage_candidates:
                from app.services.video_motion_candidates import register
                result = register(db, args.character_id, args.owner_id, videos)
            else:
                result = prepare_character_videos(db, args.character_id, args.owner_id,
                    videos, apply=args.apply, review=review)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, MotionBindingError) else 'motion_video_delivery_blocked'
        print(json.dumps({'status': 'blocked', 'code': code, 'new_model_requests': 0}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
