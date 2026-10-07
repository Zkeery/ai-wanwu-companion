"""Trusted maintenance entry for durable one-shot motion requests; default read-only."""
import argparse
import json

from app.services import character_walk_workflow as flow, motion_generation as generation


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', nargs='?', default='plan', choices=['plan', 'status', 'grant', 'grant-all', 'consume'])
    parser.add_argument('--character-id', type=int, required=True)
    parser.add_argument('--owner-id', required=True)
    parser.add_argument('--activity', choices=generation.ACTIVITIES, default='walk')
    parser.add_argument('--request-id')
    parser.add_argument('--source-sha256')
    parser.add_argument('--approval-ref')
    parser.add_argument('--price-verified-on')
    parser.add_argument('--accept-metered-cost', action='store_true')
    args = parser.parse_args()
    try:
        if args.action == 'plan':
            result = {**flow.plan(args.character_id, args.owner_id, activity=args.activity),
                      'request': generation.status(args.character_id, args.owner_id, activity=args.activity)}
        elif args.action == 'status':
            result = generation.status(args.character_id, args.owner_id, activity=args.activity)
        elif args.action == 'grant-all':
            result = generation.authorize_activities(args.character_id, args.owner_id,
                expected_source_sha256=args.source_sha256 or '', approval_ref=args.approval_ref or '',
                price_verified_on=args.price_verified_on or '', accept_metered_cost=args.accept_metered_cost)
        elif args.action == 'grant':
            current = generation.status(args.character_id, args.owner_id, activity=args.activity)
            if not args.request_id or current['request_id'] != args.request_id:
                raise ValueError('request_mismatch')
            result = generation.authorize(args.request_id, args.owner_id,
                expected_source_sha256=args.source_sha256 or '', approval_ref=args.approval_ref or '',
                price_verified_on=args.price_verified_on or '', accept_metered_cost=args.accept_metered_cost)
        else:
            current = generation.status(args.character_id, args.owner_id, activity=args.activity)
            if not args.request_id or current['request_id'] != args.request_id:
                raise ValueError('request_mismatch')
            result = {'processed': generation.process_one(request_id=args.request_id)}
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': {'code': 'motion_request_unavailable',
                                   'message': '请核对任务、当前原图和单次费用授权'}}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
