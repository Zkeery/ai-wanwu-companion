"""Mock time/HTTP with real private and shared business kernels; never live AI."""
import asyncio
import copy
import fcntl
import hashlib
import json
import sqlite3
import subprocess
import sys
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import create_engine, insert, select, update

from app.core.database import Base
from app.models.models import User, Photo, Object, Character
from app.living.store import metadata
from app.living.life_runtime import LifeRuntime
from app.living.life_provider import RESERVE_MICRO
from app.living.life_live_planner import run_real_planner
from app.living.gathering_automatic import AutomaticDialogueStore
from app.living.gathering_dialogue import run_exchange, tasks as shared_tasks
from app.services.trial_gate import TrialGate, TrialBlocked
from app.services.trial_wiring import TrialLifeFactories
from app.services.life_trial_window import LifeWindow, LifeWork
from tests.test_trial_guards import setup, evidence, text_result, KEY


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    def deny(*a, **kw):raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)
    first, now = setup(tmp_path, 'life')
    engine = create_engine('sqlite:///'+str(tmp_path/'business.db'))
    Base.metadata.create_all(engine);metadata.create_all(engine)
    runtime = LifeRuntime(engine, lambda: now[0], origin='real_provider');runtime.initialize()
    store = AutomaticDialogueStore(engine, lambda: now[0])
    with engine.begin() as db:
        db.execute(insert(User).values(id='owner',phone='13900000981'))
        db.execute(insert(Photo).values(id=1,filename='synthetic.png',status='done',owner_id='owner'))
        db.execute(insert(Object).values(id=1,photo_id=1,label='合成物品'))
        for cid in (1,2,3):
            db.execute(insert(Character).values(id=cid,object_id=1,owner_id='owner',name='合成伙伴'+str(cid),
                       persona='仅供离线编排',opening_line='',status='ready',location_epoch=1))
    sid=str(uuid4());runtime.store.create_space('owner',sid,'home','private','1')
    with engine.begin() as db:db.execute(update(Character).where(Character.id==1).values(current_space_id=sid))
    runtime.save_permission('owner',sid,str(uuid4()),0,True,('rest','walk'))
    runtime.set_limit('project',3*RESERVE_MICRO,'synthetic-private');runtime.set_limit('space:'+sid,3*RESERVE_MICRO,'synthetic-private')
    runtime.save_automatic('owner',sid,str(uuid4()),0,True)
    runtime.save_viewing('owner',sid,str(uuid4()),1,True)
    group=store.create('owner',str(uuid4()),'合成窗口','合成','home')
    for cid in (2,3):
        for action,values in [('visit',{'character_id':cid}),('dialogue_consent',{'character_id':cid,'enabled':True})]:
            group=store.command('owner',group['id'],str(uuid4()),group['revision'],dict(action=action,**values))
    group=store.command('owner',group['id'],str(uuid4()),group['revision'],dict(action='dialogue_space',enabled=True))
    gid=group['id'];grant=store.authorize_session('owner',gid,[2,3],3,'synthetic-shared',project_cap_micro=3*RESERVE_MICRO,space_cap_micro=3*RESERVE_MICRO)
    store.configure('owner',gid,str(uuid4()),0,True,grant);store.viewing('owner',gid,str(uuid4()),True)
    p=copy.deepcopy(first.policy);p['authorization_ref']+='-kernel';p['scopes']={'private_life':{'owner':'owner','subject':sid},'shared_life':{'owner':'owner','subject':gid}}
    gate=TrialGate.create(tmp_path/'kernel-gate.db',first.daily,p,clock=lambda:now[0])
    seen=[];fault={'mode':None};committed=[]
    def factory(kind):
        def handler(request):
            seen.append(kind)
            if fault['mode']=='timeout':raise httpx.ReadTimeout('synthetic')
            body={'activity':'rest','reason':'先休息'} if kind=='private_life' else {'lines':[
                {'character_id':cid,'text':'看看风景。','item_ids':[]} for cid in (2,3)]}
            if fault['mode']=='bad-json':body={'invalid':True}
            return httpx.Response(200,json=text_result(json.dumps(body,ensure_ascii=False)))
        return httpx.MockTransport(handler)
    factories=TrialLifeFactories(gate,lambda k:evidence(gate,k),KEY,delegate_factory=factory)
    async def catalog():return {'model':'qwen3.8-flash','reserve_micro':RESERVE_MICRO}
    def prepare(kind):
        if kind=='private_life':
            runtime.schedule_automatic();specs=runtime.dispatched_tasks()
            if not specs:return None
            spec=specs[0];tid=spec.basis.plan_id
            async def perform(adapter):
                await run_real_planner(runtime,'owner',sid,tid,lambda:adapter,catalog)
                if runtime.read_task('owner',sid,tid).state=='done':committed.append(kind);return True
                return False
            return LifeWork('owner',sid,tid,'visible' if spec.source=='viewing' else 'away',perform)
        before=store.status('owner',gid)['today_count'];task=store.claim_next()
        if not task:return None
        away=store.status('owner',gid)['today_count']>before
        async def perform(adapter):
            await run_exchange(store,task,lambda:adapter,catalog)
            with engine.connect() as db:done=db.execute(select(shared_tasks.c.state).where(shared_tasks.c.id==task['id'])).scalar()=='done'
            if done:committed.append(kind)
            return done
        return LifeWork('owner',gid,task['id'],'away' if away else 'visible',perform)
    def observe():
        with sqlite3.connect(tmp_path/'business.db') as db:
            names=['life_runtime_events','life_runtime_tasks','life_dialogue_tasks','life_gatherings']
            rows=[]
            for name in names:rows.extend(db.execute('SELECT * FROM '+name).fetchall())
            private=db.execute('SELECT count(*) FROM life_runtime_events').fetchone()[0]
            shared=db.execute("SELECT count(*) FROM life_dialogue_tasks WHERE state='done'").fetchone()[0]
            digest=hashlib.sha256(json.dumps(rows,sort_keys=True,default=str).encode()).hexdigest()
            return dict(private_events=private,shared_events=shared,digest=digest,sqlite_integrity=db.execute('PRAGMA integrity_check').fetchone()[0])
    def stop():
        policy=runtime.snapshot('owner',sid).automatic
        if policy.enabled:runtime.save_automatic('owner',sid,str(uuid4()),policy.revision,False)
        setting=store.status('owner',gid)
        if setting['enabled']:store.configure('owner',gid,str(uuid4()),setting['revision'],False)
        return not runtime.snapshot('owner',sid).automatic.enabled and not store.status('owner',gid)['enabled']
    window=LifeWindow.create(tmp_path/'window.db',factories,prepare,observe,stop,origin='mock_simulated')
    value=dict(window=window,now=now,gate=gate,seen=seen,fault=fault,committed=committed,prepare=prepare,
               observe=observe,stop=stop,factories=factories,runtime=runtime,store=store,sid=sid,gid=gid,root=tmp_path)
    yield value
    engine.dispose()


def tick(v):return asyncio.run(v['window'].tick())


def test_full_simulated_window_real_kernels_cross_midnight_and_reopen(isolated):
    v=isolated;start=v['now'][0]
    for offset in range(0,86401,60):
        v['now'][0]=start+offset
        if offset==660:
            w=v['window'];v['window']=LifeWindow(w.path,v['factories'],v['prepare'],v['observe'],v['stop'],origin='mock_simulated')
        result=tick(v)
        assert result['status'] in ('running','passed'),result
    assert result['status']=='passed' and result['observed_span_seconds']==86400
    assert result['max_gap_seconds']==60 and result['evidence_origin']=='mock_simulated'
    assert not result['real_acceptance_passed'] and result['operation_count']==6
    assert v['gate'].summary()['counts']=={'private_life':3,'shared_life':3}
    assert v['gate'].daily.status()['used']==4  # First watched pair before Beijing midnight; four after it.
    assert v['seen']==['private_life','shared_life']*3 and len(v['committed'])==6
    assert not v['runtime'].snapshot('owner',v['sid']).automatic.enabled
    assert not v['store'].status('owner',v['gid'])['enabled']
    before=v['observe']();v['now'][0]+=600;assert tick(v)['status']=='passed';assert v['observe']()==before
    code="import sqlite3,json,sys;d=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);s=json.loads(d.execute('select data from state').fetchone()[0]);a=d.execute('select min(at),max(at),count(*) from observations').fetchone();print(json.dumps([s['status'],a[1]-a[0],a[2],d.execute('pragma integrity_check').fetchone()[0]]))"
    independent=json.loads(subprocess.check_output([sys.executable,'-c',code,str(v['window'].path)],text=True))
    assert independent==['passed',86400,1442,'ok']


@pytest.mark.parametrize('fault',['timeout','bad-json'])
def test_first_failure_blocks_other_group_and_never_retries(isolated,fault):
    v=isolated;v['fault']['mode']=fault;r=tick(v)
    assert r['status']=='failed' and len(v['seen'])==1 and v['seen'][0]=='private_life'
    saved=v['gate'].summary()['reserved_micro'];v['fault']['mode']=None;v['now'][0]+=60
    assert tick(v)['status']=='failed' and len(v['seen'])==1 and v['gate'].summary()['reserved_micro']==saved


@pytest.mark.parametrize('shift,code',[(121,'observation_gap'),(-1,'clock_reversed')])
def test_bad_observation_gap_is_not_hidden_by_restarting(isolated,shift,code):
    v=isolated;assert tick(v)['status']=='running';v['now'][0]+=shift
    assert tick(v)['failure_code']==code and len(v['seen'])==2


def test_interrupted_intent_stops_before_any_reissue(isolated):
    v=isolated;w=v['window']
    with w.connect() as db:s=w.state(db)
    s['in_flight']={'kind':'private_life','operation_sha256':'0'*64};w.save(s)
    assert tick(v)['failure_code']=='interrupted_work_unknown' and not v['seen']


def test_unknown_balance_and_scope_change_send_nothing(isolated):
    v=isolated
    def unknown(k):
        value=evidence(v['gate'],k);value['wallet']['verified']=False;return value
    v['factories'].reader=unknown
    assert tick(v)['status']=='failed' and not v['seen']


def test_scope_mismatch_send_nothing(isolated):
    v=isolated;real=v['window'].prepare_work
    def bad(k):
        w=real(k)
        return LifeWork('other-owner',w.subject,w.operation,w.presence,w.perform)
    v['window'].prepare_work=bad
    assert tick(v)['failure_code']=='scope_mismatch' and not v['seen']


def test_no_recreation_copy_or_simulated_real_label(isolated):
    v=isolated;w=v['window']
    with pytest.raises(FileExistsError):LifeWindow.create(w.path,v['factories'],v['prepare'],v['observe'],v['stop'],origin='mock_simulated')
    other=w.path.with_name('copy.db');other.write_bytes(w.path.read_bytes());other.chmod(0o600)
    with pytest.raises(TrialBlocked,match='binding_changed'):LifeWindow(other,v['factories'],v['prepare'],v['observe'],v['stop'],origin='mock_simulated')
    with pytest.raises(TrialBlocked,match='real_clock_required'):LifeWindow.create(w.path.with_name('fake-real.db'),v['factories'],v['prepare'],v['observe'],v['stop'],origin='real_wall_clock')
    assert not w.path.with_name('fake-real.db').exists()


def test_competing_lock_cannot_stop_owner_and_operator_stop_is_terminal(isolated):
    v=isolated;w=v['window']
    with w.lock():
        with pytest.raises(TrialBlocked,match='already_running'):tick(v)
    assert not v['seen'] and w.report()['status']=='prepared'
    assert w.stop()['status']=='stopped';assert tick(v)['status']=='stopped' and not v['seen']


def test_changed_business_after_early_stop_fails_observation(isolated):
    v=isolated;start=v['now'][0]
    for offset in range(0,1201,60):v['now'][0]=start+offset;assert tick(v)['status']=='running'
    assert v['window'].report()['work_stopped']
    old=v['window'].observe
    def changed():r=old();r['private_events']+=1;return r
    v['window'].observe=changed;v['now'][0]+=60
    assert tick(v)['failure_code']=='business_changed_after_stop' and len(v['seen'])==6


@pytest.mark.parametrize('case',['slow','missing-event'])
def test_success_return_cannot_hide_long_call_or_missing_event(isolated,case):
    v=isolated;w=v['window'];original=w.prepare_work
    def prepare(kind):
        work=original(kind)
        async def perform(adapter):
            result=await work.perform(adapter)
            if case=='slow':v['now'][0]+=121
            return result
        return LifeWork(work.owner,work.subject,work.operation,work.presence,perform)
    w.prepare_work=prepare
    if case=='missing-event':
        old=w.observe
        def missing():r=old();r['private_events']=0;return r
        w.observe=missing
    result=tick(v)
    assert result['status']=='failed' and len(v['seen'])==1
    assert result['failure_code']==('work_observation_gap' if case=='slow' else 'business_completion_unverified')


def test_missing_original_window_is_not_recreated(isolated):
    v=isolated;w=v['window'];saved=w.path.with_suffix('.preserved');w.path.rename(saved)
    with pytest.raises(sqlite3.OperationalError):w.report()
    assert not w.path.exists() and saved.exists() and not v['seen']


def test_deadline_without_all_business_evidence_never_passes(isolated):
    v=isolated;w=v['window'];w.prepare_work=lambda k:None;start=v['now'][0]
    for offset in range(0,86401,120):v['now'][0]=start+offset;result=tick(v)
    assert result['status']=='failed' and result['failure_code']=='window_evidence_incomplete'
    assert not v['seen'] and result['observed_span_seconds']==86400



def test_unverified_policy_shutdown_is_never_recorded_as_success(isolated):
    v=isolated;v['window'].stop_work=lambda:False
    report=v['window'].stop()
    with v['window'].connect() as db:state=v['window'].state(db)
    assert report['status']=='stopped' and state['stop_verification_failed']
    assert not report['work_stopped'] and v['gate'].summary()['state']=='stopped'



def test_same_approval_cannot_create_another_window_even_if_original_is_lost(isolated):
    v=isolated;w=v['window'];other=w.path.with_name('another-window.db')
    with pytest.raises(TrialBlocked,match='already_bound'):LifeWindow.create(other,v['factories'],v['prepare'],v['observe'],v['stop'],origin='mock_simulated')
    assert not other.exists()
    saved=w.path.with_suffix('.original-preserved');w.path.rename(saved)
    with pytest.raises(TrialBlocked,match='already_bound'):LifeWindow.create(other,v['factories'],v['prepare'],v['observe'],v['stop'],origin='mock_simulated')
    assert not other.exists() and saved.exists()


def test_six_calls_from_elsewhere_cannot_replace_this_window_work(isolated):
    v=isolated;w=v['window'];start=v['now'][0]
    for offset in range(0,86401,120):
        v['now'][0]=start+offset
        if offset==86400:
            with w.connect() as db:s=w.state(db)
            s['operation_count']=0;w.save(s)
        result=tick(v)
    assert result['status']=='failed' and result['failure_code']=='window_evidence_incomplete'
