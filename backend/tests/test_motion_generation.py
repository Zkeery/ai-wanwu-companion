"""Request bookkeeping and one-shot dispatch; providers below are synthetic."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
from unittest.mock import Mock

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, MotionGenerationRequest, User
from app.services import character_walk_workflow as flow, motion_generation as gen
from app.services.motion_atlas_provider import AtlasProviderError
from tests.auth_helpers import TEST_USER_ID
from tests.test_character_walk_workflow import case  # noqa: F401


@pytest.fixture
def queued_case(case, monkeypatch):
    monkeypatch.setattr(flow, 'DEFAULT_ROOT', case['root'])
    monkeypatch.setattr(get_settings(), 'motion_generation_enabled', True)
    return case


def request(case):
    return gen.request(case['cid'], TEST_USER_ID)


def grant(case, rid, **overrides):
    args = dict(expected_source_sha256=case['digest'], approval_ref='one-c161-grant',
                price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    args.update(overrides)
    return gen.authorize(rid, TEST_USER_ID, **args)


def test_registration_is_transactional_idempotent_and_has_no_key_or_file_work(queued_case, monkeypatch):
    case = queued_case
    with SessionLocal() as db:
        ch = db.get(Character, case['cid'])
        read = Mock(side_effect=AssertionError('No disk work in generation transaction'))
        with monkeypatch.context() as m:
            m.setattr(flow, '_current', read)
            gen.register_request(db, ch); db.flush(); db.rollback()
        assert db.query(MotionGenerationRequest).count() == 0
        gen.register_request(db, ch); gen.register_request(db, ch); db.commit()
        assert db.query(MotionGenerationRequest).count() == 1
    case['key'].assert_not_called(); case['provider'].assert_not_called()


def test_owned_http_registers_once_without_grant_or_dispatch(client, queued_case):
    case = queued_case; url = f"/api/v1/characters/{case['cid']}/motion-generation"
    assert client.get(url).json()['state'] == 'not_requested'
    first = client.post(url, json={}).json()
    assert first['state'] == 'waiting_authorization'
    assert client.post(url, json={}).json() == first
    assert set(first) == {'character_id', 'request_id', 'state'}
    assert not gen.process_one(provider=case['provider'])
    assert client.post(url, json={'approval_ref': 'not-allowed'}).status_code == 422
    case['key'].assert_not_called(); case['provider'].assert_not_called()


@pytest.mark.parametrize('identity', ['anonymous', 'other'])
def test_http_isolation(client, anon, queued_case, identity):
    case = queued_case; url = f"/api/v1/characters/{case['cid']}/motion-generation"
    if identity == 'other':
        with SessionLocal() as db:
            db.add(User(id='other', phone='13900000161')); db.flush()
            db.get(Character, case['cid']).owner_id = 'other'; db.commit()
        actor, status = client, 404
    else:
        actor, status = anon, 401
    assert actor.get(url).status_code == status
    assert actor.post(url, json={}).status_code == status


def test_concurrent_registration_has_one_request(queued_case):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: request(queued_case), range(2)))
    assert results[0]['request_id'] == results[1]['request_id']
    with SessionLocal() as db:
        assert db.query(MotionGenerationRequest).count() == 1


@pytest.mark.parametrize('bad', [{'expected_source_sha256': 'f'*64}, {'price_verified_on': '2000-01-01'},
                               {'accept_metered_cost': False}, {'approval_ref': ''}])
def test_grant_requires_current_explicit_authorization(queued_case, bad):
    case = queued_case; rid = request(case)['request_id']
    with pytest.raises(AtlasProviderError): grant(case, rid, **bad)
    assert gen.status(case['cid'], TEST_USER_ID)['state'] == 'waiting_authorization'
    case['provider'].assert_not_called()


def test_old_approval_namespace_and_duplicate_grant_are_rejected(queued_case):
    case = queued_case; rid = request(case)['request_id']
    case['root'].mkdir(); sha = flow._digest(b'old-used')
    (case['root']/f'approval-{sha}.json').write_text('{}')
    with pytest.raises(AtlasProviderError): grant(case, rid, approval_ref='old-used')
    grant(case, rid)
    with pytest.raises(AtlasProviderError): grant(case, rid, approval_ref='second')


def test_disabled_worker_does_not_read_keys_even_with_a_grant(queued_case, monkeypatch):
    case = queued_case; grant(case, request(case)['request_id'])
    monkeypatch.setattr(get_settings(), 'motion_generation_enabled', False)
    assert not gen.process_one(provider=case['provider'])
    case['key'].assert_not_called(); case['provider'].assert_not_called()


def test_concurrent_workers_generate_once_and_link_to_private_review(client, queued_case):
    case = queued_case; rid = request(case)['request_id']; grant(case, rid)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: gen.process_one(provider=case['provider']), range(2)))
    assert sum(results) == 1 and case['provider'].call_count == 1
    assert gen.status(case['cid'], TEST_USER_ID)['state'] == 'needs_review'
    items = client.get(f"/api/v1/characters/{case['cid']}/motion-candidates").json()['items']
    assert len(items) == 1 and items[0]['state'] == 'needs_review'
    assert request(case)['request_id'] == rid
    assert not gen.process_one(provider=case['provider'])


@pytest.mark.parametrize('change', ['expired', 'source', 'owner', 'prompt'])
def test_changed_dispatch_conditions_never_call_provider(queued_case, monkeypatch, change):
    case = queued_case; rid = request(case)['request_id']; grant(case, rid)
    if change == 'source': case['source'].write_bytes(case['source'].read_bytes()+b'change')
    elif change == 'prompt':
        plan = flow.plan(case['cid'], TEST_USER_ID)
        monkeypatch.setattr(flow, 'plan', lambda *a: {**plan, 'prompt_sha256': '0'*64})
    else:
        with SessionLocal() as db:
            if change == 'expired': db.get(MotionGenerationRequest, rid).price_verified_on = '2000-01-01'
            else:
                db.add(User(id='other', phone='13900000161')); db.flush()
                db.get(Character, case['cid']).owner_id = 'other'
            db.commit()
    assert gen.process_one(provider=case['provider'])
    with SessionLocal() as db: assert db.get(MotionGenerationRequest, rid).state == 'blocked'
    case['provider'].assert_not_called(); case['key'].assert_not_called()


def test_unknown_result_never_requeues(queued_case):
    case = queued_case; grant(case, request(case)['request_id'])
    case['provider'].side_effect = RuntimeError('secret response')
    assert gen.process_one(provider=case['provider'])
    gen.recover_interrupted()
    assert gen.status(case['cid'], TEST_USER_ID)['state'] == 'unknown'
    assert not gen.process_one(provider=case['provider'])
    assert case['provider'].call_count == 1


def test_crash_before_response_restores_unknown_without_retry(queued_case):
    case = queued_case; grant(case, request(case)['request_id'])
    case['provider'].side_effect = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt): gen.process_one(provider=case['provider'])
    gen.recover_interrupted()
    assert gen.status(case['cid'], TEST_USER_ID)['state'] == 'unknown'
    assert not gen.process_one(provider=case['provider'])


def test_recovery_projects_persisted_candidate_after_db_update_interruption(queued_case):
    case = queued_case; rid = request(case)['request_id']; grant(case, rid)
    assert gen.process_one(provider=case['provider'])
    with SessionLocal() as db:
        db.get(MotionGenerationRequest, rid).state = 'running'; db.commit()
    gen.recover_interrupted()
    assert gen.status(case['cid'], TEST_USER_ID)['state'] == 'needs_review'
    assert not gen.process_one(provider=case['provider'])


def test_same_grant_cannot_be_assigned_to_a_new_source(queued_case):
    case = queued_case; rid = request(case)['request_id']; grant(case, rid)
    with SessionLocal() as db:
        ch = db.get(Character, case['cid']); ch.image_path = 'new-source.png'
        (case['source'].parent/'new-source.png').write_bytes(case['source'].read_bytes())
        gen.register_request(db, ch); db.commit()
    other = request(case)['request_id']
    assert other != rid
    with pytest.raises(AtlasProviderError): grant(case, other)
