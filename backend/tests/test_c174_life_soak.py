"""No-network checks for paid-call idempotence and persistent 24h deadlines."""
import asyncio
import gzip
import json
import sqlite3

import httpx
import pytest

from scripts import c174_batch as batch
from scripts import run_c174_life_soak as soak


@pytest.fixture
def isolated(tmp_path,monkeypatch):
    monkeypatch.setattr(batch,'PROJECT',tmp_path)
    monkeypatch.setattr(batch,'WORK',tmp_path/'batch')
    monkeypatch.setattr(batch,'authorization',lambda:{'authorization_ref':'synthetic-c174-life',
        'approved_on':'2026-10-01','plan_sha256':'synthetic-plan'})
    batch.initialize()
    monkeypatch.setattr(soak,'ROOT',batch.WORK/'life')
    source=tmp_path/'.runtime/c160-review';source.mkdir(parents=True)
    with sqlite3.connect(source/'check.db') as db:
        db.execute('CREATE TABLE characters(id INTEGER,name TEXT,persona TEXT,opening_line TEXT,status TEXT)')
        db.executemany('INSERT INTO characters VALUES (?,?,?,?,?)',
            [(3,'合成杯','合成设定','合成开场','ready'),(4,'合成苹果','合成设定','合成开场','ready')])
    return tmp_path


def request():
    return httpx.Request('POST',batch.BASE+'/chat/completions',json={
        'model':'qwen3.8-flash','max_tokens':512,'stream':False,'messages':[]})


def test_guard_claims_before_post_and_replay_never_posts_twice(isolated):
    seen=[]
    async def handler(req):
        assert batch.status()['in_flight']==1
        seen.append(req)
        return httpx.Response(200,json={'id':'synthetic-upstream','usage':{'prompt_tokens':10,'completion_tokens':2}})
    transport=soak.GuardedTransport('private','one-task',httpx.MockTransport(handler))
    asyncio.run(transport.handle_async_request(request()))
    with pytest.raises(sqlite3.IntegrityError): asyncio.run(transport.handle_async_request(request()))
    assert len(seen)==1
    assert batch.status()['reserved_cny']==1.1456


def test_timeout_retains_reservation_and_pauses_both_life_kinds(isolated):
    async def handler(req): raise httpx.ReadTimeout('synthetic')
    transport=soak.GuardedTransport('private','one-task',httpx.MockTransport(handler))
    with pytest.raises(httpx.ReadTimeout): asyncio.run(transport.handle_async_request(request()))
    with pytest.raises(ValueError,match='unresolved'): batch.claim('shared','new-task')
    assert batch.status()['unknown_results']==1
    assert batch.status()['reserved_cny']==1.1456


def test_gzipped_reply_is_decoded_once_and_keeps_real_reply_bytes(isolated):
    body=json.dumps({'model':'qwen3.8-flash','choices':[],'usage':{'prompt_tokens':1}}).encode()
    async def handler(req):
        return httpx.Response(200,headers={'content-encoding':'gzip'},content=gzip.compress(body))
    transport=soak.GuardedTransport('private','gzipped-task',httpx.MockTransport(handler))
    response=asyncio.run(transport.handle_async_request(request()))
    assert response.content==body
    assert 'content-encoding' not in response.headers
    assert len(list((batch.WORK/'provider-responses').glob('*.json')))==1
    assert batch.status()['unknown_results']==0


def test_seed_restart_retains_original_deadline_grant_and_events(isolated):
    soak.prepare()
    runtime,store=soak.kernel(soak.ROOT)
    state=json.loads((soak.ROOT/'state.json').read_text())
    soak.start(runtime,store,state)
    before=(state['started_at'],state['deadline'],state['shared_grant'])
    assert before[1]-before[0]==86400
    assert batch.status()['provider_requests']==0
    events=soak.facts(runtime,store,state)
    runtime.engine.dispose()
    runtime,store=soak.kernel(soak.ROOT)
    saved=json.loads((soak.ROOT/'state.json').read_text())
    soak.start(runtime,store,saved)
    assert (saved['started_at'],saved['deadline'],saved['shared_grant'])==before
    assert soak.facts(runtime,store,saved)['private_event_sha256']==events['private_event_sha256']
    soak.stop_policies(runtime,store,saved,final=True)
    assert saved['shared_returned_home']
    assert not runtime.snapshot(soak.OWNER,saved['sid']).automatic.enabled
    assert not store.status(soak.OWNER,saved['gid'])['enabled']
    runtime.engine.dispose()


def test_missing_database_cannot_be_recreated_on_resume(isolated):
    soak.ROOT.mkdir()
    with pytest.raises(ValueError,match='must exist'): soak.kernel(soak.ROOT)
    assert not (soak.ROOT/'life.db').exists()


def test_repair_continues_only_unspent_rounds_without_requeuing_failure(isolated):
    soak.prepare()
    runtime,store=soak.kernel(soak.ROOT)
    state=json.loads((soak.ROOT/'state.json').read_text());soak.start(runtime,store,state)
    task=store.claim_next();store.dispatch(task['id']);store.finish_failure(task['id'],'invalid_response')
    call=batch.claim('shared','shared:'+task['id']);batch.settle(call,'succeeded',{})
    stopped=store.status(soak.OWNER,state['gid'])
    assert not stopped['enabled']
    due=stopped['next_at'];runtime.engine.dispose()
    soak.resume_unspent_shared()
    runtime,store=soak.kernel(soak.ROOT)
    current=store.status(soak.OWNER,state['gid'])
    assert current['authorization']['max_rounds']==3
    assert current['next_at']==due and current['today_count']==1
    assert store.read(soak.OWNER,state['gid'])['tasks'][0]['state']=='failed'
    assert batch.status()['counts']['shared']==1
    with pytest.raises(ValueError): soak.resume_unspent_shared()
    runtime.engine.dispose()
