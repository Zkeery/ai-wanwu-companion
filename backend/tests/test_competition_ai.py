import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.database import engine
from app.living.competition_ai import CompetitionAIStore, CompetitionAdapter, decode, grants, tasks, run_suggestion
from app.living.life_provider import MODEL, RESERVE_MICRO
from app.living.rules import LivingError
from tests.auth_helpers import TEST_USER_ID as OWNER
from tests.test_competitions import arena, run  # noqa: F401


def setup(arena, kind='observe', phase='strategy'):
    s, clock, ids = arena
    m = s.create(OWNER, str(uuid4()), kind, '我')
    for cid in ids:
        m = run(s, m, 'register', character_id=cid)
    if phase == 'reflection':
        m = run(s, m, 'start')
        clock[0] += 480
        m = s.read(OWNER, m['id'])
    ai = CompetitionAIStore(engine, lambda: clock[0])
    gid = ai.authorize(OWNER, m['id'], ids[0], phase, str(uuid4()))
    return s, ai, m, clock, ids, gid


def prepare(ai, m, cid, gid, phase='strategy', rid=None):
    return ai.prepare(OWNER, m['id'], cid, phase, rid or str(uuid4()), gid)


def result(facts):
    return dict(order=list(reversed(facts['allowed'])), text='我想从边上慢慢看过去。') if facts['phase'] == 'strategy' else dict(**facts['result'], event_id=facts['experience'][0]['id'], text='和大家一起玩很开心。')


@pytest.mark.parametrize('kind', ['observe', 'garden', 'leaves'])
def test_strategy_executes_validated_order_and_preserves_rewards(arena, kind):
    s, ai, m, clock, ids, gid = setup(arena, kind)
    task, _ = prepare(ai, m, ids[0], gid)
    facts = ai.dispatch(task['id'])
    ai.complete(task['id'], result(facts))
    m = run(s, m, 'start')
    clock[0] += 30
    m = s.read(OWNER, m['id'])
    p = m['participants'][str(ids[0])]
    if kind == 'garden':
        assert p['layout'][0] == dict(kind='tree', x=90, y=75)
    else:
        assert p['targets'][0] == 19
    assert p['ai_strategy']['origin'] == 'real_provider'  # Injected adapter result, not live evidence.
    clock[0] += 480
    m = s.read(OWNER, m['id'])
    assert m['status'] == 'completed'
    before = s.inventory(OWNER)
    assert s.read(OWNER, m['id']) == m
    assert s.inventory(OWNER) == before
    assert ai.status(OWNER, m['id'])['tasks'][0]['state'] == 'done'


def test_owner_budget_digest_expiry_and_private_data(arena):
    s, ai, m, clock, ids, gid = setup(arena)
    with pytest.raises(LivingError):
        ai.prepare('another', m['id'], ids[0], 'strategy', str(uuid4()), gid)
    with pytest.raises(LivingError):
        prepare(ai, m, ids[1], gid)
    with pytest.raises(LivingError):
        prepare(ai, m, ids[0], str(uuid4()))
    with pytest.raises(LivingError):
        ai.status('another', m['id'])
    task, _ = prepare(ai, m, ids[0], gid)
    facts = json.loads(task['facts_json'])
    assert set(facts) == {'phase', 'kind', 'rules_version', 'character_id', 'name', 'traits', 'personality', 'roster', 'allowed', 'field'}
    assert ai.status(OWNER, m['id'])['grants'] == []
    assert RESERVE_MICRO == 1_145_600


def test_expired_or_changed_grant_does_not_consume(arena):
    s, ai, m, clock, ids, gid = setup(arena)
    run(s, m, 'withdraw', character_id=ids[1])
    with pytest.raises(LivingError):
        prepare(ai, m, ids[0], gid)
    assert ai.status(OWNER, m['id'])['grants'] == []
    with engine.connect() as conn:
        assert conn.execute(select(grants.c.used).where(grants.c.id == gid)).scalar_one() == 0
    run(s, m, 'register', character_id=ids[1])
    clock[0] += 3600
    with pytest.raises(LivingError):
        prepare(ai, m, ids[0], gid)


def test_concurrent_replays_dispatch_only_once(arena):
    _, ai, m, _, ids, gid = setup(arena)
    rid = str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(lambda _: prepare(ai, m, ids[0], gid, rid=rid), range(2)))
    assert sum(fresh for _, fresh in outcomes) == 1
    task = outcomes[0][0]
    ai.dispatch(task['id'])
    with pytest.raises(LivingError):
        ai.dispatch(task['id'])
    with pytest.raises(LivingError):
        prepare(ai, m, ids[0], gid)
    with pytest.raises(LivingError):
        prepare(ai, m, ids[1], gid, rid=rid)


@pytest.mark.parametrize('bad', [dict(order=[0] * 20, text='慢慢看。'), dict(order=list(range(1, 21)), text='慢慢看。'),
    dict(order=list(range(20)), text='我拿到冠军了。'), dict(order=list(range(20)), text='慢慢看。', score=999),
    dict(order=[False] + list(range(1, 20)), text='慢慢看。')])
def test_invalid_output_cannot_change_match(arena, bad):
    s, ai, m, _, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    ai.dispatch(task['id'])
    with pytest.raises(LivingError):
        ai.complete(task['id'], bad)
    assert 'ai_strategy' not in s.read(OWNER, m['id'])['participants'][str(ids[0])]


def test_start_waits_then_restart_unknown_never_resends(arena):
    s, ai, m, clock, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    facts = ai.dispatch(task['id'])
    with pytest.raises(LivingError):
        run(s, m, 'start')
    clock[0] += 60
    restored = CompetitionAIStore(engine, lambda: clock[0])
    assert restored.status(OWNER, m['id'])['tasks'][0]['state'] == 'unknown'
    assert run(s, m, 'start')['status'] == 'running'
    with pytest.raises(LivingError):
        restored.complete(task['id'], result(facts))
    replay, fresh = prepare(restored, m, ids[0], gid, rid=task['request_id'])
    assert not fresh and replay['state'] == 'unknown'


@pytest.mark.parametrize('action', ['withdraw', 'cancel'])
def test_late_result_after_withdraw_or_cancel_is_not_published(arena, action):
    s, ai, m, _, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    facts = ai.dispatch(task['id'])
    run(s, m, action, **({'character_id': ids[0]} if action == 'withdraw' else {}))
    with pytest.raises(LivingError):
        ai.complete(task['id'], result(facts))


def test_reflection_checks_actual_result_and_keeps_wallet(arena):
    s, ai, m, _, ids, gid = setup(arena, phase='reflection')
    before = s.inventory(OWNER)
    task, _ = prepare(ai, m, ids[0], gid, phase='reflection')
    facts = ai.dispatch(task['id'])
    with pytest.raises(LivingError):
        ai.complete(task['id'], dict(score=20, winner=not facts['result']['winner'], text='开心。'))
    ai.complete(task['id'], result(facts))
    restored = CompetitionAIStore(engine, ai.clock)
    saved = restored.read(OWNER, m['id'])['participants'][str(ids[0])]['ai_reflection']
    assert saved['score'] == facts['result']['score']
    assert s.inventory(OWNER) == before


@pytest.mark.parametrize('mode,tags,custom,priority', [
    ('original', [], '', None),
    ('custom', ['curious', 'gentle', 'reliable', 'playful'], '', None),
    ('custom', [], '平时话少，聊到植物很健谈。', None),
    ('custom', ['curious'], '谨慎地先看再行动。', 'custom'),
    ('custom', ['quiet'], '聊到植物会很健谈。', 'presets'),
])
def test_effective_personality_matches_character_settings_without_public_leak(arena, client, mode, tags, custom, priority):
    from app.core.database import SessionLocal
    from app.models.models import Character
    s, _, ids = arena
    # This is the authoritative field also read by chat; no preset row initially.
    with SessionLocal() as db:
        db.get(Character, ids[0]).persona = '这是只在性格输入中的原生描述。'
        db.commit()
    path = f'/api/v1/characters/{ids[0]}/personality'
    saved = client.patch(path, json=dict(expected_revision=0, mode=mode, tags=tags,
                                       custom_text=custom, priority=priority))
    assert saved.status_code == 200
    _, ai, m, _, _, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    facts = ai.dispatch(task['id'])
    assert facts['personality'] == dict(mode=mode, description=saved.json()['effective_persona'])
    assert len(facts['traits']) == len(tags)  # Do not silently drop the fourth preset.
    if custom:
        assert custom not in json.dumps(ai.status(OWNER, m['id']), ensure_ascii=False)
    assert 'personality' not in json.dumps(s.read(OWNER, m['id']), ensure_ascii=False)
    assert 'original_persona' not in facts and 'custom_text' not in facts


def test_original_personality_without_edits_and_restoration(arena, client):
    from app.core.database import SessionLocal
    from app.models.models import Character
    _, _, ids = arena
    with SessionLocal() as db:
        original = db.get(Character, ids[0]).persona
    _, ai, m, _, _, gid = setup(arena)
    first, _ = prepare(ai, m, ids[0], gid)
    assert json.loads(first['facts_json'])['personality'] == dict(mode='original', description=original)
    path = f'/api/v1/characters/{ids[0]}/personality'
    assert client.patch(path, json=dict(expected_revision=0, mode='custom', tags=['curious'])).status_code == 200
    assert client.patch(path, json=dict(expected_revision=1, mode='original')).status_code == 200
    with ai.storage.transaction() as conn:
        restored = ai.facts(conn, ai.load(conn, m['id']), OWNER, ids[0], 'strategy')
    assert restored['personality']['description'] == original
    assert restored['traits'] == []


@pytest.mark.parametrize('dispatched', [False, True])
def test_changed_personality_invalidates_authorization_or_late_response(arena, client, dispatched):
    _, ai, m, _, ids, gid = setup(arena)
    if dispatched:
        task, _ = prepare(ai, m, ids[0], gid)
        old = ai.dispatch(task['id'])
    assert client.patch(f'/api/v1/characters/{ids[0]}/personality',
        json=dict(expected_revision=0, mode='custom', tags=['curious'])).status_code == 200
    with pytest.raises(LivingError):
        if dispatched:
            ai.complete(task['id'], result(old))
        else:
            prepare(ai, m, ids[0], gid)
    with engine.connect() as conn:
        assert conn.execute(select(grants.c.used).where(grants.c.id == gid)).scalar_one() == int(dispatched)


def test_oversized_personality_rejected_before_authorization(arena):
    from app.core.database import SessionLocal
    from app.models.models import Character
    s, clock, ids = arena
    m = s.create(OWNER, str(uuid4()), 'observe', '我')
    m = run(s, m, 'register', character_id=ids[0])
    with SessionLocal() as db:
        db.get(Character, ids[0]).persona = '静' * 2001
        db.commit()
    ai = CompetitionAIStore(engine, lambda: clock[0])
    with pytest.raises(LivingError):
        ai.authorize(OWNER, m['id'], ids[0], 'strategy', str(uuid4()))
    assert ai.status(OWNER, m['id']) == dict(grants=[], tasks=[])


@pytest.mark.parametrize('kind,prefix', [('observe', 'observed_'), ('leaves', 'collected_'), ('garden', 'placed_')])
def test_reflection_references_only_actual_actions_and_immutable_evidence(arena, kind, prefix):
    s, ai, m, _, ids, gid = setup(arena, kind=kind, phase='reflection')
    before = s.inventory(OWNER)
    task, _ = prepare(ai, m, ids[0], gid, phase='reflection')
    facts = ai.dispatch(task['id'])
    assert all(e['id'].startswith(prefix) for e in facts['experience'])
    assert facts['experience']
    for invalid in [dict(result(facts), event_id='another_match'),
                    {k: v for k, v in result(facts).items() if k != 'event_id'},
                    dict(result(facts), evidence='模型伪造了记录')]:
        with pytest.raises(LivingError):
            ai.complete(task['id'], invalid)
    ai.complete(task['id'], result(facts))
    saved = CompetitionAIStore(engine, ai.clock).read(OWNER, m['id'])['participants'][str(ids[0])]['ai_reflection']
    assert saved['evidence'] == facts['experience'][0]['text']
    assert s.inventory(OWNER) == before


def test_experience_summary_uses_completed_actions_not_full_field():
    from app.living.competition_ai import experiences
    assert experiences('observe', dict(targets=[0, 4, 2], layout=[])) == [
        dict(id='observed_0', text='本场观察了2处树木目标。'), dict(id='observed_2', text='本场观察了1处蘑菇目标。')]
    assert experiences('leaves', dict(targets=[2, 9], layout=[])) == [dict(id='collected_leaf', text='本场收集了2片落叶。')]
    assert experiences('garden', dict(targets=[], layout=[dict(kind='bench', x=10, y=25)])) == [
        dict(id='placed_bench', text='本场摆放了1件长椅。')]
    assert experiences('observe', dict(targets=[], layout=[])) == [
        dict(id='completed', text='本场已正常完赛，没有已核验的行动。')]


@pytest.mark.parametrize('failure', ['factory', 'catalog', 'provider', 'invalid'])
def test_failure_stops_without_retry(arena, failure):
    _, ai, m, _, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    calls = []
    async def catalog():
        if failure == 'catalog':
            raise RuntimeError()
    class Adapter:
        async def suggest(self, facts):
            calls.append(1)
            if failure == 'provider':
                raise TimeoutError()
            return {'order': [], 'text': '错误。'}
    def factory():
        if failure == 'factory':
            raise RuntimeError()
        return Adapter()
    asyncio.run(run_suggestion(ai, task, factory, catalog))
    state = ai.status(OWNER, m['id'])['tasks'][0]['state']
    assert state == ('unknown' if failure == 'provider' else 'failed')
    assert len(calls) == (1 if failure in ('provider', 'invalid') else 0)


def test_decoder_and_http_switch(arena, client, anon):
    _, ai, m, _, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    facts = json.loads(task['facts_json'])
    envelope = dict(model=MODEL, choices=[dict(finish_reason='stop', message=dict(role='assistant', content=json.dumps(result(facts))))])
    assert decode(json.dumps(envelope).encode(), facts) == result(facts)
    envelope['choices'][0]['finish_reason'] = 'length'
    with pytest.raises(LivingError):
        decode(json.dumps(envelope).encode(), facts)
    path = '/api/v1/activities/' + m['id'] + '/ai'
    assert anon.get(path).status_code == 401
    assert client.get(path).json()['available'] is False
    response = client.post(path, json=dict(request_id=str(uuid4()), grant_id=gid, character_id=ids[0], phase='strategy'))
    assert response.status_code == 409
    assert response.json()['error']['code'] == 'competition_ai_unavailable'


def test_adapter_retains_invalid_provider_envelope_without_exposing_it(arena):
    import httpx
    _, ai, m, _, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={'model': MODEL, 'choices': []})
    async def catalog():
        pass
    asyncio.run(run_suggestion(ai, task,
        lambda: CompetitionAdapter('test-key', transport=httpx.MockTransport(handle)), catalog))
    assert len(calls) == 1
    with engine.connect() as conn:
        row = conn.execute(select(tasks).where(tasks.c.id == task['id'])).mappings().one()
        assert json.loads(row['response_json'])['choices'] == []
        assert row['state'] == 'failed'
    public = json.dumps(ai.status(OWNER, m['id']))
    assert 'response_json' not in public and 'test-key' not in public


def test_corrupt_saved_strategy_cannot_settle(arena):
    from app.living.competitions import matches
    from sqlalchemy import update
    s, ai, m, clock, ids, gid = setup(arena)
    m = run(s, m, 'start')
    m['participants'][str(ids[0])]['ai_strategy'] = dict(order=[999] * 20, text='bad')
    with engine.begin() as conn:
        conn.execute(update(matches).where(matches.c.id == m['id']).values(state_json=json.dumps(m)))
    clock[0] += 180
    with pytest.raises(LivingError) as exc:
        s.read(OWNER, m['id'])
    assert exc.value.code == 'corrupt_state'
    assert s.inventory(OWNER)['balance'] == 0


def test_api_one_successful_request_replayed_without_second_call(arena, client, monkeypatch):
    import app.api.competitions as api
    _, ai, m, _, ids, gid = setup(arena)
    calls = []
    class Adapter:
        async def suggest(self, facts):
            calls.append(facts)
            return result(facts)
    async def catalog():
        pass
    async def execute(store, task, factory):
        await run_suggestion(store, task, lambda: Adapter(), catalog)
    monkeypatch.setattr(api, 'ai_store', ai)
    monkeypatch.setattr(api, 'ai_available', lambda: True)
    monkeypatch.setattr(api, 'run_suggestion', execute)
    payload = dict(request_id=str(uuid4()), grant_id=gid, character_id=ids[0], phase='strategy')
    path = '/api/v1/activities/' + m['id'] + '/ai'
    first = client.post(path, json=payload)
    second = client.post(path, json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert len(calls) == 1


@pytest.mark.parametrize('code', ['provider_read_timeout', 'provider_http_401', 'provider_http_429', 'provider_deadline'])
def test_preserves_safe_provider_failure_code_for_diagnosis(arena, code):
    _, ai, m, _, ids, gid = setup(arena)
    task, _ = prepare(ai, m, ids[0], gid)
    class Adapter:
        async def suggest(self, facts):
            raise LivingError(code, 'private provider detail must not be exposed')
    async def catalog():
        pass
    asyncio.run(run_suggestion(ai, task, lambda: Adapter(), catalog))
    saved = ai.status(OWNER, m['id'])['tasks'][0]
    assert saved['error_code'] == code and saved['state'] == 'unknown'
    assert 'private provider' not in json.dumps(saved)


@pytest.mark.parametrize('phase', ['strategy', 'reflection'])
def test_competition_request_uses_bounded_non_thinking_transport(arena, phase):
    import httpx
    from app.living.life_provider import MaaSPlannerAdapter
    _, ai, m, _, ids, gid = setup(arena, phase=phase)
    task, _ = prepare(ai, m, ids[0], gid, phase=phase)
    facts = json.loads(task['facts_json'])
    calls = []
    def handle(request):
        calls.append(request)
        payload = json.loads(request.content)
        assert json.loads(payload['messages'][1]['content']) == facts
        assert facts['personality']['description']
        if phase == 'reflection':
            assert facts['experience']
        assert payload['enable_thinking'] is False
        assert payload['model'] == MODEL and payload['max_tokens'] == 512
        assert request.extensions['timeout']['read'] == 30
        assert request.extensions['timeout']['connect'] == 5
        return httpx.Response(200, json=dict(model=MODEL, choices=[dict(finish_reason='stop',
            message=dict(role='assistant', content=json.dumps(result(facts))))]))
    async def catalog():
        pass
    asyncio.run(run_suggestion(ai, task,
        lambda: CompetitionAdapter('test-key', transport=httpx.MockTransport(handle)), catalog))
    assert len(calls) == 1
    assert ai.status(OWNER, m['id'])['tasks'][0]['state'] == 'done'
    assert MaaSPlannerAdapter.read_timeout == 12
    assert MaaSPlannerAdapter.request_deadline == 15
    assert MaaSPlannerAdapter.request_options == {}
