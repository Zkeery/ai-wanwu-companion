"""R7.5 postmortem must preserve failures and never waive browser acceptance."""
import importlib.util
import json
from pathlib import Path

import pytest

PROJECT = Path(__file__).resolve().parents[2]
SCRIPT = PROJECT / 'backend/scripts/analyze_generation_pilot.py'
RESULT = PROJECT / 'docs/PRD/版本/V1.2/验收证据/阶段7/R7.5真实首轮20260923/results.json'
spec = importlib.util.spec_from_file_location('analyze_generation_pilot', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_real_pilot_needs_model_path_change_not_only_local_download():
    result = module.analyze(json.loads(RESULT.read_text(encoding='utf-8')))
    assert (result['sample_count'], result['success_count'], result['failure_count']) == (8, 5, 3)
    assert result['local_within_8s_count'] == 0
    assert result['fastest_success_sample_id'] == 'pilot-02'
    assert result['fastest_success_model_request_pair_ms'] > 12000
    assert result['all_successful_model_request_pairs_over_8s'] is True
    assert result['release_passed'] is False
    assert [row['status'] for row in result['samples']].count('failed') == 3


def test_fast_model_pair_can_still_fail_due_to_local_segments():
    report = {'protocol_id': 'r75-candidate-pilot-v1', 'samples': [{
        'sample_id': 'one', 'status': 'succeeded', 'local_total_ms': 9000,
        'timings_ms': {'preprocess': 100, 'vision': 2000, 'image_post': 3000,
                       'download': 3800, 'decode': 100},
    }]}
    result = module.analyze(report)
    assert result['samples'][0]['model_request_pair_ms'] == 5000
    assert result['all_successful_model_request_pairs_over_8s'] is False
    assert result['local_within_8s_count'] == 0
    assert result['release_passed'] is False


@pytest.mark.parametrize('change', [
    lambda r: r['samples'].append(dict(r['samples'][0])),
    lambda r: r['samples'][0]['timings_ms'].pop('image_post'),
    lambda r: r['samples'][0]['timings_ms'].__setitem__('vision', float('nan')),
])
def test_invalid_success_cannot_be_counted_as_fast(change):
    report = {'protocol_id': 'r75-candidate-pilot-v1', 'samples': [{
        'sample_id': 'one', 'status': 'succeeded', 'local_total_ms': 7000,
        'timings_ms': {'preprocess': 100, 'vision': 2000, 'image_post': 3000,
                       'download': 1800, 'decode': 100},
    }]}
    change(report)
    with pytest.raises(ValueError):
        module.analyze(report)
