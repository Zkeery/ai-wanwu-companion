"""Fresh real 24h acceptance: one private and one shared request, max CNY3."""
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
from sqlalchemy import insert, update

from scripts import run_c174_life_soak as previous
from scripts.real_web_budget import Budget
from scripts.run_real_web import ENDPOINT, PROJECT

ROOT = PROJECT/'.runtime/acceptance-20261002/life'
REF = 'acceptance-life-20261002-3cny-2requests'
OWNER = previous.OWNER
STOP = False


def save(path, value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False,indent=2));temporary.chmod(0o600)
    temporary.replace(path)


def budget(root=None):
    root=ROOT if root is None else root
    return Budget(root,ENDPOINT,reference=REF,budget_micro=3000000,requests_max=2,
                  purpose_limits={'private':1,'shared':1})


class Transport(httpx.AsyncBaseTransport):
    def __init__(self, ledger, purpose, delegate=None):
        self.ledger, self.purpose = ledger, purpose
        self.delegate = delegate or httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request):
        payload=json.loads(request.content)
        if (request.method!='POST' or str(request.url)!=ENDPOINT+'/chat/completions'
                or payload.get('model')!='qwen3.8-flash' or payload.get('max_tokens')!=512
                or payload.get('stream') is not False or len(request.content)>40000):
            raise ValueError('Unapproved real-life request envelope')
        call=self.ledger.claim('qwen3.8-flash',purpose=self.purpose)
        response=await self.delegate.handle_async_request(request)
        try:
            body=bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body)>previous.MAX_RESPONSE:
                    raise ValueError('Oversized provider response')
        finally:
            await response.aclose()
        if response.status_code!=200:
            self.ledger.settle(call,'failed',response.status_code)
            raise ValueError('Provider rejected this request')
        data=json.loads(body)
        self.ledger.response_receipt(call,data)
        # Preserve original raw response before the production schema decoder.
        self.ledger.settle(call,'succeeded',response.status_code)
        headers={k:v for k,v in response.headers.items()
                 if k.lower() not in ('content-encoding','content-length','transfer-encoding')}
        return httpx.Response(response.status_code,headers=headers,content=bytes(body),request=request)

    async def aclose(self):
        await self.delegate.aclose()


def prepare():
    if ROOT.exists():
        raise FileExistsError('Never replace an existing acceptance window')
    source=PROJECT/'.runtime/c160-review/check.db'
    with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as db:
        db.row_factory=sqlite3.Row
        rows={r['id']:dict(r) for r in db.execute(
            'SELECT id,name,persona,opening_line,status FROM characters WHERE id IN (3,4)')}
    if set(rows)!={3,4} or any(r['status']!='ready' for r in rows.values()):
        raise ValueError('Previously accepted companions are required')
    ROOT.mkdir(parents=True,mode=0o700)
    runtime,store=previous.kernel(ROOT,create=True)
    try:
        state=dict(status='prepared',origin='real_provider',sid=str(uuid4()),scans=0,resumes=0,
            largest_observation_gap_seconds=0,started_at=None,deadline=None,
            private_start_id=str(uuid4()),shared_start_id=str(uuid4()),source_character_ids=[4,3,4],
            source_note='Previously accepted characters, fresh independent acceptance database',
            original_unknown_reservation_retained=True,automatic_retries=0)
        with runtime.engine.begin() as conn:
            conn.execute(insert(previous.User).values(id=OWNER,phone='13900000742'))
            conn.execute(insert(previous.Photo).values(id=1,filename='accepted-reference',status='done',owner_id=OWNER))
            conn.execute(insert(previous.Object).values(id=1,photo_id=1,label='已采用伙伴续验'))
            for cid,source_id in enumerate(state['source_character_ids'],1):
                row=rows[source_id]
                conn.execute(insert(previous.Character).values(id=cid,object_id=1,owner_id=OWNER,
                    name=row['name'],persona=row['persona'],opening_line=row['opening_line'],status='ready',location_epoch=1))
        runtime.store.create_space(OWNER,state['sid'],'home','private','1')
        with runtime.engine.begin() as conn:
            conn.execute(update(previous.Character).where(previous.Character.id==1).values(current_space_id=state['sid']))
        runtime.save_permission(OWNER,state['sid'],str(uuid4()),0,True,('rest','walk'))
        group=store.create(OWNER,str(uuid4()),'真实连续24小时续验','验收','home')
        for cid in (2,3):
            group=previous.command(store,group,'visit',character_id=cid)
            group=previous.command(store,group,'dialogue_consent',character_id=cid,enabled=True)
        group=previous.command(store,group,'dialogue_space',enabled=True)
        state['gid']=group['id'];save(ROOT/'state.json',state)
        budget()
    finally:
        runtime.engine.dispose()
    return dict(status='prepared',provider_requests=0,authorization_required=True)


def start(runtime,store,state,ledger):
    ledger.approval()
    if state['started_at'] is None:
        now=int(time.time())
        state.update(started_at=now,deadline=now+86400,status='starting')
        save(ROOT/'state.json',state)
    if state['status']=='starting':
        cap=previous.RESERVE_MICRO
        runtime.set_limit('project',cap,REF+':private')
        runtime.set_limit('space:'+state['sid'],cap,REF+':private')
        runtime.save_automatic(OWNER,state['sid'],state['private_start_id'],0,True)
        grant=store.authorize_session(OWNER,state['gid'],[2,3],1,REF+':shared',
            project_cap_micro=cap,space_cap_micro=cap)
        store.configure(OWNER,state['gid'],state['shared_start_id'],0,True,grant)
        state.update(status='running',shared_grant=grant)
        save(ROOT/'state.json',state)
    elif state['status']=='interrupted':
        # Resume the existing window without re-enabling or issuing paid grants.
        state['status']='running'
        save(ROOT/'state.json',state)


def close(runtime,store,state):
    previous.stop_policies(runtime,store,state)
    current=runtime.read_budget(OWNER,state['sid'])
    runtime.set_limit('project',current.committed,REF+':closed')
    runtime.set_limit('space:'+state['sid'],current.committed,REF+':closed')
    with store.transaction() as conn:
        conn.execute(update(previous.sessions).where(previous.sessions.c.group_id==state['gid']).values(stopped=1))
        for scope,gid in [('project',None),('space:'+state['gid'],state['gid'])]:
            committed=store._budget(conn,gid)['committed_micro']
            conn.execute(update(previous.limits).where(previous.limits.c.scope==scope).values(cap_micro=committed))
    group=previous.GatheringStore(runtime.engine,store.clock).read(OWNER,state['gid'])
    for cid in (2,3):
        if any(c['id']==cid for c in group['companions']):
            group=previous.command(store,group,'recall',character_id=cid)
    state['shared_returned_home']=not group['companions']


async def tick(runtime,store,state,key,ledger):
    if ledger.status()['paused'] or ledger.status()['requests']>=2:
        previous.stop_policies(runtime,store,state)
        state['paid_dispatch_paused']=True
        return
    async def execute(owner,sid,task):
        await previous.run_real_planner(runtime,owner,sid,task,
            lambda:previous.MaaSLifePlannerAdapter(key,transport=Transport(ledger,'private')))
    await previous.private_tick(runtime,execute)
    observed=previous.facts(runtime,store,state)
    # Any real business failure stops all future paid dispatch, even HTTP200.
    if any(task.get('state')=='failed' for task in observed['private_snapshot']['tasks']):
        ledger.stop('business_failure')
    if ledger.status()['paused']:
        previous.stop_policies(runtime,store,state)
        state['paid_dispatch_paused']=True
        return
    await previous.shared_tick(store,
        lambda:previous.MaaSDialogueAdapter(key,transport=Transport(ledger,'shared')))
    shared=store.status(OWNER,state['gid'])
    if shared.get('last_task_state')=='failed':
        ledger.stop('business_failure')
    if ledger.status()['paused'] or ledger.status()['requests']>=2:
        previous.stop_policies(runtime,store,state)
        state['paid_dispatch_finished']=True


def facts(runtime,store,state,ledger):
    value=previous.facts(runtime,store,state)
    value['provider_budget']=ledger.status()
    with sqlite3.connect((ROOT/'life.db').as_uri()+'?mode=ro',uri=True) as db:
        value['sqlite_integrity']=db.execute('PRAGMA integrity_check').fetchone()[0]
    return value


def run():
    global STOP
    ledger=budget();ledger.approval()
    previous.batch.current_prices()
    settings=previous.get_settings()
    if settings.use_mock or settings.model_base_url.rstrip('/')!=ENDPOINT:
        raise ValueError('This project real MaaS configuration is required')
    with (ROOT/'run.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads((ROOT/'state.json').read_text())
        if state['status'].startswith('completed'):
            return status()
        from scripts.soak_power_guard import attach
        attach(ROOT,os.getpid())
        runtime,store=previous.kernel(ROOT)
        try:
            if state['started_at'] is not None:
                state['resumes']+=1
            start(runtime,store,state,ledger)
            signal.signal(signal.SIGTERM,lambda *_:globals().__setitem__('STOP',True))
            while not STOP:
                now=int(time.time())
                if state.get('last_observed_at'):
                    state['largest_observation_gap_seconds']=max(state['largest_observation_gap_seconds'],now-state['last_observed_at'])
                if now>=state['deadline']:
                    close(runtime,store,state)
                    observed=facts(runtime,store,state,ledger)
                    passed=(state['largest_observation_gap_seconds']<=120 and
                            len(observed['private_events'])>=1 and len(observed['shared_exchanges'])>=1
                            and observed['sqlite_integrity']=='ok' and not observed['provider_budget']['paused'])
                    state.update(status='completed' if passed else 'completed_failed',finished_at=now)
                    save(ROOT/'final-facts.json',observed);save(ROOT/'state.json',state)
                    export_result(state,observed);break
                asyncio.run(tick(runtime,store,state,settings.model_api_key,ledger))
                state.update(last_observed_at=int(time.time()),scans=state['scans']+1)
                save(ROOT/'latest-facts.json',facts(runtime,store,state,ledger));save(ROOT/'state.json',state)
                for _ in range(60):
                    if STOP:break
                    time.sleep(1)
            if STOP:
                state['status']='interrupted';save(ROOT/'state.json',state)
        finally:
            runtime.engine.dispose()
    return status()


def export_result(state,observed):
    result=dict(status=state['status'],origin='real_provider',started_at=state['started_at'],deadline=state['deadline'],
        finished_at=state.get('finished_at'),scans=state['scans'],largest_observation_gap_seconds=state['largest_observation_gap_seconds'],
        gap_limit_seconds=120,private_events=len(observed['private_events']),shared_exchanges=len(observed['shared_exchanges']),
        private_event_sha256=observed['private_event_sha256'],shared_event_sha256=observed['shared_event_sha256'],
        budget=observed['provider_budget'],sqlite_integrity=observed['sqlite_integrity'],
        old_windows_preserved=True,old_unknown_reservation_retained=True)
    save(PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段3/四项验收续跑/真实连续24小时结果.json',result)


def status():
    if not (ROOT/'state.json').exists():
        return dict(status='not_prepared')
    state=json.loads((ROOT/'state.json').read_text())
    with (ROOT/'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            held=False
        except BlockingIOError:
            held=True
    return {**state,'budget':budget().status(),'process_lock_held':held}


def launch(resume=False):
    ledger=budget();ledger.approval()
    if not (ROOT/'state.json').exists():
        raise ValueError('Prepare the independent life database first')
    with (ROOT/'run.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads((ROOT/'state.json').read_text())
        if resume:
            if state['status'] not in ('running','interrupted') or state['started_at'] is None:
                raise ValueError('Only an existing interrupted continuous window can resume')
            marker=ROOT/f'resume-{state["resumes"]+1}.json'
        else:
            if state['status']!='prepared':
                raise ValueError('This window has already started')
            marker=ROOT/'launch.json'
        # Durable launcher exclusion also covers the interval before child flock.
        marker.touch(mode=0o600,exist_ok=False)
        marker.write_text(json.dumps({'deadline':state['deadline'],'automatic_retry':False}))
    (ROOT/'tmp').mkdir(exist_ok=True,mode=0o700)
    with (ROOT/'process.log').open('a') as log:
        process=subprocess.Popen([sys.executable,'-m','scripts.run_acceptance_life','run'],
            cwd=PROJECT/'backend',env={**os.environ,'TMPDIR':str(ROOT/'tmp')},stdin=subprocess.DEVNULL,
            stdout=log,stderr=log,start_new_session=True)
    value=dict(status='launched',pid=process.pid);save(ROOT/'process.json',value)
    return value


def restart():
    state=status()
    if (state['status'] not in ('running','interrupted') or not state['process_lock_held']
            or state['budget']['requests']!=2 or state['budget']['paused']
            or not state.get('paid_dispatch_finished')):
        raise ValueError('Only a running window with finished paid dispatch can restart')
    pid=json.loads((ROOT/'process.json').read_text())['pid']
    command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
    cwd_info=subprocess.check_output(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],text=True)
    if (not command.endswith(' -m scripts.run_acceptance_life run') or os.getpgid(pid)!=pid
            or f'n{PROJECT/"backend"}\n' not in cwd_info):
        raise ValueError('Continuous window process identity changed')
    before=json.loads((ROOT/'latest-facts.json').read_text())
    os.killpg(pid,signal.SIGTERM)
    for _ in range(100):
        if not status()['process_lock_held']:
            break
        time.sleep(.1)
    else:
        raise ValueError('Continuous window did not stop')
    # The old process-bound awake lease must release before a new owner attaches.
    awake=json.loads((ROOT/'awake.json').read_text())
    for _ in range(100):
        try:
            command=subprocess.check_output(['ps','-p',str(awake['guard_pid']),'-o','command='],text=True).strip()
        except subprocess.CalledProcessError:
            break
        if command!=f'/usr/bin/caffeinate -i -s -w {pid}':
            break
        time.sleep(.1)
    else:
        raise ValueError('Previous awake lease did not release')
    launched=launch(resume=True)
    for _ in range(100):
        restored=status()
        if (restored['status']=='running' and restored['resumes']>state['resumes']
                and restored['scans']>state['scans'] and restored['process_lock_held']):
            after=json.loads((ROOT/'latest-facts.json').read_text())
            unchanged=(restored['deadline']==state['deadline']
                and before['private_event_sha256']==after['private_event_sha256']
                and before['shared_event_sha256']==after['shared_event_sha256']
                and restored['budget']['requests']==state['budget']['requests'])
            receipt=dict(status='verified' if unchanged else 'failed',before_pid=pid,
                after_pid=launched['pid'],resumes=restored['resumes'],deadline=restored['deadline'],
                deadline_unchanged=restored['deadline']==state['deadline'],
                private_hash_unchanged=before['private_event_sha256']==after['private_event_sha256'],
                shared_hash_unchanged=before['shared_event_sha256']==after['shared_event_sha256'],
                private_events=len(after['private_events']),shared_exchanges=len(after['shared_exchanges']),
                budget=restored['budget'],largest_gap_seconds=restored['largest_observation_gap_seconds'])
            save(PROJECT/f'docs/PRD/版本/V1.2/验收证据/阶段3/四项验收续跑/真实生活重启-{restored["resumes"]}.json',receipt)
            if not unchanged:
                raise ValueError('Restart verification failed')
            return receipt
        time.sleep(.1)
    raise ValueError('Restart restoration has not completed; do not relaunch')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','launch','resume','restart','run','status','prices'])
    mode=parser.parse_args().mode
    if mode=='prices':
        result=previous.batch.current_prices()
        save(ROOT.parent/'price-check.json',result)
    else:
        result=prepare() if mode=='prepare' else launch(mode=='resume') if mode in ('launch','resume') else restart() if mode=='restart' else run() if mode=='run' else status()
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'status':'stopped','error_type':type(exc).__name__}));sys.exit(1)
