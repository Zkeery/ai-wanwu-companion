"""C1.5 HTTP and pilot contracts. No external socket or real credentials."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import subprocess
import sys
from types import SimpleNamespace

import httpx
import pytest

from app.living import life_provider as provider
from app.living.life_planner import Prompt, SYSTEM
from app.living.rules import LivingError
from scripts import life_planner_pilot as pilot


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError('C1.5 tests forbid external network')
    monkeypatch.setattr('socket.socket.connect', fail)


def response(content=None):
    return {'model': provider.MODEL, 'choices': [{'finish_reason': 'stop', 'message':
        {'role': 'assistant', 'content': content or json.dumps({'activity': 'rest', 'reason': '休息'})}}],
        'usage': {'prompt_tokens': 500, 'completion_tokens': 50, 'total_tokens': 550}}


def catalog():
    return {'success': True, 'data': {'items': [{'name': provider.MODEL, 'status': 'RELEASED',
        'contextLength': '1000000', 'maxCompletionTokens': 128000, 'offShelfFlag': 0, 'offShelfDate': None,
        'updatedTime': '2026-09-22 15:25:56', 'priceInfo': {'prices': [{'priceCurrency': 'CNY', 'price': [
            {'priceCode': 'INPUT', 'unitCode': 'M_TOKENS', 'priceValue': '0.8'},
            {'priceCode': 'OUTPUT', 'unitCode': 'M_TOKENS', 'priceValue': '2.7'}]}]}}]}}


def test_http_contract_and_no_offline_worker_interface():
    calls = []
    def handler(request):
        assert str(request.url) == provider.BASE_URL + '/chat/completions'
        assert request.headers['authorization'] == 'Bearer synthetic-test-key'
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=response())
    adapter = provider.MaaSPlannerAdapter('synthetic-test-key', transport=httpx.MockTransport(handler))
    result = asyncio.run(adapter.plan(Prompt(SYSTEM, '{}')))
    assert not hasattr(adapter, 'complete')
    assert len(calls) == 1
    assert set(calls[0]) == {'model', 'stream', 'max_tokens', 'messages'}
    assert calls[0]['stream'] is False and calls[0]['max_tokens'] == 512
    assert result.estimated_micro == 535 and result.candidate['activity'] == 'rest'


@pytest.mark.parametrize('status', [301, 302, 400, 401, 429, 500, 503])
def test_errors_never_redirect_retry_or_leak_body(status):
    count = []
    def handler(request):
        count.append(1)
        return httpx.Response(status, text='PRIVATE_CREDENTIAL', headers={'Location': 'https://outside.invalid/'})
    adapter = provider.MaaSPlannerAdapter('synthetic-key', transport=httpx.MockTransport(handler))
    with pytest.raises(LivingError) as error:
        asyncio.run(adapter.plan(Prompt(SYSTEM, '{}')))
    assert len(count) == 1 and 'PRIVATE' not in str(error.value)
    assert error.value.code == f'provider_http_{status}'


def test_transport_timeout_is_sanitized_and_not_retried():
    count = []
    def handler(request):
        count.append(1)
        raise httpx.ReadTimeout('PRIVATE_KEY', request=request)
    with pytest.raises(LivingError) as error:
        asyncio.run(provider.MaaSPlannerAdapter('synthetic-key', transport=httpx.MockTransport(handler)).plan(Prompt(SYSTEM, '{}')))
    assert count == [1] and 'PRIVATE_KEY' not in str(error.value)
    assert error.value.code == 'provider_read_timeout'


@pytest.mark.parametrize('exception,code', [
    (httpx.ConnectTimeout, 'provider_connect_timeout'),
    (httpx.WriteTimeout, 'provider_write_timeout'),
    (httpx.PoolTimeout, 'provider_pool_timeout'),
    (httpx.ConnectError, 'provider_connect_error'),
    (httpx.RemoteProtocolError, 'provider_transport_error'),
    (TimeoutError, 'provider_deadline'),
])
def test_transport_diagnostics_are_specific_without_leaking_details(exception, code):
    def handler(request):
        raise exception('PRIVATE_CREDENTIAL')
    with pytest.raises(LivingError) as error:
        asyncio.run(provider.MaaSPlannerAdapter('synthetic-key', transport=httpx.MockTransport(handler)).plan(Prompt(SYSTEM, '{}')))
    assert error.value.code == code and 'PRIVATE' not in str(error.value)


@pytest.mark.parametrize('kind', ['model', 'choices', 'length', 'filter', 'role', 'tool', 'refusal', 'content', 'bool_usage', 'negative_usage', 'sum_usage', 'large_usage'])
def test_response_contract_rejects_invalid_envelopes(kind):
    data = response()
    message, choice = data['choices'][0]['message'], data['choices'][0]
    if kind == 'model': data['model'] = 'unexpected-model'
    if kind == 'choices': data['choices'].append(copy.deepcopy(choice))
    if kind == 'length': choice['finish_reason'] = 'length'
    if kind == 'filter': choice['finish_reason'] = 'content_filter'
    if kind == 'role': message['role'] = 'user'
    if kind == 'tool': message['tool_calls'] = [{'name': 'delete'}]
    if kind == 'refusal': message['refusal'] = 'refused'
    if kind == 'content': message['content'] = '{}'
    if kind == 'bool_usage': data['usage']['prompt_tokens'] = True
    if kind == 'negative_usage': data['usage']['completion_tokens'] = -1
    if kind == 'sum_usage': data['usage']['total_tokens'] = 1
    if kind == 'large_usage': data['usage'] = {'prompt_tokens': 0, 'completion_tokens': 128001, 'total_tokens': 128001}
    with pytest.raises(LivingError):
        provider.decode_reply(json.dumps(data).encode())


@pytest.mark.parametrize('body', [b'[]', b'null', b'{"model":"a","model":"b"}', b'{"a":NaN}', b' ' * 65537])
def test_body_limits_and_duplicate_keys(body):
    with pytest.raises(LivingError): provider.decode_reply(body)


def test_oversized_stream_is_rejected():
    adapter = provider.MaaSPlannerAdapter('synthetic-key', transport=httpx.MockTransport(
        lambda _: httpx.Response(200, content=b'x' * 65537)))
    with pytest.raises(LivingError): asyncio.run(adapter.plan(Prompt(SYSTEM, '{}')))


def test_missing_usage_does_not_fabricate_zero_cost():
    data = response(); del data['usage']
    reply = provider.decode_reply(json.dumps(data).encode())
    assert reply.usage is None and reply.estimated_micro is None


def test_oversized_prompt_rejected_before_http():
    adapter = provider.MaaSPlannerAdapter('synthetic-key', transport=httpx.MockTransport(
        lambda _: pytest.fail('oversized input was dispatched')))
    with pytest.raises(LivingError): asyncio.run(adapter.plan(Prompt(SYSTEM, 'x' * 16385)))


def test_cancelled_request_stays_cancelled():
    async def scenario():
        started = asyncio.Event()
        async def handler(request):
            started.set()
            await asyncio.Event().wait()
        adapter = provider.MaaSPlannerAdapter('synthetic-key', transport=httpx.MockTransport(handler))
        task = asyncio.create_task(adapter.plan(Prompt(SYSTEM, '{}')))
        await started.wait(); task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
    asyncio.run(scenario())


def test_price_ceiling_and_budget_math():
    assert provider.verify_catalog(catalog())['reserve_micro'] == 1145600
    assert pilot.manifest()['total_reserved_micro'] == 3436800 < pilot.CAP_MICRO


@pytest.mark.parametrize('change', ['price', 'unit', 'currency', 'off_shelf', 'status', 'input_limit', 'output_limit', 'missing', 'nan', 'negative', 'duplicate'])
def test_changed_catalog_stops_before_dispatch(change):
    data = catalog(); model = data['data']['items'][0]; tier = model['priceInfo']['prices'][0]
    if change == 'price': tier['price'][1]['priceValue'] = '2.8'
    if change == 'unit': tier['price'][0]['unitCode'] = 'K_TOKENS'
    if change == 'currency': tier['priceCurrency'] = 'USD'
    if change == 'off_shelf': model['offShelfFlag'] = 1
    if change == 'status': model['status'] = 'OFFLINE'
    if change == 'input_limit': model['contextLength'] = '1000001'
    if change == 'output_limit': model['maxCompletionTokens'] = 128001
    if change == 'missing': tier['price'] = []
    if change == 'nan': tier['price'][0]['priceValue'] = 'NaN'
    if change == 'negative': tier['price'][0]['priceValue'] = '-1'
    if change == 'duplicate': data['data']['items'].append(copy.deepcopy(model))
    with pytest.raises(LivingError) as error: provider.verify_catalog(data)
    assert error.value.code == 'pricing_unverified'


def ledger(tmp_path):
    return pilot.PilotLedger(tmp_path / 'pilot.db', 'synthetic-offline-authorization', origin='offline_contract')


class Adapter:
    def __init__(self, fail=False): self.calls = []; self.fail = fail
    async def plan(self, prompt):
        self.calls.append(prompt)
        if self.fail: raise RuntimeError('PRIVATE_CREDENTIAL')
        data = json.loads(prompt.user); activity = data['allowed_activities'][0]
        candidate = {'activity': activity, 'target_id': data['visible_items'][0]['id'] if activity == 'observe' else None, 'reason': '离线合同样例'}
        return provider.decode_reply(json.dumps(response(json.dumps(candidate))).encode())


def test_three_readonly_cases_and_replay_make_no_additional_calls(tmp_path):
    book, adapter = ledger(tmp_path), Adapter()
    report = asyncio.run(pilot.run_batch(book, adapter))
    assert len(adapter.calls) == 3 and report['reserved_micro'] == 3436800
    assert report['origin'] == 'offline_contract'
    assert all(r['state'] == 'passed' for r in report['attempts'])
    reopened = ledger(tmp_path)
    assert asyncio.run(pilot.run_batch(reopened, adapter)) == report
    assert len(adapter.calls) == 3
    assert all('expected' not in json.loads(p.user) for p in adapter.calls)


def test_failure_stops_batch_and_restart_cannot_advance(tmp_path):
    book, adapter = ledger(tmp_path), Adapter(True)
    report = asyncio.run(pilot.run_batch(book, adapter))
    assert len(adapter.calls) == 1 and report['attempts'][0]['state'] == 'failed'
    assert 'PRIVATE_CREDENTIAL' not in json.dumps(report)
    with pytest.raises(LivingError): asyncio.run(pilot.run_batch(ledger(tmp_path), Adapter()))


def test_reserved_crash_is_never_redispatched(tmp_path):
    book = ledger(tmp_path); assert book.claim('day-observe')
    adapter = Adapter()
    with pytest.raises(LivingError): asyncio.run(pilot.run_batch(ledger(tmp_path), adapter))
    assert adapter.calls == [] and book.report()['reserved_micro'] == 1145600


def test_concurrent_claim_only_one_reservation(tmp_path):
    book = ledger(tmp_path)
    def claim():
        try: return book.claim('day-observe')
        except LivingError: return False
    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(lambda _: claim(), range(2))) == [False, True]
    assert len(book.report()['attempts']) == 1


def test_order_unknown_case_and_changed_authorization_are_rejected(tmp_path):
    book = ledger(tmp_path)
    for name in ('night-rest', 'fourth-case'):
        with pytest.raises(LivingError): book.claim(name)
    with pytest.raises(LivingError): pilot.PilotLedger(book.path, 'different', origin='offline_contract')
    assert book.report()['attempts'] == []


def test_finish_cannot_overwrite_or_invent_result(tmp_path):
    book = ledger(tmp_path)
    with pytest.raises(LivingError): book.finish('day-observe', 'passed', {})
    book.claim('day-observe'); book.finish('day-observe', 'failed', {})
    with pytest.raises(LivingError): book.finish('day-observe', 'passed', {})


def test_missing_approval_precedes_credentials_network_and_database(tmp_path, monkeypatch):
    monkeypatch.setattr(pilot, 'DB', tmp_path / 'never-created.db')
    with pytest.raises(LivingError) as error: asyncio.run(pilot.execute(''))
    assert error.value.code == 'approval_required' and not pilot.DB.exists()


def test_explicit_batch_missing_approval_has_no_side_effects(tmp_path, monkeypatch):
    default = tmp_path / 'default.db'
    explicit = tmp_path / 'new-batch' / 'pilot.db'
    monkeypatch.setattr(pilot, 'DB', default)
    monkeypatch.setattr('app.core.config.get_settings', lambda: pytest.fail('missing approval read credentials'))
    with pytest.raises(LivingError) as error:
        asyncio.run(pilot.execute('', explicit))
    assert error.value.code == 'approval_required'
    assert not default.exists() and not explicit.parent.exists()


def test_explicit_batch_price_failure_never_touches_default_or_dispatches(tmp_path, monkeypatch):
    default, explicit = tmp_path / 'default.db', tmp_path / 'new-batch' / 'pilot.db'
    monkeypatch.setattr(pilot, 'DB', default)
    monkeypatch.setattr('app.core.config.get_settings', lambda: SimpleNamespace(
        model_base_url=provider.BASE_URL, chat_model=provider.MODEL, model_api_key='synthetic-key'))
    monkeypatch.setattr(pilot, 'run_batch', lambda *args: pytest.fail('price failure dispatched planning'))
    seen = []
    def handler(request):
        seen.append((request.method, str(request.url)))
        data = catalog()
        data['data']['items'][0]['priceInfo']['prices'][0]['price'][1]['priceValue'] = '9'
        return httpx.Response(200, json=data)
    client_class = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(LivingError) as error:
        asyncio.run(pilot.execute('synthetic-approval', explicit))
    assert error.value.code == 'pricing_unverified'
    assert seen == [('GET', provider.CATALOG_URL)]
    assert explicit.exists() and not default.exists()
    assert not explicit.with_suffix('.result.json').exists()


def test_execute_rechecks_price_before_any_paid_request(tmp_path, monkeypatch):
    monkeypatch.setattr(pilot, 'DB', tmp_path / 'pilot.db')
    monkeypatch.setattr('app.core.config.get_settings', lambda: SimpleNamespace(
        model_base_url=provider.BASE_URL, chat_model=provider.MODEL, model_api_key='synthetic-key'))
    seen = []
    def handler(request):
        seen.append(str(request.url))
        assert request.method == 'GET' and str(request.url) == provider.CATALOG_URL
        data = catalog(); data['data']['items'][0]['priceInfo']['prices'][0]['price'][1]['priceValue'] = '9'
        return httpx.Response(200, json=data)
    client_class = httpx.AsyncClient
    monkeypatch.setattr(httpx, 'AsyncClient', lambda **kwargs: client_class(transport=httpx.MockTransport(handler), **kwargs))
    with pytest.raises(LivingError) as error: asyncio.run(pilot.execute('synthetic-approval'))
    assert error.value.code == 'pricing_unverified' and seen == [provider.CATALOG_URL]


def test_dry_run_is_local_and_does_not_load_credentials(capsys, monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['life_planner_pilot.py'])
    monkeypatch.setattr('app.core.config.get_settings', lambda: pytest.fail('dry run loaded credentials'))
    pilot.main()
    data = json.loads(capsys.readouterr().out)
    assert data['requires_explicit_approval'] is True and len(data['cases']) == 3


def test_manifest_change_cannot_silently_reuse_batch(tmp_path, monkeypatch):
    book = ledger(tmp_path)
    original = pilot.manifest
    monkeypatch.setattr(pilot, 'manifest', lambda: {**original(), 'version': 'changed'})
    with pytest.raises(LivingError): ledger(tmp_path)
    assert book.report()['attempts'] == []


def test_fresh_process_dry_run_has_no_config_database_or_network_imports():
    code = '''
import sys, runpy
sys.modules['app.core.database'] = None
sys.modules['app.core.config'] = None
def guard(event, args):
    if event in ('sqlite3.connect', 'socket.connect'):
        raise AssertionError('dry-run side effect')
    if event == 'open' and str(args[0]).endswith('.env'):
        raise AssertionError('dry-run read credentials')
sys.addaudithook(guard)
sys.argv = ['life_planner_pilot.py']
runpy.run_path('scripts/life_planner_pilot.py', run_name='__main__')
'''
    result = subprocess.run([sys.executable, '-c', code], cwd=pilot.BACKEND, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)['total_reserved_micro'] == 3436800
