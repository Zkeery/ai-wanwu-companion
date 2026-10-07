import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from scripts.real_web_budget import Budget, REF, install

ENDPOINT = 'https://maas-api.antdigital.com/v1'


def grant(root):
    value = dict(authorization_ref=REF, budget_cny=5, requests_max=12, automatic_retries=0,
                 confirmed=True, user_reply='合成测试许可', target_root=str(root.resolve()), endpoint=ENDPOINT)
    (root/'authorization.json').write_text(json.dumps(value))


@pytest.fixture
def budget(tmp_path):
    value = Budget(tmp_path, ENDPOINT)
    original = install(value)
    try:
        yield value
    finally:
        httpx.Client.send = original


def post(client, *, model='qwen3.8-flash', **extras):
    payload = dict(model=model, messages=[dict(role='user', content='你好')], **extras)
    return client.post(ENDPOINT+'/chat/completions', json=payload)


def test_no_authorization_sends_nothing(budget):
    calls=[]
    with httpx.Client(transport=httpx.MockTransport(lambda r: calls.append(r))) as client:
        with pytest.raises(httpx.RequestError):
            post(client)
    assert calls == [] and budget.status()['requests'] == 0


def test_cost_limit_persists_and_changed_approval_rejected(budget):
    grant(budget.root)
    received=[]
    def handler(request):
        received.append(json.loads(request.content))
        return httpx.Response(200, json={'choices':[]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        for _ in range(4):
            assert post(client).status_code == 200
        with pytest.raises(httpx.RequestError):
            post(client)
        assert all(p['max_tokens']==8192 for p in received)
        assert Budget(budget.root, ENDPOINT).status()['reserved_cny'] == 4.5824
        path=budget.root/'authorization.json'
        value=json.loads(path.read_text());value['user_reply']='changed'
        path.write_text(json.dumps(value))
        with pytest.raises(httpx.RequestError):
            post(client, model='ling-3.0-flash-vl')
    assert len(received)==4


def test_count_cap_and_unknown_request_survive_restart(budget):
    grant(budget.root)
    for _ in range(12):
        call=budget.claim('wan2.6-t2i');budget.settle(call,'succeeded',200)
    with pytest.raises(ValueError, match='budget_exhausted'):
        budget.claim('wan2.6-t2i')
    assert budget.status()['requests']==12


def test_concurrent_reservations_block_duplicate_inflight(budget):
    grant(budget.root)
    def claim(_):
        try: return budget.claim('qwen3.8-flash')
        except ValueError: return None
    with ThreadPoolExecutor(max_workers=8) as pool:
        result=list(pool.map(claim,range(8)))
    assert sum(r is not None for r in result)==1
    reopened=Budget(budget.root,ENDPOINT)
    assert reopened.status()['paused'] and reopened.status()['reserved_cny']==1.1456
    with pytest.raises(ValueError,match='requires_review'):
        reopened.claim('wan2.6-t2i')


@pytest.mark.parametrize('error', [False,True])
def test_stream_done_or_disconnect(budget,error):
    grant(budget.root)
    class Stream(httpx.SyncByteStream):
        def __iter__(self):
            yield b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
            if error: raise httpx.ReadError('synthetic disconnect')
            yield b'data: [DO'
            yield b'NE]\n\n'
    def handler(request):
        return httpx.Response(200,stream=Stream())
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        if error:
            with pytest.raises(httpx.ReadError):
                with client.stream('POST',ENDPOINT+'/chat/completions',json=dict(model='qwen3.8-flash',
                    messages=[dict(role='user',content='hello')],stream=True)) as response:
                    list(response.iter_bytes())
        else:
            with client.stream('POST',ENDPOINT+'/chat/completions',json=dict(model='qwen3.8-flash',
                messages=[dict(role='user',content='hello')],stream=True)) as response:
                assert b'[DONE]' in b''.join(response.iter_bytes())
    assert budget.status()['paused'] is error
    assert budget.status()['requests']==1


@pytest.mark.parametrize('payload,url', [
    ({'model':'other'},ENDPOINT+'/chat/completions'),
    ({'model':'qwen3.8-flash','messages':[],'max_tokens':8193},ENDPOINT+'/chat/completions'),
    ({'model':'wan2.6-t2i','n':2,'size':'1024x1024'},ENDPOINT+'/images/generations'),
    ({'model':'qwen3.8-flash','messages':[]},'https://invalid.example/chat/completions')])
def test_unsupported_scope_never_posts(budget,payload,url):
    grant(budget.root)
    calls=[]
    with httpx.Client(transport=httpx.MockTransport(lambda r:calls.append(r))) as client:
        with pytest.raises(httpx.RequestError):client.post(url,json=payload)
    assert not calls and budget.status()['requests']==0


def test_timeout_reserve_is_not_returned(budget):
    grant(budget.root)
    def handler(request):raise httpx.ReadTimeout('synthetic timeout',request=request)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(httpx.ReadTimeout):post(client)
        with pytest.raises(httpx.RequestError):post(client)
    assert budget.status()['requests']==1 and budget.status()['paused']


def test_authorized_missing_ledger_cannot_reset_budget(budget):
    grant(budget.root)
    call=budget.claim('qwen3.8-flash');budget.settle(call,'succeeded',200)
    budget.path.unlink()
    with pytest.raises(sqlite3.OperationalError):budget.claim('qwen3.8-flash')
    assert not budget.path.exists()
    with pytest.raises(ValueError,match='authorized_ledger_missing'):
        Budget(budget.root,budget.endpoint)
    assert not budget.path.exists()
