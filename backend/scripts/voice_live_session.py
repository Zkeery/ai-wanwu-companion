"""Explicit target plan by default. Prepare never enables or sends a voice round."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database', required=True, type=Path)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--character-id', required=True, type=int)
    parser.add_argument('--prepare', action='store_true')
    parser.add_argument('--approval-file', type=Path)
    parser.add_argument('--evidence-file', type=Path)
    parser.add_argument('--daily-quota', type=Path)
    parser.add_argument('--directory', type=Path)
    args = parser.parse_args(argv)
    from sqlalchemy import create_engine
    from app.services.trial_gate import TrialBlocked
    from app.services.voice_acceptance_setup import plan, prepare
    from app.services.trial_wiring import private_json
    engine = None
    try:
        if args.database.is_symlink() or not args.database.is_file():
            raise TrialBlocked('existing_database_required')
        # SQLite mode=ro also prevents SQLAlchemy from creating an empty file.
        engine = create_engine('sqlite:///file:' + str(args.database.resolve()) + '?mode=ro&uri=true')
        result = plan(engine, args.owner_id, args.character_id)
        if args.prepare:
            if not all((args.approval_file, args.evidence_file, args.daily_quota, args.directory)):
                raise TrialBlocked('complete_preparation_inputs_required')
            approval, evidence = private_json(args.approval_file), private_json(args.evidence_file)
            if approval.get('owner_id') != args.owner_id or approval.get('character_id') != args.character_id:
                raise TrialBlocked('voice_target_scope_mismatch')
            if args.daily_quota.is_symlink() or not args.daily_quota.is_file():
                raise TrialBlocked('existing_daily_quota_required')
            engine.dispose()
            engine = create_engine('sqlite:///' + str(args.database.resolve()))
            from app.core.config import get_settings
            from app.services.cloud_speech import project_tts_key
            from app.services.daily_model_quota import DailyModelQuota
            result = prepare(engine, get_settings(), DailyModelQuota(args.daily_quota, 30),
                             project_tts_key(), approval, evidence, args.directory)
        print(json.dumps(result, sort_keys=True))
        return 0
    except Exception as error:
        code = str(error) if isinstance(error, TrialBlocked) else 'voice_preparation_blocked'
        print(json.dumps({'status': 'blocked', 'code': code, 'new_model_posts': 0}))
        return 2
    finally:
        if engine is not None:
            engine.dispose()


if __name__ == '__main__':
    raise SystemExit(main())
