"""Production entrypoint; isolated acceptance limits never renew themselves."""
import json
import os
from pathlib import Path


def configure_budget(root, authorized, closed=False):
    from scripts.real_web_budget import Budget
    revision2 = authorized == '20261002-total3cny-revision2'
    revision = revision2 or authorized == '20261002-total3cny-revision1'
    prior_reserved = 0
    if revision2:
        prior = configure_budget(root, '20261002-total3cny-revision1')
        previous = prior.status()
        prior_reserved = round(previous['reserved_cny'] + prior.prior_reserved_cny, 6)
        if not previous['authorized'] or not previous['paused'] or prior_reserved > .4:
            raise ValueError('prior_batches_must_be_closed_within_retained_allowance')
        root = root.with_name(root.name + '-revision2')
    elif revision:
        prior = Budget(root, 'https://maas-api.antdigital.com/v1',
            reference='cloud-acceptance-20261002-1cny', budget_micro=1_000_000, requests_max=3)
        previous = prior.status()
        if not previous['authorized'] or not previous['paused'] or previous['reserved_cny'] > .2:
            raise ValueError('prior_batch_must_be_closed_within_retained_allowance')
        prior_reserved = previous['reserved_cny']
        root = root.with_name(root.name + '-revision1')
    budget = Budget(root, 'https://maas-api.antdigital.com/v1',
        reference=('cloud-acceptance-' + authorized) if revision else 'cloud-acceptance-20261002-1cny',
        budget_micro=2_600_000 if revision2 else (2_800_000 if revision else 1_000_000),
        requests_max=4 if revision else 3)
    if revision:
        budget.revision_start = 0
        budget.revision_models = ('ling-3.0-flash-vl', 'wan2.6-t2i', 'qwen3.8-flash', 'qwen3.8-flash')
        budget.prior_reserved_cny = prior_reserved
    approval = root / 'authorization.json'
    # Exact user-authorized batch. No implicit renewal after restart or exhaustion.
    if (revision or authorized == '20261002-1cny') and not approval.exists():
        value = dict(authorization_ref=budget.reference, budget_cny=budget.budget_micro / 1_000_000,
            requests_max=budget.requests_max, automatic_retries=0, confirmed=True,
            user_reply=('那再给你一次机会，你能不能做好？' if revision2 else
                ('可以 继续（确认累计3元、最多再4次、失败即停）' if revision else '创建账号，并在 1 元内完成真实验证。创建呗')),
            target_root=str(root.resolve()), endpoint=budget.endpoint, purpose_limits={})
        descriptor = os.open(approval, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as file:
            json.dump(value, file, ensure_ascii=False)
            file.flush()
            os.fsync(file.fileno())
    if closed:
        with budget.db() as db:
            db.execute("INSERT OR IGNORE INTO stops VALUES ('batch_closed', strftime('%s','now'))")
    return budget


def configure_life_allowance(budget, owner, space_id):
    """Trusted startup setting for the single authorized acceptance space."""
    if not space_id:
        return
    if budget.reference not in ('cloud-acceptance-20261002-total3cny-revision1',
                                'cloud-acceptance-20261002-total3cny-revision2'):
        raise ValueError('life_allowance_requires_revision_authorization')
    from app.api.life_runtime import live_runtime
    from app.living.life_provider import RESERVE_MICRO
    live_runtime.snapshot(owner, space_id)  # Verify ownership before any write.
    live_runtime.set_limit('project', RESERVE_MICRO, budget.reference)
    live_runtime.set_limit('space:' + space_id, RESERVE_MICRO, budget.reference)


def install_acceptance_guard(budget, service_mode):
    """Normal user operation is independent from archived acceptance budgets."""
    if service_mode == 'normal':
        return False
    if service_mode != 'acceptance':
        raise ValueError('unknown_cloud_service_mode')
    from scripts.real_web_budget import install, install_async
    install(budget)
    install_async(budget)
    return True


def main():
    budget = configure_budget(
        Path('/mnt/workspace/wanwu-companion/runtime/cloud-acceptance-20261002'),
        os.environ.get('CLOUD_ACCEPTANCE_AUTHORIZED'),
        os.environ.get('CLOUD_ACCEPTANCE_CLOSED') == 'true')
    service_mode = os.environ.get('CLOUD_SERVICE_MODE', 'acceptance')
    acceptance_active = install_acceptance_guard(budget, service_mode)
    from app.main import app
    app.state.model_budget = budget if acceptance_active else None
    from app.api.deps import get_current_user
    from fastapi import Depends
    if acceptance_active:
        configure_life_allowance(budget, os.environ.get('CLOUD_ACCEPTANCE_OWNER_ID'),
            os.environ.get('CLOUD_ACCEPTANCE_LIFE_SPACE_ID'))

    @app.middleware('http')
    async def stop_on_business_failure(request, call_next):
        before = budget.status()['requests'] if acceptance_active and request.method == 'POST' else 0
        response = await call_next(request)
        if acceptance_active and request.method == 'POST':
            from scripts.real_web_response import protect
            response = protect(response, budget, before)
        return response

    @app.get('/api/v1/deployment-check')
    def deployment_check(_user=Depends(get_current_user)):
        state = budget.status()
        prior = getattr(budget, 'prior_reserved_cny', 0)
        return dict(release='cloud-desktop-20261002-budget-v3', service_mode=service_mode,
            acceptance_guard_active=acceptance_active, prior_reserved_cny=prior,
            total_reserved_cny=round(prior + state['reserved_cny'], 6), **state)

    app.router.routes.insert(0, app.router.routes.pop())

    @app.get('/api/v1/deployment-check/receipts')
    def acceptance_receipts(user=Depends(get_current_user)):
        from app.core.errors import api_error
        if user.id != os.environ.get('CLOUD_ACCEPTANCE_OWNER_ID'):
            raise api_error(404, 'not_found', '未找到验收记录')
        with budget.db() as db:
            rows = db.execute('SELECT id,model,outcome FROM calls ORDER BY started_at LIMIT 4').fetchall()
        receipts = []
        for call_id, model, outcome in rows:
            path = budget.root / 'provider-responses' / (call_id + '.json')
            if path.is_file() and not path.is_symlink() and path.stat().st_size <= 262144:
                data = json.loads(path.read_text())
                receipts.append(dict(call_id=call_id, model=model, outcome=outcome,
                    usage=data.get('usage'), choices=data.get('choices')))
        return dict(receipts=receipts)

    app.router.routes.insert(0, app.router.routes.pop())
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8020, access_log=False)


if __name__ == '__main__':
    main()
