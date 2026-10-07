"""Three-activity requests and synthetic end-to-end delivery; no network calls."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import subprocess
import sys
from unittest.mock import Mock

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterActivityMotionAsset, MotionGenerationRequest, MotionGenerationActivityRequest
from app.services import character_walk_workflow as flow, motion_generation as gen, motion_preparation as prep
from app.services.motion_atlas_provider import AtlasProviderError
from tests.auth_helpers import TEST_USER_ID
from tests.test_motion_generation import queued_case  # noqa: F401
from tests.test_character_walk_workflow import case  # noqa: F401
from tests.test_characters_api import _upload


def requests(case):
    return {item['activity']: item for item in gen.request_activities(case['cid'], TEST_USER_ID)['activities']}


def grant(case, activity, approval=None):
    current = requests(case)[activity]
    return gen.authorize(current['request_id'], TEST_USER_ID, expected_source_sha256=case['digest'],
                         approval_ref=approval or f'c173-{activity}',
                         price_verified_on=date.today().isoformat(), accept_metered_cost=True)


def test_ready_transaction_creates_three_without_disk_reads_and_rolls_back_all(queued_case, monkeypatch):
    with SessionLocal() as db:
        ch = db.get(Character, queued_case['cid'])
        with monkeypatch.context() as m:
            m.setattr(flow, '_current', Mock(side_effect=AssertionError('registration is disk-free')))
            gen.register_request(db, ch); gen.register_request(db, ch); db.flush()
            assert db.query(MotionGenerationRequest).count() == 1
            assert db.query(MotionGenerationActivityRequest).count() == 2
            db.rollback()
        assert db.query(MotionGenerationRequest).count() == 0
        assert db.query(MotionGenerationActivityRequest).count() == 0
    queued_case['key'].assert_not_called()


def test_parallel_registration_keeps_three_unique_durable_ids(queued_case):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: requests(queued_case), range(2)))
    assert results[0] == results[1]
    assert len({item['request_id'] for item in results[0].values()}) == 3
    with SessionLocal() as db:
        assert db.query(MotionGenerationActivityRequest).count() == 2


def test_owned_http_has_three_and_legacy_response_remains_exact(client, queued_case):
    cid = queued_case['cid']; url = f'/api/v1/characters/{cid}/motion-generation/activities'
    first = client.get(url)
    assert first.headers['cache-control'] == 'private, no-store'
    assert [item['activity'] for item in first.json()['activities']] == list(gen.ACTIVITIES)
    assert {item['state'] for item in first.json()['activities']} == {'not_requested'}
    saved = client.post(url, json={}).json()
    assert client.post(url, json={}).json() == saved
    assert client.get(url).json() == saved
    assert client.post(url, json={'accept_metered_cost': True}).status_code == 422
    old = client.get(f'/api/v1/characters/{cid}/motion-generation').json()
    walk = saved['activities'][1]
    assert old == {'character_id': cid, 'state': walk['state'], 'request_id': walk['request_id']}
    assert not gen.process_one(provider=queued_case['provider'])
    queued_case['key'].assert_not_called()


def test_actual_character_generation_registers_all_three_in_ready_transaction(client, png_header, parse_sse):
    object_id = _upload(client, png_header)
    response = client.post('/api/v1/characters', json={'object_id': object_id})
    saved = [data for event, data in parse_sse(response.text) if event == 'done'][0]
    current = gen.activities_status(saved['id'], TEST_USER_ID)
    assert [item['state'] for item in current['activities']] == ['waiting_authorization'] * 3
    assert len({item['request_id'] for item in current['activities']}) == 3
    with SessionLocal() as db:
        assert db.query(MotionGenerationRequest).count() == 1
        assert db.query(MotionGenerationActivityRequest).count() == 2


@pytest.mark.parametrize('actor', ['anonymous', 'other'])
def test_all_activity_routes_isolate_identity(client, anon, queued_case, actor):
    cid = queued_case['cid']
    if actor == 'other':
        from app.models.models import User
        with SessionLocal() as db:
            db.add(User(id='other-c173', phone='13900000173')); db.flush()
            db.get(Character, cid).owner_id = 'other-c173'; db.commit()
        caller, expected = client, 404
    else:
        caller, expected = anon, 401
    url = f'/api/v1/characters/{cid}/motion-generation/activities'
    assert caller.get(url).status_code == caller.post(url, json={}).status_code == expected


@pytest.mark.parametrize('first,second', [('walk', 'rest'), ('rest', 'walk'), ('rest', 'observe')])
def test_one_grant_cannot_be_reused_between_legacy_and_activity_tables(queued_case, first, second):
    grant(queued_case, first, 'same-grant')
    with pytest.raises(AtlasProviderError, match='approval_already_used'):
        grant(queued_case, second, 'same-grant')
    assert gen.status(queued_case['cid'], TEST_USER_ID, activity=second)['state'] == 'waiting_authorization'


@pytest.mark.parametrize('activity', gen.ACTIVITIES)
def test_each_activity_is_dispatched_once_to_its_own_review_list(client, queued_case, activity):
    case = queued_case; rid = requests(case)[activity]['request_id']; grant(case, activity)
    seen = []
    def provider(path, key, **args):
        seen.append(args.pop('activity', 'walk'))
        return case['provider'](path, key, **args)
    assert gen.process_one(provider=provider, request_id=rid)
    assert not gen.process_one(provider=provider, request_id=rid)
    assert seen == [activity]
    assert gen.status(case['cid'], TEST_USER_ID, activity=activity)['state'] == 'needs_review'
    for kind in gen.ACTIVITIES:
        items = client.get(f"/api/v1/characters/{case['cid']}/motion-candidates?activity={kind}").json()['items']
        assert len(items) == (1 if kind == activity else 0)


@pytest.mark.parametrize('activity', gen.ACTIVITIES)
def test_uncertain_result_and_process_crash_never_reissue(activity, queued_case):
    grant(queued_case, activity)
    def crash(*args, **kwargs):
        raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        gen.process_one(provider=crash)
    result = subprocess.run([sys.executable, '-c',
        'from app.services.motion_generation import recover_interrupted; recover_interrupted()'],
        capture_output=True, timeout=20)
    assert result.returncode == 0
    assert gen.status(queued_case['cid'], TEST_USER_ID, activity=activity)['state'] == 'unknown'
    assert not gen.process_one(provider=queued_case['provider'])


def test_three_candidates_review_bind_and_read_after_independent_process_restart(client, anon, queued_case):
    case = queued_case; registered = requests(case)
    for activity in gen.ACTIVITIES:
        grant(case, activity)
        def provider(path, key, **kwargs):
            kwargs.pop('activity', None)
            return case['provider'](path, key, **kwargs)
        assert gen.process_one(provider=provider, request_id=registered[activity]['request_id'])
        url = f"/api/v1/characters/{case['cid']}/motion-candidates?activity={activity}"
        candidate = client.get(url).json()['items'][0]
        assert client.get(candidate['image_url']).status_code == 200
        assert anon.get(candidate['image_url']).status_code == 401
        review = client.post(f"/api/v1/characters/{case['cid']}/motion-candidates/{candidate['job_id']}/review",
                             json={'decision': 'accept', 'candidate_sha256': candidate['candidate_sha256']})
        assert review.status_code == 200 and review.json()['state'] == 'queued'
        before = gen.activities_status(case['cid'], TEST_USER_ID)
        assert not all(item['state'] == 'ready' for item in before['activities'])
        prep.process_batch()
    assert [item['state'] for item in gen.activities_status(case['cid'], TEST_USER_ID)['activities']] == ['ready'] * 3
    result = subprocess.run([sys.executable, '-c',
        'from app.core.database import SessionLocal\n'
        'from app.models.models import CharacterActivityMotionAsset\n'
        'with SessionLocal() as db:\n assert db.query(CharacterActivityMotionAsset).count() == 3\n'],
        capture_output=True, timeout=20)
    assert result.returncode == 0
    for activity in gen.ACTIVITIES:
        resource = client.get(f"/api/v1/characters/{case['cid']}/motion?activity={activity}")
        assert resource.status_code == 200
        assert client.get(resource.json()['sprite_url']).status_code == 200
        assert anon.get(resource.json()['sprite_url']).status_code == 401
    assert case['provider'].call_count == 3
    assert not gen.process_one(provider=case['provider'])


def test_delete_cascades_all_three_pending_requests(queued_case):
    requests(queued_case)
    with SessionLocal() as db:
        db.delete(db.get(Character, queued_case['cid'])); db.commit()
        assert db.query(MotionGenerationRequest).count() == db.query(MotionGenerationActivityRequest).count() == 0


def test_one_explicit_batch_queues_exactly_three_and_cannot_be_reused(queued_case):
    case = queued_case; requests(case)
    args = dict(expected_source_sha256=case['digest'], approval_ref='single-three-call-batch',
                price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    result = gen.authorize_activities(case['cid'], TEST_USER_ID, **args)
    assert [item['state'] for item in result['activities']] == ['queued'] * 3
    with SessionLocal() as db:
        rows = [db.query(model).all() for model in gen.REQUEST_MODELS]
        assert len({row.approval_sha256 for group in rows for row in group}) == 3
    with pytest.raises(AtlasProviderError):
        gen.authorize_activities(case['cid'], TEST_USER_ID, **args)
    case['provider'].assert_not_called()


def test_one_batch_generates_each_activity_once_and_stops_after_three(queued_case):
    case = queued_case; requests(case)
    gen.authorize_activities(case['cid'], TEST_USER_ID, expected_source_sha256=case['digest'],
        approval_ref='complete-three-call-batch', price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    seen = []
    def provider(path, key, **kwargs):
        seen.append(kwargs.pop('activity', 'walk'))
        return case['provider'](path, key, **kwargs)
    for _ in gen.ACTIVITIES:
        assert gen.process_one(provider=provider)
    assert not gen.process_one(provider=provider)
    assert sorted(seen) == sorted(gen.ACTIVITIES)
    assert [item['state'] for item in gen.activities_status(case['cid'], TEST_USER_ID)['activities']] == ['needs_review'] * 3
    assert case['provider'].call_count == 3


@pytest.mark.parametrize('blocked', ['already-granted', 'reused-reference', 'unapproved-source', 'expired'])
def test_three_call_authorization_is_all_or_none(queued_case, blocked):
    case = queued_case; requests(case)
    args = dict(expected_source_sha256=case['digest'], approval_ref='atomic-three-call-batch',
                price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    if blocked == 'already-granted':
        grant(case, 'observe')
    elif blocked == 'reused-reference':
        case['root'].mkdir()
        digest = flow._digest(b'atomic-three-call-batch:observe')
        (case['root'] / f'approval-{digest}.json').write_text('{}')
    elif blocked == 'unapproved-source':
        args['expected_source_sha256'] = '0' * 64
    else:
        args['price_verified_on'] = '2000-01-01'
    with pytest.raises(AtlasProviderError):
        gen.authorize_activities(case['cid'], TEST_USER_ID, **args)
    for activity in ('rest', 'walk'):
        assert gen.status(case['cid'], TEST_USER_ID, activity=activity)['state'] == 'waiting_authorization'
    case['provider'].assert_not_called()


def test_batch_stops_remaining_calls_after_one_unknown_outcome(queued_case):
    case = queued_case; requests(case)
    gen.authorize_activities(case['cid'], TEST_USER_ID, expected_source_sha256=case['digest'],
        approval_ref='stop-on-first-failure', price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    provider = Mock(side_effect=RuntimeError('private supplier response'))
    assert gen.process_one(provider=provider)
    assert not gen.process_one(provider=provider)
    states = [item['state'] for item in gen.activities_status(case['cid'], TEST_USER_ID)['activities']]
    assert states.count('unknown') == 1 and states.count('blocked') == 2
    assert provider.call_count == 1


def test_batch_process_crash_blocks_unstarted_calls_after_restart(queued_case):
    case = queued_case; requests(case)
    gen.authorize_activities(case['cid'], TEST_USER_ID, expected_source_sha256=case['digest'],
        approval_ref='batch-crash', price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    def crash(*args, **kwargs):
        raise KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        gen.process_one(provider=crash)
    result = subprocess.run([sys.executable, '-c',
        'from app.services.motion_generation import recover_interrupted; recover_interrupted()'],
        capture_output=True, timeout=20)
    assert result.returncode == 0
    states = [item['state'] for item in gen.activities_status(case['cid'], TEST_USER_ID)['activities']]
    assert states.count('unknown') == 1 and states.count('blocked') == 2
    assert not gen.process_one(provider=case['provider'])
    case['provider'].assert_not_called()


def test_parallel_workers_cannot_overlap_a_three_call_batch(queued_case):
    from threading import Event
    case = queued_case; requests(case)
    gen.authorize_activities(case['cid'], TEST_USER_ID, expected_source_sha256=case['digest'],
        approval_ref='serial-batch', price_verified_on=date.today().isoformat(), accept_metered_cost=True)
    entered, finish = Event(), Event()
    def provider(path, key, **kwargs):
        entered.set(); assert finish.wait(5)
        kwargs.pop('activity', None)
        return case['provider'](path, key, **kwargs)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(gen.process_one, provider=provider)
        try:
            assert entered.wait(5)
            assert not pool.submit(gen.process_one, provider=provider).result(timeout=5)
        finally:
            finish.set()
        assert first.result(timeout=5)
    assert case['provider'].call_count == 1
