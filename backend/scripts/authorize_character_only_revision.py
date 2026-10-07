"""Persist the user's exact 0.05 CNY addendum without replacing original approval."""
import hashlib
import json
from uuid import uuid4

from scripts.real_web_recovery import SUPPLEMENT_REF, call_digest, selected
from scripts.run_real_web import ROOT, ENDPOINT


def activate(root=ROOT, endpoint=ENDPOINT, *, user_reply):
    if not isinstance(user_reply, str) or not user_reply.strip():
        raise ValueError('Explicit user confirmation is required')
    grant_path = root/'character-only-authorization.json'
    marker_path = root/'active-character-only.json'
    if grant_path.exists() or marker_path.exists():
        raise FileExistsError('Never overwrite the single revision addendum')
    budget = selected(root, endpoint)
    value = budget.status()
    if value != dict(authorized=True, requests=7, reserved_cny=3.6848, budget_cny=4.8,
                     requests_max=11, paused=False, automatic_retries=0):
        raise ValueError('Reviewed budget changed; do not apply the addendum')
    grant = dict(authorization_ref=SUPPLEMENT_REF, confirmed=True, user_reply=user_reply,
        confirmed_on='2026-10-02', target_root=str(root.resolve()), endpoint=endpoint,
        original_authorization_sha256=budget.approval(), original_calls_sha256=call_digest(budget),
        original_requests=7, original_reserved_cny=3.6848, additional_budget_cny=.05,
        recovery_budget_cny=4.85, webpage_budget_cny=5.05, combined_budget_cny=8.05,
        max_new_model_requests=2, max_new_reservation_cny=1.1616, automatic_retries=0,
        source_character_id=6, request_id=str(uuid4()), appearance_style_id='whimsical-object-spirit-v2')
    with grant_path.open('x') as file:
        json.dump(grant, file, ensure_ascii=False, indent=2)
    grant_path.chmod(0o600)
    with marker_path.open('x') as file:
        json.dump(dict(authorization_sha256=hashlib.sha256(grant_path.read_bytes()).hexdigest()), file)
    marker_path.chmod(0o600)
    result = selected(root, endpoint).status()
    if not result['authorized']:
        raise ValueError('Addendum did not validate')
    return result


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--user-reply', required=True)
    args = parser.parse_args()
    try:
        from scripts import c174_batch
        c174_batch.WORK = ROOT/'acceptance/character-only-revision'
        c174_batch.WORK.mkdir(parents=True, exist_ok=True, mode=0o700)
        c174_batch.current_prices()
        print(json.dumps(activate(user_reply=args.user_reply), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'status':'stopped', 'error_type':type(exc).__name__}))
        raise SystemExit(1)
