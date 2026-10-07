"""Temporary localhost-only production UI verification of the bound sample DB."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

from scripts import c174_batch as batch
from scripts import run_c174_motion as motion

ROOT=batch.WORK/'preview'


def serve():
    os.environ.update(MODEL_API_KEY='',MODEL_BASE_URL='',IMAGE_BASE_URL='',DEV_AUTH_TOKEN='',
        SMS_LIVE_ENABLED='false',LIFE_RUNTIME_ENABLED='false',LIFE_RUNTIME_PREVIEW_ENABLED='false',
        LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false',GATHERING_DIALOGUE_ENABLED='false',
        GATHERING_DIALOGUE_AUTOMATIC_ENABLED='false',VOICE_LIVE_REPLY_ENABLED='false')
    motion.context()
    from app.main import app
    import uvicorn
    uvicorn.run(app,host='127.0.0.1',port=8051,log_level='error')


def launch():
    if json.loads((motion.ROOT/'state.json').read_text())['status']!='ready':
        raise ValueError('All fifteen actual bindings must be ready')
    for port in (8051,3058):
        with socket.socket() as sock:
            try: sock.bind(('127.0.0.1',port))
            except OSError: raise ValueError('Preview port already occupied') from None
    ROOT.mkdir(exist_ok=False)
    frontend=ROOT/'frontend'
    shutil.copytree(batch.PROJECT/'frontend',frontend,
        ignore=shutil.ignore_patterns('node_modules','.next*','.env*','tests','coverage','*.tsbuildinfo'))
    (frontend/'node_modules').symlink_to(batch.PROJECT/'frontend/node_modules',target_is_directory=True)
    _,SessionLocal,_,models=motion.context()
    from app.services.auth import create_session
    with SessionLocal() as db:
        token=create_session(db,db.get(models[0],motion.OWNER))
    batch.save(ROOT/'session.json',{'token':token,'owner_id':motion.OWNER})
    with (ROOT/'backend.log').open('a') as log:
        backend=subprocess.Popen([sys.executable,'-m','scripts.c174_preview','serve'],
            cwd=batch.PROJECT/'backend',env={**os.environ,'TMPDIR':str(batch.WORK/'tmp')},
            stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    with (ROOT/'frontend.log').open('a') as log:
        front=subprocess.Popen([str(frontend/'node_modules/.bin/next'),'dev','--webpack','--hostname','localhost','--port','3058'],
            cwd=frontend,env={**os.environ,'BACKEND_URL':'http://127.0.0.1:8051','NEXT_DIST_DIR':'.next-preview',
                'TMPDIR':str(batch.WORK/'tmp')},stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    value={'backend_pid':backend.pid,'frontend_pid':front.pid,'url':'http://localhost:3058/companions/1'}
    batch.save(ROOT/'process.json',value);return value


def resume_frontend():
    value=json.loads((ROOT/'process.json').read_text());frontend=ROOT/'frontend'
    with socket.socket() as sock: sock.bind(('127.0.0.1',3058))
    with (ROOT/'frontend.log').open('a') as log:
        proc=subprocess.Popen([str(frontend/'node_modules/.bin/next'),'dev','--webpack','--hostname','localhost','--port','3058'],
            cwd=frontend,env={**os.environ,'BACKEND_URL':'http://127.0.0.1:8051','NEXT_DIST_DIR':'.next-preview',
                'TMPDIR':str(batch.WORK/'tmp')},stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
    value['frontend_pid']=proc.pid;batch.save(ROOT/'process.json',value);return value


def cleanup():
    from signal import SIGTERM
    value=json.loads((ROOT/'process.json').read_text())
    for key in ('frontend_pid','backend_pid'):
        try:
            if os.getpgid(value[key])!=value[key]:
                raise ValueError('Preview process group changed')
            os.killpg(value[key],SIGTERM)
        except ProcessLookupError: pass
    _,SessionLocal,_,_=motion.context()
    from app.services.auth import logout
    if (ROOT/'session.json').exists():
        token=json.loads((ROOT/'session.json').read_text())['token']
        with SessionLocal() as db: logout(db,token)
        (ROOT/'session.json').unlink()
    return {'status':'stopped','qa_session_revoked':True}


def sync_player():
    for name in ('motion-player.tsx','motion-player.module.css'):
        shutil.copyfile(batch.PROJECT/'frontend/components'/name,ROOT/'frontend/components'/name)
    return {'status':'synced','files':2,'additional_model_requests':0}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode',choices=['launch','serve','cleanup','resume-frontend','sync-player'])
    mode=parser.parse_args().mode
    if mode=='serve': serve()
    else: print(json.dumps(launch() if mode=='launch' else resume_frontend() if mode=='resume-frontend'
                          else sync_player() if mode=='sync-player' else cleanup()))


if __name__=='__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'status':'paused_failure','error_type':type(exc).__name__}));sys.exit(1)
