import copy
import json
import subprocess
from pathlib import Path
import sys

import pytest
from scripts.audit_generation_performance import audit_batch


def batch(ms=8000):
    return {'schema_version': 1, 'overflowed': False, 'samples': [{
        'sample_id': '11111111-1111-4111-8111-111111111111', 'status': 'succeeded',
        'marks': {'click': 0, 'upload_started': 20, 'recognized': 500, 'generation_started': 600,
                  'ready': 1500, 'displayed': ms, 'ended': ms}}]}


@pytest.mark.parametrize('ms,passed', [(5000.1, True), (7000, True), (7999, True), (8000, True), (8000.1, False), (14000, False)])
def test_per_request_hard_limit(ms, passed):
    result = audit_batch(batch(ms), 'mock', expected_samples=1)
    assert result['budget_ms'] == 8000
    assert result['policy_id'] == 'prd-v1.2-generation-8s-20260922'
    assert result['samples'][0]['reason'] == (None if passed else 'over_8000ms')
    assert result['batch_timing_met'] is passed
    assert result['release_passed'] is False
    assert sum(result['samples'][0]['segments_ms'].values()) == ms


def test_failures_and_slow_outliers_are_never_removed():
    data = batch(2000)
    for i, ms in enumerate([3000, 15000]):
        sample = batch(ms)['samples'][0]
        sample['sample_id'] = f'00000000-0000-4000-8000-{i:012d}'
        data['samples'].append(sample)
    data['samples'].append({'sample_id': '22222222-2222-4222-8222-222222222222', 'status': 'failed', 'marks': {'click': 0, 'ended': 12}})
    result = audit_batch(data, 'real', expected_samples=4)
    assert not result['batch_timing_met'] and not result['release_passed']
    assert result['sample_count'] == 4 and result['display_success_rate'] == .75
    assert result['displayed_only_statistics_ms'] == {'p50': 3000, 'p95': 15000, 'max': 15000}
    assert result['within_budget_count'] == 2


@pytest.mark.parametrize('status', ['failed', 'running', 'interrupted', 'needs_review'])
def test_non_displayed_requests_cannot_pass(status):
    data = batch(); sample = data['samples'][0]; sample['status'] = status
    sample['marks'].pop('displayed')
    if status == 'running': sample['marks'].pop('ended')
    assert not audit_batch(data)['batch_timing_met']


@pytest.mark.parametrize('mutation', [
    lambda b: b['samples'][0]['marks'].pop('recognized'),
    lambda b: b['samples'][0]['marks'].update(ready=float('nan')),
    lambda b: b['samples'][0]['marks'].update(ready=float('inf')),
    lambda b: b['samples'][0]['marks'].update(ready=10**1000),
    lambda b: b['samples'][0]['marks'].update(ready=-1),
    lambda b: b['samples'][0]['marks'].update(ready=True),
    lambda b: b['samples'][0]['marks'].update(ready=100),
    lambda b: b['samples'][0].update(token='must-not-be-echoed'),
    lambda b: b['samples'].append(copy.deepcopy(b['samples'][0])),
    lambda b: b.update(schema_version=True),
])
def test_rejects_corrupt_or_sensitive_payloads(mutation):
    data = batch(); mutation(data)
    with pytest.raises(ValueError, match='Invalid generation timing batch'):
        audit_batch(data)


def test_empty_and_overflow_batches_do_not_pass():
    data = batch(); data['overflowed'] = True
    assert not audit_batch(data)['batch_timing_met']
    data['samples'] = []
    result = audit_batch(data)
    assert not result['batch_timing_met'] and result['displayed_only_statistics_ms']['p95'] is None


def test_cli_preserves_existing_report_and_handles_invalid_input(tmp_path):
    script = Path(__file__).resolve().parents[1] / 'scripts/audit_generation_performance.py'
    source, target = tmp_path / 'input.json', tmp_path / 'report.json'
    source.write_text(json.dumps(batch(8000.1)))
    cmd = [sys.executable, str(script), str(source), '--output', str(target), '--mode', 'mock', '--expected-samples', '1']
    assert subprocess.run(cmd, capture_output=True).returncode == 2
    before = target.read_bytes()
    assert subprocess.run(cmd, capture_output=True).returncode == 1
    assert target.read_bytes() == before
    source.write_text('{"token":"must-not-be-echoed"}')
    result = subprocess.run(cmd, capture_output=True)
    assert b'must-not-be-echoed' not in result.stdout + result.stderr


def test_missing_samples_or_unspecified_expected_count_cannot_pass():
    assert not audit_batch(batch())['batch_timing_met']
    result = audit_batch(batch(), expected_samples=2)
    assert not result['batch_timing_met']
    assert 'sample_count_mismatch' in result['blockers']
