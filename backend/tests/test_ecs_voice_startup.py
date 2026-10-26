import json
import os
from pathlib import Path
import subprocess
import sys
import pytest


@pytest.mark.parametrize('case', ['disabled', 'configured', 'missing', 'paid-enabled'])
def test_real_production_entry_keeps_paid_voice_blocked(tmp_path, case):
    backend = Path(__file__).resolve().parents[1]
    model = os.environ.get('ECS_TEST_MODEL_PATH')
    if not model:
        # Configuration wiring only: never instantiate ASR or load this fixture.
        stub = tmp_path / 'offline-model-configuration-only'
        stub.mkdir()
        for name in ('model.bin', 'config.json', 'tokenizer.json'):
            (stub / name).write_bytes(b'configuration-fixture-not-a-model')
        model = str(stub)
    config = dict(APP_ENV='production', AUTH_MODE='invite', SMS_LIVE_ENABLED='false',
        MODEL_API_KEY='fixture-only-not-a-real-key', MODEL_BASE_URL='https://models.example.invalid/v1',
        IMAGE_BASE_URL='https://images.example.invalid/v1', MODEL_MAX_RETRIES='0',
        DATABASE_URL='sqlite:///' + str(tmp_path / 'entry.db'), UPLOAD_DIR=str(tmp_path / 'uploads'),
        LIFE_RUNTIME_ENABLED='false', LIFE_SIMULATION_ENABLED='false', LIFE_RUNTIME_PREVIEW_ENABLED='false',
        LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false', GATHERING_DIALOGUE_ENABLED='false',
        GATHERING_DIALOGUE_AUTOMATIC_ENABLED='false', MOTION_GENERATION_ENABLED='false',
        DEV_AUTH_TOKEN='', DEV_SMS_FIXED_CODE='', LEGACY_CLAIM_USER_ID='', QWEN_TTS_API_KEY='',
        VOICE_LOCAL_MODEL_PATH=model if case in ['configured', 'paid-enabled'] else (str(tmp_path / 'absent') if case == 'missing' else ''),
        VOICE_LIVE_REPLY_ENABLED='true' if case == 'paid-enabled' else 'false',
        PARTNER_DAILY_QUOTA_DB=str(tmp_path / 'quota.db'), PARTNER_DAILY_REQUEST_LIMIT='30')
    code = '''import socket,json,runpy,sys,pydantic_settings
original=pydantic_settings.BaseSettings.__init__
def init(self,*a,**kw):kw['_env_file']=None;original(self,*a,**kw)
pydantic_settings.BaseSettings.__init__=init
attempts=[]
def deny(*a,**kw):attempts.append(1);raise RuntimeError('NETWORK_FORBIDDEN')
socket.socket.connect=deny;socket.socket.connect_ex=deny
try:
 m=runpy.run_path(sys.argv[1]);result={'allowed':True,'health':m['health'](),'deployment':m['deployment_check'](None)}
except ValueError as e:result={'allowed':False,'error':str(e)}
result['socket_attempts']=len(attempts);print(json.dumps(result))
'''
    child = subprocess.run([sys.executable, '-c', code, str(backend / 'scripts/ecs_partner_serve.py')],
        cwd=backend, env={**os.environ, **config}, text=True, capture_output=True, timeout=30)
    assert child.returncode == 0, child.stderr
    result = json.loads(child.stdout)
    assert result['socket_attempts'] == 0
    assert result['allowed'] is (case in ['disabled', 'configured'])
    if result['allowed']:
        assert result['health']['ok'] is True
        assert result['deployment']['whisper_enabled'] is (case == 'configured')
    elif case == 'paid-enabled':
        assert 'live voice replies must remain disabled' in result['error']
    else:
        assert 'complete offline prerequisites' in result['error']
