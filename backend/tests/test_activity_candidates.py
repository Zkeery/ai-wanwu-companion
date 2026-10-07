"""Activity isolation with synthetic providers; no claim of new model quality."""
from datetime import date
import hashlib
import json
import subprocess
import sys
from unittest.mock import Mock

import httpx
import pytest

from app.core.database import SessionLocal
from app.models.models import CharacterActivityMotionAsset
from app.services import character_walk_workflow as flow, motion_generation as generation
from app.services import motion_walk_aihubmix as provider
from app.services.motion_activity_prompts import PROMPTS
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_walk_openai import PROMPT as LEGACY_WALK
from tests.auth_helpers import TEST_USER_ID
from tests.test_character_walk_workflow import case, create, accept, record  # noqa: F401


def make(case, activity, approval=None):
    def generate(path, key, *, expected_sha256, on_task, **kwargs):
        assert kwargs.get('activity', 'walk') == activity
        on_task('activity_test')
        return case['raw'], {}
    return create(case, activity=activity, approval_ref=approval or 'approval-'+activity,
                  provider=Mock(side_effect=generate))


@pytest.mark.parametrize('activity', ['rest', 'walk', 'observe'])
def test_prompt_and_native_request_match_activity(case, activity):
    plan = flow.plan(case['cid'], TEST_USER_ID, activity=activity)
    assert plan['activity'] == activity
    assert plan['prompt_sha256'] == hashlib.sha256(PROMPTS[activity].encode()).hexdigest()
    assert PROMPTS['walk'] == LEGACY_WALK
    calls = []
    def handler(request):
        calls.append(request)
        body = json.loads(request.content)
        assert body['prompt'] == PROMPTS[activity] and body['n'] == 1
        return httpx.Response(403, json={'error': {'code': 'not_allowed'}})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError, match='provider_access_denied'):
            provider.generate(case['source'], 'synthetic-key', activity=activity,
                              expected_sha256=case['digest'], client=client)
    assert len(calls) == 1


def test_all_three_review_into_separate_slots_and_survive_worker_restart(case, monkeypatch):
    monkeypatch.setattr(flow, 'DEFAULT_ROOT', case['root'])
    jobs = {activity: make(case, activity) for activity in ('rest', 'walk', 'observe')}
    for activity, job in jobs.items():
        assert job['activity'] == activity and job['state'] == 'needs_review'
        assert record(case, job)['activity'] == activity
        assert accept(case, job)['state'] == 'queued'
    code = ('from app.core.database import SessionLocal\n'
            'from app.services.motion_preparation import process_one\n'
            'with SessionLocal() as db:\n'
            ' while process_one(db): pass\n')
    child = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=30)
    assert child.returncode == 0, child.stderr.decode()
    for activity, job in jobs.items():
        current = flow.status(job['job_id'], case['cid'], TEST_USER_ID, root=case['root'])
        assert current['activity'] == activity and current['state'] == 'ready'
        assert accept(case, job)['state'] == 'ready'
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == 3


def test_one_approval_cannot_be_reused_for_another_activity(case):
    make(case, 'rest', 'single-grant')
    with pytest.raises(AtlasProviderError, match='approval_already_used'):
        make(case, 'observe', 'single-grant')


@pytest.mark.parametrize('activity', ['dance', '', None, ['walk']])
def test_invalid_activity_never_reads_key_or_calls_provider(case, activity):
    with pytest.raises(AtlasProviderError, match='activity_invalid'):
        create(case, activity=activity)
    case['key'].assert_not_called()
    case['provider'].assert_not_called()
    assert not case['root'].exists()


def test_legacy_receipt_defaults_to_walk_and_invalid_record_is_rejected(case):
    job = create(case)
    path = case['root']/f"approval-{job['job_id']}.json"
    data = json.loads(path.read_text()); data.pop('activity'); path.write_text(json.dumps(data))
    assert flow.status(job['job_id'], case['cid'], TEST_USER_ID, root=case['root'])['activity'] == 'walk'
    data['activity'] = 'dance'; path.write_text(json.dumps(data))
    with pytest.raises(AtlasProviderError, match='job_invalid'):
        flow.status(job['job_id'], case['cid'], TEST_USER_ID, root=case['root'])


def test_http_activity_filter_review_and_walk_request_isolation(client, anon, case, monkeypatch):
    monkeypatch.setattr(flow, 'DEFAULT_ROOT', case['root'])
    rest = make(case, 'rest')
    assert generation.status(case['cid'], TEST_USER_ID)['state'] == 'not_requested'
    walk = create(case)
    base = f"/api/v1/characters/{case['cid']}/motion-candidates"
    legacy = client.get(base).json()['items']
    assert [i['job_id'] for i in legacy] == [walk['job_id']]
    assert 'activity' not in legacy[0]
    items = client.get(base+'?activity=rest').json()['items']
    assert [i['job_id'] for i in items] == [rest['job_id']]
    assert items[0]['activity'] == 'rest'
    assert client.get(base+'?activity=observe').json()['items'] == []
    assert client.get(base+'?activity=dance').status_code == 422
    assert anon.get(base+'?activity=rest').status_code == 401
    result = client.post(base+'/'+rest['job_id']+'/review', json={
        'decision': 'accept', 'candidate_sha256': rest['candidate_sha256']})
    assert result.status_code == 200
    assert result.json()['activity'] == 'rest' and result.json()['state'] == 'queued'
