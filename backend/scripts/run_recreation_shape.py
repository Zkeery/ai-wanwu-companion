"""One persisted, non-retrying recreation through the isolated website API."""
import argparse
import json
import os
import subprocess
import sys
import time
from uuid import uuid4

import httpx

from scripts.run_real_web import PROJECT, ROOT, ENDPOINT, save
from scripts.real_web_recovery import selected

RUN = ROOT/'acceptance/shape-revision'
STATE = RUN/'state.json'
API = 'http://127.0.0.1:8052/api/v1'
CHARACTER_ONLY = False


def checked_budget():
    budget = selected(ROOT, ENDPOINT)
    value = budget.status()
    if (budget.reference != 'real-web-recovery-20261002-4.8cny-11requests'
            or not value['authorized'] or value['paused']
            or value['requests'] + 2 > value['requests_max']
            or round(value['reserved_cny'] + 1.1616, 6) > value['budget_cny']):
        raise ValueError('Existing recovery authorization cannot cover this single revision')
    return value


def events(lines):
    event = None; data = []
    for line in lines:
        if line.startswith('event:'):
            event = line[6:].strip()
        elif line.startswith('data:'):
            data.append(line[5:].strip())
        elif not line and event:
            yield event, json.loads('\n'.join(data))
            event = None; data = []
    if event or data:
        raise ValueError('Incomplete generation event')


def run():
    value = json.loads(STATE.read_text())
    if value['status'] != 'prepared':
        raise ValueError('Never restart or resend a submitted revision')
    # Exclusive marker survives a crash before/after the API submission.
    with (RUN/'submitted.json').open('x') as marker:
        marker.write(json.dumps(dict(request_id=value['request_id'], started_at=time.time())))
    value.update(status='started', started_at=time.time(), pid=os.getpid())
    save(STATE, value)
    token = None; started = time.perf_counter()
    try:
        before = checked_budget()
        with httpx.Client(timeout=300, trust_env=False) as client:
            info = client.get(API+'/real-experience'); info.raise_for_status()
            if (info.json().get('sms') != 'local_test' or info.json().get('source') != 'real_provider'
                    or info.json().get('automatic_paid_features') is not False):
                raise ValueError('Isolated website configuration changed')
            if CHARACTER_ONLY and (info.json().get('appearance_style_id') != 'whimsical-object-spirit-v2'
                    or selected(ROOT, ENDPOINT).revision_request_id != value['request_id']):
                raise ValueError('Character-only direction or request authorization changed')
            login = client.post(API+'/auth/login', json={'phone':'13900000160','code':'123456'})
            login.raise_for_status(); token = login.json()['token']
            headers = {'Authorization':'Bearer '+token}
            source = client.get(API+'/characters/6', headers=headers); source.raise_for_status()
            if source.json()['status'] != 'ready' or source.json()['name'] != '斑斑':
                raise ValueError('Revision source changed')
            with client.stream('POST', API+'/characters/6/recreations', headers=headers,
                    json={'request_id':value['request_id']}) as response:
                response.raise_for_status()
                terminal = None
                for event, data in events(response.iter_lines()):
                    if event == 'started':
                        value['character_id'] = data['character_id']; save(STATE,value)
                    if event in ('done','error'):
                        if terminal is not None: raise ValueError('Duplicate terminal event')
                        terminal = event
                        if event == 'done':
                            value.update(status='ready',character_id=data['id'],name=data['name'])
                        else:
                            value.update(status='failed',error_code=data.get('error',{}).get('code'))
                        save(STATE,value)
                if terminal is None: raise ValueError('Missing terminal event; do not resend')
            value.update(budget_before=before,budget_after=selected(ROOT,ENDPOINT).status(),
                api_elapsed_ms=(time.perf_counter()-started)*1000,ended_at=time.time())
    except Exception as exc:
        # Never include exception text, response bodies, headers or credentials.
        if value['status'] != 'ready': value['status'] = 'unknown' if value.get('character_id') else 'stopped'
        value.update(error_type=type(exc).__name__,ended_at=time.time())
        selected(ROOT,ENDPOINT).stop('validation_failed')
    finally:
        if token:
            try:
                with httpx.Client(timeout=10,trust_env=False) as client:
                    result=client.post(API+'/auth/logout',headers={'Authorization':'Bearer '+token})
                    value['own_session_revoked']=result.status_code==204
            except Exception:
                value['own_session_revoked']=False
        save(STATE,value)


def main():
    global RUN, STATE, CHARACTER_ONLY
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['prepare','launch','run','status'])
    parser.add_argument('--character-only', action='store_true')
    args = parser.parse_args(); mode = args.mode
    CHARACTER_ONLY = args.character_only
    if CHARACTER_ONLY:
        RUN = ROOT/'acceptance/character-only-revision'
        STATE = RUN/'state.json'
    if mode=='prepare':
        before=checked_budget()
        RUN.mkdir(parents=True,exist_ok=True,mode=0o700)
        value=dict(status='prepared',request_id=str(uuid4()),source_character_id=6,
            feedback='两次创作的造型差异更明显',max_new_model_requests=2,
            max_new_reservation_cny=1.1616,automatic_retries=0,budget_at_prepare=before)
        if CHARACTER_ONLY:
            value.update(request_id=selected(ROOT,ENDPOINT).revision_request_id,
                feedback='独立完整3D角色，省略附带花盆、盆土及底座，保留植物主体特征与造型差异')
        with STATE.open('x') as file: json.dump(value,file,ensure_ascii=False,indent=2)
        STATE.chmod(0o600)
    elif mode=='launch':
        value=json.loads(STATE.read_text())
        if value['status']!='prepared' or (RUN/'submitted.json').exists():
            raise ValueError('Single revision already submitted')
        checked_budget()
        # A second launch is also rejected before a second worker starts.
        with (RUN/'launch.json').open('x') as file: json.dump({'at':time.time()},file)
        with (RUN/'worker.log').open('a') as log:
            worker=subprocess.Popen([sys.executable,'-m','scripts.run_recreation_shape','run',
                *(['--character-only'] if CHARACTER_ONLY else [])],
                cwd=PROJECT/'backend',stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        value=dict(status='launched',pid=worker.pid,request_id=value['request_id'])
    elif mode=='run':
        run(); value=json.loads(STATE.read_text())
    else:
        value=json.loads(STATE.read_text())
    print(json.dumps(value,ensure_ascii=False))


if __name__=='__main__':main()
