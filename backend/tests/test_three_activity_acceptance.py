"""Approved runner guards with synthetic providers; never imports the review DB."""
from datetime import date
import hashlib
import importlib
import json
import sys
from types import ModuleType
from unittest.mock import Mock

import pytest
import scripts

from app.core.database import SessionLocal
from app.services import character_walk_workflow as flow, motion_generation as gen
from tests.auth_helpers import TEST_USER_ID
from tests.test_motion_generation import queued_case  # noqa: F401
from tests.test_character_walk_workflow import case  # noqa: F401


@pytest.fixture
def runner(queued_case, tmp_path, monkeypatch):
    stub = ModuleType('scripts.check_candidate_review')
    stub.flow, stub.SessionLocal = flow, SessionLocal
    monkeypatch.setitem(sys.modules, 'scripts.check_candidate_review', stub)
    monkeypatch.setattr(scripts, 'check_candidate_review', stub, raising=False)
    sys.modules.pop('scripts.run_three_activity_acceptance', None)
    module = importlib.import_module('scripts.run_three_activity_acceptance')
    work, evidence = tmp_path / 'runner', tmp_path / 'evidence'
    work.mkdir(); evidence.mkdir()
    for key, value in {'WORK': work, 'BATCH': work/'batch.json', 'EVIDENCE': evidence,
                       'AUTHORIZATION': evidence/'authorization.json', 'SOURCE_SHA': queued_case['digest']}.items():
        monkeypatch.setattr(module, key, value)
    result = gen.request_activities(queued_case['cid'], TEST_USER_ID)
    gen.authorize_activities(queued_case['cid'], TEST_USER_ID,
        expected_source_sha256=queued_case['digest'], approval_ref=module.APPROVAL,
        price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    module.save({'phase': 'starting', 'character_id': queued_case['cid'], 'owner_id': TEST_USER_ID,
        'attempts': [], 'requests': {item['activity']: item['request_id'] for item in result['activities']},
        'prompt_sha256': {kind: flow.plan(queued_case['cid'], TEST_USER_ID, activity=kind)['prompt_sha256']
                         for kind in module.ACTIVITIES}})
    real_process = gen.process_one
    def process(request_id):
        def provider(path, key, **kwargs):
            kwargs.pop('activity', None)
            return queued_case['provider'](path, key, **kwargs)
        return real_process(request_id=request_id, provider=provider)
    monkeypatch.setattr(gen, 'process_one', process)
    yield module, queued_case
    sys.modules.pop('scripts.run_three_activity_acceptance', None)


def test_runner_generates_three_candidates_without_a_fourth_or_automatic_review(runner, monkeypatch):
    module, case = runner
    monkeypatch.setattr(module, 'approved', lambda: {})
    result = module.run()
    assert result['actual_model_calls'] == case['provider'].call_count == 3
    assert result['phase'] == 'needs_review'
    assert [item['state'] for item in result['activities']] == ['needs_review'] * 3
    assert len(list(module.EVIDENCE.glob('*-真实候选.png'))) == 3
    with pytest.raises(ValueError, match='batch_already_started'):
        module.run()
    assert case['provider'].call_count == 3


def test_first_provider_failure_stops_unstarted_requests_and_never_relaunches(runner, monkeypatch):
    module, case = runner
    monkeypatch.setattr(module, 'approved', lambda: {})
    case['provider'].side_effect = RuntimeError('synthetic failure')
    result = module.run()
    assert result['phase'] == 'stopped' and result['actual_model_calls'] == 1
    states = [item['state'] for item in result['activities']]
    assert states.count('unknown') == 1 and states.count('blocked') == 2
    launch = Mock(); monkeypatch.setattr(module.subprocess, 'Popen', launch)
    with pytest.raises(ValueError, match='batch_not_startable'):
        module.start()
    launch.assert_not_called()


def test_status_recognizes_finished_human_binding_without_reopening_paid_batch(runner, monkeypatch):
    module, case = runner
    monkeypatch.setattr(module, 'approved', lambda: {})
    module.run()
    original = gen.activities_status(case['cid'], TEST_USER_ID)
    for item in original['activities']:
        item['state'] = 'ready'
    monkeypatch.setattr(gen, 'activities_status', lambda *args, **kwargs: original)
    result = module.status()
    assert result['phase'] == 'completed' and result['human_review_required'] is False
    assert result['actual_model_calls'] == case['provider'].call_count == 3
    with pytest.raises(ValueError, match='batch_not_startable'):
        module.start()
    assert case['provider'].call_count == 3


def test_preflight_failure_blocks_all_three_without_a_provider_call(runner, monkeypatch):
    module, case = runner
    monkeypatch.setattr(module, 'approved', Mock(side_effect=ValueError('budget_changed')))
    result = module.run()
    assert result['phase'] == 'stopped' and result['actual_model_calls'] == 0
    assert [item['state'] for item in result['activities']] == ['blocked'] * 3
    case['provider'].assert_not_called()


def test_start_is_a_single_durable_launch(runner, monkeypatch):
    module, case = runner
    batch = json.loads(module.BATCH.read_text()); batch['phase'] = 'queued'; module.save(batch)
    monkeypatch.setattr(module, 'approved', lambda: {})
    launch = Mock(return_value=Mock(pid=123)); monkeypatch.setattr(module.subprocess, 'Popen', launch)
    assert module.start()['started']
    with pytest.raises(ValueError, match='batch_not_startable'):
        module.start()
    assert launch.call_count == 1 and case['provider'].call_count == 0


@pytest.mark.parametrize('field,value', [('budget_usd', .31), ('max_client_requests', 4),
    ('platform_unlimited_quota', True), ('price_verified_on', '2000-01-01'),
    ('platform_key_display_sha256', '0'*64)])
def test_changed_budget_date_or_project_key_is_rejected_before_dispatch(runner, monkeypatch, field, value):
    module, case = runner
    key = 'synthetic-c173-secret-key'
    authorization = {'approval_ref': module.APPROVAL, 'source_sha256': module.SOURCE_SHA,
        'max_client_requests': 3, 'automatic_retries': 0, 'budget_usd': .30,
        'platform_remaining_after_setting_usd': .30, 'platform_limit_verified': True,
        'platform_unlimited_quota': False, 'platform_fallback_models': 0,
        'price_verified_on': date.today().isoformat(), 'user_confirmation': '嗯 确认',
        'platform_key_display_sha256': hashlib.sha256((key[:7]+'****'+key[-4:]).encode()).hexdigest()}
    authorization[field] = value
    module.AUTHORIZATION.write_text(json.dumps(authorization))
    monkeypatch.setattr(module, 'dotenv_values', lambda *args, **kwargs: {'AIHUBMIX_API_KEY': key})
    with pytest.raises(ValueError):
        module.approved()
    case['provider'].assert_not_called()
