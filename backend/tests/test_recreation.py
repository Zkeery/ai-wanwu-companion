"""Offline quota/recreation transactions; no real generation or paid calls."""
import json
import hashlib
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, GenerationCharge, GenerationCredits, Memory, Message, Object, Recreation
from app.services import generation_quota as quota
from app.services.model_client import ModelClient
from tests.auth_helpers import TEST_USER_ID


@pytest.fixture
def quotas(monkeypatch):
    monkeypatch.setattr(get_settings(), 'generation_quota_enabled', True)


def credits(client):
    response = client.get('/api/v1/characters/generation-credits')
    assert response.status_code == 200, response.text
    return response.json()['available']


def recreate(client, cid, parse_sse, key=None):
    key = key or str(uuid4())
    response = client.post(f'/api/v1/characters/{cid}/recreations', json={'request_id': key})
    assert response.status_code == 200, response.text
    events = parse_sse(response.text)
    assert events[-1][0] in ('done', 'error')
    return key, events[-1]


def test_recreation_is_independent_keeps_original_and_spends_once(client, ready_character_id, quotas, parse_sse, monkeypatch):
    cid = ready_character_id
    with SessionLocal() as db:
        original = db.get(Character, cid)
        original.object.visual_features = '透明杯身，金色饮料'
        original.object.character_concept_json = '{"do-not-copy":"old-concept"}'
        db.add_all([Message(character_id=cid, role='user', content='原来的聊天'), Memory(character_id=cid, content='原来的记忆')])
        db.commit()
        before = {col.name: getattr(original, col.name) for col in Character.__table__.columns}
    calls = []
    original_generate = ModelClient.generate_concept
    def fresh(self, label, features, **kwargs):
        calls.append((label, features, kwargs))
        return original_generate(self, label, features, **kwargs)
    monkeypatch.setattr(ModelClient, 'generate_concept', fresh)
    assert credits(client) == 5
    key, (kind, new) = recreate(client, cid, parse_sse)
    assert kind == 'done' and new['id'] != cid and credits(client) == 4
    assert len(calls) == 1 and calls[0][1] == '透明杯身，金色饮料'
    assert calls[0][2]['previous_character']['name'] == before['name']
    assert recreate(client, cid, parse_sse, key)[1] == ('done', new)
    assert credits(client) == 4 and len(calls) == 1
    with SessionLocal() as db:
        original = db.get(Character, cid)
        assert {col.name: getattr(original, col.name) for col in Character.__table__.columns} == before
        assert original.messages[0].content == '原来的聊天' and original.memories[0].content == '原来的记忆'
        assert original.object.character_concept_json == '{"do-not-copy":"old-concept"}'
        assert db.get(Character, new['id']).object_id != original.object_id
        assert db.query(GenerationCharge).one().status == 'spent'
    assert client.delete(f"/api/v1/characters/{new['id']}").status_code == 204
    assert credits(client) == 4
    assert client.get('/api/v1/characters/recreation-requests/' + key).json()['status'] == 'deleted'
    assert client.get(f'/api/v1/characters/{cid}').status_code == 200


@pytest.mark.parametrize('stage', ['profile', 'image'])
def test_technical_failure_refunds_once_and_duplicate_does_not_retry(client, ready_character_id, quotas, parse_sse, monkeypatch, stage):
    calls = []
    def fail(*args, **kwargs):
        calls.append(1)
        raise RuntimeError('private failure detail')
    monkeypatch.setattr(ModelClient, 'generate_concept' if stage == 'profile' else 'generate_image', fail)
    key, (kind, data) = recreate(client, ready_character_id, parse_sse)
    assert kind == 'error' and data['status'] == 'failed' and credits(client) == 5
    assert client.post(f'/api/v1/characters/{ready_character_id}/recreations', json={'request_id':key}).status_code == 409
    assert credits(client) == 5 and len(calls) == 1
    with SessionLocal() as db:
        charge = db.query(GenerationCharge).one()
        assert charge.status == 'refunded'
        object_id = db.get(Character, charge.character_id).object_id
        quota.settle(db, charge.id, success=False)
        db.commit()
    response = client.post('/api/v1/characters', json={'object_id': object_id})
    assert response.status_code == 409 and response.json()['error']['code'] == 'recreation_pending'
    assert len(calls) == 1
    assert credits(client) == 5


def test_five_successes_exhaust_quota_before_models_or_objects_are_created(client, ready_character_id, quotas, parse_sse, monkeypatch):
    for _ in range(5):
        assert recreate(client, ready_character_id, parse_sse)[1][0] == 'done'
    assert credits(client) == 0
    with SessionLocal() as db:
        count = db.query(Object).count()
    def forbidden(*args, **kwargs):
        raise AssertionError('must not generate')
    monkeypatch.setattr(ModelClient, 'generate_concept', forbidden)
    response = client.post(f'/api/v1/characters/{ready_character_id}/recreations', json={'request_id':str(uuid4())})
    assert response.status_code == 409 and response.json()['error']['code'] == 'credits_exhausted'
    with SessionLocal() as db:
        assert db.query(Object).count() == count and db.query(Recreation).count() == 5
    assert credits(client) == 0


def test_ordinary_creation_and_failed_retry_use_same_credit_rules(client, ready_character_id, quotas, parse_sse, monkeypatch):
    with SessionLocal() as db:
        source = db.get(Character, ready_character_id)
        obj = Object(photo_id=source.object.photo_id, label='新杯子', visual_features='红色')
        db.add(obj); db.commit(); oid = obj.id
    original = ModelClient.generate_concept
    def fail(*args, **kwargs):
        raise RuntimeError('failed')
    monkeypatch.setattr(ModelClient, 'generate_concept', fail)
    assert parse_sse(client.post('/api/v1/characters', json={'object_id':oid}).text)[-1][0] == 'error'
    assert credits(client) == 5
    monkeypatch.setattr(ModelClient, 'generate_concept', original)
    assert parse_sse(client.post('/api/v1/characters', json={'object_id':oid}).text)[-1][0] == 'done'
    assert credits(client) == 4
    assert client.post('/api/v1/characters', json={'object_id':oid}).status_code == 409
    assert credits(client) == 4


def test_never_started_stream_refunds_reservation(client, ready_character_id, quotas):
    from app.api.characters import recreate as endpoint, RecreationRequest
    from app.models.models import User
    key = str(uuid4())
    with SessionLocal() as db:
        response = endpoint(ready_character_id, RecreationRequest(request_id=key), db.get(User, TEST_USER_ID), db)
    assert credits(client) == 4
    response.finish()
    response.finish()
    assert credits(client) == 5
    assert client.get('/api/v1/characters/recreation-requests/' + key).json()['status'] == 'failed'


def test_delete_generating_character_refunds_and_old_worker_cannot_publish(client, ready_character_id, quotas, parse_sse, monkeypatch):
    original = ModelClient.generate_concept
    def deleted(self, *args, **kwargs):
        with SessionLocal() as db:
            cid = db.query(Character).filter_by(status='generating').one().id
        assert client.delete(f'/api/v1/characters/{cid}').status_code == 204
        return original(self, *args, **kwargs)
    monkeypatch.setattr(ModelClient, 'generate_concept', deleted)
    key, (kind, _) = recreate(client, ready_character_id, parse_sse)
    assert kind == 'error' and credits(client) == 5
    assert client.get('/api/v1/characters/recreation-requests/' + key).json()['status'] == 'deleted'


def test_recovery_refunds_running_reservations_and_preserves_spent(client, ready_character_id, quotas, parse_sse):
    recreate(client, ready_character_id, parse_sse)
    with SessionLocal() as db:
        source = db.get(Character, ready_character_id)
        obj = Object(photo_id=source.object.photo_id, label='中断杯子')
        db.add(obj); db.flush()
        ch = Character(object_id=obj.id, owner_id=TEST_USER_ID, name='', persona='', opening_line='', status='generating')
        db.add(ch); db.flush()
        quota.reserve(db, TEST_USER_ID, ch.id)
        db.commit()
    assert credits(client) == 3
    with SessionLocal() as db:
        db.query(Character).filter_by(status='generating').update({'status':'failed'})
        quota.recover(db); quota.recover(db); db.commit()
    assert credits(client) == 4
    with SessionLocal() as db:
        assert sorted(db.scalars(select(GenerationCharge.status))) == ['refunded','spent']


def test_recreation_needs_auth_enabled_flag_and_valid_uuid(client, anon, ready_character_id):
    url = f'/api/v1/characters/{ready_character_id}/recreations'
    assert anon.post(url, json={'request_id':str(uuid4())}).status_code == 401
    assert client.post(url, json={'request_id':str(uuid4())}).status_code == 409
    assert client.post(url, json={'request_id':'bad'}).status_code == 422
    assert client.get('/api/v1/characters/generation-credits').json() == {'enabled':False, 'available':None}


def test_same_key_cannot_target_a_different_source(client, ready_character_id, quotas, parse_sse):
    key, (_, result) = recreate(client, ready_character_id, parse_sse)
    r = client.post(f"/api/v1/characters/{result['id']}/recreations", json={'request_id':key})
    assert r.status_code == 409 and r.json()['error']['code'] == 'conflict'
    assert credits(client) == 4


@pytest.mark.parametrize('same_key', [True, False])
def test_concurrent_requests_cannot_double_spend_last_credit(client, ready_character_id, quotas, parse_sse, monkeypatch, same_key):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    assert credits(client) == 5
    with SessionLocal() as db:
        db.get(GenerationCredits, TEST_USER_ID).available = 1
        db.commit()
    entered, release = Event(), Event()
    original = ModelClient.generate_concept
    def paused(self, *args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(self, *args, **kwargs)
    monkeypatch.setattr(ModelClient, 'generate_concept', paused)
    key = str(uuid4())
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(recreate, client, ready_character_id, parse_sse, key)
        try:
            assert entered.wait(5)
            response = client.post(f'/api/v1/characters/{ready_character_id}/recreations', json={'request_id':key if same_key else str(uuid4())})
            assert response.status_code == 409
            assert response.json()['error']['code'] == ('recreation_pending' if same_key else 'credits_exhausted')
            assert credits(client) == 0
        finally:
            release.set()
        assert first.result(timeout=5)[1][0] == 'done'
    with SessionLocal() as db:
        assert db.query(GenerationCharge).count() == 1 and db.query(Recreation).count() == 1


def test_recreation_and_receipts_are_owner_scoped(client, ready_character_id, quotas, parse_sse):
    from datetime import datetime, timedelta
    from app.models.models import User, Session
    from app.core.security import hash_token
    key, _ = recreate(client, ready_character_id, parse_sse)
    token = 'other-recreation-test-token'
    with SessionLocal() as db:
        user = User(id=str(uuid4()), phone='13700000099')
        db.add(user); db.flush()
        db.add(Session(token_hash=hash_token(token), user_id=user.id, expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    headers = {'Authorization':'Bearer ' + token}
    assert client.get('/api/v1/characters/recreation-requests/' + key, headers=headers).status_code == 404
    assert client.post(f'/api/v1/characters/{ready_character_id}/recreations', json={'request_id':str(uuid4())}, headers=headers).status_code == 404
    assert client.get('/api/v1/characters/generation-credits', headers=headers).json()['available'] == 5
    assert credits(client) == 4


def test_new_process_recovers_pending_generation_credit(client, ready_character_id, quotas):
    import os
    import subprocess
    import sys
    from app.api.characters import recreate as endpoint, RecreationRequest
    from app.models.models import User
    key = str(uuid4())
    with SessionLocal() as db:
        response = endpoint(ready_character_id, RecreationRequest(request_id=key), db.get(User, TEST_USER_ID), db)
    assert credits(client) == 4
    script = '''
import asyncio, json
from app.main import app
from app.core.database import SessionLocal
from app.models.models import GenerationCredits, GenerationCharge
async def main():
    async with app.router.lifespan_context(app):
        with SessionLocal() as db:
            print(json.dumps({"credits": db.query(GenerationCredits).one().available,
                              "charge": db.query(GenerationCharge).one().status}))
asyncio.run(main())
'''
    result = subprocess.run([sys.executable, '-c', script], env=os.environ.copy(), capture_output=True, text=True, timeout=10, check=True)
    assert json.loads(result.stdout) == {'credits':5, 'charge':'refunded'}
    response.finish()
    assert credits(client) == 5
    assert client.get('/api/v1/characters/recreation-requests/' + key).json()['status'] == 'failed'


def test_recreation_prompt_uses_previous_identity_without_reusing_concept(quotas, monkeypatch):
    monkeypatch.setattr(get_settings(), 'model_api_key', 'synthetic-test-only')
    monkeypatch.setattr(get_settings(), 'character_bundle_enabled', False)
    prompts = []
    def capture(self, prompt, settings):
        prompts.append(prompt)
        raise RuntimeError('captured without network')
    monkeypatch.setattr(ModelClient, '_call_chat', capture)
    with pytest.raises(RuntimeError, match='captured'):
        ModelClient().generate_concept('杯子', '透明', previous_character={'name':'旧名字','persona':'安静'})
    assert '独立再创作' in prompts[0] and '旧名字' in prompts[0] and '透明' in prompts[0]


@pytest.mark.parametrize('label,features',[('绿萝','斑叶绿萝，陶盆，多个叶片'),('多肉','莲座多肉，红色盆')])
def test_same_plant_photo_registers_new_three_actions_without_reanalysis(
        client,ready_character_id,quotas,parse_sse,monkeypatch,png_header,label,features):
    from app.models.models import MotionGenerationRequest, MotionGenerationActivityRequest, MotionPreparationTask
    from app.services.motion_generation import register_request
    root=Path(get_settings().upload_dir)
    root.mkdir(parents=True,exist_ok=True)
    photo=root/'synthetic.png';photo.write_bytes(png_header)
    original_image=root/'characters'/'original.png';original_image.parent.mkdir(exist_ok=True)
    original_image.write_bytes(png_header)
    with SessionLocal() as db:
        original=db.get(Character,ready_character_id)
        original.object.label=label;original.object.category='plant';original.object.visual_features=features
        original.image_path='characters/original.png'
        register_request(db,original);db.commit()
        before={col.name:getattr(original,col.name) for col in Character.__table__.columns}
        old_object_id,photo_id=original.object_id,original.object.photo_id
    digest=hashlib.sha256(photo.read_bytes()).hexdigest()
    monkeypatch.setattr(ModelClient,'recognize',lambda *a,**k:pytest.fail('Same photo must not be recognized again'))
    calls=[];generate=ModelClient.generate_concept
    def fresh(self,actual_label,actual_features,**kwargs):
        calls.append((actual_label,actual_features,kwargs['previous_character']))
        return generate(self,actual_label,actual_features,**kwargs)
    monkeypatch.setattr(ModelClient,'generate_concept',fresh)
    key,(kind,new)=recreate(client,ready_character_id,parse_sse)
    assert kind=='done' and new['id']!=ready_character_id and credits(client)==4
    assert calls[0][:2]==(label,features) and len(calls)==1
    assert hashlib.sha256(photo.read_bytes()).hexdigest()==digest
    assert recreate(client,ready_character_id,parse_sse,key)[1]==('done',new)
    assert len(calls)==1 and credits(client)==4
    with SessionLocal() as db:
        old=db.get(Character,ready_character_id);created=db.get(Character,new['id'])
        assert {col.name:getattr(old,col.name) for col in Character.__table__.columns}==before
        assert created.object_id!=old_object_id and created.object.photo_id==photo_id
        assert created.object.visual_features==features and created.object.category=='plant'
        for cid in (ready_character_id,new['id']):
            walk=db.query(MotionGenerationRequest).filter_by(character_id=cid).one()
            extra=db.query(MotionGenerationActivityRequest).filter_by(character_id=cid).all()
            assert walk.state=='waiting_authorization' and walk.approval_ref is None
            assert {r.activity for r in extra}=={'rest','observe'}
            assert all(r.state=='waiting_authorization' and r.approval_ref is None for r in extra)
        prepared=db.query(MotionPreparationTask).filter_by(character_id=new['id']).all()
        assert {r.activity for r in prepared}=={'rest','walk','observe'}
