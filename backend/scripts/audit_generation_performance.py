"""Offline browser timing audit. Never calls providers or grants product release."""
import argparse
import json
import math
from pathlib import Path
import re

GENERATION_BUDGET_MS = 8000
POLICY_ID = 'prd-v1.2-generation-8s-20260922'

STAGES = ['click', 'upload_started', 'recognized', 'generation_started', 'ready', 'displayed']
SEGMENTS = ['preflight', 'upload_recognition', 'handoff', 'generation', 'image_delivery']
STATUSES = {'running', 'succeeded', 'failed', 'interrupted', 'needs_review'}


def require(condition):
    if not condition:
        raise ValueError('Invalid generation timing batch')


def audit_batch(batch, mode='unverified', expected_samples=None):
    require(expected_samples is None or (type(expected_samples) is int and 1 <= expected_samples <= 100))
    require(mode in {'mock', 'real', 'unverified'})
    require(isinstance(batch, dict) and set(batch) == {'schema_version', 'overflowed', 'samples'})
    require(type(batch['schema_version']) is int and batch['schema_version'] == 1)
    require(type(batch['overflowed']) is bool and isinstance(batch['samples'], list) and len(batch['samples']) <= 100)
    rows, seen = [], set()
    for sample in batch['samples']:
        require(isinstance(sample, dict) and set(sample) == {'sample_id', 'status', 'marks'})
        ident, status, marks = sample['sample_id'], sample['status'], sample['marks']
        require(isinstance(ident, str) and re.fullmatch(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}', ident) is not None)
        require(ident.lower() not in seen); seen.add(ident.lower())
        require(isinstance(status, str) and status in STATUSES and isinstance(marks, dict))
        require(set(marks) <= set(STAGES + ['ended']) and marks.get('click') == 0)
        for value in marks.values():
            require(type(value) in (int, float) and 0 <= value <= 9_007_199_254_740_991 and math.isfinite(value))
        reached = [stage for stage in STAGES if stage in marks]
        require(reached == STAGES[:len(reached)])
        times = [marks[stage] for stage in reached]
        require(all(a <= b for a, b in zip(times, times[1:])))
        if status == 'running':
            require('ended' not in marks and 'displayed' not in marks)
        else:
            require('ended' in marks and marks['ended'] >= times[-1])
        if status == 'succeeded':
            require(reached == STAGES and marks['displayed'] == marks['ended'])
        else:
            require('displayed' not in marks)
        total = marks.get('ended')
        segments = {name: marks[b] - marks[a] if a in marks and b in marks else None
                    for name, a, b in zip(SEGMENTS, STAGES, STAGES[1:])}
        passed = status == 'succeeded' and total <= GENERATION_BUDGET_MS
        rows.append({'sample_id': ident, 'status': status, 'total_ms': total,
                     'segments_ms': segments, 'within_budget': passed,
                     'reason': None if passed else 'over_8000ms' if status == 'succeeded' else status})
    complete = sorted(row['total_ms'] for row in rows if row['status'] == 'succeeded')
    def percentile(fraction):
        return complete[max(0, math.ceil(fraction * len(complete)) - 1)] if complete else None
    blockers = []
    if expected_samples is None: blockers.append('expected_count_missing')
    elif len(rows) != expected_samples: blockers.append('sample_count_mismatch')
    if not rows: blockers.append('empty_batch')
    if batch['overflowed']: blockers.append('overflowed_batch')
    if any(not row['within_budget'] for row in rows): blockers.append('nonpassing_samples')
    if mode != 'real': blockers.append('real_provider_not_verified')
    return {
        'schema_version': 1, 'budget_ms': GENERATION_BUDGET_MS, 'policy_id': POLICY_ID, 'declared_mode': mode, 'provider_calls_by_auditor': 0,
        'sample_count': len(rows), 'expected_samples': expected_samples, 'displayed_count': len(complete),
        'display_success_rate': len(complete) / len(rows) if rows else 0,
        'within_budget_count': sum(row['within_budget'] for row in rows),
        'batch_timing_met': bool(rows) and len(rows) == expected_samples and not batch['overflowed'] and all(row['within_budget'] for row in rows),
        'displayed_only_statistics_ms': {'p50': percentile(.5), 'p95': percentile(.95), 'max': max(complete) if complete else None},
        'samples': rows, 'blockers': blockers, 'release_passed': False,
        'limitation': 'Timing only. Mode is operator-declared, not provider verification. Quality, uniqueness, cost and coverage require separate acceptance.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--expected-samples', type=int, required=True)
    parser.add_argument('--mode', choices=['mock', 'real', 'unverified'], default='unverified')
    args = parser.parse_args()
    try:
        require(args.input.stat().st_size <= 2_000_000)
        result = audit_batch(json.loads(args.input.read_text()), args.mode, args.expected_samples)
        # Exclusive creation retains every earlier report, including failures.
        with args.output.open('x') as target:
            json.dump(result, target, ensure_ascii=False, indent=2, allow_nan=False)
            target.write('\n')
    except (OSError, ValueError, TypeError, RecursionError):
        print('Audit rejected: invalid input or unavailable output; existing reports are retained.')
        return 1
    print(json.dumps({'sample_count': result['sample_count'], 'batch_timing_met': result['batch_timing_met'], 'release_passed': False}))
    return 0 if result['batch_timing_met'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
