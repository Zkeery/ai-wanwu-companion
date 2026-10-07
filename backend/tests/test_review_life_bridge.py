"""Scoped review wiring uses the production budgets and scheduler, without network."""
import asyncio
from types import SimpleNamespace
from uuid import uuid4

from fastapi import HTTPException
import pytest

from scripts import review_life_bridge as bridge
from app.living.life_worker import consume_once
from app.living.rules import LivingError
from tests.test_life_live_planner import OWNER, Client, catalog, setup  # noqa: F401
from tests.test_life_live_automatic import prepared, fund, enable  # noqa: F401
from tests.test_gathering_dialogue import ready, result  # noqa: F401


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('no network in review wiring tests'))


@pytest.mark.parametrize('values', [None, {}, {'MODEL_API_KEY': 'synthetic'},
                                   {'MODEL_BASE_URL': bridge.BASE_URL, 'MODEL_API_KEY': ' '}])
def test_project_configuration_failure_is_redacted(monkeypatch, values):
    monkeypatch.setattr(bridge, 'dotenv_values', lambda _: values if values is not None else {})
    assert bridge.dialogue_available() is False
    with pytest.raises(HTTPException) as error:
        bridge.project_key()
    assert error.value.status_code == 503
    assert error.value.detail['error']['code'] == 'configuration_error'


def test_zero_budget_never_reads_key_or_catalog_or_constructs_provider(setup, monkeypatch):
    kernel, sid, tid = setup
    monkeypatch.setattr(bridge, 'project_key', lambda: pytest.fail('key must not be loaded'))
    monkeypatch.setattr(bridge, 'check_current_catalog', lambda: pytest.fail('catalog must not be loaded'))
    monkeypatch.setattr(bridge, 'MaaSLifePlannerAdapter', lambda _: pytest.fail('provider must not initialize'))
    asyncio.run(bridge.execute_requested(kernel, OWNER, sid, tid))
    assert kernel.read_task(OWNER, sid, tid).result.error_code == 'budget_exhausted'


def test_wrong_owner_rejected_before_key_access(setup, monkeypatch):
    kernel, sid, tid = setup
    monkeypatch.setattr(bridge, 'project_key', lambda: pytest.fail('key must not be loaded'))
    with pytest.raises(LivingError):
        asyncio.run(bridge.execute_requested(kernel, 'different-owner', sid, tid))


def test_background_daily_viewing_and_budget_stop_use_same_scoped_adapter(prepared, monkeypatch):
    from app.core.config import get_settings
    before = get_settings().model_dump()
    kernel, sid, clock = prepared
    fund(kernel, sid, 3)
    client = Client()
    monkeypatch.setattr(bridge, 'project_key', lambda: 'synthetic-test-key')
    monkeypatch.setattr(bridge, 'MaaSLifePlannerAdapter', lambda _: client)
    monkeypatch.setattr(bridge, 'check_current_catalog', catalog)
    enable(kernel, sid)
    def tick():
        asyncio.run(consume_once(kernel, lambda owner, space, tid: bridge.execute_requested(kernel, owner, space, tid)))
    tick(); tick()
    assert client.calls == 1
    clock[0] += 600
    tick()
    clock[0] += 600
    tick()
    assert client.calls == 2
    assert kernel.snapshot(OWNER, sid).automatic.today_count == 2
    for _ in range(2):
        kernel.save_viewing(OWNER, sid, str(uuid4()), 1, True)
    tick(); tick()
    assert client.calls == 3
    assert kernel.snapshot(OWNER, sid).tasks[0].id
    assert kernel.snapshot(OWNER, sid).automatic.budget_available is False
    clock[0] += 600
    tick()
    assert client.calls == 3
    kernel.save_automatic(OWNER, sid, str(uuid4()), 1, False)
    assert not kernel.snapshot(OWNER, sid).automatic.enabled
    assert get_settings().model_dump() == before


def test_dialogue_scoped_factory_still_requires_grant(client, ready, monkeypatch):
    from app.api import gatherings as api
    from app.living.gathering_dialogue import run_exchange
    store, _, group, ids, grant = ready
    calls = []
    class DialogueClient:
        async def exchange(self, facts):
            calls.append(facts)
            return result(ids)
    monkeypatch.setattr(bridge, 'project_key', lambda: 'synthetic-test-key')
    monkeypatch.setattr(bridge, 'MaaSDialogueAdapter', lambda _: DialogueClient())
    monkeypatch.setattr(api, 'dialogue_store', store)
    monkeypatch.setattr(api, 'dialogue_available', bridge.dialogue_available)
    monkeypatch.setattr(api, 'dialogue_client', bridge.dialogue_client)
    async def run(s, task, factory):
        await run_exchange(s, task, factory, catalog)
    monkeypatch.setattr(api, 'run_exchange', run)
    url = f"/api/v1/gatherings/{group['id']}/dialogue"
    payload = dict(request_id=str(uuid4()), expected_revision=group['revision'], character_ids=ids, grant_id=str(uuid4()))
    rejected = client.post(url, json=payload)
    assert rejected.status_code == 409 and rejected.json()['error']['code'] == 'budget_exhausted' and calls == []
    payload['grant_id'] = grant
    assert client.post(url, json=payload).status_code == 200 and len(calls) == 1
    assert client.post(url, json=payload).status_code == 200 and len(calls) == 1


def test_install_is_explicit_and_cannot_enable_global_model_calls(monkeypatch):
    from app.api import life_runtime, gatherings
    from app.core import config
    settings = SimpleNamespace(app_env='test', database_url=f'sqlite:///{bridge.BACKEND.parent / ".runtime/c160-review/check.db"}',
                               model_api_key='', life_live_planner_preview_enabled=True)
    monkeypatch.setattr(config, 'get_settings', lambda: settings)
    for module, name in [(life_runtime, 'check_live_configuration'), (life_runtime, 'execute_requested'),
                         (gatherings, 'dialogue_available'), (gatherings, 'dialogue_client')]:
        monkeypatch.setattr(module, name, getattr(module, name))
    bridge.install()
    assert life_runtime.execute_requested is bridge.execute_requested
    assert gatherings.dialogue_client is bridge.dialogue_client
    assert settings.model_api_key == ''
    settings.database_url = 'sqlite:////other-project/data.db'
    with pytest.raises(ValueError):
        bridge.install()


def test_shared_automatic_requires_explicit_opt_in_without_global_key_or_config_change(monkeypatch):
    from app.api import life_runtime, gatherings
    from app.core import config
    settings = SimpleNamespace(app_env='test', database_url=f'sqlite:///{bridge.BACKEND.parent / ".runtime/c160-review/check.db"}',
                               model_api_key='', life_live_planner_preview_enabled=True)
    monkeypatch.setattr(config, 'get_settings', lambda: settings)
    for module, name in [(life_runtime, 'check_live_configuration'), (life_runtime, 'execute_requested'),
                         (gatherings, 'dialogue_available'), (gatherings, 'dialogue_client'), (gatherings, 'automatic_available')]:
        monkeypatch.setattr(module, name, getattr(module, name))
    original = gatherings.automatic_available
    before = vars(settings).copy()
    keys = []
    monkeypatch.setattr(bridge, 'project_key', lambda: keys.append('checked') or 'synthetic')
    bridge.install()
    assert gatherings.automatic_available is original and keys == []
    bridge.install(shared_automatic=True)
    assert gatherings.automatic_available is bridge.dialogue_available
    assert gatherings.automatic_available() is True and keys == ['checked', 'checked']
    assert vars(settings) == before


@pytest.mark.parametrize('invalid', ['key', 'scope', 'type'])
def test_shared_install_failure_never_partially_wires_factories(monkeypatch, invalid):
    from app.api import life_runtime, gatherings
    from app.core import config
    settings = SimpleNamespace(app_env='test', database_url=f'sqlite:///{bridge.BACKEND.parent / ".runtime/c160-review/check.db"}',
                               model_api_key='', life_live_planner_preview_enabled=True)
    if invalid == 'scope':
        settings.database_url = 'sqlite:////other-project/data.db'
    monkeypatch.setattr(config, 'get_settings', lambda: settings)
    def missing():
        raise HTTPException(503, 'configuration_error')
    monkeypatch.setattr(bridge, 'project_key', missing)
    pairs = [(life_runtime, 'execute_requested'), (gatherings, 'dialogue_client'), (gatherings, 'automatic_available')]
    original = [getattr(module, name) for module, name in pairs]
    with pytest.raises((ValueError, HTTPException)):
        bridge.install(shared_automatic='true' if invalid == 'type' else True)
    assert [getattr(module, name) for module, name in pairs] == original


def test_shared_worker_without_auto_batch_never_accesses_provider_even_with_manual_grant(ready, monkeypatch):
    from app.core.database import engine
    from app.living.gathering_automatic import AutomaticDialogueStore, consume_once as shared_tick
    _, clock, _, _, _ = ready
    store = AutomaticDialogueStore(engine, lambda: clock[0])
    monkeypatch.setattr(bridge, 'project_key', lambda: pytest.fail('no automatic grant'))
    asyncio.run(shared_tick(store, bridge.dialogue_client))
