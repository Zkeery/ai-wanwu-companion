import json

import pytest

from scripts.real_web_budget import Budget, REF as ORIGINAL_REF
from scripts.real_web_recovery import REF, prepare, activate, selected, recovery_budget

ENDPOINT='https://maas-api.antdigital.com/v1'


def grant(ledger,reference,amount,count):
    (ledger.root/'authorization.json').write_text(json.dumps(dict(authorization_ref=reference,
        budget_cny=amount,requests_max=count,automatic_retries=0,confirmed=True,user_reply='合成手动确认',
        target_root=str(ledger.root.resolve()),endpoint=ENDPOINT)))


@pytest.fixture
def stopped(tmp_path):
    base=Budget(tmp_path,ENDPOINT);grant(base,ORIGINAL_REF,5,12)
    call=base.claim('ling-3.0-flash-vl');base.settle(call,'succeeded',200);base.stop('business_failure')
    return base


def test_prepare_does_not_unlock_or_confirm(stopped):
    result=prepare(stopped.root,ENDPOINT)
    assert not result['authorized'] and result['reserved_cny']==0
    assert selected(stopped.root,ENDPOINT).status()['paused']
    with pytest.raises(FileNotFoundError):activate(stopped.root,ENDPOINT)
    assert stopped.status()['reserved_cny']==.2
    with pytest.raises(FileExistsError):prepare(stopped.root,ENDPOINT)


def test_explicit_recovery_keeps_original_reserve_and_combined_caps(stopped):
    prepare(stopped.root,ENDPOINT);retry=recovery_budget(stopped.root,ENDPOINT)
    grant(retry,REF,4.8,11);activate(stopped.root,ENDPOINT)
    assert selected(stopped.root,ENDPOINT).root==retry.root
    for _ in range(4):
        call=retry.claim('qwen3.8-flash');retry.settle(call,'succeeded',200)
    with pytest.raises(ValueError,match='budget_exhausted'):retry.claim('qwen3.8-flash')
    assert retry.status()['reserved_cny']+stopped.status()['reserved_cny']<=5
    assert stopped.status()['paused']
    with pytest.raises(FileExistsError):activate(stopped.root,ENDPOINT)


def test_changed_original_or_missing_authorized_ledger_fails_closed(stopped):
    prepare(stopped.root,ENDPOINT);retry=recovery_budget(stopped.root,ENDPOINT)
    grant(retry,REF,4.8,11);activate(stopped.root,ENDPOINT)
    stopped.stop('validation_failed')
    with pytest.raises(ValueError,match='changed'):selected(stopped.root,ENDPOINT)
    retry.path.unlink()
    with pytest.raises(ValueError,match='authorized_ledger_missing'):recovery_budget(stopped.root,ENDPOINT)
