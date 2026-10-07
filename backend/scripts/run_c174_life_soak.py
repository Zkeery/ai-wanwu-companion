"""Approved real-provider 24h soak, isolated from the existing experience."""
import argparse
import asyncio
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import time
from uuid import uuid4

import httpx
from sqlalchemy import create_engine, insert, update

from app.core.config import get_settings
from app.core.database import Base
from app.models.models import User, Photo, Object, Character
from app.living.store import metadata
from app.living.life_runtime import LifeRuntime
from app.living.life_live_planner import run_real_planner
from app.living.life_provider import MaaSLifePlannerAdapter, RESERVE_MICRO, MAX_RESPONSE
from app.living.life_worker import consume_once as private_tick
from app.living.gathering_automatic import AutomaticDialogueStore, consume_once as shared_tick, sessions, limits
from app.living.gathering_dialogue import MaaSDialogueAdapter
from app.living.gatherings import GatheringStore
from scripts import c174_batch as batch

OWNER='c174-real-quality-life'
ROOT=batch.WORK/'life'
STOP=False


class GuardedTransport(httpx.AsyncBaseTransport):
    def __init__(self, kind, task_id, delegate=None):
        self.kind=kind;self.task_id=task_id
        self.delegate=delegate or httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request):
        payload=json.loads(request.content)
        if (request.method!='POST' or str(request.url)!=batch.BASE+'/chat/completions'
            or payload.get('model')!='qwen3.8-flash' or payload.get('max_tokens')!=512
            or payload.get('stream') is not False or len(request.content)>40000):
            raise ValueError('Real-life provider request differs from approved envelope')
        call=batch.claim(self.kind,self.kind+':'+self.task_id)
        started=time.perf_counter()
        try:
            response=await self.delegate.handle_async_request(request)
            body=bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body)>MAX_RESPONSE: raise ValueError('Oversized provider response')
            await response.aclose()
            if response.status_code!=200: raise ValueError('ProviderHTTPError')
            data=json.loads(body)
            usage={k:v for k,v in (data.get('usage') or {}).items()
                   if k in ('prompt_tokens','completion_tokens','total_tokens') and type(v) is int and v>=0}
            upstream=response.headers.get('x-request-id') or data.get('request_id') or data.get('id')
            if not isinstance(upstream,str) or len(upstream)>200: upstream=None
            detail=dict(model='qwen3.8-flash',usage=usage,provider_request_id=upstream,
                elapsed_ms=round((time.perf_counter()-started)*1000,3),
                cost_status='usage_estimate' if usage else 'full_reservation_retained')
            if usage:
                detail['estimated_cny']=(usage.get('prompt_tokens',0)*.8+usage.get('completion_tokens',0)*2.7)/1000000
            receipts=batch.WORK/'provider-responses';receipts.mkdir(exist_ok=True)
            batch.save(receipts/(call+'.json'),{k:data[k] for k in ('id','request_id','model','usage','choices') if k in data})
            # aiter_bytes() already decompressed the body. Passing Content-Encoding
            # onward would decompress the same bytes twice.
            headers={k:v for k,v in response.headers.items()
                     if k.lower() not in ('content-encoding','content-length','transfer-encoding')}
            result=httpx.Response(response.status_code,headers=headers,content=bytes(body),request=request)
            batch.settle(call,'succeeded',detail)
            return result
        except BaseException as exc:
            batch.settle(call,'unknown',{'error_type':type(exc).__name__,
                'cost_status':'full_reservation_retained','automatic_retry':False})
            raise

    async def aclose(self):
        await self.delegate.aclose()


def kernel(root=None, *, create=False):
    root=ROOT if root is None else root
    path=root/'life.db'
    if path.is_symlink() or (not create and not path.is_file()):
        raise ValueError('Original life database must exist; do not recreate it on resume')
    engine=create_engine('sqlite:///'+str(path),connect_args={'check_same_thread':False,'timeout':30})
    runtime=LifeRuntime(engine,lambda:int(time.time()),origin='real_provider')
    if create:
        Base.metadata.create_all(engine);metadata.create_all(engine);runtime.initialize()
    return runtime,AutomaticDialogueStore(engine,lambda:int(time.time()))


def command(store, group, action, **values):
    return store.command(OWNER,group['id'],str(uuid4()),group['revision'],dict(action=action,**values))


def prepare():
    batch.authorization()
    root=ROOT;root.mkdir(exist_ok=False)
    source=batch.PROJECT/'.runtime/c160-review/check.db'
    with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        rows={r['id']:dict(r) for r in db.execute('SELECT id,name,persona,opening_line,status FROM characters WHERE id IN (3,4)')}
    if set(rows)!={3,4} or any(r['status']!='ready' for r in rows.values()):
        raise ValueError('Previously accepted companions are unavailable')
    runtime,store=kernel(create=True)
    try:
        state=dict(status='prepared',origin='real_provider',sid=str(uuid4()),scans=0,
            largest_observation_gap_seconds=0,resumes=0,started_at=None,deadline=None,
            private_start_id=str(uuid4()),shared_start_id=str(uuid4()),
            source_character_ids=[4,3,4],source_note='Previously accepted generated companions; new samples remain unaccepted')
        with runtime.engine.begin() as conn:
            conn.execute(insert(User).values(id=OWNER,phone='13900000742'))
            conn.execute(insert(Photo).values(id=1,filename='accepted-companion-reference',status='done',owner_id=OWNER))
            conn.execute(insert(Object).values(id=1,photo_id=1,label='已采用伙伴长期验证'))
            for cid,source_id in enumerate(state['source_character_ids'],1):
                r=rows[source_id]
                conn.execute(insert(Character).values(id=cid,object_id=1,owner_id=OWNER,
                    name=r['name'],persona=r['persona'],opening_line=r['opening_line'],status='ready',location_epoch=1))
        runtime.store.create_space(OWNER,state['sid'],'home','private','1')
        with runtime.engine.begin() as conn:
            conn.execute(update(Character).where(Character.id==1).values(current_space_id=state['sid']))
        runtime.save_permission(OWNER,state['sid'],str(uuid4()),0,True,('rest','walk'))
        g=store.create(OWNER,str(uuid4()),'C1.74真实长期交流','验收','home')
        for cid in (2,3):
            g=command(store,g,'visit',character_id=cid)
            g=command(store,g,'dialogue_consent',character_id=cid,enabled=True)
        g=command(store,g,'dialogue_space',enabled=True)
        state['gid']=g['id'];batch.save(root/'state.json',state)
    finally:
        runtime.engine.dispose()
    return {'status':'prepared','provider_requests':0}


def start(runtime, store, state):
    if state['started_at'] is None:
        now=int(time.time());state.update(started_at=now,deadline=now+86400,status='starting')
        batch.save(ROOT/'state.json',state)
    if state['status']=='starting':
        cap=4*RESERVE_MICRO;ref=batch.authorization()['authorization_ref']
        runtime.set_limit('project',cap,ref+':private')
        runtime.set_limit('space:'+state['sid'],cap,ref+':private')
        runtime.save_automatic(OWNER,state['sid'],state['private_start_id'],0,True)
        grant=store.authorize_session(OWNER,state['gid'],[2,3],4,ref+':shared',
            project_cap_micro=cap,space_cap_micro=cap)
        store.configure(OWNER,state['gid'],state['shared_start_id'],0,True,grant)
        state.update(status='running',shared_grant=grant);batch.save(ROOT/'state.json',state)


def facts(runtime,store,state):
    events=[e.model_dump(mode='json') for e in runtime.read_events(OWNER,state['sid'])]
    shared=store.read(OWNER,state['gid'])
    exchanges=shared['exchanges']
    return dict(private_events=events,shared_exchanges=exchanges,
        private_snapshot=runtime.snapshot(OWNER,state['sid']).model_dump(mode='json'),
        shared_status=store.status(OWNER,state['gid']),
        private_event_sha256=hashlib.sha256(json.dumps(events,sort_keys=True).encode()).hexdigest(),
        shared_event_sha256=hashlib.sha256(json.dumps(exchanges,sort_keys=True).encode()).hexdigest())


def stop_policies(runtime,store,state, *, final=False):
    policy=runtime.snapshot(OWNER,state['sid']).automatic
    if policy.enabled: runtime.save_automatic(OWNER,state['sid'],str(uuid4()),policy.revision,False)
    setting=store.status(OWNER,state['gid'])
    if setting['enabled']: store.configure(OWNER,state['gid'],str(uuid4()),setting['revision'],False)
    if final:
        budget=runtime.read_budget(OWNER,state['sid'])
        ref=batch.authorization()['authorization_ref']+':closed'
        runtime.set_limit('project',budget.committed,ref)
        runtime.set_limit('space:'+state['sid'],budget.committed,ref)
        with store.transaction() as conn:
            conn.execute(update(sessions).where(sessions.c.group_id==state['gid']).values(stopped=1))
            for scope,gid in [('project',None),('space:'+state['gid'],state['gid'])]:
                committed=store._budget(conn,gid)['committed_micro']
                conn.execute(update(limits).where(limits.c.scope==scope).values(cap_micro=committed))
        g=GatheringStore(runtime.engine,store.clock).read(OWNER,state['gid'])
        for cid in (2,3):
            if any(c['id']==cid for c in g['companions']):
                g=command(store,g,'recall',character_id=cid)
        state['shared_returned_home']=not g['companions']


async def tick(runtime,store,state,key):
    with batch.connect() as db:
        unknown=db.execute("SELECT 1 FROM calls WHERE kind IN ('private','shared') AND outcome='unknown'").fetchone()
        busy=db.execute("SELECT 1 FROM calls WHERE outcome='started'").fetchone()
    if unknown:
        stop_policies(runtime,store,state);state['paid_dispatch_paused']='unknown_life_result';return
    if busy: return
    async def execute(owner,sid,tid):
        await run_real_planner(runtime,owner,sid,tid,
            lambda:MaaSLifePlannerAdapter(key,transport=GuardedTransport('private',tid)))
    await private_tick(runtime,execute)
    with batch.connect() as db:
        if db.execute("SELECT 1 FROM calls WHERE kind IN ('private','shared') AND outcome='unknown'").fetchone():
            stop_policies(runtime,store,state);state['paid_dispatch_paused']='unknown_life_result';return
    def factory():
        tid=store.status(OWNER,state['gid'])['last_task_id']
        if not tid: raise ValueError('No persisted shared task')
        return MaaSDialogueAdapter(key,transport=GuardedTransport('shared',tid))
    await shared_tick(store,factory)


def run():
    global STOP
    batch.authorization();batch.current_prices()
    settings=get_settings()
    if settings.use_mock or not settings.model_api_key or settings.model_base_url.rstrip('/')!=batch.BASE:
        raise ValueError('Real provider configuration unavailable')
    with (ROOT/'run.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads((ROOT/'state.json').read_text())
        if state['status'].startswith('completed'): return status()
        runtime,store=kernel()
        try:
            with batch.connect() as db:
                interrupted=db.execute("SELECT id FROM calls WHERE kind IN ('private','shared') AND outcome='started'").fetchall()
            for row in interrupted:
                batch.settle(row['id'],'unknown',{'error_type':'ExecutorInterrupted','cost_status':'full_reservation_retained'})
            if state['started_at'] is not None: state['resumes']+=1
            start(runtime,store,state)
            state['status']='running';batch.save(ROOT/'state.json',state)
            signal.signal(signal.SIGTERM,lambda *_:globals().__setitem__('STOP',True))
            while not STOP:
                now=int(time.time())
                if state.get('last_observed_at'):
                    state['largest_observation_gap_seconds']=max(state['largest_observation_gap_seconds'],now-state['last_observed_at'])
                if now>=state['deadline']:
                    stop_policies(runtime,store,state,final=True)
                    state.update(status='completed_with_gaps' if state['largest_observation_gap_seconds']>120 else 'completed',finished_at=now)
                    batch.save(ROOT/'final-facts.json',facts(runtime,store,state));batch.save(ROOT/'state.json',state)
                    export_result(state);break
                asyncio.run(tick(runtime,store,state,settings.model_api_key))
                state.update(last_observed_at=int(time.time()),scans=state['scans']+1)
                batch.save(ROOT/'latest-facts.json',facts(runtime,store,state));batch.save(ROOT/'state.json',state)
                for _ in range(60):
                    if STOP: break
                    time.sleep(1)
            if STOP:
                state['status']='interrupted';batch.save(ROOT/'state.json',state)
        finally:
            runtime.engine.dispose()
    return status()


def resume_unspent_shared():
    """Maintenance after a verified harness repair; never requeue the failed task."""
    with (ROOT/'run.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads((ROOT/'state.json').read_text())
        with batch.connect() as db:
            calls=db.execute("SELECT outcome FROM calls WHERE kind='shared'").fetchall()
        if (state.get('shared_repair_continuation') or len(calls)!=1
            or calls[0]['outcome']!='succeeded' or int(time.time())>=state['deadline']):
            raise ValueError('Remaining-round continuation prerequisites are not met')
        runtime,store=kernel()
        try:
            current=store.status(OWNER,state['gid'])
            if current['enabled'] or current['last_task_state']!='failed':
                raise ValueError('Original failed exchange must remain stopped')
            state['retained_failed_shared_task']=current['last_task_id']
            cap=4*RESERVE_MICRO
            grant=store.authorize_session(OWNER,state['gid'],[2,3],3,
                batch.authorization()['authorization_ref']+':shared-unspent',
                project_cap_micro=cap,space_cap_micro=cap)
            store.configure(OWNER,state['gid'],str(uuid4()),current['revision'],True,grant)
            state.update(shared_repair_continuation=True,shared_grant=grant)
            batch.save(ROOT/'state.json',state)
        finally:
            runtime.engine.dispose()
    return {'status':'remaining_rounds_enabled','remaining_max':3,'failed_task_retried':False}


def export_result(state=None):
    state=state or json.loads((ROOT/'state.json').read_text())
    file=ROOT/('final-facts.json' if state['status'].startswith('completed') else 'latest-facts.json')
    observed=json.loads(file.read_text()) if file.exists() else {}
    with sqlite3.connect((ROOT/'life.db').as_uri()+'?mode=ro',uri=True) as db:
        integrity=db.execute('PRAGMA integrity_check').fetchone()[0]
        private=db.execute('SELECT created_at,state FROM life_runtime_tasks ORDER BY created_at,id').fetchall()
        shared=db.execute('SELECT created_at,state FROM life_dialogue_tasks ORDER BY created_at,id').fetchall()
    def checks(rows):
        times=[r[0] for r in rows];days={}
        for stamp in times:
            day=(stamp+28800)//86400;days[str(day)]=days.get(str(day),0)+1
        gaps=[b-a for a,b in zip(times,times[1:])]
        return dict(tasks=len(rows),succeeded=sum(r[1]=='done' for r in rows),
            failed=sum(r[1] not in ('done','running','scheduled') for r in rows),
            daily_counts=days,daily_limit_ok=max(days.values(),default=0)<=2,
            shortest_interval_seconds=min(gaps,default=None),cadence_ok=all(g>=600 for g in gaps))
    with batch.connect() as db:
        calls=db.execute("SELECT id,kind,operation,outcome,detail FROM calls WHERE kind IN ('private','shared')").fetchall()
    result=dict(status=state['status'],origin='real_provider',started_at=state['started_at'],deadline=state['deadline'],
        observed_until=state.get('finished_at',state.get('last_observed_at')),
        actual_24h_elapsed=bool(state.get('finished_at') and state['finished_at']-state['started_at']>=86400),
        largest_observation_gap_seconds=state['largest_observation_gap_seconds'],gap_limit_seconds=120,
        resumes=state['resumes'],scans=state['scans'],sqlite_integrity=integrity,
        private=checks(private),shared=checks(shared),provider_requests=len(calls),
        unique_provider_operations=len({r['operation'] for r in calls}),
        unresolved_provider_results=sum(r['outcome']!='succeeded' for r in calls),
        usage_estimated_cny=sum(json.loads(r['detail']).get('estimated_cny',0) for r in calls),
        reserved_cny=len(calls)*RESERVE_MICRO/1000000,actual_bill_verified=False,
        private_events=len(observed.get('private_events',[])),shared_exchanges=len(observed.get('shared_exchanges',[])),
        shared_returned_home=state.get('shared_returned_home',False),
        private_automatic_enabled=observed.get('private_snapshot',{}).get('automatic',{}).get('enabled'),
        shared_automatic_enabled=observed.get('shared_status',{}).get('enabled'),
        formal_visual_quality_completed=False)
    batch.save(batch.EVIDENCE/'真实长期运行结果.json',result)
    return result


def restart_evidence(verify=False):
    with batch.connect() as db:
        if db.execute("SELECT 1 FROM calls WHERE outcome='started'").fetchone():
            raise ValueError('Do not interrupt any paid provider request')
        count=db.execute("SELECT count(*) FROM calls WHERE kind IN ('private','shared')").fetchone()[0]
    state=json.loads((ROOT/'state.json').read_text())
    runtime,store=kernel()
    try: observed=facts(runtime,store,state)
    finally: runtime.engine.dispose()
    current=dict(deadline=state['deadline'],private_event_sha256=observed['private_event_sha256'],
        shared_event_sha256=observed['shared_event_sha256'],private_events=len(observed['private_events']),
        shared_exchanges=len(observed['shared_exchanges']),life_provider_requests=count)
    path=ROOT/'successful-event-restart.json'
    if not verify:
        if not current['private_events'] or not current['shared_exchanges']:
            raise ValueError('Wait for actual published private and shared results')
        batch.save(path,dict(before=current,original_resumes=state['resumes']))
        return {'checkpoint_saved':True,**current}
    previous=json.loads(path.read_text())
    passed=previous['before']==current and state['resumes']>previous['original_resumes']
    previous.update(after=current,actual_restart_verified=passed,resumes=state['resumes'])
    batch.save(path,previous);batch.save(batch.EVIDENCE/'真实事件重启验证.json',previous)
    if not passed: raise ValueError('Restart changed original deadline, events, or paid calls')
    return {'actual_restart_verified':True,**current}


def status():
    if not (ROOT/'state.json').exists(): return {'status':'not_prepared'}
    state=json.loads((ROOT/'state.json').read_text())
    with (ROOT/'run.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);held=False
        except BlockingIOError: held=True
    now=int(time.time())
    state.update(process_lock_held=held,elapsed_seconds=0 if not state['started_at'] else now-state['started_at'])
    if state['status']=='running' and not held: state['execution_state']='interrupted'
    return state


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','launch','run','status','resume-unspent-shared','export','checkpoint-restart','verify-restart'],nargs='?',default='status')
    mode=parser.parse_args().mode
    if mode=='prepare': value=prepare()
    elif mode=='run': value=run()
    elif mode=='resume-unspent-shared': value=resume_unspent_shared()
    elif mode=='export': value=export_result()
    elif mode=='checkpoint-restart': value=restart_evidence()
    elif mode=='verify-restart': value=restart_evidence(verify=True)
    elif mode=='launch':
        state=status()
        if state.get('process_lock_held'): raise ValueError('Existing runner holds the process lock')
        temp=batch.WORK/'tmp';temp.mkdir(exist_ok=True)
        with (ROOT/'process.log').open('a') as log:
            proc=subprocess.Popen([sys.executable,'-m','scripts.run_c174_life_soak','run'],
                cwd=batch.PROJECT/'backend',env={**os.environ,'TMPDIR':str(temp)},
                stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        value={'status':'launched','pid':proc.pid};batch.save(ROOT/'process.json',value)
    else: value=status()
    print(json.dumps(value,ensure_ascii=False))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'status':'paused_failure','error_type':type(exc).__name__}));sys.exit(1)
