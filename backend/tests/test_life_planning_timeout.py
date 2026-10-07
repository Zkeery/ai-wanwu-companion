"""Life-only waiting policy and both runtime factories; never external network."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from app.living.life_planner import Prompt, SYSTEM
from app.living.life_provider import MaaSLifePlannerAdapter, MaaSPlannerAdapter
from app.living.rules import LivingError
from tests.test_life_provider import response


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('external network forbidden'))


def test_life_waits_past_old_deadline_and_preserves_request_limits():
    seen = []
    async def handler(request):
        seen.append(request)
        # Exercise the previous read cutoff without making a real provider call.
        timeout = request.extensions['timeout']
        assert timeout['read'] == 30 and timeout['connect'] == 5
        await asyncio.sleep(12.05)
        return httpx.Response(200, json=response())
    adapter = MaaSLifePlannerAdapter('synthetic-key', transport=httpx.MockTransport(handler))
    result = asyncio.run(adapter.plan(Prompt(SYSTEM, '{}')))
    body = json.loads(seen[0].content)
    assert len(seen) == 1 and result.candidate['activity'] == 'rest'
    assert body['enable_thinking'] is False and body['max_tokens'] == 512 and body['stream'] is False
    assert adapter.request_deadline == 40
    assert MaaSPlannerAdapter.read_timeout == 12 and MaaSPlannerAdapter.request_deadline == 15
    assert MaaSPlannerAdapter.request_options == {}


def test_deadline_cancels_transport_once_without_retry_or_details():
    seen, cancelled = [], []
    async def handler(request):
        seen.append(request)
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)
    adapter = MaaSLifePlannerAdapter('synthetic-key', transport=httpx.MockTransport(handler))
    adapter.request_deadline = 0.02
    with pytest.raises(LivingError) as error:
        asyncio.run(adapter.plan(Prompt(SYSTEM, '{}')))
    assert error.value.code == 'provider_deadline'
    assert len(seen) == 1 and cancelled == [True]
    assert 'synthetic-key' not in str(error.value)


@pytest.mark.parametrize('target', ['production', 'review'])
def test_real_execution_uses_life_specific_factory(target, monkeypatch):
    from app.api import life_runtime as api
    from scripts import review_life_bridge as bridge
    module = api if target == 'production' else bridge
    seen = []
    selected = SimpleNamespace(origin='real_provider', read_task=lambda *args: seen.append(args))
    async def run(runtime, owner, sid, tid, factory, *args):
        assert seen == [('owner', 'space', 'task')]
        adapter = factory()
        assert type(adapter) is MaaSLifePlannerAdapter
        assert adapter.request_deadline == 40 and adapter.request_options == {'enable_thinking': False}
        seen.append('factory checked')
    monkeypatch.setattr(module, 'run_real_planner', run)
    if target == 'production':
        monkeypatch.setattr(api, 'check_live_configuration', lambda _: None)
        monkeypatch.setattr(api, 'get_settings', lambda: SimpleNamespace(model_api_key='synthetic-key'))
    else:
        monkeypatch.setattr(bridge, 'project_key', lambda: 'synthetic-key')
    asyncio.run(module.execute_requested(selected, 'owner', 'space', 'task'))
    assert seen[-1] == 'factory checked'
