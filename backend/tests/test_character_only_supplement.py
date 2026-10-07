import json

import pytest

from scripts.authorize_character_only_revision import activate as supplement
from scripts.real_web_budget import Budget, REF as ORIGINAL_REF
from scripts.real_web_recovery import REF, prepare, activate, selected, recovery_budget

ENDPOINT = 'https://maas-api.antdigital.com/v1'


def grant(budget, reference, amount, count):
    (budget.root/'authorization.json').write_text(json.dumps(dict(authorization_ref=reference,
        budget_cny=amount, requests_max=count, automatic_retries=0, confirmed=True,
        user_reply='synthetic confirmation', target_root=str(budget.root.resolve()), endpoint=ENDPOINT)))


@pytest.fixture
def reviewed(tmp_path):
    base = Budget(tmp_path, ENDPOINT); grant(base, ORIGINAL_REF, 5, 12)
    call = base.claim('ling-3.0-flash-vl'); base.settle(call, 'succeeded', 200); base.stop('business_failure')
    prepare(tmp_path, ENDPOINT)
    budget = recovery_budget(tmp_path, ENDPOINT); grant(budget, REF, 4.8, 11); activate(tmp_path, ENDPOINT)
    for model in ('ling-3.0-flash-vl', 'qwen3.8-flash', 'wan2.6-t2i', 'qwen3.8-flash',
                  'wan2.6-t2i', 'qwen3.8-flash', 'wan2.6-t2i'):
        call = budget.claim(model); budget.settle(call, 'succeeded', 200)
    return tmp_path, budget


def test_append_only_supplement_and_exact_two_call_sequence(reviewed):
    root, old = reviewed
    original = (old.root/'authorization.json').read_bytes()
    before_digest = old.approval()
    value = supplement(root, ENDPOINT, user_reply='确认')
    budget = selected(root, ENDPOINT)
    assert value['budget_cny'] == 4.85 and value['requests_max'] == 11
    assert budget.approval() == before_digest and (old.root/'authorization.json').read_bytes() == original
    with pytest.raises(ValueError, match='scope'): budget.claim('wan2.6-t2i')
    call = budget.claim('qwen3.8-flash'); budget.settle(call, 'succeeded', 200)
    with pytest.raises(ValueError): budget.claim('qwen3.8-flash')
    call = budget.claim('wan2.6-t2i'); budget.settle(call, 'succeeded', 200)
    assert budget.status()['reserved_cny'] == 4.8464 and budget.status()['paused']
    with pytest.raises(ValueError): budget.claim('wan2.6-t2i')
    with pytest.raises(FileExistsError): supplement(root, ENDPOINT, user_reply='确认')


def test_unconfirmed_or_changed_budget_is_blocked(reviewed):
    root, old = reviewed
    with pytest.raises(ValueError): supplement(root, ENDPOINT, user_reply='')
    assert not (root/'active-character-only.json').exists()
    old.stop('validation_failed')
    with pytest.raises(ValueError): supplement(root, ENDPOINT, user_reply='确认')


def test_tampered_addendum_blocks_before_dispatch(reviewed):
    root, _ = reviewed
    supplement(root, ENDPOINT, user_reply='确认'); budget = selected(root, ENDPOINT)
    path = root/'character-only-authorization.json'
    value = json.loads(path.read_text()); value['additional_budget_cny'] = 99
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError): budget.claim('qwen3.8-flash')
    assert not budget.status()['authorized']
    with pytest.raises(ValueError): selected(root, ENDPOINT)


def test_unknown_first_call_prevents_second_and_resume_is_same_budget(reviewed):
    root, _ = reviewed
    supplement(root, ENDPOINT, user_reply='确认')
    budget = selected(root, ENDPOINT); budget.claim('qwen3.8-flash')
    resumed = selected(root, ENDPOINT)
    assert resumed.status()['requests'] == 8 and resumed.status()['paused']
    with pytest.raises(ValueError): resumed.claim('wan2.6-t2i')
