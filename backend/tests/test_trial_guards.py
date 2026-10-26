"""Offline acceptance dispatch protection; no real approvals or providers."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
from datetime import datetime, timezone
import hashlib
from io import BytesIO
import json
import subprocess
import sys
import wave

import httpx
import pytest

from app.services.daily_model_quota import DailyModelQuota
from app.services.trial_gate import TrialGate, TrialBlocked, PRICE_CAPS, PROFILES
from app.services.trial_transport import Envelope, TrialTransport, AsyncTrialTransport, TEXT_URL, TTS_URL

KEY = 'synthetic-not-a-credential'


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def deny(*a, **k):
        raise AssertionError('NETWORK_FORBIDDEN')
    monkeypatch.setattr('socket.socket.connect', deny)
    monkeypatch.setattr('socket.socket.connect_ex', deny)


def setup(tmp_path, mode='voice', budget=None):
    now = [int(datetime(2026, 10, 19, 15, 59, tzinfo=timezone.utc).timestamp())]
    kinds = ['voice_text', 'voice_tts'] if mode == 'voice' else ['private_life', 'shared_life']
    vendors = {PROFILES[k][0] for k in kinds}
    p = {'approved': True, 'authorization_ref': 'synthetic-approval-only', 'mode': mode,
         'starts_at': now[0], 'ends_at': now[0] + 86400,
         'budget_micro': budget or (2_400_000 if mode == 'voice' else 7_000_000),
         'scopes': {k: {'owner': 'owner', 'subject': '6' if mode == 'voice' else k} for k in kinds},
         'accounts': {v: 'synthetic-account-' + v for v in vendors},
         'credentials': {v: hashlib.sha256(KEY.encode()).hexdigest() for v in vendors}}
    q = DailyModelQuota(tmp_path / 'daily.db', 30, clock=lambda: now[0])
    g = TrialGate.create(tmp_path / 'trial.db', q, p, clock=lambda: now[0])
    return g, now


def evidence(g, kind):
    vendor, model, _ = PROFILES[kind]
    base = {'verified': True, 'vendor': vendor, 'currency': 'CNY', 'checked_at': int(g.clock()),
            'authorization_ref': g.policy['authorization_ref']}
    return {'wallet': dict(base, account=g.policy['accounts'][vendor], available_micro=20_000_000, pending_micro=0),
            'price': dict(base, model=model, rates=PRICE_CAPS[vendor].copy())}


def envelope(g, kind='voice_text', operation='operation-0001', **kwargs):
    return Envelope(g, kind, 'owner', '6' if kind.startswith('voice') else kind, operation,
                    lambda: evidence(g, kind), **kwargs)


def text_result(content='好呢，先歇一会儿。'):
    return {'model': 'qwen3.8-flash', 'choices': [{'finish_reason': 'stop',
        'message': {'role': 'assistant', 'content': content}}],
        'usage': {'prompt_tokens': 500, 'completion_tokens': 30, 'total_tokens': 530}}


def payload(kind='voice_text'):
    result = {'model': 'qwen3.8-flash', 'messages': [{'role': 'system', 'content': 'synthetic'},
        {'role': 'user', 'content': 'fixture'}], 'max_tokens': 1024 if kind == 'voice_text' else 512, 'stream': False}
    if kind == 'shared_life':
        from app.living.gathering_dialogue import MaaSDialogueAdapter
        result.update(MaaSDialogueAdapter.request_options)
    return result


def send(g, kind='voice_text', operation='operation-0001', *, response=None, presence='visible'):
    calls = []
    e = envelope(g, kind, operation, presence=presence)
    def handler(r):
        calls.append(r.method)
        return httpx.Response(200, json=response or text_result())
    with httpx.Client(transport=TrialTransport(e, httpx.MockTransport(handler))) as client:
        client.post(TEXT_URL, headers={'Authorization': 'Bearer ' + KEY}, json=payload(kind))
    return calls


@pytest.mark.parametrize('field,value', [('approved', False), ('budget_micro', 2_400_001), ('budget_micro', True),
    ('ends_at', 0), ('mode', 'motion')])
def test_invalid_approval_does_not_create_a_new_ledger(tmp_path, field, value):
    g, _ = setup(tmp_path)
    p = copy.deepcopy(g.policy);p[field] = value
    with pytest.raises(TrialBlocked):
        TrialGate.create(tmp_path / 'bad.db', g.daily, p)
    assert not (tmp_path / 'bad.db').exists()


def test_approval_cannot_be_reused_or_changed_and_ledger_copy_is_not_a_reset(tmp_path):
    g, _ = setup(tmp_path)
    with pytest.raises(TrialBlocked, match='already_used'):
        TrialGate.create(tmp_path / 'second.db', g.daily, g.policy)
    (tmp_path / 'copy.db').write_bytes(g.path.read_bytes())
    with pytest.raises(TrialBlocked, match='binding_changed'):
        TrialGate(tmp_path / 'copy.db', g.daily)
    with g.connection() as db:
        p = dict(g.policy, budget_micro=1)
        db.execute('UPDATE batch SET policy=?', (json.dumps(p, sort_keys=True),))
    with pytest.raises(TrialBlocked, match='binding_changed'):
        TrialGate(g.path, g.daily)


@pytest.mark.parametrize('mutation', ['missing', 'stale', 'future', 'low', 'pending', 'account', 'currency', 'price', 'model'])
def test_funds_or_price_uncertainty_stops_before_post_and_consumes_no_daily_attempt(tmp_path, mutation):
    g, _ = setup(tmp_path);e = envelope(g);v = evidence(g, 'voice_text')
    if mutation == 'missing':v = {}
    elif mutation == 'stale':v['wallet']['checked_at'] -= 901
    elif mutation == 'future':v['price']['checked_at'] += 1
    elif mutation == 'low':v['wallet']['available_micro'] = 1
    elif mutation == 'pending':v['wallet']['pending_micro'] = 20_000_000
    elif mutation == 'account':v['wallet']['account'] = 'different-account'
    elif mutation == 'currency':v['price']['currency'] = 'USD'
    elif mutation == 'price':v['price']['rates']['output_per_million'] += 1
    elif mutation == 'model':v['price']['model'] = 'other'
    e.evidence = lambda: v;calls=[]
    with httpx.Client(transport=TrialTransport(e, httpx.MockTransport(lambda r: calls.append(r)))) as client:
        with pytest.raises(TrialBlocked):client.post(TEXT_URL, json=payload(), headers={'Authorization':'Bearer '+KEY})
    assert not calls and g.daily.status()['used'] == 0 and g.summary()['state'] == 'stopped'


def test_two_voice_rounds_with_actual_adapters_keep_four_posts_and_no_replay(tmp_path, monkeypatch):
    from app.core.config import Settings
    from app.services.voice_reply import configured_reply
    from app.services import model_client, qwen_tts_candidate as tts
    g, now = setup(tmp_path);calls=[]
    b=BytesIO()
    with wave.open(b, 'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(b'\0\0'*24000)
    def respond(r):
        calls.append(r.method)
        if str(r.url) == TEXT_URL:return httpx.Response(200,json=text_result())
        if r.method == 'POST':return httpx.Response(200,json={'output':{'audio':{
            'url':'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.wav?signature=synthetic'}},'usage':{'characters':20}})
        return httpx.Response(200,content=b.getvalue())
    settings=Settings(_env_file=None,model_base_url=TEXT_URL.removesuffix('/chat/completions'),model_api_key=KEY,
                      chat_model='qwen3.8-flash',voice_live_reply_enabled=True,model_max_retries=0)
    for i in range(2):
        op='voice-round-000'+str(i)
        e=envelope(g,operation=op)
        monkeypatch.setattr(model_client,'model_http_client',lambda *a,**k:httpx.Client(
            transport=TrialTransport(e,httpx.MockTransport(respond))))
        reply=configured_reply(payload()['messages'],settings=settings)
        speech=envelope(g,'voice_tts',op)
        with httpx.Client(transport=httpx.MockTransport(lambda r: (_ for _ in ()).throw(AssertionError('unexpected host'))),
            mounts={'https://dashscope.aliyuncs.com':TrialTransport(speech,httpx.MockTransport(respond)),
                    'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com':httpx.MockTransport(respond)}) as c:
            assert tts.synthesize_text(KEY,reply,'Cherry',model=tts.FLASH_MODEL,client=c).wav == b.getvalue()
    assert calls.count('POST') == 4 and calls.count('GET') == 2
    assert g.summary()['reserved_micro'] == 2_400_000
    reopened=TrialGate(g.path,g.daily,clock=lambda:now[0])
    with pytest.raises(TrialBlocked):send(reopened,operation='voice-round-0000')
    with pytest.raises(TrialBlocked):send(reopened,operation='voice-round-0002')
    assert g.daily.status()['used'] == 4
    raw=g.path.read_bytes()
    assert KEY.encode() not in raw and '先歇一会儿'.encode() not in raw and b'https://' not in raw


@pytest.mark.parametrize('kind', ['private_life','shared_life'])
def test_life_real_adapter_envelope_and_window_caps_survive_midnight(tmp_path, kind):
    from app.living.life_provider import MaaSLifePlannerAdapter
    from app.living.life_planner import Prompt, SYSTEM
    from app.living.gathering_dialogue import MaaSDialogueAdapter
    g,now=setup(tmp_path,'life');calls=[]
    content=json.dumps({'activity':'rest','reason':'休息'}) if kind=='private_life' else json.dumps({'lines':[
        {'character_id':i,'text':'看看眼前的风景。','item_ids':[]} for i in [1,2]]})
    async def run(i,presence):
        e=envelope(g,kind,'life-call-000'+str(i),presence=presence)
        def respond(r):calls.append(1);return httpx.Response(200,json=text_result(content))
        transport=AsyncTrialTransport(e,httpx.MockTransport(respond))
        if kind=='private_life':await MaaSLifePlannerAdapter(KEY,transport=transport).plan(Prompt(SYSTEM,'{}'))
        else:await MaaSDialogueAdapter(KEY,transport=transport).exchange({})
    asyncio.run(run(0,'visible'));now[0]+=600
    asyncio.run(run(1,'away'));now[0]+=600
    asyncio.run(run(2,'away'));now[0]+=600
    with pytest.raises(Exception):asyncio.run(run(3,'away'))
    assert len(calls)==3 and g.summary()['counts'][kind]==3
    assert g.summary()['reserved_micro']==3*1_145_600


@pytest.mark.parametrize('case',['http','timeout','usage','incomplete','model','oversized'])
def test_first_failure_retains_reservation_and_stops_other_profiles(tmp_path,case,caplog):
    g,_=setup(tmp_path);calls=[]
    def handler(r):
        calls.append(1);v=text_result()
        if case=='timeout':raise httpx.ReadTimeout('SECRET_PROVIDER_DETAIL')
        if case=='usage':v.pop('usage')
        if case=='incomplete':v['choices'][0]['finish_reason']='length'
        if case=='model':v['model']='different'
        if case=='oversized':return httpx.Response(200,content=b'x'*(1024*1024+1))
        return httpx.Response(503 if case=='http' else 200,json=v)
    with httpx.Client(transport=TrialTransport(envelope(g),httpx.MockTransport(handler))) as c:
        with pytest.raises(TrialBlocked,match='dispatch_failed_no_retry'):
            c.post(TEXT_URL,json=payload(),headers={'Authorization':'Bearer '+KEY})
    with pytest.raises(TrialBlocked):send(g,operation='different-operation')
    assert calls==[1] and g.summary()['state']=='stopped' and g.summary()['reserved_micro']==1_145_600
    records = [r for r in caplog.records if r.msg == 'TRIAL_DISPATCH_FAILURE %s']
    assert len(records) == 1
    diagnostic = json.loads(records[0].args[0])
    expected = ('read_timeout' if case == 'timeout' else 'http_error' if case == 'http'
                else 'response_too_large' if case == 'oversized' else 'response_invalid')
    assert diagnostic['code'] == expected
    assert diagnostic['kind'] == 'voice_text' and diagnostic['vendor'] == 'maas'
    assert diagnostic['elapsed_ms'] >= 0
    assert diagnostic['http_status'] == (None if case == 'timeout' else 503 if case == 'http' else 200)
    assert set(diagnostic) == {'code', 'stage', 'kind', 'vendor', 'elapsed_ms', 'http_status'}
    assert 'SECRET_PROVIDER_DETAIL' not in caplog.text and KEY not in caplog.text


def test_crash_before_result_is_terminal_after_restart(tmp_path):
    g,now=setup(tmp_path)
    with g.single_dispatch():g.reserve('voice_text','owner','6','interrupted-call',b'{}',evidence(g,'voice_text'))
    reopened=TrialGate(g.path,g.daily,clock=lambda:now[0])
    with pytest.raises(TrialBlocked,match='interrupted_unknown'):send(reopened,operation='new-after-crash')
    assert reopened.summary()['unknown']==1 and reopened.summary()['state']=='stopped'
    assert reopened.summary()['reserved_micro']==1_145_600 and g.daily.status()['used']==1


@pytest.mark.parametrize('status', [401, 403, 429])
def test_provider_rejection_diagnostic_omits_response_body(tmp_path, caplog, status):
    g, _ = setup(tmp_path)
    calls = []
    def reject(request):
        calls.append(1)
        return httpx.Response(status, json={'message': 'SECRET_PROVIDER_BODY'})
    with httpx.Client(transport=TrialTransport(envelope(g), httpx.MockTransport(reject))) as client:
        with pytest.raises(TrialBlocked, match='dispatch_failed_no_retry'):
            client.post(TEXT_URL, json=payload(), headers={'Authorization': 'Bearer ' + KEY})
    diagnostic = json.loads(next(r.args[0] for r in caplog.records if r.msg == 'TRIAL_DISPATCH_FAILURE %s'))
    assert diagnostic['code'] == 'http_error' and diagnostic['http_status'] == status
    assert calls == [1] and g.summary()['state'] == 'stopped'
    assert 'SECRET_PROVIDER_BODY' not in caplog.text and KEY not in caplog.text


def test_connect_timeout_is_distinguished_from_provider_read_timeout(tmp_path, caplog):
    g, _ = setup(tmp_path)
    def timeout(request):
        raise httpx.ConnectTimeout('SECRET_CONNECTION_DETAIL')
    with httpx.Client(transport=TrialTransport(envelope(g), httpx.MockTransport(timeout))) as client:
        with pytest.raises(TrialBlocked, match='dispatch_failed_no_retry'):
            client.post(TEXT_URL, json=payload(), headers={'Authorization': 'Bearer ' + KEY})
    diagnostic = json.loads(next(r.args[0] for r in caplog.records if r.msg == 'TRIAL_DISPATCH_FAILURE %s'))
    assert diagnostic['code'] == 'connect_timeout' and diagnostic['http_status'] is None
    assert g.daily.status()['used'] == 1 and g.summary()['state'] == 'stopped'
    assert 'SECRET_CONNECTION_DETAIL' not in caplog.text


def test_tts_timeout_keeps_successful_text_and_stops_without_retry(tmp_path, caplog):
    g, _ = setup(tmp_path)
    send(g)
    calls = []
    def timeout(request):
        calls.append(1)
        raise httpx.ReadTimeout('SECRET_TTS_DETAIL')
    with httpx.Client(transport=TrialTransport(envelope(g, 'voice_tts'), httpx.MockTransport(timeout))) as client:
        with pytest.raises(TrialBlocked, match='dispatch_failed_no_retry'):
            client.post(TTS_URL, json={'model': 'qwen3-tts-flash', 'input': {
                'text': '合成演练。', 'voice': 'Cherry', 'language_type': 'Chinese',
            }}, headers={'Authorization': 'Bearer ' + KEY})
    diagnostic = json.loads(next(r.args[0] for r in caplog.records if r.msg == 'TRIAL_DISPATCH_FAILURE %s'))
    assert diagnostic['kind'] == 'voice_tts' and diagnostic['vendor'] == 'bailian'
    assert diagnostic['code'] == 'read_timeout'
    assert calls == [1] and g.summary()['counts'] == {'voice_text': 1, 'voice_tts': 1}
    assert g.summary()['state'] == 'stopped' and g.summary()['reserved_micro'] == 1_200_000
    assert 'SECRET_TTS_DETAIL' not in caplog.text and KEY not in caplog.text


def test_concurrent_claims_share_one_durable_intent_and_global_daily_quota(tmp_path):
    g,_=setup(tmp_path)
    def worker(_):
        try:return send(g)
        except TrialBlocked:return []
    with ThreadPoolExecutor(max_workers=4) as pool:results=list(pool.map(worker,range(4)))
    assert sum(len(x) for x in results)==1 and g.daily.status()['used']==1


def test_existing_daily_limit_cannot_be_bypassed_and_reservation_is_retained(tmp_path):
    g,_=setup(tmp_path)
    for _ in range(30):g.daily.reserve()
    with pytest.raises(TrialBlocked,match='daily_guard_blocked'):send(g)
    assert g.summary()['reserved_micro']==1_145_600 and g.summary()['state']=='stopped'
    assert g.daily.status()['used']==30


@pytest.mark.parametrize('case',['owner','subject','model','tokens','endpoint','key','get'])
def test_scope_or_request_tampering_rejected_before_provider(tmp_path,case):
    g,_=setup(tmp_path);e=envelope(g);v=payload();url=TEXT_URL;key=KEY;calls=[]
    if case=='owner':e.owner='other'
    if case=='subject':e.subject='7'
    if case=='model':v['model']='different'
    if case=='tokens':v['max_tokens']=2048
    if case=='endpoint':url=TEXT_URL+'?override=1'
    if case=='key':key='different-key'
    with httpx.Client(transport=TrialTransport(e,httpx.MockTransport(lambda r:calls.append(r)))) as c:
        with pytest.raises(TrialBlocked):
            if case=='get':c.get(url,headers={'Authorization':'Bearer '+key})
            else:c.post(url,json=v,headers={'Authorization':'Bearer '+key})
    assert not calls and g.daily.status()['used']==0


def test_expiration_pause_interval_and_presence_limits_do_not_create_more_calls(tmp_path):
    g,now=setup(tmp_path,'life');r=text_result(json.dumps({'activity':'rest','reason':'休息'}))
    send(g,'private_life',response=r)
    with pytest.raises(TrialBlocked,match='minimum_interval'):send(g,'private_life','next-away-0001',response=r,presence='away')
    now[0]+=600
    with pytest.raises(TrialBlocked,match='presence_count_exhausted'):send(g,'private_life','next-visible-01',response=r)
    now[0]=g.policy['ends_at']
    with pytest.raises(TrialBlocked,match='outside_window'):send(g,'shared_life','past-deadline-01',response=r)
    assert g.summary()['attempts']==1
    with pytest.raises(TrialBlocked):g.stop()
    assert g.summary()['state']=='stopped'


def test_optimized_python_is_fail_closed():
    result=subprocess.run([sys.executable,'-O','-c','import app.services.trial_gate'],capture_output=True,text=True)
    assert result.returncode!=0 and 'trial_guards_require_unoptimized_python' in result.stderr


def test_all_six_life_intents_share_window_budget_and_stop_is_persistent(tmp_path):
    g,now=setup(tmp_path,'life')
    for i in range(3):
        for kind in ['private_life','shared_life']:
            with g.single_dispatch():
                g.reserve(kind,'owner',kind,'six-window-'+kind+str(i),b'{}',evidence(g,kind),
                          presence='visible' if i==0 else 'away')
                g.finish('six-window-'+kind+str(i),kind,True,200)
        now[0]+=600
    assert g.summary()['attempts']==6 and g.summary()['reserved_micro']==6_873_600
    with pytest.raises(TrialBlocked):g.stop()
    reloaded=TrialGate(g.path,g.daily,clock=lambda:now[0])
    with pytest.raises(TrialBlocked):send(reloaded,'private_life','after-stop-0001',presence='away')
    assert reloaded.summary()==g.summary() and g.daily.status()['used']==4
    with g.daily.connection() as db:
        assert db.execute('SELECT count(*) FROM model_attempts').fetchone()[0]==6


def test_low_window_budget_and_unavailable_evidence_fail_closed(tmp_path):
    g,_=setup(tmp_path,budget=1)
    with pytest.raises(TrialBlocked,match='window_budget_exhausted'):send(g)
    assert g.summary()['attempts']==0


def test_evidence_reader_failure_stops_without_attempt(tmp_path):
    g,_=setup(tmp_path);e=envelope(g)
    def fail():raise ValueError('sensitive detail')
    e.evidence=fail
    with httpx.Client(transport=TrialTransport(e,httpx.MockTransport(lambda r:None))) as c:
        with pytest.raises(TrialBlocked,match='evidence_unavailable'):
            c.post(TEXT_URL,json=payload(),headers={'Authorization':'Bearer '+KEY})
    assert g.summary()['state']=='stopped' and g.summary()['attempts']==0


def test_independent_process_cannot_replay_a_saved_post(tmp_path):
    g,now=setup(tmp_path);send(g)
    code='''import json,socket,sys
from pathlib import Path
from app.services.trial_gate import TrialGate,TrialBlocked
from app.services.daily_model_quota import DailyModelQuota
def deny(*a,**k):raise AssertionError('NETWORK_FORBIDDEN')
socket.socket.connect=deny;socket.socket.connect_ex=deny
clock=lambda:int(sys.argv[3])
g=TrialGate(Path(sys.argv[1]),DailyModelQuota(Path(sys.argv[2]),30,clock=clock),clock=clock)
try:
 with g.single_dispatch():g.reserve('voice_text','owner','6','operation-0001',b'{}',{})
except TrialBlocked as e:print(json.dumps({'code':str(e),'summary':g.summary()}))
'''
    child=subprocess.run([sys.executable,'-c',code,str(g.path),str(g.daily.path),str(now[0])],
                         capture_output=True,text=True,timeout=20)
    assert child.returncode==0,child.stderr
    assert json.loads(child.stdout)['code']=='already_attempted'
    assert json.loads(child.stdout)['summary']['attempts']==1


def test_new_call_deducts_all_retained_reserves_even_with_fresh_wallet_evidence(tmp_path):
    g,_=setup(tmp_path);send(g)
    e=envelope(g,operation='new-operation-0002')
    v=evidence(g,'voice_text');v['wallet']['available_micro']=1_200_000;e.evidence=lambda:v
    with httpx.Client(transport=TrialTransport(e,httpx.MockTransport(lambda r:None))) as c:
        with pytest.raises(TrialBlocked,match='funds_or_price_unverified'):
            c.post(TEXT_URL,json=payload(),headers={'Authorization':'Bearer '+KEY})
    assert g.summary()['attempts']==1 and g.summary()['reserved_micro']==1_145_600
