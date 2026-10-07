"""Read-only plan by default. Authorize only after a new, concrete user approval."""
import argparse
import json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--authorize', action='store_true')
    parser.add_argument('--authorization-ref')
    parser.add_argument('--rounds', type=int, choices=range(1, 11), default=10)
    args = parser.parse_args()
    if args.authorize and not (args.authorization_ref and 8 <= len(args.authorization_ref) <= 120):
        parser.error('需要本批具体费用授权编号，不填密钥')
    from pathlib import Path
    import sqlite3
    database = Path(__file__).resolve().parents[2] / '.runtime/c160-review/check.db'
    with sqlite3.connect(f'file:{database}?mode=ro', uri=True) as db:
        row = db.execute('SELECT owner_id,status FROM characters WHERE id=4').fetchone()
        if not row or not row[0] or row[1] != 'ready':
            raise RuntimeError('本人4号苹果未就绪')
    plan = dict(character_id=4, max_rounds=args.rounds, budget_yuan=f'{args.rounds * 1.2:.2f}',
        validity_hours=24, model='qwen3.8-flash', new_model_requests=0,
        sends='本伙伴当前私人聊天、性格、允许的记忆、心情与场景；原音只在本机识别', state='planned')
    if args.authorize:
        from scripts import check_candidate_review as qa  # noqa: F401
        from app.api.voice import service
        from app.services.voice_sessions import authorize
        with service.storage.transaction() as conn:
            service.owned(conn, row[0], 4)
            plan['session'] = authorize(conn, row[0], 4, args.authorization_ref, args.rounds, service.clock())
        plan['state'] = 'authorized'
    print(json.dumps(plan, ensure_ascii=False))


if __name__ == '__main__':
    main()
