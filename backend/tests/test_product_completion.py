"""Product routes and durable candidates with forbidden external network."""
import asyncio
import copy
import hashlib
import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from app.core.config import Settings
from app.core.database import engine, SessionLocal
from app.models.models import MotionPreparationTask, Character, CharacterActivityMotionAsset
from app.services import life_dispatch
from app.services import video_motion_candidates as video
from app.services.trial_gate import TrialGate, TrialBlocked
from app.services.trial_wiring import TrialLifeFactories, BASE_URL
from app.services.motion_preparation import process_one
from tests.test_remaining_acceptance_wiring import clips, pack  # noqa: F401
from tests.test_life_live_planner import setup, allocate, OWNER, catalog as private_catalog  # noqa: F401
from tests.test_gathering_dialogue import ready, UID, result  # noqa: F401
from tests.test_gathering_automatic import prepared, fund, enable, catalog  # noqa: F401
from tests.test_trial_guards import setup as gate_setup, evidence, text_result, KEY


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*_a, **_kw): raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)
    life_dispatch.install()
    yield
    life_dispatch.install()


@pytest.fixture
def staged(clips, tmp_path, monkeypatch):
    cid, source, videos = clips
    monkeypatch.setattr('app.services.character_walk_workflow.DEFAULT_ROOT', tmp_path / 'candidates')
    with SessionLocal() as db: batch = video.register(db, cid, UID, videos)
    return cid, source, batch


def test_video_web_review_atomic_queue_refresh_and_private_playback(client, anon, staged):
    cid, _, batch = staged
    for item in batch['items']:
        page = client.get(f'/api/v1/characters/{cid}/motion-candidates?activity={item["activity"]}')
        assert page.status_code == 200
        assert page.json()['items'] == [item]
        media = client.get(item['video_url'])
        assert media.status_code == 200 and media.headers['content-type'] == 'video/mp4'
        assert hashlib.sha256(media.content).hexdigest() == item['candidate_sha256']
        assert anon.get(item['video_url']).status_code == 401
    for index, item in enumerate(batch['items']):
        response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                              json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
        assert response.status_code == 200, response.text
        assert response.json()['state'] == ('queued' if index == 2 else 'reviewed')
        with SessionLocal() as db:
            assert db.query(MotionPreparationTask).count() == (3 if index == 2 else 0)
    item = batch['items'][-1]
    client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 3
        for _ in range(3): assert process_one(db)
        assert db.query(CharacterActivityMotionAsset).count() == 3
    for item in batch['items']:
        page = client.get(f'/api/v1/characters/{cid}/motion-candidates?activity={item["activity"]}').json()
        assert page['items'][0]['state'] == 'ready'
        bound = client.get(f'/api/v1/characters/{cid}/motion?activity={item["activity"]}').json()
        assert client.get(bound['video_url']).status_code == 200


@pytest.mark.parametrize('change', ['reject', 'source', 'video', 'owner', 'digest'])
def test_video_web_review_fails_closed_without_partial_publish(client, staged, change):
    cid, source, batch = staged
    item = batch['items'][0]
    body = {'decision': 'accept', 'candidate_sha256': item['candidate_sha256']}
    if change == 'reject':
        body['decision'] = 'reject'
        assert client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review', json=body).status_code == 200
        body['decision'] = 'accept'
    elif change == 'source': source.write_bytes(b'changed source fixture')
    elif change == 'video':
        file, _, activity = video._find(item['job_id'], cid, UID)
        (file.parent / (activity + '.mp4')).write_bytes(b'changed candidate fixture')
    elif change == 'owner':
        from app.models.models import User
        with SessionLocal() as db:
            db.add(User(id='video-other', phone='13900999331')); db.flush()
            db.get(Character, cid).owner_id = 'video-other'; db.commit()
    else: body['candidate_sha256'] = '0' * 64
    response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review', json=body)
    assert response.status_code >= 400
    with SessionLocal() as db: assert db.query(MotionPreparationTask).count() == 0


def factory(tmp_path, clock, owner, sid, shared='shared-fixture', fail=False):
    first, _ = gate_setup(tmp_path, 'life')
    p = copy.deepcopy(first.policy); p['authorization_ref'] = 'product-' + uuid4().hex
    p['starts_at'] = clock(); p['ends_at'] = clock() + 86400
    p['scopes'] = {'private_life': {'owner': owner, 'subject': sid},
                   'shared_life': {'owner': owner, 'subject': shared}}
    gate = TrialGate.create(tmp_path/'product.db', first.daily, p, clock=clock)
    requests = []
    def handle(r):
        requests.append(r.method)
        if fail: raise httpx.ReadTimeout('synthetic-timeout')
        return httpx.Response(200, json=text_result('{"activity":"rest","reason":"在住处休息"}'))
    proof = lambda kind: evidence(gate, kind)
    factories = TrialLifeFactories(gate, proof, KEY, delegate_factory=lambda _: httpx.MockTransport(handle))
    return factories, gate, requests


def test_product_private_life_uses_scoped_transport_and_retains_usage(setup, tmp_path, monkeypatch):
    from app.api import life_runtime as api
    from app.living.life_live_planner import run_real_planner
    kernel, sid, tid = setup
    allocate(kernel, sid)
    factories, gate, requests = factory(tmp_path, kernel._now, OWNER, sid)
    settings = Settings(_env_file=None, app_env='production', auth_mode='invite', model_base_url=BASE_URL,
                        model_api_key=KEY, chat_model='qwen3.8-flash')
    monkeypatch.setattr(api, 'get_settings', lambda: settings)
    monkeypatch.setattr(life_dispatch, 'get_settings', lambda: settings)
    async def bounded(*args, **kw): return await run_real_planner(*args, **kw, catalog_check=private_catalog)
    monkeypatch.setattr(api, 'run_real_planner', bounded)
    life_dispatch.install(factories)
    asyncio.run(api.execute_requested(kernel, OWNER, sid, tid))
    assert kernel.read_task(OWNER, sid, tid).state == 'done'
    asyncio.run(api.execute_requested(kernel, OWNER, sid, tid))
    assert requests == ['POST'] and gate.summary()['counts']['private_life'] == 1
    usage = gate.usage()
    assert usage['actual_bill_micro'] is None and usage['actual_bill_verified'] is False
    assert usage['records'][0]['total_tokens'] == 530
    assert KEY not in json.dumps(usage) and '在住处休息' not in json.dumps(usage)
    with pytest.raises(Exception):
        life_dispatch.adapter('private_life', 'other-owner', sid, str(uuid4()), presence='away', fallback=lambda: None)
    assert gate.summary()['state'] == 'active' and requests == ['POST']


def test_product_private_failure_stops_gate_and_both_policy_scopes(setup, tmp_path, monkeypatch):
    from app.api import life_runtime as api
    from app.living.life_live_planner import run_real_planner
    kernel, sid, tid = setup; allocate(kernel, sid)
    factories, gate, requests = factory(tmp_path, kernel._now, OWNER, sid, fail=True)
    settings = Settings(_env_file=None, app_env='production', auth_mode='invite', model_base_url=BASE_URL, model_api_key=KEY, chat_model='qwen3.8-flash')
    monkeypatch.setattr(api, 'get_settings', lambda: settings)
    async def bounded(*args, **kw): return await run_real_planner(*args, **kw, catalog_check=private_catalog)
    monkeypatch.setattr(api, 'run_real_planner', bounded)
    stopped = []
    life_dispatch.install(factories, on_stop=lambda scopes: stopped.extend(scopes))
    asyncio.run(api.execute_requested(kernel, OWNER, sid, tid))
    assert kernel.read_task(OWNER, sid, tid).state == 'failed'
    assert requests == ['POST'] and gate.summary()['state'] == 'stopped'
    assert set(stopped) == {'private_life', 'shared_life'} and gate.usage()['records'] == []
    asyncio.run(api.execute_requested(kernel, OWNER, sid, tid))
    assert requests == ['POST']


def test_production_life_never_falls_back_to_unrestricted_provider(monkeypatch):
    from app.living.rules import LivingError
    from types import SimpleNamespace
    monkeypatch.setattr(life_dispatch, 'get_settings', lambda: SimpleNamespace(app_env='production'))
    with pytest.raises(LivingError):
        life_dispatch.adapter('private_life', 'x', 'y', 'z', presence='away',
                              fallback=lambda: pytest.fail('unrestricted provider forbidden'))


def test_shared_worker_binds_claimed_task_owner_group_and_request(prepared, monkeypatch):
    from app.api import gatherings as api
    from app.living.gathering_automatic import consume_once
    store, clock, group, ids = prepared
    sid = fund(prepared); enable(prepared, sid)
    monkeypatch.setattr(api, 'automatic_store', store)
    monkeypatch.setattr(api, 'automatic_available', lambda: True)
    seen = []
    class Factories:
        def adapter(self, kind, owner, subject, operation, *, presence):
            seen.append((kind, owner, subject, operation, presence))
            class Client:
                async def exchange(self, facts): return result(ids)
            return Client()
    life_dispatch.install(Factories())
    asyncio.run(consume_once(store, lambda: pytest.fail('unscoped factory forbidden'), catalog,
                             task_factory=api.automatic_task_client))
    assert len(seen) == 1 and seen[0][:3] == ('shared_life', UID, group['id'])
    assert seen[0][4] == 'away' and store.read(UID, group['id'])['tasks'][0]['state'] == 'done'


def test_video_candidates_survive_new_process_without_reapproval(client, staged):
    import os
    import subprocess
    import sys
    from app.services import character_walk_workflow as flow
    cid, _, batch = staged
    item = batch['items'][0]
    response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                           json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
    assert response.status_code == 200 and response.json()['state'] == 'reviewed'
    code = """import json,socket,sys
from pathlib import Path
from app.services import character_walk_workflow as f
from app.services.video_motion_candidates import describe
def deny(*a,**kw):raise RuntimeError('NETWORK_FORBIDDEN')
socket.socket.connect=deny;socket.socket.connect_ex=deny
f.DEFAULT_ROOT=Path(sys.argv[1])
print(json.dumps(describe(sys.argv[2],int(sys.argv[3]),sys.argv[4])))
"""
    child = subprocess.run([sys.executable, '-c', code, str(flow.DEFAULT_ROOT), item['job_id'], str(cid), UID],
                           env=os.environ.copy(), capture_output=True, text=True, timeout=15)
    assert child.returncode == 0
    assert json.loads(child.stdout) == response.json()
    with SessionLocal() as db: assert db.query(MotionPreparationTask).count() == 0


def test_rejected_alternative_never_hides_an_active_video_batch(client, staged, clips):
    cid, _, first = staged
    with SessionLocal() as db: second = video.register(db, cid, UID, clips[2])
    rejected = max((first, second), key=lambda b: b['batch_id'])
    item = rejected['items'][0]
    response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                           json={'decision': 'reject', 'candidate_sha256': item['candidate_sha256']})
    assert response.status_code == 200
    states = client.get(f'/api/v1/characters/{cid}/motion-generation/activities').json()
    assert all(item['state'] == 'needs_review' for item in states['activities'])
    with SessionLocal() as db: assert db.query(MotionPreparationTask).count() == 0


@pytest.mark.parametrize('damage', ['json', 'schema', 'symlink'])
def test_damaged_historical_batch_does_not_block_owned_video(client, staged, damage):
    from app.services import character_walk_workflow as flow
    cid, _, batch = staged
    bad = flow.DEFAULT_ROOT / ('video-batch-' + '0' * 64)
    bad.mkdir()
    record = bad / 'record.json'
    if damage == 'symlink':
        target = bad / 'retained-original.json'
        target.write_text('{}')
        record.symlink_to(target)
    else:
        record.write_text('{' if damage == 'json' else '{}')
    original = record.read_bytes()
    item = batch['items'][0]
    assert client.get(item['video_url']).status_code == 200
    response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                           json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
    assert response.status_code == 200 and response.json()['state'] == 'reviewed'
    missing = client.get(f'/api/v1/characters/{cid}/motion-candidates/{"f"*64}/video/{"f"*64}')
    assert missing.status_code == 404
    assert record.read_bytes() == original
    assert record.is_symlink() == (damage == 'symlink')


def test_failed_video_preparation_resumes_only_on_explicit_accept(client, staged):
    cid, _, batch = staged
    for item in batch['items']:
        response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                               json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
        assert response.status_code == 200
    item = batch['items'][1]
    with SessionLocal() as db:
        job = db.get(MotionPreparationTask, (cid, item['activity']))
        job.state, job.attempts, job.error_code = 'failed', 3, 'motion_unavailable'
        old_pack = job.input_pack_id
        db.commit()
        for _ in range(2): assert process_one(db)
        assert db.query(CharacterActivityMotionAsset).count() == 2
    file, record, _ = video._find(item['job_id'], cid, UID)
    history = copy.deepcopy(record['history'])
    # Reading the page never resets the failed queue or the user's decisions.
    for _ in range(2):
        page = client.get(f'/api/v1/characters/{cid}/motion-candidates?activity={item["activity"]}')
        assert page.status_code == 200 and page.json()['items'][0]['state'] == 'reviewed'
    with SessionLocal() as db:
        assert db.get(MotionPreparationTask, (cid, item['activity'])).attempts == 3
    response = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                           json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
    assert response.status_code == 200 and response.json()['state'] == 'queued'
    with SessionLocal() as db:
        job = db.get(MotionPreparationTask, (cid, item['activity']))
        assert job.state == 'queued' and job.attempts == 0 and job.input_pack_id != old_pack
        assert db.query(MotionPreparationTask).count() == 3
        new_pack = job.input_pack_id
    assert video._read(file)['history'] == history and len(history) == 3
    # A second identical HTTP request is idempotent, including queue inputs.
    again = client.post(f'/api/v1/characters/{cid}/motion-candidates/{item["job_id"]}/review',
                        json={'decision': 'accept', 'candidate_sha256': item['candidate_sha256']})
    assert again.status_code == 200
    with SessionLocal() as db:
        assert db.get(MotionPreparationTask, (cid, item['activity'])).input_pack_id == new_pack
        assert process_one(db)
        assert not process_one(db)
        assert db.query(CharacterActivityMotionAsset).count() == 3
    assert video.describe(item['job_id'], cid, UID)['state'] == 'ready'
    assert video._read(file)['history'] == history
