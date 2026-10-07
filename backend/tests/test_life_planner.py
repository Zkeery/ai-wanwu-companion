"""C1.4 offline worker contracts; sockets are forbidden and fees are synthetic."""
import asyncio
import json
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select

from app.living import life_planner as planner
from app.living import life_runtime as rt
from app.living.rules import LivingError
from tests.test_life_runtime import OWNER, WALK, allocate, enable, queued, runtime, no_network, stamp  # noqa: F401


class Client:
    def __init__(self, value=None, effect=None):
        self.value = value if value is not None else json.dumps(WALK)
        self.effect = effect
        self.prompts = []

    async def complete(self, prompt):
        self.prompts.append(prompt)
        if self.effect:
            await self.effect()
        return self.value


def setup(runtime):
    kernel, sid, _, _ = runtime
    task = queued(runtime)
    allocate(kernel, sid)
    return kernel, sid, task.spec.basis.plan_id


def run(runtime, client, *, factory=None):
    kernel, sid, tid = setup(runtime)
    result = asyncio.run(planner.run_offline_planner(kernel, OWNER, sid, tid,
        factory or (lambda: client), max_cost=30))
    return result


def ledger(kernel):
    with kernel.engine.connect() as conn:
        return [json.loads(row.payload) for row in conn.execute(select(rt.calls.c.payload))]


def test_success_is_redacted_single_step_and_unknown_cost_is_retained(runtime):
    client = Client()
    result = run(runtime, client)
    kernel, sid, _, _ = runtime
    assert result.state == 'done'
    assert result.result.event.activity == 'walk'
    assert result.result.event.origin == 'offline_fixture'
    assert len(client.prompts) == len(kernel.read_events(OWNER, sid)) == 1
    prompt = client.prompts[0]
    data = json.loads(prompt.user)
    assert set(data) == {'scene', 'season', 'rain', 'sound', 'local_time', 'allowed_activities', 'visible_items'}
    assert OWNER not in prompt.user and sid not in prompt.user and result.token is None
    assert '+08:00' in data['local_time']
    assert prompt.system == planner.SYSTEM and prompt.origin == 'offline_fixture'
    assert ledger(kernel)[0]['outcome'] == 'unknown'
    assert kernel.read_budget(OWNER, sid).committed == 30
    # Re-entry reads the durable terminal result without constructing a client.
    replay = asyncio.run(planner.run_offline_planner(kernel, OWNER, sid, result.spec.basis.plan_id,
        lambda: pytest.fail('must not initialize'), max_cost=30))
    assert replay == result


@pytest.mark.parametrize('raw', [
    'not JSON', '```json\n{}\n```', '[]', 'null',
    '{"activity":"walk","activity":"rest","reason":"x"}',
    '{"activity":"walk","reason":"x","budget":999}',
    '{"activity":"fly","reason":"x"}',
    '{"activity":"walk","reason":""}',
    json.dumps({'activity': 'walk', 'reason': 'x' * 121}),
    '{"activity":"walk","reason":NaN}',
    '{"activity":"walk","reason":"x\\ny"}',
    '{"activity":"walk","reason":"' + '中' * 1400 + '"}',
    ' ' * 4097, 123,
])
def test_malformed_output_fails_without_event_or_retry(runtime, raw):
    client = Client(raw)
    result = run(runtime, client)
    kernel, sid, _, _ = runtime
    assert result.state == 'failed' and result.result.error_code == 'invalid_request'
    assert kernel.read_events(OWNER, sid) == []
    assert len(client.prompts) == 1 and kernel.read_budget(OWNER, sid).committed == 30


def test_target_must_still_be_real(runtime):
    result = run(runtime, Client(json.dumps({'activity': 'observe', 'target_id': str(uuid4()), 'reason': '观察'})))
    assert result.state == 'failed' and result.result.error_code == 'invalid_action'


def test_only_visible_item_ids_are_sent_and_valid_observe_executes(runtime):
    kernel, sid, _, _ = runtime
    kernel.store.execute(OWNER, sid, str(uuid4()), 0, {'action': 'place', 'kind': 'tree', 'x': .3, 'y': .4})
    class Observer(Client):
        async def complete(self, prompt):
            self.prompts.append(prompt)
            item = json.loads(prompt.user)['visible_items'][0]
            assert set(item) == {'id', 'kind'}
            return json.dumps({'activity': 'observe', 'target_id': item['id'], 'reason': '看看小树'})
    result = run(runtime, Observer())
    assert result.state == 'done' and result.result.event.target_id is not None


def test_no_budget_prevents_client_initialization(runtime):
    kernel, sid, _, _ = runtime
    task = queued(runtime)
    result = asyncio.run(planner.run_offline_planner(kernel, OWNER, sid, task.spec.basis.plan_id,
        lambda: pytest.fail('no budget'), max_cost=30))
    assert result.state == 'failed' and result.result.error_code == 'invalid_action'
    assert ledger(kernel) == []


def test_initialization_failure_is_zero_cost_and_sanitized(runtime):
    def broken():
        raise RuntimeError('PRIVATE_KEY_AND_PROVIDER_DIAGNOSTIC')
    result = run(runtime, None, factory=broken)
    kernel, sid, _, _ = runtime
    assert result.state == 'failed' and result.result.error_code == 'worker_error'
    assert ledger(kernel)[0]['actual_cost'] == 0
    assert ledger(kernel)[0]['outcome'] == 'failed'
    assert kernel.read_budget(OWNER, sid).committed == 0
    assert 'PRIVATE_KEY' not in result.model_dump_json()


def test_pause_during_local_initialization_prevents_dispatch(runtime):
    kernel, sid, _, _ = runtime
    client = Client()
    def initialize():
        enable(kernel, sid, revision=1, enabled=False)
        return client
    assert run(runtime, client, factory=initialize).state == 'cancelled'
    assert client.prompts == []
    assert kernel.read_budget(OWNER, sid).committed == 0


@pytest.mark.parametrize('activity,expected', [('rest', 'done'), ('walk', 'failed')])
def test_night_rule_is_checked_after_planning(runtime, activity, expected):
    runtime[2][0] = stamp(hour=23)
    result = run(runtime, Client(json.dumps({'activity': activity, 'reason': '夜间活动'})))
    assert result.state == expected


def test_provider_exception_retains_budget_and_no_raw_error(runtime):
    async def fail():
        raise RuntimeError('PRIVATE_TOKEN')
    result = run(runtime, Client(effect=fail))
    kernel, sid, _, _ = runtime
    assert result.state == 'failed' and result.result.error_code == 'worker_error'
    assert kernel.read_budget(OWNER, sid).committed == 30
    assert 'PRIVATE_TOKEN' not in result.model_dump_json() + json.dumps(ledger(kernel))


def test_timeout_cancels_client_without_retry(runtime, monkeypatch):
    monkeypatch.setattr(planner, 'REQUEST_TIMEOUT', .01)
    stopped = []
    async def stall():
        try:
            await asyncio.sleep(10)
        finally:
            stopped.append(True)
    client = Client(effect=stall)
    assert run(runtime, client).state == 'failed'
    assert stopped == [True] and len(client.prompts) == 1
    assert ledger(runtime[0])[0]['outcome'] == 'unknown'


def test_cancellation_is_persisted_before_propagation(runtime):
    kernel, sid, tid = setup(runtime)
    async def scenario():
        started = asyncio.Event()
        async def stall():
            started.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(planner.run_offline_planner(kernel, OWNER, sid, tid,
            lambda: Client(effect=stall), max_cost=30))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(scenario())
    assert kernel.read_task(OWNER, sid, tid).state == 'failed'
    assert ledger(kernel)[0]['outcome'] == 'unknown'


@pytest.mark.parametrize('change', ['pause', 'scene', 'expiry'])
def test_response_cannot_override_changed_facts_or_permission(runtime, change):
    kernel, sid, clock, _ = runtime
    async def alter():
        if change == 'pause':
            enable(kernel, sid, revision=1, enabled=False)
        elif change == 'scene':
            kernel.store.execute(OWNER, sid, str(uuid4()), 0, {'action': 'place', 'kind': 'tree', 'x': .3, 'y': .4})
        else:
            clock[0] += 61
    result = run(runtime, Client(effect=alter))
    assert result.state == ('running' if change == 'expiry' else 'cancelled')
    assert kernel.read_events(OWNER, sid) == []
    assert kernel.read_budget(OWNER, sid).committed == 30
    if change == 'expiry':
        again = asyncio.run(planner.run_offline_planner(kernel, OWNER, sid, result.spec.basis.plan_id,
            lambda: pytest.fail('late result must not retry'), max_cost=30))
        assert again.state == 'failed'


@pytest.mark.parametrize('outcome', ['reserved', 'unknown'])
def test_reopened_database_never_redispatches_uncertain_attempt(runtime, outcome):
    kernel, sid, tid = setup(runtime)
    _, _, clock, db = runtime
    task = kernel.claim(OWNER, sid, tid)
    cid = planner.call_id_for(tid)
    kernel.reserve_call(OWNER, sid, tid, task.token, cid, 30)
    if outcome == 'unknown':
        kernel.settle_call(OWNER, sid, tid, cid, None, 'unknown')
    kernel.engine.dispose()
    clock[0] += 61
    reopened_engine = create_engine('sqlite:///' + str(db))
    try:
        recovered = rt.LifeRuntime(reopened_engine, lambda: clock[0])
        result = asyncio.run(planner.run_offline_planner(recovered, OWNER, sid, tid,
            lambda: pytest.fail('unknown dispatch must not repeat'), max_cost=30))
        assert result.state == 'failed'
        assert recovered.read_budget(OWNER, sid).committed == 30
        assert len(ledger(recovered)) == 1 and recovered.read_events(OWNER, sid) == []
    finally:
        reopened_engine.dispose()


def test_concurrent_worker_cannot_make_second_request(runtime):
    kernel, sid, tid = setup(runtime)
    async def scenario():
        started, release = asyncio.Event(), asyncio.Event()
        async def wait():
            started.set()
            await release.wait()
        client = Client(effect=wait)
        first = asyncio.create_task(planner.run_offline_planner(kernel, OWNER, sid, tid, lambda: client, max_cost=30))
        await started.wait()
        with pytest.raises(LivingError) as error:
            await planner.run_offline_planner(kernel, OWNER, sid, tid, lambda: pytest.fail('second client'), max_cost=30)
        assert error.value.code == 'conflict'
        release.set()
        assert (await first).state == 'done'
        assert len(client.prompts) == 1
    asyncio.run(scenario())


def test_storage_failure_after_response_keeps_reservation(runtime, monkeypatch):
    kernel, sid, tid = setup(runtime)
    original = kernel.settle_call
    def unavailable(*args, **kwargs):
        raise LivingError('storage_unavailable', '费用状态暂时无法保存')
    monkeypatch.setattr(kernel, 'settle_call', unavailable)
    with pytest.raises(LivingError) as error:
        asyncio.run(planner.run_offline_planner(kernel, OWNER, sid, tid, lambda: Client(), max_cost=30))
    assert error.value.code == 'storage_unavailable'
    monkeypatch.setattr(kernel, 'settle_call', original)
    assert ledger(kernel)[0]['outcome'] == 'reserved'
    assert kernel.read_events(OWNER, sid) == []


def test_planning_inputs_rejects_wrong_owner_and_lease(runtime):
    kernel, sid, tid = setup(runtime)
    task = kernel.claim(OWNER, sid, tid)
    for owner, token in [('other-owner', task.token), (OWNER, str(uuid4()))]:
        with pytest.raises(LivingError):
            kernel.planning_inputs(owner, sid, tid, token)
