import asyncio
import gzip
import json
import socket
import sqlite3

import httpx
import pytest

from scripts import run_acceptance_life as soak


@pytest.fixture
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(soak,'PROJECT',tmp_path)
    monkeypatch.setattr(soak,'ROOT',tmp_path/'.runtime/acceptance/life')
    source=tmp_path/'.runtime/c160-review';source.mkdir(parents=True)
    with sqlite3.connect(source/'check.db') as db:
        db.execute('CREATE TABLE characters(id INTEGER,name TEXT,persona TEXT,opening_line TEXT,status TEXT)')
        db.executemany('INSERT INTO characters VALUES (?,?,?,?,?)',
            [(3,'合成杯','合成设定','合成开场','ready'),(4,'合成苹果','合成设定','合成开场','ready')])
    monkeypatch.setattr(socket.socket,'connect',lambda *_:(_ for _ in ()).throw(AssertionError('No real network in tests')))
    return tmp_path


def grant(ledger):
    (ledger.root/'authorization.json').write_text(json.dumps(dict(authorization_ref=soak.REF,budget_cny=3,
        requests_max=2,automatic_retries=0,confirmed=True,user_reply='合成测试',
        target_root=str(ledger.root.resolve()),endpoint=soak.ENDPOINT,purpose_limits={'private':1,'shared':1})))


def request():
    return httpx.Request('POST',soak.ENDPOINT+'/chat/completions',json=dict(
        model='qwen3.8-flash',max_tokens=512,stream=False,messages=[]))


def test_prepare_has_no_calls_or_implicit_authorization(isolated):
    assert soak.prepare()['provider_requests']==0
    ledger=soak.budget(soak.ROOT)
    with pytest.raises(FileNotFoundError):ledger.approval()
    assert ledger.status()['requests']==0


def test_restart_preserves_original_deadline_and_closing_caps(isolated):
    soak.prepare();ledger=soak.budget(soak.ROOT);grant(ledger)
    runtime,store=soak.previous.kernel(soak.ROOT)
    state=json.loads((soak.ROOT/'state.json').read_text())
    soak.start(runtime,store,state,ledger)
    deadline=state['deadline'];grant_id=state['shared_grant']
    assert deadline-state['started_at']==86400
    before=soak.previous.facts(runtime,store,state)
    runtime.engine.dispose()
    runtime,store=soak.previous.kernel(soak.ROOT)
    state=json.loads((soak.ROOT/'state.json').read_text());soak.start(runtime,store,state,ledger)
    state['status']='interrupted'
    soak.start(runtime,store,state,ledger)
    assert state['status']=='running'
    assert state['deadline']==deadline and state['shared_grant']==grant_id
    after=soak.previous.facts(runtime,store,state)
    assert before['private_event_sha256']==after['private_event_sha256']
    assert before['shared_event_sha256']==after['shared_event_sha256']
    soak.close(runtime,store,state)
    assert state['shared_returned_home']
    assert not runtime.snapshot(soak.OWNER,state['sid']).automatic.enabled
    assert not store.status(soak.OWNER,state['gid'])['enabled']
    runtime.engine.dispose()


def test_one_each_and_double_decode_regression(isolated):
    soak.prepare();ledger=soak.budget(soak.ROOT);grant(ledger)
    seen=[]
    body=json.dumps({'model':'qwen3.8-flash','choices':[],'usage':{'prompt_tokens':1}}).encode()
    async def handler(req):
        assert ledger.status()['paused']
        seen.append(req)
        return httpx.Response(200,headers={'content-encoding':'gzip'},content=gzip.compress(body))
    transport=soak.Transport(ledger,'private',httpx.MockTransport(handler))
    response=asyncio.run(transport.handle_async_request(request()))
    assert response.content==body and 'content-encoding' not in response.headers
    with pytest.raises(ValueError,match='purpose_exhausted'):
        asyncio.run(transport.handle_async_request(request()))
    response=asyncio.run(soak.Transport(ledger,'shared',httpx.MockTransport(handler)).handle_async_request(request()))
    assert ledger.status()['requests']==2 and ledger.status()['reserved_cny']==2.2912
    assert len(seen)==2 and len(list((soak.ROOT/'provider-responses').glob('*.json')))==2


def test_timeout_and_business_stop_survive_reopen(isolated):
    soak.prepare();ledger=soak.budget(soak.ROOT);grant(ledger)
    async def handler(req):raise httpx.ReadTimeout('synthetic')
    with pytest.raises(httpx.ReadTimeout):
        asyncio.run(soak.Transport(ledger,'private',httpx.MockTransport(handler)).handle_async_request(request()))
    reopened=soak.budget(soak.ROOT)
    with pytest.raises(ValueError,match='requires_review'):reopened.claim('qwen3.8-flash',purpose='shared')
    assert reopened.status()['reserved_cny']==1.1456
    reopened.stop('business_failure')
    assert soak.budget(soak.ROOT).status()['paused']


def test_wrong_scope_or_modified_grant_sends_nothing(isolated):
    soak.prepare();ledger=soak.budget(soak.ROOT);grant(ledger)
    with pytest.raises(ValueError,match='explicit_purpose'):ledger.claim('qwen3.8-flash')
    with pytest.raises(ValueError,match='unsupported_purpose'):ledger.claim('wan2.6-t2i',purpose='private')
    call=ledger.claim('qwen3.8-flash',purpose='private');ledger.settle(call,'succeeded',200)
    path=ledger.root/'authorization.json';value=json.loads(path.read_text());value['user_reply']='changed';path.write_text(json.dumps(value))
    assert not ledger.status()['authorized']
    with pytest.raises(ValueError,match='authorization_changed'):ledger.claim('qwen3.8-flash',purpose='shared')


def test_business_decode_failure_stops_shared_even_after_http200(isolated,monkeypatch):
    soak.prepare();ledger=soak.budget(soak.ROOT);grant(ledger)
    runtime,store=soak.previous.kernel(soak.ROOT)
    state=json.loads((soak.ROOT/'state.json').read_text());soak.start(runtime,store,state,ledger)
    seen=[]
    async def handler(req):
        seen.append(req)
        return httpx.Response(200,json={'model':'qwen3.8-flash','choices':[{
            'finish_reason':'stop','message':{'content':'synthetic invalid JSON'}}]})
    transport=soak.Transport
    monkeypatch.setattr(soak,'Transport',lambda budget,purpose:transport(budget,purpose,httpx.MockTransport(handler)))
    original=soak.previous.run_real_planner
    async def catalog():return {'model':'qwen3.8-flash','reserve_micro':soak.previous.RESERVE_MICRO}
    async def checked(*args):return await original(*args,catalog)
    monkeypatch.setattr(soak.previous,'run_real_planner',checked)
    async def unexpected(*_):pytest.fail('No shared dispatch after failed private decode')
    monkeypatch.setattr(soak.previous,'shared_tick',unexpected)
    asyncio.run(soak.tick(runtime,store,state,'synthetic-test-key',ledger))
    assert len(seen)==1 and ledger.status()['requests']==1 and ledger.status()['paused']
    assert not soak.previous.facts(runtime,store,state)['private_events']
    assert not runtime.snapshot(soak.OWNER,state['sid']).automatic.enabled
    assert not store.status(soak.OWNER,state['gid'])['enabled']
    runtime.engine.dispose()


def test_launch_marker_prevents_race_before_child_lock(isolated,monkeypatch):
    soak.prepare();ledger=soak.budget(soak.ROOT);grant(ledger)
    spawned=[]
    class Process:pid=42
    def popen(*args,**kwargs):spawned.append(args);return Process()
    monkeypatch.setattr(soak.subprocess,'Popen',popen)
    assert soak.launch()['pid']==42
    with pytest.raises(FileExistsError):soak.launch()
    assert len(spawned)==1 and ledger.status()['requests']==0


def test_restart_refuses_unfinished_dispatch_and_wrong_process(isolated,monkeypatch):
    monkeypatch.setattr(soak,'status',lambda:dict(status='running',process_lock_held=True,
        budget={'requests':1,'paused':False},paid_dispatch_finished=False))
    with pytest.raises(ValueError,match='finished paid dispatch'):soak.restart()
    soak.ROOT.mkdir(parents=True)
    (soak.ROOT/'process.json').write_text(json.dumps({'pid':42}))
    monkeypatch.setattr(soak,'status',lambda:dict(status='running',process_lock_held=True,
        budget={'requests':2,'paused':False},paid_dispatch_finished=True))
    monkeypatch.setattr(soak.subprocess,'check_output',lambda *_args,**_kw:'other process')
    monkeypatch.setattr(soak.os,'killpg',lambda *_:pytest.fail('Must not stop another process'))
    with pytest.raises(ValueError,match='identity changed'):soak.restart()
