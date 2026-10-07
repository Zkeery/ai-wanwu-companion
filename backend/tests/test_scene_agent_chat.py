"""Offline HTTP integration; no provider calls, real accounts, or production data."""
import json
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import select, update

from app.core.config import get_settings
from app.core.database import SessionLocal, engine
from app.models.models import Message, SceneAgentChat, SceneProposal
from app.scene_agent import chat as host
from app.scene_agent.adapter import ProviderAdapter
from app.scene_agent.runtime import runs
from tests.auth_helpers import TEST_USER_ID
from tests.test_scene_bridge import home, act
from tests.test_scene_agent_runtime import Scripted, tool


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(get_settings(), "scene_agent_enabled", True)
    adapter = Scripted(tool("read_scene"), tool("propose_scene_action", action="plant_tree"))
    monkeypatch.setattr(host, "ProviderAdapter", lambda: adapter)
    return adapter


def send(client, cid, parse_sse, key=None, message="想给这里添一片绿意"):
    key = key or str(uuid4())
    response = client.post(f"/api/v1/characters/{cid}/chat", json={"message": message, "request_id": key})
    assert response.status_code == 200, response.text
    events = parse_sse(response.text)
    assert events[0] == ("task", {"request_id": key})
    assert events[-1][0] in ("done", "error")
    return key, events[-1], events


def request_state(client, cid, key):
    return client.get(f"/api/v1/characters/{cid}/chat/requests/{key}")


def test_agent_request_is_idempotent_and_confirmation_is_exactly_once(client, ready_character_id, enabled, parse_sse):
    cid = ready_character_id
    snap = home(client, cid)
    key, (_, done), _ = send(client, cid, parse_sse)
    proposal = done["proposal"]
    assert proposal["action"] == "plant_tree"
    assert not client.get('/api/v1/living/spaces/' + snap['id']).json()['items']
    _, (_, duplicate), _ = send(client, cid, parse_sse, key)
    assert duplicate == done and len(enabled.calls) == 2
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=cid).count() == 2
    assert request_state(client, cid, key).json()['result'] == done
    base = f"/api/v1/characters/{cid}/scene/proposals/{proposal['id']}/confirm"
    assert client.post(base).status_code == 200
    assert client.post(base).status_code == 409
    assert len(client.get('/api/v1/living/spaces/' + snap['id']).json()['items']) == 1
    assert request_state(client, cid, key).json()['result']['proposal'] is None
    assert send(client, cid, parse_sse, key)[1][1]['proposal'] is None
    assert len(enabled.calls) == 2


def test_reject_does_not_modify_scene_or_restore_proposal(client, ready_character_id, enabled, parse_sse):
    snap = home(client, ready_character_id)
    key, (_, done), _ = send(client, ready_character_id, parse_sse)
    response = client.post(f"/api/v1/characters/{ready_character_id}/scene/proposals/{done['proposal']['id']}/reject")
    assert response.status_code == 200
    assert not client.get('/api/v1/living/spaces/' + snap['id']).json()['items']
    assert request_state(client, ready_character_id, key).json()['result']['proposal'] is None


def test_reusing_key_with_new_text_is_conflict(client, ready_character_id, enabled, parse_sse):
    home(client, ready_character_id)
    key, _, _ = send(client, ready_character_id, parse_sse)
    res = client.post(f'/api/v1/characters/{ready_character_id}/chat', json={'message':'different', 'request_id':key})
    assert res.status_code == 409 and len(enabled.calls) == 2


def test_auth_and_other_owner_cannot_read_task(client, anon, ready_character_id, enabled, parse_sse):
    from datetime import datetime, timedelta
    from app.models.models import User, Session
    from app.core.security import hash_token
    home(client, ready_character_id)
    key, _, _ = send(client, ready_character_id, parse_sse)
    url = f'/api/v1/characters/{ready_character_id}/chat/requests/{key}'
    assert anon.get(url).status_code == 401
    token = 'isolated-other-user-token'
    with SessionLocal() as db:
        other = User(id=str(uuid4()), phone='13900000088')
        db.add(other)
        db.flush()
        db.add(Session(token_hash=hash_token(token), user_id=other.id,
                       expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    assert client.get(url, headers={'Authorization': 'Bearer ' + token}).status_code == 404


def test_host_completed_result_survives_new_process(client, ready_character_id, enabled, parse_sse):
    import os
    import subprocess
    import sys
    home(client, ready_character_id)
    key, (_, done), _ = send(client, ready_character_id, parse_sse)
    script = '''
import json, sys
from app.scene_agent import chat
chat.initialize()
chat.recover_interrupted()
print(json.dumps(chat.read_request(sys.argv[1], int(sys.argv[2]), sys.argv[3])))
'''
    result = subprocess.run([sys.executable, '-c', script, TEST_USER_ID, str(ready_character_id), key],
                            env=os.environ.copy(), capture_output=True, text=True, timeout=10, check=True)
    restored = json.loads(result.stdout)
    assert restored['status'] == 'completed' and restored['result'] == done
    assert len(enabled.calls) == 2


@pytest.mark.parametrize('change', ['revision', 'roundtrip', 'delete_space', 'remove_member'])
def test_changed_scene_never_executes_stale_proposal(client, ready_character_id, enabled, parse_sse, change):
    cid = ready_character_id
    snap = home(client, cid, mode='shared' if change == 'remove_member' else 'private')
    if change == 'remove_member':
        client.post(f"/api/v1/living/spaces/{snap['id']}/members", json={'companion_id': str(cid)})
        client.put(f'/api/v1/characters/{cid}/location', json={'space_id': snap['id']})
    key, (_, done), _ = send(client, cid, parse_sse)
    if change == 'revision':
        assert act(client, snap, {'action':'place', 'kind':'flower', 'x':.3, 'y':.4}).status_code == 200
    elif change == 'roundtrip':
        desert = home(client, cid, 'desert')
        for sid in [desert['id'], snap['id']]:
            client.put(f'/api/v1/characters/{cid}/location', json={'space_id':sid})
    elif change == 'remove_member':
        client.delete(f"/api/v1/living/spaces/{snap['id']}/members/{cid}")
    else:
        client.delete('/api/v1/living/spaces/' + snap['id'])
    assert request_state(client, cid, key).json()['result']['proposal'] is None
    assert client.post(f"/api/v1/characters/{cid}/scene/proposals/{done['proposal']['id']}/confirm").status_code == 409


@pytest.mark.parametrize('operation', ['clear', 'delete'])
def test_clear_and_delete_remove_tasks_and_late_results(client, ready_character_id, enabled, parse_sse, operation):
    cid = ready_character_id
    home(client, cid)
    def deleted(_history):
        suffix = '/messages' if operation == 'clear' else ''
        assert client.delete(f'/api/v1/characters/{cid}' + suffix).status_code == 204
        return tool('propose_scene_action', action='plant_tree')
    enabled.steps[-1] = deleted
    _, (event, _), _ = send(client, cid, parse_sse)
    assert event == 'error'
    with SessionLocal() as db:
        assert db.query(SceneAgentChat).count() == 0
        assert db.execute(select(runs.c.id)).first() is None
        assert db.query(Message).filter_by(character_id=cid).count() == 0
        assert db.query(SceneProposal).count() == 0


def test_clear_before_stream_start_cannot_recreate_task(client, ready_character_id, enabled):
    cid = ready_character_id
    home(client, cid)
    response = host.prepare(TEST_USER_ID, cid, '一起种树', str(uuid4()))
    assert client.delete(f'/api/v1/characters/{cid}/messages').status_code == 204
    # StreamingResponse wraps the sync iterator; consume through its async iterator.
    import asyncio
    async def consume():
        return ''.join([chunk async for chunk in response.body_iterator])
    assert 'event: error' in asyncio.run(consume())
    assert not enabled.calls
    with engine.connect() as conn:
        assert conn.execute(select(runs.c.id)).first() is None


def test_deletion_between_loading_and_reserving_is_guarded(client, ready_character_id, enabled, parse_sse, monkeypatch):
    cid = ready_character_id
    home(client, cid)
    original = host.runtime.start
    def cleared(*args, **kwargs):
        assert client.delete(f'/api/v1/characters/{cid}/messages').status_code == 204
        return original(*args, **kwargs)
    monkeypatch.setattr(host.runtime, 'start', cleared)
    assert send(client, cid, parse_sse)[1][0] == 'error'
    assert not enabled.calls
    with engine.connect() as conn:
        assert conn.execute(select(runs.c.id)).first() is None


def test_concurrent_http_retry_does_not_duplicate_messages_or_decisions(client, ready_character_id, enabled, parse_sse):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    cid = ready_character_id
    home(client, cid)
    key = str(uuid4())
    entered, release = Event(), Event()
    def paused(_history):
        entered.set()
        assert release.wait(5)
        return tool('read_scene')
    enabled.steps[0] = paused
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(send, client, cid, parse_sse, key)
        try:
            assert entered.wait(5)
            _, (kind, data), _ = send(client, cid, parse_sse, key)
            assert kind == 'error' and data['error']['code'] == 'in_progress'
            assert request_state(client, cid, key).json()['status'] == 'running'
        finally:
            release.set()
        assert first.result(timeout=5)[1][0] == 'done'
    assert len(enabled.calls) == 2
    with SessionLocal() as db:
        assert db.query(Message).filter_by(character_id=cid).count() == 2


def test_late_suggestion_after_location_change_is_cancelled(client, ready_character_id, enabled, parse_sse):
    cid = ready_character_id
    home(client, cid)
    desert = home(client, cid, 'desert')
    def moved(_history):
        client.put(f'/api/v1/characters/{cid}/location', json={'space_id': desert['id']})
        return tool('propose_scene_action', action='plant_tree')
    enabled.steps[-1] = moved
    _, (_, result), _ = send(client, cid, parse_sse)
    assert result['proposal'] is None and result['action'] is None
    assert '建议已取消' in result['message']['content']


def test_newer_chat_cannot_lose_its_proposal_to_late_reply(client, ready_character_id, enabled, parse_sse, monkeypatch):
    cid = ready_character_id
    home(client, cid)
    newer = {}
    def second_chat(_history):
        next_adapter = Scripted(tool('read_scene'), tool('propose_scene_action', action='plant_flower'))
        monkeypatch.setattr(host, 'ProviderAdapter', lambda: next_adapter)
        _, (_, done), _ = send(client, cid, parse_sse, message='种花')
        newer.update(done['proposal'])
        return tool('propose_scene_action', action='plant_tree')
    enabled.steps[-1] = second_chat
    _, (event, _), _ = send(client, cid, parse_sse)
    assert event == 'error'
    scene = client.get(f'/api/v1/characters/{cid}/scene').json()
    assert scene['proposal']['id'] == newer['id']


def test_context_keeps_memory_and_history_and_scene_whitelist(client, ready_character_id, enabled, parse_sse):
    cid = ready_character_id
    desert = home(client, cid, 'desert')
    client.put(f'/api/v1/characters/{cid}/location', json={'space_id': desert['id']})
    client.post(f'/api/v1/characters/{cid}/memories', json={'content':'我喜欢清晨'})
    with SessionLocal() as db:
        db.add(Message(character_id=cid, role='user', content='昨天的散步很开心'))
        db.commit()
    _, (_, done), _ = send(client, cid, parse_sse)
    assert done['proposal']['action'] == 'plant_tree'
    serialized = json.dumps(enabled.calls[0][0], ensure_ascii=False)
    assert '我喜欢清晨' in serialized and '昨天的散步很开心' in serialized
    assert enabled.calls[1][0][-1]['content']['allowed_actions'] == {
        'plant_tree': '种树', 'add_pond': '添个水池', 'place_bench': '放张长椅'}
    # The proposed action code is returned, but no object exists before confirmation.
    assert not client.get('/api/v1/living/spaces/' + desert['id']).json()['items']


def test_adapter_failure_is_persisted_and_not_retried(client, ready_character_id, enabled, parse_sse):
    home(client, ready_character_id)
    def fail(_history):
        raise RuntimeError('private-value')
    enabled.steps = [fail]
    key, (kind, payload), _ = send(client, ready_character_id, parse_sse)
    assert kind == 'error' and 'private-value' not in json.dumps(payload)
    assert request_state(client, ready_character_id, key).json()['status'] == 'failed'
    assert send(client, ready_character_id, parse_sse, key)[1][0] == 'error'
    assert len(enabled.calls) == 1


def test_startup_recovery_fails_unstarted_task_without_paid_calls(client, ready_character_id, enabled, parse_sse):
    home(client, ready_character_id)
    key = str(uuid4())
    host.prepare(TEST_USER_ID, ready_character_id, '想给这里添一片绿意', key)
    host.recover_interrupted()
    assert request_state(client, ready_character_id, key).json()['error']['code'] == 'interrupted'
    assert send(client, ready_character_id, parse_sse, key)[1][0] == 'error'
    assert not enabled.calls


def test_validates_request_key_without_requiring_living_space(client, ready_character_id, enabled):
    url = f'/api/v1/characters/{ready_character_id}/chat'
    assert client.post(url, json={'message':'hi','request_id':'bad'}).status_code == 422
    assert not enabled.calls
    assert client.post(url, json={'message':'hi'}).status_code == 200
    assert len(enabled.calls) == 2


def test_default_flag_preserves_existing_chat(client, ready_character_id, parse_sse):
    assert not get_settings().scene_agent_enabled
    response = client.post(f'/api/v1/characters/{ready_character_id}/chat', json={'message':'种树'})
    assert parse_sse(response.text)[-1][0] == 'done'
    with SessionLocal() as db:
        assert db.query(SceneAgentChat).count() == 0


@pytest.mark.parametrize('mode', ['success','429','malformed','truncated','oversized','init_failure'])
def test_provider_contract_single_attempt_and_no_mock_fallback(mode):
    from types import SimpleNamespace
    calls = []
    settings = SimpleNamespace(use_mock=False, model_base_url='https://test.invalid/v1', model_api_key='test-only',
                               chat_model='configured-model', model_timeout_seconds=60, model_enable_thinking=None)
    def handle(request):
        calls.append(request)
        if mode == '429':
            return httpx.Response(429)
        content = 'x' * 66000 if mode == 'oversized' else 'not json' if mode == 'malformed' else json.dumps({'type':'finish','reply':'hi'})
        return httpx.Response(200, json={'choices':[{'finish_reason':'length' if mode == 'truncated' else 'stop', 'message':{'content':content}}]})
    def factory(**kwargs):
        assert kwargs['timeout'].read == 4.0
        if mode == 'init_failure':
            raise RuntimeError('initialization failed')
        return httpx.Client(**kwargs, transport=httpx.MockTransport(handle))
    adapter = ProviderAdapter(settings_factory=lambda: settings, client_factory=factory)
    history = [{'role':'system','content':'system'}, {'role':'tool','name':'read_scene','content':{'allowed_actions':{'plant_tree':'种树'}}}]
    if mode == 'success':
        assert adapter.decide(history, timeout_seconds=4.0) == {'type':'finish','reply':'hi'}
        payload = json.loads(calls[0].content)
        assert payload['model'] == 'configured-model' and payload['stream'] is False
        assert payload['messages'][-1]['role'] == 'user' and 'tool_result' in payload['messages'][-1]['content']
    else:
        with pytest.raises(Exception):
            adapter.decide(history, timeout_seconds=4.0)
    assert len(calls) == (0 if mode == 'init_failure' else 1)


def test_r41_record_remains_readable_without_new_conversation_field(client, ready_character_id, enabled, parse_sse):
    from app.scene_agent.runtime import Runtime
    from tests.test_scene_agent_runtime import Scripted
    from sqlalchemy import create_engine
    local = create_engine('sqlite://')
    r = Runtime(local)
    r.initialize()
    context = {'companion_id':1,'source_message_id':2,'name':'n','persona':'p','space_id':str(uuid4()),'scene_type':'home',
               'revision':0,'location_epoch':0,'elements':{}}
    run = r.start('a', str(uuid4()), context, 'hi', Scripted({'type':'finish','reply':'hello'}))
    old = run.model_dump()
    del old['context']['conversation']
    with local.begin() as conn:
        conn.execute(update(runs).where(runs.c.id == run.id).values(state_json=json.dumps(old)))
    assert r.read('a', run.id).reply == 'hello'
    local.dispose()


def test_new_companion_can_chat_before_selecting_home(client, ready_character_id, enabled, parse_sse, monkeypatch):
    adapter = Scripted({'type': 'finish', 'reply': '你好，我在这里陪着你。'})
    monkeypatch.setattr(host, 'ProviderAdapter', lambda: adapter)
    key, (event, done), _ = send(client, ready_character_id, parse_sse, message='你好')
    assert event == 'done' and done['proposal'] is None
    assert done['message']['content'] == '你好，我在这里陪着你。'
    assert client.get(f'/api/v1/characters/{ready_character_id}/location').json()['space_id'] is None
    assert send(client, ready_character_id, parse_sse, key, message='你好')[1][1] == done
    assert len(adapter.calls) == 1
    assert request_state(client, ready_character_id, key).json()['status'] == 'completed'


def test_no_home_action_prompts_selection_then_new_home_can_receive_proposal(client, ready_character_id, enabled, parse_sse, monkeypatch):
    _, (event, done), _ = send(client, ready_character_id, parse_sse)
    assert event == 'done' and done['proposal'] is None
    assert '选一个住处' in done['message']['content']
    assert client.get('/api/v1/living/spaces').json() == []
    home(client, ready_character_id)
    monkeypatch.setattr(host, 'ProviderAdapter', lambda: Scripted(tool('read_scene'), tool('propose_scene_action', action='plant_tree')))
    _, (event, done), _ = send(client, ready_character_id, parse_sse)
    assert event == 'done' and done['proposal']['action'] == 'plant_tree'
