#!/usr/bin/env python3
"""Private financial snapshot bridge; no cloud API, credential or model call."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.accounting_proof_refresh import check, refresh
from app.services.trial_gate import TrialBlocked


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('check', 'refresh'), nargs='?', default='check')
    parser.add_argument('--directory', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = (check if args.command == 'check' else refresh)(args.directory)
    except Exception as error:
        result = {'status': 'blocked', 'code': str(error) if isinstance(error, TrialBlocked)
                  else 'financial_refresh_failed', 'new_model_posts': 0, 'worker_started': False}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] in ('disabled', 'ready', 'ready_for_publication') else 2


if __name__ == '__main__':
    raise SystemExit(main())
