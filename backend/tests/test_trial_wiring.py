"""Real service/startup wiring with synthetic approvals and zero network."""
import asyncio
import copy
import json
import os
from pathlib import Path
import runpy
import time
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select

from app.core.config import Settings
from app.core.database import engine, SessionLocal
from app.living.life_planner import Prompt, SYSTEM
from app.living.rules import LivingError
from app.models.models import Message
from app.services import trial_wiring as wiring, voice_sessions, daily_model_quota as daily
from app.services.trial_gate import TrialGate, TrialBlocked
from app.services.trial_transport import TEXT_URL
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_trial_guards import setup, evidence, text_result, KEY
from tests.test_voice import wav
from tests.test_qwen_flash_speech import source_wav


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*a, **k):raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect',deny)
    monkeypatch.setattr('socket.socket.connect_ex',deny)
    monkeypatch.setattr('app.services.voice.local_voices',lambda:[])


def build(tmp_path, cid, *, mode='voice', bad_download=False):
    first,now=setup(tmp_path,mode);now[0]=int(time.time())
    p=copy.deepcopy(first.policy);p['authorization_ref']+='-wiring'
    p['starts_at']=now[0]-5;p['ends_at']=p['starts_at']+86400
    if mode=='voice':p['scopes']={k:{'owner':UID,'subject':str(cid)} for k in p['scopes']}
    g=TrialGate.create(tmp_path/'wiring.db',first.daily,p,clock=lambda:now[0])
    settings=Settings(_env_file=None,app_env='development',model_base_url=wiring.BASE_URL,
        image_base_url=wiring.BASE_URL,model_api_key=KEY,chat_model=wiring.MODEL,model_max_retries=0)
    reader=lambda k:evidence(g,k)
    calls=[];download_failure=[bad_download]
    def respond(r):
        calls.append((r.method,r.url.host))
        if r.method=='GET':return httpx.Response(503) if download_failure[0] else httpx.Response(200,content=source_wav())
        if str(r.url)==TEXT_URL:return httpx.Response(200,json=text_result())
        return httpx.Response(200,json={'output':{'audio':{'url':
            'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav?signature=synthetic'}},'usage':{'characters':20}})
    factory=lambda k:httpx.MockTransport(respond)
    if mode=='voice':
        with engine.begin() as conn:voice_sessions.authorize(conn,UID,cid,p['authorization_ref'],2,now[0])
        service=wiring.TrialVoiceService(engine,g,reader,settings,KEY,delegate_factory=factory)
        service.read_settings(UID,cid);service.save_settings(UID,cid,'qwen:Cherry',None,False)
    else:service=wiring.TrialLifeFactories(g,reader,KEY,delegate_factory=factory)
    return service,g,now,calls,download_failure,settings


def test_two_actual_voice_service_rounds_count_once_and_replay_after_stop(tmp_path,ready_character_id):
    s,g,now,calls,_,_=build(tmp_path,ready_character_id);cid=ready_character_id
    restore=daily.install_httpx_quota(g.daily,[wiring.BASE_URL,'https://dashscope.aliyuncs.com/api/v1'])
    try:
        rids=[]
        for text in ['有点累，想歇一会儿。','你还记得刚才说什么吗？']:
            rid=str(uuid4());rids.append(rid)
            result=s.send(UID,cid,rid,text,wav(),offline=True)
            assert result['state']=='completed' and result['error'] is None
        assert g.daily.status()['used']==4 and g.summary()['attempts']==4
        with pytest.raises(TrialBlocked):g.stop()
        assert s.send(UID,cid,rids[0],'有点累，想歇一会儿。',wav(),offline=True)['state']=='completed'
        with pytest.raises(LivingError):s.send(UID,cid,str(uuid4()),'不能多发',wav(),offline=True)
        assert len(calls)==6 and g.daily.status()['used']==4
        assert s.context.get() is None
    finally:restore()


@pytest.mark.parametrize('scene_type', ['home', 'forest'])
def test_fractional_gate_clock_supports_two_voice_rounds_in_living_scene(tmp_path, ready_character_id, scene_type):
    from app.living.store import LivingStore
    from app.models.models import Character

    s, g, now, calls, _, _ = build(tmp_path, ready_character_id)
    cid = ready_character_id
    scene = LivingStore(engine).create_space(UID, str(uuid4()), scene_type, 'private', str(cid))
    with SessionLocal() as db:
        db.get(Character, cid).current_space_id = scene['id']
        db.commit()
    # Scene creation uses the wall clock; keep this fractional test clock at or
    # after that committed state even if setup crossed an integer-second edge.
    now[0] = max(now[0], time.time()) + 0.25

    for text in ['今天想在这里休息。', '你还记得我刚才说什么吗？']:
        result = s.send(UID, cid, str(uuid4()), text, wav(), offline=False)
        assert result['state'] == 'completed' and result['error'] is None
    assert g.summary()['counts'] == {'voice_text': 2, 'voice_tts': 2}
    assert g.daily.status()['used'] == 4
    assert len(calls) == 6


def test_download_failure_stops_batch_but_download_only_recovery_adds_no_charge(tmp_path,ready_character_id):
    s,g,_,calls,bad,_=build(tmp_path,ready_character_id,bad_download=True);cid=ready_character_id
    result=s.send(UID,cid,str(uuid4()),'先休息。',wav(),offline=True)
    assert result['error']=='audio_unavailable' and g.summary()['state']=='stopped'
    assert g.daily.status()['used']==2 and len(calls)==3
    bad[0]=False
    entry=next(x for x in s.history(UID,cid) if x['role']=='assistant')
    assert s.retry_audio(UID,cid,entry['id'])['state']=='ready'
    assert len(calls)==4 and g.daily.status()['used']==2
    with pytest.raises(LivingError):s.send(UID,cid,str(uuid4()),'不得再合成',wav(),offline=True)


@pytest.mark.parametrize('case',['stale','tts-unknown','other-owner','wrong-cid','revoked'])
def test_no_text_or_audio_dispatch_on_invalid_send_context(tmp_path,ready_character_id,case):
    s,g,now,calls,_,_=build(tmp_path,ready_character_id);cid=ready_character_id;uid=UID
    if case=='stale':
        snapshot={k:evidence(g,k) for k in g.policy['scopes']}
        s.reader=lambda k:snapshot[k];now[0]+=901
    elif case=='tts-unknown':s.reader=lambda k:{} if k=='voice_tts' else evidence(g,k)
    elif case=='other-owner':uid='someone-else'
    elif case=='wrong-cid':cid+=1
    elif case=='revoked':s.end_live_session(UID,cid)
    with pytest.raises(LivingError):s.send(uid,cid,str(uuid4()),'不能发',wav(),offline=True)
    assert calls==[] and g.daily.status()['used']==0
    with SessionLocal() as db:assert db.query(Message).count()==0


def test_restart_refuses_unfinished_voice_intent_without_reissuing(tmp_path,ready_character_id):
    s,g,_,calls,_,settings=build(tmp_path,ready_character_id)
    with g.single_dispatch():g.reserve('voice_text',UID,str(ready_character_id),'pending-intent-01',b'{}',evidence(g,'voice_text'))
    with pytest.raises(TrialBlocked,match='preflight_blocked'):
        wiring.TrialVoiceService(engine,g,s.reader,settings,KEY)
    assert not calls and g.daily.status()['used']==1


def test_life_factory_and_normal_model_request_share_daily_limit_without_double_count(tmp_path):
    f,g,now,calls,_,_=build(tmp_path,0,mode='life')
    life_response=text_result(json.dumps({'activity':'rest','reason':'休息'}))
    def respond(r):calls.append(('POST','mock'));return httpx.Response(200,json=life_response)
    f.delegate_factory=lambda k:httpx.MockTransport(respond)
    restore=daily.install_httpx_quota(g.daily,[wiring.BASE_URL])
    try:
        adapter=f.adapter('private_life','owner','private_life','life-operation-01',presence='visible')
        asyncio.run(adapter.plan(Prompt(SYSTEM,'{}')))
        assert g.daily.status()['used']==1 and g.summary()['attempts']==1
        # The internal trial counting scope must have ended for ordinary requests.
        with httpx.Client(transport=httpx.MockTransport(respond)) as c:c.post(TEXT_URL,json={})
        assert g.daily.status()['used']==2 and g.summary()['attempts']==1
        with pytest.raises(TrialBlocked):f.adapter('shared_life','outsider','shared_life','bad-scope-0001',presence='away')
    finally:restore()


def test_default_off_requires_no_evidence_key_or_grant(tmp_path):
    q=daily.DailyModelQuota(tmp_path/'quota.db',30)
    value=wiring.configure_trials(engine,Settings(_env_file=None),q,{})
    assert value=={'voice':None,'life':None} and q.status()['used']==0
    with q.connection() as db:assert not db.execute("SELECT name FROM sqlite_master WHERE name='acceptance_authorizations'").fetchone()


def test_life_evidence_failure_stays_stopped_after_evidence_is_refreshed(tmp_path):
    f,g,now,calls,_,_=build(tmp_path,0,mode='life')
    frozen={k:evidence(g,k) for k in g.policy['scopes']}
    f.reader=lambda k:frozen[k];now[0]+=901
    with pytest.raises(TrialBlocked):f.adapter('private_life','owner','private_life','stale-task-0001',presence='visible')
    f.reader=lambda k:evidence(g,k)
    with pytest.raises(TrialBlocked):f.adapter('private_life','owner','private_life','fresh-task-0001',presence='visible')
    assert g.summary()['state']=='stopped' and calls==[]


@pytest.mark.parametrize('case',['missing-evidence','public-evidence','wrong-key','expired','both-phases'])
def test_startup_rejects_bad_trial_without_call_or_new_grant(tmp_path,ready_character_id,monkeypatch,case):
    s,g,now,calls,_,settings=build(tmp_path,ready_character_id)
    f=tmp_path/'evidence.json';f.write_text(json.dumps({k:evidence(g,k) for k in g.policy['scopes']}));f.chmod(0o600)
    env={'PARTNER_VOICE_TRIAL_LEDGER':str(g.path),'PARTNER_TRIAL_EVIDENCE_FILE':str(f)}
    settings=settings.model_copy(update={'voice_local_model_path':'fixture'})
    monkeypatch.setattr(wiring,'TrialGate',lambda path,q:g)
    monkeypatch.setattr('app.services.transcription_config.transcription_status',lambda p:'configured')
    monkeypatch.setattr(wiring.cloud_speech,'project_tts_key',lambda:KEY)
    if case=='missing-evidence':f.unlink()
    elif case=='public-evidence':f.chmod(0o644)
    elif case=='wrong-key':settings=settings.model_copy(update={'model_api_key':'other-key'})
    elif case=='expired':now[0]=g.policy['ends_at']
    elif case=='both-phases':env['PARTNER_LIFE_TRIAL_LEDGER']=str(g.path)
    with pytest.raises((TrialBlocked,OSError)):wiring.configure_trials(engine,settings,g.daily,env)
    assert calls==[] and g.daily.status()['used']==0


@pytest.mark.parametrize('configured',[False,True])
def test_actual_production_entry_installs_only_valid_bounded_service(tmp_path,ready_character_id,monkeypatch,configured):
    # Import routes with the normal test configuration before temporarily
    # replacing the startup factory; imported aliases must not retain it.
    from app.main import app
    from app.api import voice
    s,g,_,calls,_,settings=build(tmp_path,ready_character_id)
    f=tmp_path/'evidence.json';f.write_text(json.dumps({k:evidence(g,k) for k in g.policy['scopes']}));f.chmod(0o600)
    for k in ['PARTNER_VOICE_TRIAL_LEDGER','PARTNER_LIFE_TRIAL_LEDGER','PARTNER_TRIAL_EVIDENCE_FILE']:
        monkeypatch.delenv(k,raising=False)
    monkeypatch.setenv('PARTNER_DAILY_QUOTA_DB',str(g.daily.path));monkeypatch.setenv('PARTNER_DAILY_REQUEST_LIMIT','30')
    monkeypatch.setenv('PARTNER_VOICE_TRIAL_LEDGER',str(g.path if configured else tmp_path/'absent.db'))
    monkeypatch.setenv('PARTNER_TRIAL_EVIDENCE_FILE',str(f))
    monkeypatch.setattr('app.services.transcription_config.transcription_status',lambda p:'configured')
    monkeypatch.setattr(wiring.cloud_speech,'project_tts_key',lambda:KEY)
    settings=settings.model_copy(update={'app_env':'production','auth_mode':'invite','voice_local_model_path':'fixture'})
    monkeypatch.setattr('app.core.config.get_settings',lambda:settings)
    monkeypatch.setattr(voice,'service',voice.service)
    restores=[];install=daily.install_httpx_quota
    def record(*a,**kw):
        restore=install(*a,**kw);restores.append(restore);return restore
    monkeypatch.setattr(daily,'install_httpx_quota',record)
    try:
        m=runpy.run_path(str(Path(__file__).resolve().parents[1]/'scripts/ecs_partner_serve.py'))
        result=m['deployment_check'](None)
        assert m['health']()['ok'] is True
        assert result['voice_trial_ready'] is configured
        assert result['trial_configuration_blocked'] is not configured
        assert result['life_trial_ready'] is False and calls==[]
        assert g.daily.status()['used']==0
    finally:
        for restore in reversed(restores):restore()
