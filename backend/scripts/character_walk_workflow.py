"""Trusted local walk workflow. Default plan is read-only; generation is opt-in."""
import argparse
import json
from pathlib import Path

from app.services import character_walk_workflow as workflow
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_bindings import MotionBindingError


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='plan', choices=('plan', 'generate', 'status', 'import', 'recover', 'review'))
    parser.add_argument('--character-id', type=int, required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--activity', choices=('rest', 'walk', 'observe'), default='walk',
                        help='Activity for plan/generate; existing jobs retain their recorded activity')
    parser.add_argument('--job-id', default='')
    parser.add_argument('--source-sha256', default='')
    parser.add_argument('--approval-ref', default='')
    parser.add_argument('--price-verified-on', default='')
    parser.add_argument('--accept-metered-cost', action='store_true')
    parser.add_argument('--receipt', type=Path)
    parser.add_argument('--candidate', type=Path)
    parser.add_argument('--decision', choices=('accept', 'reject'))
    parser.add_argument('--candidate-sha256', default='')
    parser.add_argument('--review-ref', default='')
    args = parser.parse_args()
    cid, owner = args.character_id, args.owner_id
    try:
        if args.action == 'plan':
            result = workflow.plan(cid, owner, activity=args.activity)
        elif args.action == 'generate':
            result = workflow.generate_candidate(cid, owner, expected_source_sha256=args.source_sha256,
                approval_ref=args.approval_ref, price_verified_on=args.price_verified_on,
                accept_metered_cost=args.accept_metered_cost, activity=args.activity)
        elif args.action == 'import':
            if args.receipt is None or args.candidate is None:
                raise AtlasProviderError('receipt_invalid')
            result = workflow.import_candidate(cid, owner, args.receipt, args.candidate)
        elif args.action == 'review':
            result = workflow.review(args.job_id, cid, owner, decision=args.decision,
                candidate_sha256=args.candidate_sha256, review_ref=args.review_ref)
        elif args.action == 'recover':
            result = workflow.recover_local(args.job_id, cid, owner)
        else:
            result = workflow.status(args.job_id, cid, owner)
    except (AtlasProviderError, MotionBindingError) as exc:
        parser.exit(2, json.dumps({'error': {'code': exc.code, 'message': '动作流程未完成，请核对本次状态与输入。'}}, ensure_ascii=False) + '\n')
    except Exception:
        parser.exit(2, json.dumps({'error': {'code': 'workflow_unavailable', 'message': '动作流程暂不可用，本次不会自动重试生成。'}}, ensure_ascii=False) + '\n')
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == '__main__':
    main()
