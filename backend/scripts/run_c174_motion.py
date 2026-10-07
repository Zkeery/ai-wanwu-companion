"""Bounded motions for the five specifically adopted C1.74 static candidates."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import fcntl
import hashlib
from html import escape
import json
import os
from pathlib import Path
import shutil
import subprocess
import socket
import sys
from threading import Lock

import httpx

from scripts import c174_batch as batch

ROOT=batch.WORK/'motion'
OWNER='c174-five-sample-motion'
REVIEW=batch.EVIDENCE/'静态采用确认.json'
QUOTA=batch.EVIDENCE/'动作通道额度.json'
ACTIVITIES=('rest','walk','observe')
LOCK=Lock()


def approved():
    batch.authorization()
    review=json.loads(REVIEW.read_text())
    quota=json.loads(QUOTA.read_text())
    if (review['user_reply']!='五类都采用，继续动作' or len(review['candidates'])!=5
        or quota['status']!='opened_for_approved_batch' or quota['unlimited']
        or quota['fallback_models']!=0 or quota['remaining_usd_approved']!=2
        or quota['model_allowlist']!=['gpt-image-2.5-sunburst']
        or quota['verified_on']!=date.today().isoformat()):
        raise ValueError('Specific static review or current bounded quota is missing')
    from dotenv import dotenv_values
    key=dotenv_values(batch.PROJECT/'.env',interpolate=False).get('AIHUBMIX_API_KEY','')
    digest=hashlib.sha256((key[:7]+'****'+key[-4:]).encode()).hexdigest()
    if not key or digest!=quota['platform_key_display_sha256']:
        raise ValueError('Project Sunburst key differs from verified console row')
    rows=json.loads((batch.WORK/'static/state.json').read_text())['cases']
    selected=[r for r in rows if r['case_id'] in review['candidates']]
    if len(selected)!=5 or any(r['status']!='needs_review' or
        r['image_sha256']!=review['candidates'][r['case_id']] or
        hashlib.sha256((batch.PROJECT/r['image_file']).read_bytes()).hexdigest()!=r['image_sha256'] for r in selected):
        raise ValueError('Adopted candidate changed')
    return selected


def context(*, create=False):
    if not create and not (ROOT/'motion.db').is_file():
        raise ValueError('Keep the original motion database; never recreate on resume')
    os.environ.update(DATABASE_URL='sqlite:///'+str(ROOT/'motion.db'),UPLOAD_DIR=str(ROOT/'uploads'),
        WALK_WORKFLOW_ROOT=str(ROOT/'workflow'),MOTION_GENERATION_ENABLED='false',APP_ENV='test')
    from app.core.config import get_settings
    get_settings.cache_clear()
    from app.core.database import Base,engine,SessionLocal
    if engine.url.database!=str(ROOT/'motion.db'):
        raise ValueError('Motion process is not isolated')
    from app.models.models import User,Photo,Object,Character
    from app.services import motion_generation as generation
    if create: Base.metadata.create_all(engine)
    return get_settings(),SessionLocal,generation,(User,Photo,Object,Character)


def prepare():
    rows=approved()
    ROOT.mkdir(exist_ok=False);(ROOT/'uploads').mkdir()
    _,SessionLocal,generation,models=context(create=True)
    User,Photo,Object,Character=models
    state=dict(status='preparing',origin='real_provider',candidates=[],max_requests=15,
        source_review_sha256=hashlib.sha256(REVIEW.read_bytes()).hexdigest())
    batch.save(ROOT/'state.json',state)
    with SessionLocal() as db:
        db.add(User(id=OWNER,phone='13900000743'));db.flush()
        photo=Photo(filename='C1.74-reviewed-public-photographs',status='done',owner_id=OWNER)
        db.add(photo);db.flush()
        for row in rows:
            name=row['case_id']+Path(row['image_file']).suffix
            shutil.copyfile(batch.PROJECT/row['image_file'],ROOT/'uploads'/name)
            obj=Object(photo_id=photo.id,label=row['label'],visual_features=row['visual_features'])
            db.add(obj);db.flush()
            ch=Character(object_id=obj.id,owner_id=OWNER,name=row['name'],persona=row['persona'],
                opening_line=row['opening_line'],status='ready',image_path=name)
            db.add(ch);db.flush();generation.register_request(db,ch)
            state['candidates'].append(dict(case_id=row['case_id'],character_id=ch.id,
                image_sha256=row['image_sha256'],name=row['name'],activities={}))
        db.commit()
    for item in state['candidates']:
        grant=generation.authorize_activities(item['character_id'],OWNER,
            expected_source_sha256=item['image_sha256'],
            approval_ref=batch.authorization()['authorization_ref']+':'+item['case_id'],
            price_verified_on=date.today().isoformat(),accept_metered_cost=True)
        item['activities']={r['activity']:r for r in grant['activities']}
        batch.save(ROOT/'state.json',state)
    state['status']='queued';batch.save(ROOT/'state.json',state)
    return {'status':'queued','candidates':5,'requests':15,'provider_requests':0}


def run():
    approved()
    with (ROOT/'run.lock').open('a') as process_lock:
        fcntl.flock(process_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads((ROOT/'state.json').read_text())
        if state['status']!='queued': raise ValueError('Motion batch already attempted; never retry it')
        settings,_,generation,_=context()
        from app.services.motion_walk_aihubmix import generate,preflight
        from app.services.motion_atlas_provider import AtlasProviderError
        settings.motion_generation_enabled=True
        state['status']='running';batch.save(ROOT/'state.json',state)
        def candidate(item):
            for activity in ACTIVITIES:
                approved()
                current=generation.status(item['character_id'],OWNER,activity=activity)
                if current['state']!='queued': return
                def provider(source,key,*,expected_sha256,on_task=None,activity=activity):
                    preflight(source,activity=activity)
                    call=batch.claim('motion',item['case_id']+':'+activity)
                    upstream={}
                    def task(task_id):
                        upstream['id']=task_id
                        if on_task: on_task(task_id)
                    try:
                        with httpx.Client(timeout=httpx.Timeout(180,connect=10),trust_env=False,follow_redirects=False) as client:
                            raw,usage=generate(source,key,expected_sha256=expected_sha256,
                                activity=activity,on_task=task,client=client)
                        batch.settle(call,'succeeded',dict(model='gpt-image-2.5-sunburst',
                            provider_request_id=upstream.get('id'),usage=usage,actual_bill_verified=False,
                            case_id=item['case_id'],activity=activity,cost_status='full_reservation_retained'))
                        return raw,usage
                    except Exception as exc:
                        batch.settle(call,'unknown',dict(error_type=type(exc).__name__,
                            provider_request_id=upstream.get('id'),cost_status='full_reservation_retained'))
                        raise AtlasProviderError('provider_call_unknown') from None
                generation.process_one(request_id=current['request_id'],provider=provider)
                result=generation.status(item['character_id'],OWNER,activity=activity)
                with LOCK:
                    item['activities'][activity]=result;batch.save(ROOT/'state.json',state)
                if result['state']!='needs_review': return
        try:
            with ThreadPoolExecutor(max_workers=3) as pool:
                futures=[pool.submit(candidate,item) for item in state['candidates']]
                for future in futures: future.result()
            states=[a['state'] for item in state['candidates'] for a in item['activities'].values()]
            state['status']='needs_review' if all(s=='needs_review' for s in states) else 'paused_failure'
        except Exception as exc:
            state.update(status='paused_failure',error_type=type(exc).__name__)
        finally:
            settings.motion_generation_enabled=False;batch.save(ROOT/'state.json',state)
            export(state)
    return status()


def export(state):
    target=batch.EVIDENCE/'真实动作候选';target.mkdir(exist_ok=True)
    cards=[]
    for item in state['candidates']:
        source=next((ROOT/'uploads').glob(item['case_id']+'.*'))
        static_name=item['case_id']+'-static'+source.suffix
        shutil.copyfile(source,target/static_name)
        cells=['<div><h3>已采用静态</h3><img style="width:200px;height:200px;object-fit:contain" src="'+static_name+'"></div>']
        for activity in ACTIVITIES:
            ref=batch.authorization()['authorization_ref']+':'+item['case_id']+':'+activity
            job=hashlib.sha256(ref.encode()).hexdigest()
            receipt=ROOT/'workflow'/('approval-'+job+'.json')
            if not receipt.is_file(): continue
            record=json.loads(receipt.read_text());candidate=ROOT/'workflow'/'jobs'/job/'candidate.png'
            if not candidate.is_file(): continue
            name=item['case_id']+'-'+activity+'.png';shutil.copyfile(candidate,target/name)
            item['activities'][activity].update(candidate_sha256=record.get('candidate_sha256'),
                provider_request_id=record.get('provider_task_id'),candidate_file=name,
                quality_check=record.get('quality_check'),workflow_job_id=job)
            cells.append('<div><h3>'+{'rest':'休息','walk':'散步','observe':'观察'}[activity]+'</h3><div class="sprite" style="background-image:url('+name+')"></div><details><summary>四帧原图</summary><img src="'+name+'"></details></div>')
        cards.append('<article><h2>'+escape(item['name'])+'</h2><div class="actions">'+''.join(cells)+'</div></article>')
    html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>C1.74动作审查</title><style>body{font:16px system-ui;margin:24px;background:#f5f7f2;color:#234}article{background:white;border-radius:14px;padding:20px;margin:20px 0}.actions{display:flex;flex-wrap:wrap;gap:24px}.sprite{width:200px;height:200px;background-size:400px 400px;animation:poses 1.2s steps(1) infinite;background-color:#edf0e8}img{max-width:320px;width:100%}@keyframes poses{0%{background-position:0 0}25%{background-position:100% 0}50%{background-position:0 100%}75%{background-position:100% 100%}}</style><h1>五类伙伴 · 三类真实动作候选</h1><p>此页仅供审查，尚未采用、制包或绑定。休息持续闭眼；散步交替迈步；观察左右打量。请同时核对身份、肢体、盆栽结构和帧间连贯性。</p>'+''.join(cards)+'</html>'
    (target/'index.html').write_text(html,encoding='utf8');batch.save(target/'候选摘要.json',state)
    batch.save(ROOT/'state.json',state)


def status():
    if not (ROOT/'state.json').exists(): return {'status':'not_prepared'}
    state=json.loads((ROOT/'state.json').read_text())
    return {'status':state['status'],'candidates':len(state['candidates']),
        'activities':{i['case_id']:{k:v['state'] for k,v in i['activities'].items()} for i in state['candidates']},
        'call_guard':batch.status()}


def bind():
    review=json.loads((batch.EVIDENCE/'动作采用确认.json').read_text())
    candidate_summary=batch.EVIDENCE/'真实动作候选/候选摘要.json'
    if (review['user_reply']!='15 个动作都采用，继续绑定' or review['accepted_motion_count']!=15
        or hashlib.sha256(candidate_summary.read_bytes()).hexdigest()!=review['reviewed_summary_sha256']):
        raise ValueError('Specific motion adoption or immutable candidate summary changed')
    with (ROOT/'run.lock').open('a') as process_lock:
        fcntl.flock(process_lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        state=json.loads((ROOT/'state.json').read_text())
        if state['status'] not in ('needs_review','binding','paused_binding','ready'):
            raise ValueError('Generated candidates are not bindable')
        _,SessionLocal,generation,_=context()
        from app.services import character_walk_workflow as flow
        from app.services import motion_preparation as preparation
        before=batch.status()['counts']['motion']
        original_connect=socket.socket.connect;original_connect_ex=socket.socket.connect_ex
        def forbidden(*_args,**_kwargs): raise AssertionError('Binding forbids network and model calls')
        socket.socket.connect=socket.socket.connect_ex=forbidden
        try:
            state['status']='binding';batch.save(ROOT/'state.json',state)
            for item in state['candidates']:
                for activity in ACTIVITIES:
                    row=item['activities'][activity]
                    flow.review(row['workflow_job_id'],item['character_id'],OWNER,decision='accept',
                        candidate_sha256=row['candidate_sha256'],review_ref=review['review_ref'],root=ROOT/'workflow')
            for _ in range(20):
                with SessionLocal() as db:
                    if not preparation.process_one(db): break
            for item in state['candidates']:
                for activity in ACTIVITIES:
                    current=generation.status(item['character_id'],OWNER,activity=activity)
                    if current['state']!='ready': raise ValueError('Preparation has not reached ready')
                    item['activities'][activity].update(current)
            if batch.status()['counts']['motion']!=before:
                raise ValueError('Paid motion calls changed during offline binding')
            state.update(status='ready',review_ref=review['review_ref'],binding_network_forbidden=True,
                paid_motion_requests_before_binding=before,paid_motion_requests_after_binding=before)
            batch.save(ROOT/'state.json',state)
            batch.save(batch.EVIDENCE/'真实动作候选/绑定摘要.json',state)
            return {'status':'ready','bound_activities':15,'new_model_requests':0}
        except Exception as exc:
            state.update(status='paused_binding',binding_error_type=type(exc).__name__)
            batch.save(ROOT/'state.json',state);raise
        finally:
            socket.socket.connect=original_connect;socket.socket.connect_ex=original_connect_ex


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','launch','run','status','export','bind','launch-bind'],nargs='?',default='status')
    mode=parser.parse_args().mode
    if mode=='prepare': value=prepare()
    elif mode=='run': value=run()
    elif mode=='bind': value=bind()
    elif mode=='launch-bind':
        with (ROOT/'bind.log').open('a') as log:
            proc=subprocess.Popen([sys.executable,'-m','scripts.run_c174_motion','bind'],cwd=batch.PROJECT/'backend',
                env={**os.environ,'TMPDIR':str(batch.WORK/'tmp')},stdin=subprocess.DEVNULL,
                stdout=log,stderr=log,start_new_session=True)
        value={'status':'binding_launched','pid':proc.pid};batch.save(ROOT/'bind-process.json',value)
    elif mode=='launch':
        approved()
        if json.loads((ROOT/'state.json').read_text())['status']!='queued': raise ValueError('Already attempted')
        with (ROOT/'launch.json').open('x') as file: json.dump({'reserved':True},file)
        with (ROOT/'process.log').open('a') as log:
            proc=subprocess.Popen([sys.executable,'-m','scripts.run_c174_motion','run'],cwd=batch.PROJECT/'backend',
                env={**os.environ,'TMPDIR':str(batch.WORK/'tmp')},stdin=subprocess.DEVNULL,
                stdout=log,stderr=log,start_new_session=True)
        value={'status':'launched','pid':proc.pid,'max_requests':15};batch.save(ROOT/'process.json',value)
    elif mode=='export': export(json.loads((ROOT/'state.json').read_text()));value=status()
    else: value=status()
    print(json.dumps(value,ensure_ascii=False))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'status':'paused_failure','error_type':type(exc).__name__}));sys.exit(1)
