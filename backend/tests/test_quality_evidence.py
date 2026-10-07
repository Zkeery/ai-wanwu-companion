"""Synthetic evidence contracts, not real photographic/model quality scores."""
from copy import deepcopy
from io import BytesIO

from PIL import Image
import pytest

from scripts import check_quality_evidence as gate


@pytest.fixture
def evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(gate, 'PROJECT', tmp_path)
    image = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    for y in (0, 512):
        for x in (0, 512):
            image.paste((100, 140, 100, 255), (x+50, y+50, x+450, y+450))
    file = BytesIO()
    image.save(file, format='PNG')
    raw = file.getvalue()
    (tmp_path/'output.png').write_bytes(raw)
    plan = {'cases': [{'case_id': cid, 'sha256': 'source-'+cid} for cid in gate.IDS]}
    plan_hash = gate.fingerprint(plan)
    results = dict(plan_sha256=plan_hash, evidence_origin='real_provider', cases=[])
    reviews = dict(plan_sha256=plan_hash, reviewer_ref='synthetic-test-reviewer', decisions=[])
    for cid in gate.IDS:
        row = dict(case_id=cid, source_sha256='source-'+cid, stages={})
        for stage, criteria in gate.CRITERIA.items():
            row['stages'][stage] = dict(provider_request_id=cid+'-'+stage, elapsed_ms=15000,
                outcome='succeeded', artifact='output.png', artifact_sha256=gate.sha(raw))
            reviews['decisions'].append(dict(case_id=cid, stage=stage, artifact_sha256=gate.sha(raw),
                accepted=True, criteria={k: True for k in criteria}))
        results['cases'].append(row)
    return plan, results, reviews


def test_missing_and_partial_cases_cannot_shrink_the_denominator(evidence):
    plan, results, reviews = evidence
    assert gate.check(plan)['counts'] == {'PASS': 0, 'FAIL': 0, 'NEED_REVIEW': 24}
    results['cases'] = results['cases'][:1]
    checked = gate.check(plan, results, reviews)
    assert checked['counts'] == {'PASS': 4, 'FAIL': 0, 'NEED_REVIEW': 20}
    assert checked['overall'] == 'NEED_REVIEW'


def test_one_hard_failure_prevents_pass_despite_23_acceptances(evidence):
    plan, results, reviews = evidence
    assert gate.check(plan, results, reviews)['overall'] == 'PASS'
    reviews['decisions'][-1]['criteria']['looking_both_sides'] = False
    checked = gate.check(plan, results, reviews)
    assert checked['counts'] == {'PASS': 23, 'FAIL': 1, 'NEED_REVIEW': 0}
    assert checked['overall'] == 'FAIL'


@pytest.mark.parametrize('change', ['origin', 'plan', 'source', 'duplicate_request', 'review_pixels'])
def test_stale_forged_or_mispaired_records_rejected(evidence, change):
    plan, results, reviews = deepcopy(evidence)
    if change == 'origin': results['evidence_origin'] = 'offline_fixture'
    if change == 'plan': results['plan_sha256'] = 'old-plan'
    if change == 'source': results['cases'][0]['source_sha256'] = 'other-photo'
    if change == 'duplicate_request': results['cases'][0]['stages']['walk']['provider_request_id'] = 'object_mug-rest'
    if change == 'review_pixels': reviews['decisions'][0]['artifact_sha256'] = 'different-pixels'
    with pytest.raises(ValueError):
        gate.check(plan, results, reviews)


def test_integer_scores_do_not_impersonate_boolean_hard_gates(evidence):
    plan, results, reviews = evidence
    reviews['decisions'][0]['criteria']['category'] = 1
    with pytest.raises(ValueError, match='criteria'):
        gate.check(plan, results, reviews)


def test_bad_png_is_failure_and_retained_in_full_report(evidence, tmp_path):
    plan, results, _ = evidence
    (tmp_path/'broken.png').write_bytes(b'not an image')
    record = results['cases'][0]['stages']['static']
    record.update(artifact='broken.png', artifact_sha256=gate.sha(b'not an image'))
    checked = gate.check(plan, results)
    assert checked['overall'] == 'FAIL'
    assert checked['counts'] == {'PASS': 0, 'FAIL': 1, 'NEED_REVIEW': 23}
