"""C1.74 fixed coverage and artifact-bound human review. Read-only by default."""
from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path

from PIL import Image

from app.services.motion_walk_openai import inspect_sheet
from app.services.motion_atlas_provider import AtlasProviderError
from app.core.config import get_settings
from scripts.prepare_quality_samples import OUTPUT, PROJECT

IDS = ('object_mug', 'object_clock', 'object_apple', 'plant_pothos', 'plant_succulent', 'repeat_pothos')
CRITERIA = {
    'static': ('category', 'source_features', 'identity', 'no_extra_parts_or_watermark'),
    'rest': ('identity', 'eyes_closed', 'natural_loop', 'scene_fit'),
    'walk': ('identity', 'alternating_steps', 'natural_loop', 'scene_fit'),
    'observe': ('identity', 'looking_both_sides', 'natural_loop', 'scene_fit'),
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def fingerprint(value):
    return sha(json.dumps(value, sort_keys=True, ensure_ascii=False,
                          separators=(',', ':'), allow_nan=False).encode())


def source_plan():
    manifest = json.loads((OUTPUT/'manifest.json').read_text(encoding='utf-8'))
    cases = manifest['cases']
    if tuple(row['case_id'] for row in cases) != IDS:
        raise ValueError('Fixed coverage cannot be reduced or silently replaced')
    for row in cases:
        if Path(row['filename']).name != row['filename'] or row['evidence_origin'] != 'public_photograph':
            raise ValueError('Invalid photographic input')
        if sha((OUTPUT/row['filename']).read_bytes()) != row['sha256']:
            raise ValueError('Source changed after capture')
    if cases[3]['sha256'] != cases[5]['sha256']:
        raise ValueError('Repeat case must use exactly the same photo')
    settings = get_settings()
    sources = ('app/services/prompts.py', 'app/services/appearance.py',
               'app/services/model_client.py', 'app/services/character_generation.py',
               'app/services/motion_walk_aihubmix.py', 'app/services/motion_activity_prompts.py',
               'app/living/life_runtime.py', 'app/living/gathering_automatic.py')
    # Only source code and allowlisted settings; never .env or credentials.
    source_hashes = {name: sha((PROJECT/'backend'/name).read_bytes()) for name in sources}
    return dict(schema_version=1, rule_version='c174-v1',
                cases=[{k: row[k] for k in ('case_id', 'filename', 'sha256', 'evidence_origin')} for row in cases],
                criteria=CRITERIA, performance_decision='deferred_by_user',
                source_hashes=source_hashes,
                current_models={key: getattr(settings, key) for key in ('vision_model', 'chat_model', 'image_model', 'character_bundle_enabled', 'model_enable_thinking', 'vision_enable_thinking')},
                planned_batch={'client_retries': 0, 'static_generations': 6,
                               'motion_requests': 18, 'life_requests': 8,
                               'budget_cny': 20, 'budget_usd': 2, 'real_duration_seconds': 86400},
                real_provider_required=True, automated_visual_scoring=False)


def artifact_file(relative):
    if not isinstance(relative, str) or Path(relative).is_absolute():
        raise ValueError('Artifact must use a project-relative path')
    path = (PROJECT/relative).resolve()
    if PROJECT.resolve() not in path.parents or not path.is_file() or path.stat().st_size > 10*1024*1024:
        raise ValueError('Artifact outside the project or invalid file size')
    return path


def check(plan, results=None, reviews=None):
    plan_hash = fingerprint(plan)
    records = {}
    if results is not None:
        if results['plan_sha256'] != plan_hash or results['evidence_origin'] != 'real_provider':
            raise ValueError('Results are not from this frozen real-provider batch')
        for row in results['cases']:
            if row['case_id'] not in IDS or row['case_id'] in records:
                raise ValueError('Unknown or repeated result case')
            records[row['case_id']] = row
    decisions = {}
    if reviews is not None:
        if reviews['plan_sha256'] != plan_hash or not reviews.get('reviewer_ref'):
            raise ValueError('Review must reference the frozen batch and an actual reviewer')
        for row in reviews['decisions']:
            key = (row['case_id'], row['stage'])
            if key[0] not in IDS or key[1] not in CRITERIA or key in decisions:
                raise ValueError('Unknown or repeated review decision')
            decisions[key] = row
    outcomes, requests = [], set()
    for case in plan['cases']:
        cid = case['case_id']
        result = records.get(cid)
        if result and result['source_sha256'] != case['sha256']:
            raise ValueError('Output is paired with a different photographic input')
        for stage, required in CRITERIA.items():
            status, issues = 'NEED_REVIEW', ['real_output_missing']
            record = (result or {}).get('stages', {}).get(stage)
            if record:
                request = record['provider_request_id']
                if not isinstance(request, str) or not request or request in requests:
                    raise ValueError('Provider request must identify one unique output')
                requests.add(request)
                elapsed = record['elapsed_ms']
                if type(elapsed) not in (float, int) or not math.isfinite(elapsed) or elapsed < 0:
                    raise ValueError('Invalid measured duration')
                if record['outcome'] != 'succeeded':
                    status, issues = 'FAIL', ['provider_output_not_completed']
                else:
                    raw = artifact_file(record['artifact']).read_bytes()
                    if sha(raw) != record['artifact_sha256']:
                        raise ValueError('Generated pixels changed after capture')
                    try:
                        if stage == 'static':
                            with Image.open(BytesIO(raw)) as image:
                                valid = image.format in ('PNG', 'JPEG') and image.size == (1024, 1024)
                                image.verify()
                        else:
                            valid = inspect_sheet(raw)['state'] == 'needs_review'
                    except (OSError, ValueError, Image.DecompressionBombError, AtlasProviderError):
                        valid = False
                    if not valid:
                        status, issues = 'FAIL', ['image_structure_failed']
                    else:
                        status, issues = 'NEED_REVIEW', ['human_review_missing']
                        review = decisions.get((cid, stage))
                        if review:
                            if review['artifact_sha256'] != record['artifact_sha256']:
                                raise ValueError('Human review is attached to different pixels')
                            values = review.get('criteria', {})
                            if any(k not in required or (type(values[k]) is not bool and values[k] is not None) for k in values):
                                raise ValueError('Invalid review criteria')
                            if any(values.get(k) is False for k in required) or review.get('accepted') is False:
                                status, issues = 'FAIL', ['human_review_rejected']
                            elif all(values.get(k) is True for k in required) and review.get('accepted') is True:
                                status, issues = 'PASS', []
                            else:
                                issues = ['human_review_incomplete']
            outcomes.append(dict(case_id=cid, stage=stage, status=status, issues=issues))
    counts = {s: sum(row['status'] == s for row in outcomes) for s in ('PASS', 'FAIL', 'NEED_REVIEW')}
    overall = 'FAIL' if counts['FAIL'] else 'PASS' if counts['PASS'] == 24 else 'NEED_REVIEW'
    return dict(plan_sha256=plan_hash, overall=overall, counts=counts, outcomes=outcomes,
                formal_two_reviewer_calibration='not_run', performance='deferred_by_user')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--results', type=Path)
    parser.add_argument('--reviews', type=Path)
    parser.add_argument('--freeze', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    plan = source_plan()
    if args.freeze:
        with (OUTPUT/'评测冻结.json').open('x', encoding='utf-8') as file:
            json.dump({'plan': plan, 'plan_sha256': fingerprint(plan)}, file, ensure_ascii=False, indent=2)
    results = json.loads(args.results.read_text()) if args.results else None
    reviews = json.loads(args.reviews.read_text()) if args.reviews else None
    report = check(plan, results, reviews)
    if args.report:
        target = args.report.resolve()
        if PROJECT.resolve() not in target.parents:
            raise ValueError('Report must stay in this project')
        with target.open('x', encoding='utf-8') as file:
            json.dump(report, file, ensure_ascii=False, indent=2)
    print(json.dumps({k: report[k] for k in ('plan_sha256', 'overall', 'counts')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
