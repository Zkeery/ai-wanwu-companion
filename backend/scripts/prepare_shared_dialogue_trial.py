"""Check an explicit independent approval; --create only creates a new ledger.

Never writes evidence, creates a business grant, changes flags, or sends requests.
The supplied reviewed proof must already contain complete official liabilities.
"""
import argparse
import json
from pathlib import Path
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.accounting_proof_refresh import _private, read_published
from app.services.daily_model_quota import DailyModelQuota
from app.services.trial_admission import validate_shared_dialogue_approval
from app.services.trial_gate import TrialBlocked, TrialGate


def prepare(approval, evidence, ledger, daily_path, *, create=False, clock=time.time):
    policy, _ = _private(Path(approval))
    proof = read_published(Path(evidence), policy.get('authorization_ref'))
    now = int(clock())
    admission = validate_shared_dialogue_approval(policy, proof, now)
    ledger, daily_path = Path(ledger), Path(daily_path)
    if (ledger.exists() or ledger.is_symlink() or not ledger.parent.is_dir()
            or ledger.parent.stat().st_mode & 0o077 or not daily_path.is_file()
            or daily_path.is_symlink() or ledger.resolve() == daily_path.resolve()
            or str(ledger.resolve()).startswith(str(daily_path.resolve()) + '-')):
        raise TrialBlocked('fresh_private_shared_ledger_required')
    # Default check never opens SQLite, including WAL/SHM readers. The global
    # authorization binding is checked atomically only by explicit creation.
    result = dict(status='checked', mode='shared_dialogue', max_requests=1,
                  reserved_micro=1145600, budget_micro=policy['budget_micro'],
                  ends_at=policy['ends_at'], proof_expires_at=admission['expires_at'],
                  authorization_binding_checked=False,
                  ledger_created=False, grant_created=False, flags_changed=False,
                  worker_started=False, new_model_posts=0)
    if create:
        daily = DailyModelQuota(daily_path, 30, clock=clock)
        TrialGate.create(ledger, daily, policy, clock=clock)
        result.update(status='prepared_not_started', ledger_created=True, authorization_binding_checked=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--approval', required=True, help='Reviewed private policy JSON; a new shared-dialogue- authorization_ref is required')
    parser.add_argument('--evidence', required=True, help='Existing private official complete-funds and exact-price proof')
    parser.add_argument('--ledger', required=True, help='Fresh ledger path in an existing private directory')
    parser.add_argument('--daily-quota', required=True, help='Existing project daily quota database')
    parser.add_argument('--create', action='store_true', help='Explicitly create only the new ledger after all checks; default is read-only check')
    args = parser.parse_args()
    try:
        result = prepare(args.approval, args.evidence, args.ledger, args.daily_quota, create=args.create)
    except Exception:
        print(json.dumps(dict(status='blocked', new_model_posts=0, worker_started=False)))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
