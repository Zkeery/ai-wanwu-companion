"""Shared output stays strict; failures retain safe actionable codes without text."""
import asyncio
import json

import httpx
import pytest

from app.living.gathering_dialogue import DialogueStore, MaaSDialogueAdapter, decode_exchange, run_exchange
from app.living.life_provider import MODEL, MaaSPlannerAdapter
from app.living.rules import LivingError
from tests.test_gathering_dialogue import ready, begin, result, catalog, UID  # noqa: F401


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect', lambda *_: pytest.fail('external network forbidden'))


def envelope(content):
    return {'model': MODEL, 'choices': [{'finish_reason': 'stop', 'message': {
        'role': 'assistant', 'content': content}}]}


def test_shared_request_sends_strict_schema_without_changing_other_adapters():
    calls = []
    def handler(request):
        body = json.loads(request.content)
        calls.append(body)
        assert body['enable_thinking'] is False
        fmt = body['response_format']
        assert fmt['type'] == 'json_schema' and fmt['json_schema']['strict'] is True
        schema = fmt['json_schema']['schema']
        assert schema['additionalProperties'] is False
        assert schema['properties']['lines']['minItems'] == schema['properties']['lines']['maxItems'] == 2
        assert schema['$defs']['Line']['properties']['character_id']['type'] == 'integer'
        assert schema['$defs']['Line']['additionalProperties'] is False
        assert body['max_tokens'] == 512 and body['stream'] is False
        assert request.extensions['timeout']['read'] == 12
        return httpx.Response(200, json=envelope(json.dumps(result([1, 2]))))
    client = MaaSDialogueAdapter('synthetic-key', transport=httpx.MockTransport(handler))
    reply = asyncio.run(client.exchange({'participants': [{'character_id': 1}, {'character_id': 2}]}))
    assert reply == result([1, 2]) and len(calls) == 1
    assert MaaSPlannerAdapter.request_options == {} and client.request_deadline == 15


@pytest.mark.parametrize('kind,code', [
    ('json', 'dialogue_json_invalid'), ('schema', 'dialogue_schema_invalid'),
    ('text', 'dialogue_text_invalid'), ('envelope', 'dialogue_envelope_invalid'),
    ('incomplete', 'dialogue_incomplete'), ('participants', 'dialogue_participants_invalid'),
    ('items', 'dialogue_items_invalid'),
])
def test_each_validation_failure_persists_without_publication_refund_or_replay(ready, kind, code):
    store, clock, group, ids, _ = ready
    task, _ = begin(ready)
    calls = []
    class Client:
        async def exchange(self, facts):
            calls.append(1)
            answer = result(ids)
            if kind == 'schema': answer['lines'][0]['character_id'] = str(ids[0])
            if kind == 'text': answer['lines'][0]['text'] = 'PRIVATE_TEXT\nnot allowed'
            if kind == 'participants': answer['lines'][0]['character_id'] = 999999
            if kind == 'items': answer['lines'][0]['item_ids'] = ['invented']
            body = envelope('```json\nPRIVATE_TEXT' if kind == 'json' else json.dumps(answer))
            if kind == 'envelope': body['model'] = 'wrong-model'
            if kind == 'incomplete': body['choices'][0]['finish_reason'] = 'length'
            return decode_exchange(json.dumps(body).encode())
    asyncio.run(run_exchange(store, task, Client, catalog))
    state = DialogueStore(store.engine, lambda: clock[0]).read(UID, group['id'])
    assert state['tasks'][0]['state'] == 'failed' and state['tasks'][0]['error_code'] == code
    assert state['tasks'][0]['dispatched'] and not state['grants'] and not state['exchanges']
    assert 'PRIVATE_TEXT' not in json.dumps(state) and calls == [1]
    with pytest.raises(LivingError): store.dispatch(task['id'])


@pytest.mark.parametrize('exception,code', [
    (LivingError('provider_read_timeout', 'PRIVATE_PROVIDER'), 'provider_read_timeout'),
    (LivingError('provider_http_503', 'PRIVATE_PROVIDER'), 'provider_http_503'),
    (TimeoutError('PRIVATE_PROVIDER'), 'provider_deadline'),
    (LivingError('PRIVATE_PROVIDER', 'PRIVATE_PROVIDER'), 'provider_error'),
])
def test_transport_failure_is_unknown_and_preserves_only_safe_code(ready, exception, code):
    store, _, group, _, _ = ready
    task, _ = begin(ready)
    calls = []
    class Client:
        async def exchange(self, facts):
            calls.append(1)
            raise exception
    asyncio.run(run_exchange(store, task, Client, catalog))
    state = store.read(UID, group['id'])
    assert state['tasks'][0]['state'] == 'unknown' and state['tasks'][0]['error_code'] == code
    assert not state['grants'] and not state['exchanges'] and calls == [1]
    assert 'PRIVATE_PROVIDER' not in json.dumps(state)
