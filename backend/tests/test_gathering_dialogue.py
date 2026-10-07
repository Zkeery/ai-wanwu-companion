import asyncio
import json
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.database import engine, SessionLocal
from app.living.gathering_dialogue import DialogueStore, grants, tasks, run_exchange, parse_exchange, decode_exchange
from app.living.life_provider import MODEL, RESERVE_MICRO
from app.living.rules import LivingError
from app.models.models import Character, CharacterPersonality, Message
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member


@pytest.fixture
def ready(ready_character_id):
    cid = ready_character_id
    with SessionLocal() as db:
        c = db.get(Character, cid)
        c.persona = 'PRIVATE_PERSONA'
        other = Character(object_id=c.object_id, owner_id=UID, name='另一个伙伴', persona='PRIVATE_OTHER', opening_line='', status='ready')
        db.add(other); db.flush(); second = other.id
        db.add(CharacterPersonality(character_id=cid, mode='custom', original_persona='PRIVATE_ORIGINAL', tags_json='["curious"]', custom_text='PRIVATE_CUSTOM'))
        db.add(Message(character_id=cid, role='user', content='PRIVATE_CHAT'))
        db.commit()
    clock = [1800000000]
    store = DialogueStore(engine, lambda: clock[0])
    g = create(store)
    for id in [cid, second]:
        g = command(store, g, 'visit', character_id=id)
        g = command(store, g, 'dialogue_consent', character_id=id, enabled=True)
    g = command(store, g, 'dialogue_space', enabled=True)
    ids = [cid, second]
    grant = store.authorize(UID, g['id'], ids, str(uuid4()))
    return store, clock, g, ids, grant


def begin(ready, rid=None):
    s, _, g, ids, grant = ready
    return s.prepare(UID, g['id'], rid or str(uuid4()), g['revision'], ids, grant)


def result(ids):
    return {'lines': [{'character_id': id, 'text': '看看眼前的风景吧。', 'item_ids': []} for id in ids]}


async def catalog():
    return {'verified': True}


def test_private_facts_excluded_and_restart_reads_same_exchange(ready):
    s, clock, g, ids, grant = ready
    t, fresh = begin(ready)
    assert fresh and 'PRIVATE_' not in t['facts_json']
    assert json.loads(t['facts_json'])['participants'][0]['traits'] == ['好奇探索']
    captured = []
    class Client:
        async def exchange(self, facts):
            captured.append(facts)
            return result(ids)
    asyncio.run(run_exchange(s, t, Client, catalog))
    r = DialogueStore(engine, lambda: clock[0]).read(UID, g['id'])
    assert r['tasks'][0]['state'] == 'done' and len(r['exchanges']) == 1 and not r['grants']
    assert r['exchanges'][0]['origin'] == 'real_provider'
    assert 'audience' not in r['exchanges'][0]
    assert len(captured) == 1 and 'PRIVATE_' not in json.dumps(captured)
    # Persisted test-adapter records do not assert real model quality.


def test_request_replay_and_grant_reuse_cannot_dispatch_twice(ready):
    s, _, g, ids, grant = ready
    rid = str(uuid4())
    task, first = begin(ready, rid)
    same, second = begin(ready, rid)
    assert first and not second and task['id'] == same['id']
    with pytest.raises(LivingError): begin(ready)
    with pytest.raises(LivingError): s.prepare(UID, g['id'], rid, g['revision'], list(reversed(ids)), grant)
    s.dispatch(task['id'])
    with pytest.raises(LivingError): s.dispatch(task['id'])
    with engine.connect() as c:
        assert c.execute(select(grants.c.used).where(grants.c.id == grant)).scalar() == 1


@pytest.mark.parametrize('change', ['recall', 'consent', 'space', 'join', 'activity', 'location', 'traits'])
def test_change_during_model_call_does_not_publish(ready, change):
    s, _, g, ids, _ = ready
    task, _ = begin(ready)
    class Client:
        async def exchange(self, facts):
            if change == 'recall': command(s, g, 'recall', character_id=ids[0])
            elif change == 'consent': command(s, g, 'dialogue_consent', character_id=ids[0], enabled=False)
            elif change == 'space': command(s, g, 'dialogue_space', enabled=False)
            elif change == 'join': member(s, g, 'new-member')
            elif change == 'activity': command(s, g, 'activity', character_ids=[ids[0]], activity='rest')
            else:
                with SessionLocal() as db:
                    if change == 'location': db.get(Character, ids[0]).current_space_id = None
                    else: db.get(CharacterPersonality, ids[0]).tags_json = '["quiet"]'
                    db.commit()
            return result(ids)
    asyncio.run(run_exchange(s, task, Client, catalog))
    state = s.read(UID, g['id'])
    assert state['tasks'][0]['state'] == 'failed' and not state['exchanges'] and not state['grants']


@pytest.mark.parametrize('failure', ['catalog', 'factory', 'provider', 'invalid', 'participant', 'item'])
def test_failures_do_not_publish_or_refund_grant(ready, failure):
    s, _, g, ids, _ = ready
    task, _ = begin(ready)
    class Client:
        async def exchange(self, facts):
            if failure == 'provider': raise TimeoutError()
            r = result(ids)
            if failure == 'invalid': r['tool'] = 'place'
            if failure == 'participant': r['lines'][0]['character_id'] = 9999
            if failure == 'item': r['lines'][0]['item_ids'] = ['invented-tree']
            return r
    def factory():
        if failure == 'factory': raise ValueError('private details')
        return Client()
    async def price():
        if failure == 'catalog': raise ValueError('private details')
    asyncio.run(run_exchange(s, task, factory, price))
    state = s.read(UID, g['id'])
    assert not state['exchanges'] and not state['grants']
    assert state['tasks'][0]['state'] == ('unknown' if failure == 'provider' else 'failed')
    assert state['tasks'][0]['dispatched'] == (failure not in ('catalog', 'factory'))
    assert 'private details' not in json.dumps(state)


def test_interrupted_task_becomes_unknown_without_retry(ready):
    s, clock, g, _, _ = ready
    task, _ = begin(ready)
    s.dispatch(task['id']); clock[0] += 61
    state = DialogueStore(engine, lambda: clock[0]).read(UID, g['id'])
    assert state['tasks'][0]['state'] == 'unknown' and not state['grants']
    with pytest.raises(LivingError): s.dispatch(task['id'])


def test_late_joiner_does_not_receive_prior_dialogue(ready):
    s, _, g, ids, _ = ready
    task, _ = begin(ready); s.dispatch(task['id']); s.complete(task['id'], result(ids))
    snapshot = super(DialogueStore, s).read(UID, g['id'])
    joined = member(s, snapshot, 'late-member')
    assert not s.read('late-member', g['id'])['exchanges']
    late_snapshot = super(DialogueStore, s).read('late-member', g['id'])
    assert not any(e.get('kind') == 'dialogue' for e in late_snapshot['events'])
    command(s, joined, 'remove', member_id='late-member')
    with pytest.raises(LivingError): s.read('late-member', g['id'])


def test_owner_consent_and_single_use_ref_enforced(ready):
    s, _, g, ids, grant = ready
    g = member(s, g, 'other')
    with pytest.raises(LivingError): command(s, g, 'dialogue_consent', uid='other', character_id=ids[0], enabled=True)
    with pytest.raises(LivingError): command(s, g, 'dialogue_space', uid='other', enabled=False)
    with pytest.raises(LivingError): s.authorize('other', g['id'], ids, 'not-own')
    with pytest.raises(LivingError): s.authorize(UID, g['id'], ids, 'invalid-cap', cap_micro=RESERVE_MICRO-1)
    s.authorize(UID, g['id'], ids, 'unique-test-ref')
    with pytest.raises(LivingError): s.authorize(UID, g['id'], ids, 'unique-test-ref')
    g = command(s, g, 'recall', character_id=ids[0])
    g = command(s, g, 'visit', character_id=ids[0])
    assert not next(c for c in g['companions'] if c['id'] == ids[0]).get('dialogue_allowed')


@pytest.mark.parametrize('raw', ['{}', '{"lines":[],"lines":[]}', 'null', '{"lines":NaN}', 'x'*5000])
def test_strict_output(raw):
    with pytest.raises(LivingError): parse_exchange(raw)


def test_provider_envelope_rejects_truncation_and_tool_calls():
    body = {'model': MODEL, 'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': json.dumps(result([1,2]))}}]}
    assert len(decode_exchange(json.dumps(body).encode())['lines']) == 2
    body['choices'][0]['finish_reason'] = 'length'
    with pytest.raises(LivingError): decode_exchange(json.dumps(body).encode())
    body['choices'][0]['finish_reason'] = 'stop'; body['choices'][0]['message']['tool_calls'] = [{}]
    with pytest.raises(LivingError): decode_exchange(json.dumps(body).encode())


def test_api_defaults_disabled_no_grant_or_call(client, anon, ready):
    _, _, g, ids, grant = ready
    url = f"/api/v1/gatherings/{g['id']}/dialogue"
    assert client.get(url).json()['available'] is False
    assert anon.get(url).status_code == 401
    r = client.post(url, json={'request_id':str(uuid4()), 'expected_revision':g['revision'], 'character_ids':ids, 'grant_id':grant})
    assert r.status_code == 409
    with engine.connect() as c:
        assert c.execute(select(tasks.c.id)).first() is None


def test_enabled_api_persists_one_exchange_and_replay_does_not_call(client, ready, monkeypatch):
    from app.api import gatherings as api
    store, _, g, ids, grant = ready
    calls = []
    class Client:
        async def exchange(self, facts):
            calls.append(facts)
            return result(ids)
    async def run(s, task, factory):
        await run_exchange(s, task, factory, catalog)
    monkeypatch.setattr(api, 'dialogue_store', store)
    monkeypatch.setattr(api, 'dialogue_available', lambda: True)
    monkeypatch.setattr(api, 'MaaSDialogueAdapter', lambda _: Client())
    monkeypatch.setattr(api, 'run_exchange', run)
    url = f"/api/v1/gatherings/{g['id']}/dialogue"
    payload = dict(request_id=str(uuid4()), expected_revision=g['revision'], character_ids=ids, grant_id=grant)
    first = client.post(url, json=payload)
    assert first.status_code == 200 and first.json()['tasks'][0]['state'] == 'done'
    assert client.post(url, json=payload).json()['exchanges'] == first.json()['exchanges']
    assert len(calls) == 1
    assert client.get(url).json()['exchanges'] == first.json()['exchanges']


def publish_next(store, gid, ids, text):
    group = super(DialogueStore, store).read(UID, gid)
    grant = store.authorize(UID, gid, ids, str(uuid4()))
    task, _ = store.prepare(UID, gid, str(uuid4()), group['revision'], ids, grant)
    facts = store.dispatch(task['id'])
    response = result(ids)
    for line in response['lines']:
        line['text'] = text
    store.complete(task['id'], response)
    return facts


def test_next_exchange_carries_last_three_published_rounds_after_restart(ready):
    store, clock, group, ids, _ = ready
    for index in range(4):
        clock[0] += 1
        facts = publish_next(store, group['id'], ids, f'这是第{index + 1}次一起看风景。')
        assert len(facts['recent_exchanges']) == min(index, 3)
        assert 'PRIVATE_' not in json.dumps(facts)
    restarted = DialogueStore(engine, lambda: clock[0])
    # Participants can be selected in the opposite order without losing their history.
    facts = publish_next(restarted, group['id'], list(reversed(ids)), '接着刚才的话题聊。')
    recent = facts['recent_exchanges']
    assert len(recent) == 3
    assert [r['lines'][0]['text'] for r in recent] == [f'这是第{i}次一起看风景。' for i in (2, 3, 4)]
    assert all(set(r) == {'event_id', 'at', 'lines'} for r in recent)
    assert all(set(line) == {'character_id', 'text'} for r in recent for line in r['lines'])
    assert len({r['event_id'] for r in recent}) == 3


def test_late_member_cannot_receive_old_dialogue_through_next_model_input(ready):
    store, clock, group, ids, _ = ready
    publish_next(store, group['id'], ids, '只属于原来成员可见的旧交流。')
    current = super(DialogueStore, store).read(UID, group['id'])
    member(store, current, 'late-member')
    facts = publish_next(store, group['id'], ids, '这条交流全体当前成员可见。')
    assert facts['recent_exchanges'] == []
    facts = publish_next(store, group['id'], ids, '接着大家可见的话题。')
    assert len(facts['recent_exchanges']) == 1
    assert facts['recent_exchanges'][0]['lines'][0]['text'] == '这条交流全体当前成员可见。'
    assert '旧交流' not in json.dumps(facts, ensure_ascii=False)


@pytest.mark.parametrize('change', ['missing_memory', 'audience', 'other_pair', 'fixture_origin', 'malformed', 'future'])
def test_unshared_or_invalid_history_is_not_sent_to_model(ready, change):
    from sqlalchemy import delete
    from app.living.gatherings import memories
    store, clock, group, ids, _ = ready
    publish_next(store, group['id'], ids, '这条过去的交流不能被误用。')
    with store.transaction() as conn:
        state, revision = store.load(conn, group['id'])
        event = next(e for e in reversed(state['events']) if e.get('kind') == 'dialogue')
        if change == 'missing_memory':
            conn.execute(delete(memories).where(memories.c.event_id == event['id']))
        elif change == 'audience':
            event['audience'] = []
        elif change == 'other_pair':
            event['characters'] = [ids[0], 999999]
        elif change == 'fixture_origin':
            event['origin'] = 'offline_fixture'
        elif change == 'malformed':
            event['lines'][0]['text'] = 'x' * 121
        else:
            event['at'] = clock[0] + 1
        store.save(conn, state, revision)
    facts = publish_next(store, group['id'], ids, '从当前环境开始新的话题。')
    assert facts['recent_exchanges'] == []


def test_history_requires_every_current_member_persistent_copy(ready):
    from sqlalchemy import delete
    from app.living.gatherings import memories
    store, _, group, ids, _ = ready
    member(store, group, 'other-member')
    publish_next(store, group['id'], ids, '已有audience仍必须核对每位成员的记录。')
    with store.transaction() as conn:
        conn.execute(delete(memories).where(memories.c.group_id == group['id'], memories.c.owner_id == 'other-member'))
    assert publish_next(store, group['id'], ids, '重新开始。')['recent_exchanges'] == []


def test_historical_visibility_change_during_request_prevents_publication(ready):
    from sqlalchemy import delete
    from app.living.gatherings import memories
    store, _, group, ids, _ = ready
    publish_next(store, group['id'], ids, '这一轮已发布。')
    current = super(DialogueStore, store).read(UID, group['id'])
    grant = store.authorize(UID, group['id'], ids, str(uuid4()))
    task, _ = store.prepare(UID, group['id'], str(uuid4()), current['revision'], ids, grant)
    store.dispatch(task['id'])
    with store.transaction() as conn:
        conn.execute(delete(memories).where(memories.c.group_id == group['id'], memories.c.owner_id == UID))
    with pytest.raises(LivingError, match='变化'):
        store.complete(task['id'], result(ids))
    with engine.connect() as conn:
        state, _ = store.load(conn, group['id'])
        assert len([e for e in state['events'] if e.get('kind') == 'dialogue']) == 1
