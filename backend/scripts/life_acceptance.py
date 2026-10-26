#!/usr/bin/env python3
"""Explicit independent acceptance CLI; default invocation never starts a job."""
import argparse
import json
from pathlib import Path
import socket
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.life_acceptance_worker import audit, run
from app.services.trial_gate import TrialBlocked


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('simulate', 'resume-simulated', 'prepare-approved', 'run-approved', 'audit', 'readiness'):
        cmd = sub.add_parser(name)
        if name != 'readiness':
            cmd.add_argument('--directory', required=True, type=Path)
        if name in ('simulate', 'resume-simulated'):
            cmd.add_argument('--until', type=int, default=86400)
        if name == 'simulate':
            cmd.add_argument('--scenario', choices=['timeout', 'bad-json', 'bad-usage', 'stale-proof', 'gap'])
        if name in ('prepare-approved', 'readiness'):
            cmd.add_argument('--approval-file', required=True, type=Path)
            cmd.add_argument('--evidence-file', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command in ('simulate', 'resume-simulated'):
            if not 0 <= args.until <= 86400 or args.until % 30:
                raise TrialBlocked('simulation_boundary_invalid')
            def deny(*_a, **_k):
                raise RuntimeError('simulation_network_forbidden')
            socket.socket.connect = deny
            socket.socket.connect_ex = deny
            if args.command == 'simulate':
                from app.services.life_acceptance_simulation import prepare
                prepare(args.directory, scenario=args.scenario)
            result = run(args.directory, simulated=True, until=args.until)
        elif args.command == 'readiness':
            from app.services.life_acceptance_setup import check_admission
            from app.services.trial_wiring import private_json
            from app.services.accounting_proof_refresh import read_published
            approval = private_json(args.approval_file)
            result = check_admission(approval, read_published(args.evidence_file, approval['authorization_ref']))
        elif args.command == 'prepare-approved':
            from app.services.life_acceptance_setup import prepare_approved
            result = prepare_approved(args.directory, args.approval_file, args.evidence_file)
        elif args.command == 'audit':
            result = audit(args.directory)
        else:
            # A mock manifest cannot cross this entry. No credential is inferred
            # from production settings or from a user's logged-in browser.
            result = run(args.directory, simulated=False)
        print(json.dumps(result, sort_keys=True))
        return 0 if result['status'] in ('running', 'passed', 'prepared', 'ready_for_preparation') else 2
    except Exception as error:
        # Never print exception text, provider bodies, owner identity or secrets.
        code = str(error) if isinstance(error, TrialBlocked) and str(error).replace('_', '').isalnum() else 'acceptance_command_blocked'
        print(json.dumps({'status': 'blocked', 'code': code, 'model_retry': False}))
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
