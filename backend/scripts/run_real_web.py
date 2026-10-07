"""Independent localhost real-AI website; no model call during prepare/launch."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / '.runtime/real-web'
DATA = ROOT / 'data'
SOURCE = PROJECT / '.runtime/c160-review'
ENDPOINT = 'https://maas-api.antdigital.com/v1'


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.chmod(0o600)
    temporary.replace(path)


def prepare():
    # The established backup helper also supports its standalone script entry.
    sys.path.insert(0, str(PROJECT/'backend/scripts'))
    from scripts.check_full_flow_recovery import capture, restore_test
    if ROOT.exists():
        raise FileExistsError('Real website already prepared')
    ROOT.mkdir(mode=0o700)
    options = dict(source=SOURCE, snapshot=ROOT/'backup', database_name='check.db', include_runtime_state=True)
    captured = capture(**options)
    restored = restore_test(DATA, **options)
    frontend = ROOT/'frontend'
    shutil.copytree(PROJECT/'frontend', frontend,
        ignore=shutil.ignore_patterns('node_modules', '.next*', '.env*', 'tests', 'coverage', '*.tsbuildinfo'))
    (frontend/'node_modules').symlink_to(PROJECT/'frontend/node_modules', target_is_directory=True)
    (ROOT/'tmp').mkdir(mode=0o700)
    value = dict(status='prepared', original_data_unchanged=True, backup=captured, restore=restored,
                 source='real_provider', new_model_requests=0, url='http://127.0.0.1:3059')
    save(ROOT/'prepared.json', value)
    return value


def serve():
    from dotenv import dotenv_values
    configured = dotenv_values(PROJECT/'backend/.env')
    if (not configured.get('MODEL_API_KEY', '').strip()
            or configured.get('MODEL_BASE_URL', '').rstrip('/') != ENDPOINT
            or (configured.get('IMAGE_BASE_URL') or configured.get('MODEL_BASE_URL', '')).rstrip('/') != ENDPOINT):
        raise ValueError('This project MaaS configuration is required')
    os.environ.update(MODEL_API_KEY=configured['MODEL_API_KEY'], MODEL_BASE_URL=ENDPOINT,
        IMAGE_BASE_URL=ENDPOINT, VISION_MODEL='ling-3.0-flash-vl', CHAT_MODEL='qwen3.8-flash',
        IMAGE_MODEL='wan2.6-t2i', MODEL_MAX_RETRIES='0', MODEL_ENABLE_THINKING='false',
        MODEL_TIMEOUT_SECONDS='120', MODEL_HTTP_POOL_ENABLED='true', CHARACTER_BUNDLE_ENABLED='true',
        DATABASE_URL=f'sqlite:///{DATA/"check.db"}', UPLOAD_DIR=str(DATA/'uploads'),
        WALK_WORKFLOW_ROOT=str(DATA/'ledger'), APP_ENV='development',
        DEV_AUTH_TOKEN='', DEV_SMS_FIXED_CODE='123456', SMS_PROVIDER='mock', SMS_LIVE_ENABLED='false',
        GENERATION_QUOTA_ENABLED='true', MOTION_GENERATION_ENABLED='false', SCENE_AGENT_ENABLED='false',
        LIFE_SIMULATION_ENABLED='false', LIFE_RUNTIME_ENABLED='false', LIFE_RUNTIME_PREVIEW_ENABLED='false',
        LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false', GATHERING_DIALOGUE_ENABLED='false',
        GATHERING_DIALOGUE_AUTOMATIC_ENABLED='false', VOICE_LIVE_REPLY_ENABLED='false')
    from scripts.real_web_budget import install
    from scripts.real_web_recovery import selected
    budget = selected(ROOT, ENDPOINT)
    install(budget)
    from app.core.config import get_settings
    get_settings.cache_clear()
    settings = get_settings()
    if settings.use_mock or settings.model_max_retries != 0:
        raise ValueError('Real model configuration did not take effect')
    from app.main import app
    from app.api import photos, characters
    from scripts.acceptance_vision import AcceptanceVisionClient
    from scripts.acceptance_recreation import AcceptanceRecreationClient
    # Only this isolated website process; original services and runs are frozen.
    photos.ModelClient = AcceptanceVisionClient
    characters.ModelClient = AcceptanceRecreationClient

    @app.middleware('http')
    async def require_experience_budget(request, call_next):
        import re
        from starlette.responses import JSONResponse
        path = request.url.path
        paid = (path in ('/api/v1/photos','/api/v1/characters') or
                re.fullmatch(r'/api/v1/characters/\d+/(chat|recreations)',path) is not None)
        before_requests=budget.status()['requests'] if request.method=='POST' and paid else 0
        if request.method == 'POST' and paid:
            revision_id = getattr(budget, 'revision_request_id', None)
            if revision_id:
                import json
                try:
                    submitted_id = json.loads(await request.body()).get('request_id')
                except (ValueError, AttributeError):
                    submitted_id = None
                if path != '/api/v1/characters/6/recreations' or submitted_id != revision_id:
                    return JSONResponse({'error':{'code':'single_revision_only',
                        'message':'本次补充授权仅用于已确认的一个独立3D角色候选。'}},status_code=403)
            current = budget.status()
            if not current['authorized']:
                return JSONResponse({'error':{'code':'real_experience_not_authorized',
                    'message':'当前可以浏览伙伴与动作；真实生成和聊天尚未开启费用额度。'}},status_code=503)
            if (current['paused'] or current['requests'] >= current['requests_max']
                    or current['reserved_cny'] >= current['budget_cny']):
                return JSONResponse({'error':{'code':'real_experience_paused',
                    'message':'真实体验额度已停止；请先核对费用与前次结果。'}},status_code=503)
        response=await call_next(request)
        if request.method=='POST' and paid:
            from scripts.real_web_response import protect
            response=protect(response,budget,before_requests)
        return response

    @app.get('/api/v1/real-experience')
    def experience():
        from app.services.appearance_style import STYLE_ID
        return dict(source='real_provider', mock_fallback=False, sms='local_test',
                    automatic_paid_features=False, appearance_style_id=STYLE_ID, **budget.status())

    # app.main's catch-all static mount must remain after this local status API.
    app.router.routes.insert(0, app.router.routes.pop())

    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=8052, log_level='error')


def launch():
    if not (ROOT/'prepared.json').is_file():
        raise ValueError('Prepare the verified data copy first')
    for port in (8052, 3059):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', port))
    env = {**os.environ, 'TMPDIR':str(ROOT/'tmp')}
    with (ROOT/'backend.log').open('a') as log:
        backend = subprocess.Popen([sys.executable, '-m', 'scripts.run_real_web', 'serve'],
            cwd=PROJECT/'backend', env=env, stdin=subprocess.DEVNULL,
            stdout=log, stderr=log, start_new_session=True)
    env.update(BACKEND_URL='http://127.0.0.1:8052', NEXT_DIST_DIR='.next-real',
        NEXT_PUBLIC_REAL_AI_LOCAL='true', NEXT_PUBLIC_OFFLINE_PREVIEW='false',
        NEXT_PUBLIC_GENERATION_DIAGNOSTICS='true',
        NEXT_PUBLIC_LIFE_LIVE_PLANNER_PREVIEW='false', NEXT_PUBLIC_LIFE_RUNTIME_ENABLED='false',
        NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW='false')
    with (ROOT/'frontend.log').open('a') as log:
        front = subprocess.Popen([str(ROOT/'frontend/node_modules/.bin/next'), 'dev', '--webpack',
            '--hostname', '127.0.0.1', '--port', '3059'], cwd=ROOT/'frontend', env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    value = dict(backend_pid=backend.pid, frontend_pid=front.pid, url='http://127.0.0.1:3059')
    save(ROOT/'process.json', value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=['prepare', 'launch', 'serve', 'status', 'prepare-recovery', 'activate-recovery', 'restart-backend', 'restart-frontend', 'check-frontend'])
    mode = parser.parse_args().mode
    if mode == 'serve':
        serve()
        return
    if mode == 'restart-frontend':
        import signal
        import time
        value=json.loads((ROOT/'process.json').read_text())
        pid=value['frontend_pid']
        command=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True).strip()
        cwd_info=subprocess.check_output(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],text=True)
        if (not command.endswith('next dev --webpack --hostname 127.0.0.1 --port 3059')
                or os.getpgid(pid)!=pid or f'n{ROOT/"frontend"}\n' not in cwd_info):
            raise ValueError('Frontend identity changed')
        os.killpg(pid,signal.SIGTERM)
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1',3059),timeout=.1):pass
            except OSError:break
            time.sleep(.1)
        else:raise ValueError('Frontend did not stop')
        env={**os.environ,'TMPDIR':str(ROOT/'tmp'),'BACKEND_URL':'http://127.0.0.1:8052',
            'NEXT_DIST_DIR':'.next-real','NEXT_PUBLIC_REAL_AI_LOCAL':'true',
            'NEXT_PUBLIC_OFFLINE_PREVIEW':'false','NEXT_PUBLIC_GENERATION_DIAGNOSTICS':'true',
            'NEXT_PUBLIC_LIFE_LIVE_PLANNER_PREVIEW':'false','NEXT_PUBLIC_LIFE_RUNTIME_ENABLED':'false',
            'NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW':'false'}
        with (ROOT/'frontend.log').open('a') as log:
            process=subprocess.Popen([str(ROOT/'frontend/node_modules/.bin/next'),'dev','--webpack',
                '--hostname','127.0.0.1','--port','3059'],cwd=ROOT/'frontend',env=env,
                stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True)
        value['frontend_pid']=process.pid;save(ROOT/'process.json',value)
    elif mode == 'restart-backend':
        import signal
        import time
        value = json.loads((ROOT/'process.json').read_text())
        pid = value['backend_pid']
        command = subprocess.check_output(['ps', '-p', str(pid), '-o', 'command='], text=True).strip()
        cwd_info = subprocess.check_output(['lsof','-a','-p',str(pid),'-d','cwd','-Fn'],text=True)
        if (not command.endswith(' -m scripts.run_real_web serve') or os.getpgid(pid) != pid
                or f'n{PROJECT/"backend"}\n' not in cwd_info):
            raise ValueError('Backend identity changed')
        os.killpg(pid, signal.SIGTERM)
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1',8052),timeout=.1): pass
            except OSError:
                break
            time.sleep(.1)
        else:
            raise ValueError('Backend did not stop')
        with (ROOT/'backend.log').open('a') as log:
            process = subprocess.Popen([sys.executable,'-m','scripts.run_real_web','serve'],
                cwd=PROJECT/'backend',env={**os.environ,'TMPDIR':str(ROOT/'tmp')},stdin=subprocess.DEVNULL,
                stdout=log,stderr=log,start_new_session=True)
        value['backend_pid'] = process.pid
        save(ROOT/'process.json',value)
    elif mode == 'check-frontend':
        target = ROOT/'verify-frontend'
        shutil.copytree(PROJECT/'frontend',target,
            ignore=shutil.ignore_patterns('node_modules','.next*','.env*','coverage','*.tsbuildinfo'))
        (target/'node_modules').symlink_to(PROJECT/'frontend/node_modules',target_is_directory=True)
        try:
            env={**os.environ,'NEXT_PUBLIC_REAL_AI_LOCAL':'true','NEXT_PUBLIC_OFFLINE_PREVIEW':'false',
                 'NEXT_PUBLIC_GENERATION_DIAGNOSTICS':'true',
                 'BACKEND_URL':'http://127.0.0.1:8052','NEXT_DIST_DIR':'.next-check'}
            with (ROOT/'frontend-check.log').open('w') as log:
                for args in ([str(target/'node_modules/.bin/next'),'build','--webpack'],
                             [str(target/'node_modules/.bin/tsc'),'--noEmit'],
                             [str(target/'node_modules/.bin/eslint'),'app/layout.tsx','--max-warnings','0']):
                    subprocess.run(args,cwd=target,env=env,stdout=log,stderr=log,check=True)
            value={'build':True,'types':True,'lint':True}
        finally:
            shutil.rmtree(target)
    elif mode == 'status':
        from scripts.real_web_recovery import selected
        value = selected(ROOT, ENDPOINT).status()
    elif mode in ('prepare-recovery','activate-recovery'):
        from scripts.real_web_recovery import prepare as prepare_recovery, activate
        value = prepare_recovery(ROOT,ENDPOINT) if mode=='prepare-recovery' else activate(ROOT,ENDPOINT)
    else:
        value = prepare() if mode == 'prepare' else launch()
    print(json.dumps(value, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(json.dumps({'status':'stopped', 'error_type':type(exc).__name__}))
        sys.exit(1)
