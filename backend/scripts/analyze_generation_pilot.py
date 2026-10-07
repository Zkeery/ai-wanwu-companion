"""Summarize an existing R7.5 pilot without network access or model calls."""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

LIMIT_MS = 8000.0
REQUIRED_SEGMENTS = ('preprocess', 'vision', 'image_post', 'download', 'decode')


def _milliseconds(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f'Invalid {name}')
    return float(value)


def analyze(report: dict) -> dict:
    if not isinstance(report, dict) or report.get('protocol_id') != 'r75-candidate-pilot-v1':
        raise ValueError('Expected an R7.5 pilot report')
    samples = report.get('samples')
    if not isinstance(samples, list) or not samples:
        raise ValueError('Pilot samples are missing')

    rows = []
    seen = set()
    for sample in samples:
        if not isinstance(sample, dict):
            raise ValueError('Invalid pilot sample')
        sample_id = sample.get('sample_id')
        if not isinstance(sample_id, str) or not sample_id or sample_id in seen:
            raise ValueError('Missing or duplicate sample ID')
        seen.add(sample_id)
        status = sample.get('status')
        if status not in ('succeeded', 'failed'):
            raise ValueError(f'Invalid status for {sample_id}')
        total = _milliseconds(sample.get('local_total_ms'), f'{sample_id} total')
        row = {'sample_id': sample_id, 'status': status, 'local_total_ms': round(total, 3),
               'local_within_8s': status == 'succeeded' and total <= LIMIT_MS}
        if status == 'succeeded':
            timings = sample.get('timings_ms')
            if not isinstance(timings, dict):
                raise ValueError(f'Missing timings for {sample_id}')
            parts = {name: _milliseconds(timings.get(name), f'{sample_id} {name}')
                     for name in REQUIRED_SEGMENTS}
            model_pair = parts['vision'] + parts['image_post']
            if model_pair > total + 1:
                raise ValueError(f'Model segments exceed total for {sample_id}')
            row.update(vision=sample.get('vision'), image=sample.get('image'),
                       model_request_pair_ms=round(model_pair, 3),
                       other_local_ms=round(max(0.0, total - model_pair), 3),
                       model_request_pair_over_8s=model_pair > LIMIT_MS)
        else:
            row['error_type'] = sample.get('error_type') if isinstance(sample.get('error_type'), str) else None
        rows.append(row)

    successful = [row for row in rows if row['status'] == 'succeeded']
    fastest = min(successful, key=lambda row: row['local_total_ms']) if successful else None
    return {
        'source_protocol_id': report['protocol_id'],
        'sample_count': len(rows),
        'success_count': len(successful),
        'failure_count': len(rows) - len(successful),
        'local_within_8s_count': sum(row['local_within_8s'] for row in rows),
        'fastest_success_sample_id': fastest['sample_id'] if fastest else None,
        'fastest_success_local_total_ms': fastest['local_total_ms'] if fastest else None,
        'fastest_success_model_request_pair_ms': fastest['model_request_pair_ms'] if fastest else None,
        'all_successful_model_request_pairs_over_8s': bool(successful) and all(
            row['model_request_pair_over_8s'] for row in successful),
        'scope': 'local preprocessing through download and decode; excludes browser upload and display',
        'release_passed': False,
        'samples': rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    result = analyze(json.loads(args.input.read_text(encoding='utf-8')))
    with args.output.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write('\n')
    print(f"{result['success_count']}/{result['sample_count']} successful; "
          f"{result['local_within_8s_count']} locally within 8s; release_passed=false")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
