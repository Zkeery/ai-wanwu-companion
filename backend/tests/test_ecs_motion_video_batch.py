"""Mock transport only: prove the new batch cannot spend outside its grant."""
from datetime import datetime
import hashlib
import json
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.services.daily_model_quota import DailyModelQuota
from scripts.ecs_motion_video_batch import Batch, ENDPOINT, MODEL, TASKS, validate


@pytest.fixture
def case(tmp_path):
    source = tmp_path / 'source.png'; source.write_bytes(b'\x89PNG\r\n\x1a\nsynthetic')
    plan = {'model': MODEL, 'endpoint': ENDPOINT, 'task_endpoint': TASKS,
            'requests_max': 3, 'automatic_retries': 0, 'cap_cny': 7,
            'price_cny_per_second': .45,
            'price_verified_on': datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat(),
            'source_file': str(source), 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
            'activities': [{'activity': x, 'prompt': x, 'prompt_sha256': hashlib.sha256(x.encode()).hexdigest(),
                            'parameters': {'resolution': '480P', 'ratio': '1:1', 'duration': 5, 'generate_audio': False}}
                           for x in ['walk', 'rest', 'observe']]}
    path = tmp_path / 'plan.json'; path.write_text(json.dumps(plan))
    approval = {'confirmed': True, 'cap_cny': 7, 'requests_max': 3, 'automatic_retries': 0,
                'activities': ['walk', 'rest', 'observe'], 'source_sha256': plan['source_sha256'],
                'plan_sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    auth = tmp_path / 'approval.json'; auth.write_text(json.dumps(approval))
    quota = DailyModelQuota(tmp_path / 'daily.db', 30)
    return path, auth, tmp_path / 'work', quota, source, plan


def client_for(callback):
    return httpx.Client(transport=httpx.MockTransport(callback), follow_redirects=False)


@pytest.mark.parametrize('field,value', [('model', 'other'), ('cap_cny', 8), ('requests_max', 4),
                                      ('automatic_retries', 1), ('price_cny_per_second', .46),
                                      ('price_verified_on', '2000-01-01'), ('endpoint', 'https://outside.test')])
def test_frozen_plan_rejects_unapproved_changes(case, field, value):
    plan = case[-1].copy(); plan[field] = value
    with pytest.raises(ValueError): validate(plan)


@pytest.mark.parametrize('field,value', [('confirmed', False), ('cap_cny', 8), ('requests_max', 4),
                                      ('plan_sha256', 'a' * 64), ('source_sha256', 'b' * 64)])
def test_requires_this_exact_explicit_grant_before_creating_work(case, field, value):
    path, auth, work, *_ = case
    approval = json.loads(auth.read_text()); approval[field] = value; auth.write_text(json.dumps(approval))
    with pytest.raises(ValueError): Batch(path, auth, work)
    assert not work.exists()


def test_three_posts_are_pre_reserved_and_downloads_do_not_leak_the_key(case):
    path, auth, work, quota, _, _ = case; batch = Batch(path, auth, work); posts = []
    def handler(request):
        if request.method == 'POST':
            # Assert both durable ledgers have committed before any transport call.
            assert quota.status()['used'] == len(posts) + 1
            assert batch.status()['reserved_cny'] == 2.25 * (len(posts) + 1)
            body = json.loads(request.content)
            assert body['model'] == MODEL and body['parameters']['duration'] == 5
            assert body['parameters']['generate_audio'] is False
            assert body['input']['media'][0]['url'].startswith('data:image/png;base64,')
            posts.append(body); return httpx.Response(200, json={'output': {'task_id': 'task-' + str(len(posts))}})
        if request.url.host == 'maas-api.antdigital.com':
            return httpx.Response(200, json={'output': {'task_id': 'task-' + str(len(posts)),
                'task_status': 'SUCCEEDED', 'video_url': 'https://result.oss-cn-beijing.aliyuncs.com/clip.mp4'}})
        assert 'authorization' not in request.headers
        return httpx.Response(200, content=b'\x00\x00\x00\x18ftypisomsynthetic')
    with client_for(handler) as client:
        for activity in ['walk', 'rest', 'observe']:
            assert batch.submit(activity, 'test-key', client, quota)['stopped'] is None
            assert batch.poll(activity, 'test-key', client) == 'succeeded'
            assert batch.download(activity, client)['state'] == 'needs_review'
        with pytest.raises(ValueError): batch.submit('walk', 'test-key', client, quota)
    assert len(posts) == quota.status()['used'] == 3
    assert batch.status()['reserved_cny'] == 6.75
    assert all(x['state'] == 'downloaded' for x in batch.status()['calls'])


@pytest.mark.parametrize('failure', ['network', 'http', 'receipt'])
def test_failure_or_unknown_stops_all_further_generation_without_refund(case, failure):
    path, auth, work, quota, *_ = case; batch = Batch(path, auth, work); posts = []
    def handler(request):
        posts.append(request)
        if failure == 'network': raise httpx.ReadTimeout('unknown')
        return httpx.Response(403, json={}) if failure == 'http' else httpx.Response(200, json={'output': {}})
    with client_for(handler) as client:
        result = batch.submit('walk', 'test-key', client, quota)
        assert result['stopped'] and result['reserved_cny'] == 2.25
        restarted = Batch(path, auth, work)
        for activity in ['walk', 'rest', 'observe']:
            with pytest.raises(ValueError): restarted.submit(activity, 'test-key', client, quota)
    assert len(posts) == quota.status()['used'] == 1


def test_restart_does_not_reissue_a_known_pending_task(case):
    path, auth, work, quota, *_ = case; batch = Batch(path, auth, work); called = []
    with client_for(lambda r: (called.append(r), httpx.Response(200, json={'output': {'task_id': 'known'}}))[1]) as client:
        batch.submit('walk', 'test-key', client, quota)
        with pytest.raises(ValueError): Batch(path, auth, work).submit('walk', 'test-key', client, quota)
        with pytest.raises(ValueError): batch.submit('rest', 'test-key', client, quota)
    assert len(called) == 1


def test_source_change_blocks_submission_before_any_reservation(case):
    path, auth, work, quota, source, _ = case; batch = Batch(path, auth, work)
    source.write_bytes(b'changed')
    with client_for(lambda _: pytest.fail('No network allowed')) as client, pytest.raises(ValueError):
        batch.submit('walk', 'test-key', client, quota)
    assert quota.status()['used'] == 0 and not batch.status()['calls']


def test_global_daily_limit_stops_a_new_batch_without_a_provider_call(case):
    path, auth, work, _, source, _ = case; quota = DailyModelQuota(source.parent / 'limited.db', 1)
    quota.finish(quota.reserve(), 200); batch = Batch(path, auth, work)
    with client_for(lambda _: pytest.fail('Daily quota must block transport')) as client:
        result = batch.submit('walk', 'test-key', client, quota)
    assert result['stopped'] and quota.status()['used'] == 1


def test_refuses_reusing_a_work_directory_for_a_changed_grant(case):
    path, auth, work, *_ = case; Batch(path, auth, work)
    value = json.loads(auth.read_text()); value['user_reply'] = 'different record'; auth.write_text(json.dumps(value))
    with pytest.raises(ValueError, match='another_grant'): Batch(path, auth, work)


def test_untrusted_download_origin_is_never_fetched(case):
    path, auth, work, quota, *_ = case; batch = Batch(path, auth, work)
    with client_for(lambda _: httpx.Response(200, json={'output': {'task_id': 'known'}})) as client:
        batch.submit('walk', 'test-key', client, quota)
    with client_for(lambda _: httpx.Response(200, json={'output': {'task_id': 'known', 'task_status': 'SUCCEEDED',
                     'video_url': 'https://127.0.0.1/private'}})) as client:
        batch.poll('walk', 'test-key', client)
    with client_for(lambda _: pytest.fail('No untrusted download')) as client, pytest.raises(ValueError):
        batch.download('walk', client)
    assert batch.status()['stopped'] == 'video_download_origin_unverified'
