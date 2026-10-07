import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def anyio_backend():
    return 'asyncio'

spec = importlib.util.spec_from_file_location('cloud_serve',
    Path(__file__).resolve().parents[2] / 'deploy/modelscope/serve.py')
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


def test_normal_service_does_not_install_archived_acceptance_guard(tmp_path, monkeypatch):
    import httpx
    from scripts import real_web_budget
    budget = cloud.configure_budget(tmp_path / 'batch', '20261002-1cny', closed=True)
    before = budget.status()
    def forbidden(_budget):
        raise AssertionError('Normal service must not install an acceptance transport guard')
    monkeypatch.setattr(real_web_budget, 'install', forbidden)
    monkeypatch.setattr(real_web_budget, 'install_async', forbidden)
    original_sync, original_async = httpx.Client.send, httpx.AsyncClient.send
    assert cloud.install_acceptance_guard(budget, 'normal') is False
    assert httpx.Client.send is original_sync
    assert httpx.AsyncClient.send is original_async
    assert budget.status() == before
    assert before['paused'] is True


def test_only_explicit_normal_mode_bypasses_acceptance(tmp_path, monkeypatch):
    from scripts import real_web_budget
    budget = cloud.configure_budget(tmp_path / 'batch', None)
    installed = []
    monkeypatch.setattr(real_web_budget, 'install', lambda b: installed.append(('sync', b)))
    monkeypatch.setattr(real_web_budget, 'install_async', lambda b: installed.append(('async', b)))
    assert cloud.install_acceptance_guard(budget, 'acceptance') is True
    assert installed == [('sync', budget), ('async', budget)]
    with pytest.raises(ValueError, match='unknown_cloud_service_mode'):
        cloud.install_acceptance_guard(budget, 'typo')


def test_no_implicit_permission_and_text_cannot_fit_one_yuan(tmp_path):
    budget = cloud.configure_budget(tmp_path / 'batch', None)
    assert not budget.status()['authorized']
    with pytest.raises(OSError):
        budget.claim('wan2.6-t2i')
    budget = cloud.configure_budget(tmp_path / 'batch', '20261002-1cny')
    with pytest.raises(ValueError, match='budget_exhausted'):
        budget.claim('qwen3.8-flash')
    assert budget.status()['requests'] == 0


def test_spend_and_closed_batch_survive_restart(tmp_path):
    root = tmp_path / 'batch'
    budget = cloud.configure_budget(root, '20261002-1cny')
    call = budget.claim('ling-3.0-flash-vl')
    budget.settle(call, 'succeeded', 200)
    budget = cloud.configure_budget(root, '20261002-1cny')
    assert budget.status()['reserved_cny'] == .2
    cloud.configure_budget(root, '20261002-1cny', closed=True)
    budget = cloud.configure_budget(root, '20261002-1cny')
    assert budget.status()['paused']
    with pytest.raises(ValueError, match='previous_request_requires_review'):
        budget.claim('wan2.6-t2i')


def test_unknown_call_cannot_be_repeated(tmp_path):
    root = tmp_path / 'batch'
    budget = cloud.configure_budget(root, '20261002-1cny')
    budget.claim('ling-3.0-flash-vl')
    budget = cloud.configure_budget(root, '20261002-1cny')
    with pytest.raises(ValueError, match='previous_request_requires_review'):
        budget.claim('ling-3.0-flash-vl')


def _closed_first_round(root):
    budget = cloud.configure_budget(root, '20261002-1cny')
    call = budget.claim('ling-3.0-flash-vl')
    budget.settle(call, 'succeeded', 200)
    cloud.configure_budget(root, '20261002-1cny', closed=True)


def test_revision_requires_prior_closed_and_preserves_both_ledgers(tmp_path):
    root = tmp_path / 'batch'
    cloud.configure_budget(root, '20261002-1cny')
    with pytest.raises(ValueError, match='prior_batch'):
        cloud.configure_budget(root, '20261002-total3cny-revision1')
    _closed_first_round(root)
    revision = cloud.configure_budget(root, '20261002-total3cny-revision1')
    with pytest.raises(ValueError, match='single_revision_scope'):
        revision.claim('qwen3.8-flash')
    call = revision.claim('ling-3.0-flash-vl')
    revision.settle(call, 'succeeded', 200)
    restarted = cloud.configure_budget(root, '20261002-total3cny-revision1')
    assert restarted.status()['requests'] == 1
    assert restarted.prior_reserved_cny == .2
    previous = cloud.configure_budget(root, '20261002-1cny')
    assert previous.status()['paused'] and previous.status()['reserved_cny'] == .2
    cloud.configure_budget(root, '20261002-total3cny-revision1', closed=True)
    assert cloud.configure_budget(root, '20261002-total3cny-revision1').status()['paused']


def test_final_revision_retains_both_prior_reservations_and_three_yuan_cap(tmp_path):
    root = tmp_path / 'batch'
    _closed_first_round(root)
    first = cloud.configure_budget(root, '20261002-total3cny-revision1')
    with pytest.raises(ValueError, match='prior_batches'):
        cloud.configure_budget(root, '20261002-total3cny-revision2')
    call = first.claim('ling-3.0-flash-vl')
    first.settle(call, 'succeeded', 200)
    cloud.configure_budget(root, '20261002-total3cny-revision1', closed=True)
    final = cloud.configure_budget(root, '20261002-total3cny-revision2')
    assert final.prior_reserved_cny == .4
    assert final.status()['budget_cny'] == 2.6
    for model in ('ling-3.0-flash-vl', 'wan2.6-t2i', 'qwen3.8-flash', 'qwen3.8-flash'):
        call = final.claim(model)
        final.settle(call, 'succeeded', 200)
    final = cloud.configure_budget(root, '20261002-total3cny-revision2')
    assert round(final.prior_reserved_cny + final.status()['reserved_cny'], 6) == 2.9072
    with pytest.raises(ValueError, match='budget_exhausted'):
        final.claim('wan2.6-t2i')
    assert first.status()['paused'] and first.status()['reserved_cny'] == .2


@pytest.mark.anyio
async def test_sync_and_async_calls_share_one_finite_revision(tmp_path, monkeypatch):
    import httpx
    from scripts.real_web_budget import install, install_async

    root = tmp_path / 'batch'
    _closed_first_round(root)
    budget = cloud.configure_budget(root, '20261002-total3cny-revision1')
    sync_original, async_original = httpx.Client.send, httpx.AsyncClient.send
    monkeypatch.setattr(httpx.Client, 'send', sync_original)
    monkeypatch.setattr(httpx.AsyncClient, 'send', async_original)
    install(budget)
    install_async(budget)
    sent = []

    class LifeBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"choices": ['
            yield b'{"message": {"content": "ok"}}]}'

    def provider(request):
        sent.append(request)
        if len(sent) == 4:
            return httpx.Response(200, stream=LifeBody())
        return httpx.Response(200, json={'choices': [{'message': {'content': 'ok'}}]})

    transport = httpx.MockTransport(provider)
    with httpx.Client(transport=transport) as client:
        for model in ('ling-3.0-flash-vl', 'wan2.6-t2i', 'qwen3.8-flash'):
            path = '/images/generations' if model == 'wan2.6-t2i' else '/chat/completions'
            assert client.post(budget.endpoint + path,
                json={'model': model, 'messages': [], 'size': '1024x1024'}).status_code == 200
    async with httpx.AsyncClient(transport=transport) as client:
        async with client.stream('POST', budget.endpoint + '/chat/completions',
                json={'model': 'qwen3.8-flash', 'messages': [], 'stream': False}) as response:
            assert response.status_code == 200
            await response.aread()
        with pytest.raises(httpx.RequestError):
            await client.post(budget.endpoint + '/chat/completions',
                json={'model': 'qwen3.8-flash', 'messages': []})
    assert len(sent) == 4
    assert budget.status()['reserved_cny'] == 2.5072
    assert budget.prior_reserved_cny + budget.status()['reserved_cny'] < 3


@pytest.mark.anyio
async def test_interrupted_async_body_remains_charged_and_stopped(tmp_path, monkeypatch):
    import httpx
    from scripts.real_web_budget import install_async

    root = tmp_path / 'batch'
    _closed_first_round(root)
    budget = cloud.configure_budget(root, '20261002-total3cny-revision1')
    for model in ('ling-3.0-flash-vl', 'wan2.6-t2i', 'qwen3.8-flash'):
        call = budget.claim(model)
        budget.settle(call, 'succeeded', 200)
    monkeypatch.setattr(httpx.AsyncClient, 'send', httpx.AsyncClient.send)
    install_async(budget)

    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"choices": ['
            raise httpx.ReadError('body interrupted')

    async with httpx.AsyncClient(transport=httpx.MockTransport(
            lambda request: httpx.Response(200, stream=BrokenBody()))) as client:
        with pytest.raises(httpx.ReadError):
            async with client.stream('POST', budget.endpoint + '/chat/completions',
                    json={'model': 'qwen3.8-flash', 'messages': [], 'stream': False}) as response:
                await response.aread()
    assert budget.status()['requests'] == 4
    assert budget.status()['paused']


@pytest.mark.anyio
async def test_interrupted_async_call_cannot_be_retried(tmp_path, monkeypatch):
    import httpx
    from scripts.real_web_budget import install_async

    root = tmp_path / 'batch'
    _closed_first_round(root)
    budget = cloud.configure_budget(root, '20261002-total3cny-revision1')
    for model in ('ling-3.0-flash-vl', 'wan2.6-t2i', 'qwen3.8-flash'):
        call = budget.claim(model)
        budget.settle(call, 'succeeded', 200)
    monkeypatch.setattr(httpx.AsyncClient, 'send', httpx.AsyncClient.send)
    install_async(budget)
    sent = []

    def interrupted(request):
        sent.append(request)
        raise httpx.ReadTimeout('interrupted', request=request)

    async with httpx.AsyncClient(transport=httpx.MockTransport(interrupted)) as client:
        for _ in range(2):
            with pytest.raises(httpx.RequestError):
                await client.post(budget.endpoint + '/chat/completions',
                    json={'model': 'qwen3.8-flash', 'messages': []})
    assert len(sent) == 1
    assert budget.status()['paused']


def test_receipts_owner_only_and_business_failure_stops_batch(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from fastapi.testclient import TestClient
    import httpx
    import uvicorn
    import app.main as application
    from app.api.deps import get_current_user
    from scripts import real_web_budget

    app = FastAPI()
    budget = cloud.configure_budget(tmp_path / 'batch', '20261002-1cny')
    call = budget.claim('ling-3.0-flash-vl')
    budget.response_receipt(call, {'choices': [{'message': {'content': 'test receipt'}}]})
    budget.settle(call, 'succeeded', 200)
    monkeypatch.setattr(cloud, 'configure_budget', lambda *args: budget)
    monkeypatch.setattr(real_web_budget, 'install', lambda _budget: None)
    monkeypatch.setattr(application, 'app', app)
    monkeypatch.setattr(uvicorn, 'run', lambda *args, **kwargs: None)
    monkeypatch.setenv('CLOUD_ACCEPTANCE_OWNER_ID', 'owner')
    original_async = httpx.AsyncClient.send
    try:
        cloud.main()

        @app.post('/failure')
        def fail_after_provider_reply():
            item = budget.claim('wan2.6-t2i')
            budget.settle(item, 'succeeded', 200)
            return JSONResponse({'error': {'code': 'invalid_output'}}, status_code=502)

        with TestClient(app, raise_server_exceptions=False) as client:
            app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id='owner')
            assert client.get('/api/v1/deployment-check/receipts').status_code == 200
            app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id='other')
            assert client.get('/api/v1/deployment-check/receipts').status_code == 404
            assert client.post('/failure').status_code == 502
            assert budget.status()['paused']
    finally:
        httpx.AsyncClient.send = original_async
