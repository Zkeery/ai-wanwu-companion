import json
import pytest
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

from sqlalchemy import delete, event, select, update
from sqlalchemy.exc import OperationalError

from app.core.database import engine
from app.living.activity import events
from app.living.store import receipts


def setup(client, cid):
    space = client.post('/api/v1/living/spaces', json={
        'scene_type': 'home', 'mode': 'private', 'companion_id': str(cid)}).json()
    return f"/api/v1/living/spaces/{space['id']}"


def act(client, root, revision, command, rid=None):
    return client.post(root + '/actions', json={'request_id': rid or str(uuid4()),
        'expected_revision': revision, 'command': command})


def test_actions_have_factual_sources_and_undo_keeps_history(client, ready_character_id):
    root = setup(client, ready_character_id)
    assert client.get(root + '/activity').json()['events'] == []
    first = act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .2}).json()
    iid = first['items'][0]['id']
    commands = [{'action': 'care', 'item_id': iid}, {'action': 'move', 'item_id': iid, 'x': .4, 'y': .3},
                {'action': 'store', 'item_id': iid}, {'action': 'restore', 'item_id': iid, 'x': .3, 'y': .4},
                {'action': 'atmosphere', 'weather': 'rain'}, {'action': 'undo'}]
    for revision, command in enumerate(commands, 1):
        assert act(client, root, revision, command).status_code == 200
    saved = client.get(root + '/activity').json()['events']
    assert [e['action'] for e in saved] == ['undo', 'atmosphere', 'restore', 'store', 'move', 'care', 'place']
    assert all(e['source'] == 'user' for e in saved)
    assert all(e['target_kind'] == 'tree' for e in saved[2:])
    assert saved[1]['weather'] == 'rain'
    snapshot = client.get(root).json()
    assert not snapshot['atmosphere']['rain']
    assert snapshot['items'][0]['care_remaining_seconds'] > 86000
    engine.dispose()
    assert client.get(root + '/activity').json()['events'] == saved


def test_failed_conflicting_and_replayed_actions_not_duplicated(client, ready_character_id):
    root = setup(client, ready_character_id)
    command = {'action': 'place', 'kind': 'flower', 'x': .2, 'y': .3}
    rid = str(uuid4())
    first = act(client, root, 0, command, rid)
    assert first.status_code == 200
    assert act(client, root, 0, command, rid).json() == first.json()
    assert act(client, root, 0, command).status_code == 409
    assert act(client, root, 1, {'action': 'care', 'item_id': first.json()['items'][0]['id']}).status_code == 409
    assert len(client.get(root + '/activity').json()['events']) == 1
    # An older receipt has no journal history. Replaying it must not fabricate history.
    with engine.begin() as conn:
        conn.execute(delete(events))
    assert act(client, root, 0, command, rid).status_code == 200
    assert client.get(root + '/activity').json()['events'] == []


def test_event_failure_rolls_back_scene_and_receipt(client, ready_character_id):
    root = setup(client, ready_character_id)
    rid = str(uuid4())
    def fail(conn, cursor, statement, parameters, context, executemany):
        if statement.startswith('INSERT INTO living_activity_events'):
            raise OperationalError('injected', {}, Exception('storage unavailable'))
    event.listen(engine, 'before_cursor_execute', fail)
    try:
        result = act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}, rid)
        assert result.status_code == 503
    finally:
        event.remove(engine, 'before_cursor_execute', fail)
    assert client.get(root).json()['revision'] == 0
    with engine.connect() as conn:
        assert conn.execute(select(receipts).where(receipts.c.request_id == rid)).first() is None
    assert client.get(root + '/activity').json()['events'] == []
    assert act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}, rid).status_code == 200


def test_pagination_stable_during_new_actions_and_no_read_writes(client, ready_character_id):
    root = setup(client, ready_character_id)
    for revision in range(24):
        assert act(client, root, revision, {'action': 'atmosphere', 'weather': 'clear'}).status_code == 200
    first = client.get(root + '/activity').json()
    assert len(first['events']) == 20 and first['next_before_revision'] == 5
    assert act(client, root, 24, {'action': 'atmosphere', 'weather': 'rain'}).status_code == 200
    second = client.get(root + '/activity?before_revision=5').json()
    assert [e['revision'] for e in second['events']] == [4, 3, 2, 1]
    assert second['next_before_revision'] is None
    assert client.get(root).json()['revision'] == 25
    assert client.get(root + '/activity?before_revision=0').status_code == 422
    assert client.get(root + '/activity?before_revision=99999999999999999999').status_code == 422


def test_authorization_shared_and_corrupt_records(client, anon, ready_character_id):
    from tests.auth_helpers import TEST_USER_ID
    from app.living.store import spaces
    root = setup(client, ready_character_id)
    assert anon.get(root + '/activity').status_code == 401
    with engine.begin() as conn:
        conn.execute(update(spaces).values(owner_id='another-owner'))
    assert client.get(root + '/activity').status_code == 404
    with engine.begin() as conn:
        conn.execute(update(spaces).values(owner_id=TEST_USER_ID))
    shared = client.post('/api/v1/living/spaces', json={'scene_type': 'forest', 'mode': 'shared'}).json()['id']
    assert client.get(f'/api/v1/living/spaces/{shared}/activity').status_code == 409
    assert act(client, f'/api/v1/living/spaces/{shared}', 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}).status_code == 200
    with engine.connect() as conn:
        assert conn.execute(select(events)).first() is None
    act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3})
    with engine.begin() as conn:
        conn.execute(update(events).values(event_json='{}'))
    assert client.get(root + '/activity').status_code == 500


def test_parallel_same_request_records_once(client, ready_character_id):
    root = setup(client, ready_character_id)
    rid = str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        replies = list(pool.map(lambda _: act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}, rid), range(2)))
    assert [r.status_code for r in replies] == [200, 200]
    assert replies[0].json() == replies[1].json()
    assert len(client.get(root + '/activity').json()['events']) == 1



def test_categories_filter_before_paging_and_keep_stable_revision_order(client, ready_character_id):
    root = setup(client, ready_character_id)
    first = act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}).json()
    iid = first['items'][0]['id']
    assert act(client, root, 1, {'action': 'care', 'item_id': iid}).status_code == 200
    for revision in range(2, 50):
        command = ({'action': 'atmosphere', 'weather': 'rain'} if revision % 2 == 0
                   else {'action': 'move', 'item_id': iid, 'x': .3, 'y': .3})
        assert act(client, root, revision, command).status_code == 200
    care = client.get(root + '/activity?category=care').json()
    assert care['category'] == 'care'
    assert [e['revision'] for e in care['events']] == [2]
    assert care['next_before_revision'] is None
    layout = client.get(root + '/activity?category=layout').json()
    assert len(layout['events']) == 20
    assert all(e['action'] in ('place', 'move') for e in layout['events'])
    cursor = layout['next_before_revision']
    assert cursor == layout['events'][-1]['revision']
    second = client.get(root + f'/activity?category=layout&before_revision={cursor}').json()
    assert second['next_before_revision'] is None
    complete = layout['events'] + second['events']
    assert len(complete) == 25
    revisions = [e['revision'] for e in complete]
    assert revisions == sorted(set(revisions), reverse=True)
    atmosphere = client.get(root + '/activity?category=atmosphere').json()
    assert all(e['action'] == 'atmosphere' for e in atmosphere['events'])
    assert not set(revisions) & {e['revision'] for e in atmosphere['events']}
    assert client.get(root + '/activity?category=other').status_code == 422
    assert client.get(root + '/activity').json() == client.get(root + '/activity?category=all').json()
    engine.dispose()
    assert client.get(root + '/activity?category=care').json() == care


def test_filtered_reads_do_not_write_or_cross_private_boundaries(client, anon, ready_character_id):
    from app.living.store import spaces
    from tests.auth_helpers import TEST_USER_ID
    root = setup(client, ready_character_id)
    assert act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}).status_code == 200
    statements = []
    def capture(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')):
            statements.append(statement)
    event.listen(engine, 'before_cursor_execute', capture)
    try:
        for category in ('all', 'care', 'layout', 'atmosphere'):
            assert client.get(root + '/activity?category=' + category).status_code == 200
    finally:
        event.remove(engine, 'before_cursor_execute', capture)
    # Authentication may update sessions, but journal GET never changes living data.
    assert not any('living_' in statement for statement in statements)
    for category in ('care', 'layout', 'atmosphere'):
        assert anon.get(root + '/activity?category=' + category).status_code == 401
    with engine.begin() as conn:
        conn.execute(update(spaces).values(owner_id='another-owner'))
    assert client.get(root + '/activity?category=layout').status_code == 404
    with engine.begin() as conn:
        conn.execute(update(spaces).values(owner_id=TEST_USER_ID))
    shared = client.post('/api/v1/living/spaces', json={'scene_type': 'forest', 'mode': 'shared'}).json()['id']
    assert client.get(f'/api/v1/living/spaces/{shared}/activity?category=care').status_code == 409



def test_item_ids_distinguish_same_kind_and_survive_actions_replay_and_restart(client, ready_character_id):
    root = setup(client, ready_character_id)
    first = act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}).json()
    first_id = first['items'][0]['id']
    second = act(client, root, 1, {'action': 'place', 'kind': 'tree', 'x': .4, 'y': .3}).json()
    second_id = next(item['id'] for item in second['items'] if item['id'] != first_id)
    commands = [({'action': 'care', 'item_id': second_id}, second_id),
                ({'action': 'move', 'item_id': first_id, 'x': .3, 'y': .4}, first_id),
                ({'action': 'store', 'item_id': second_id}, second_id),
                ({'action': 'restore', 'item_id': second_id, 'x': .4, 'y': .5}, second_id),
                ({'action': 'atmosphere', 'weather': 'rain'}, None),
                ({'action': 'undo'}, None)]
    expected = [first_id, second_id]
    for revision, (command, target) in enumerate(commands, 2):
        rid = str(uuid4())
        result = act(client, root, revision, command, rid)
        assert result.status_code == 200
        assert act(client, root, revision, command, rid).json() == result.json()
        expected.append(target)
    journal = client.get(root + '/activity').json()['events']
    assert [event['target_item_id'] for event in reversed(journal)] == expected
    assert len(journal) == 8
    engine.dispose()
    assert client.get(root + '/activity').json()['events'] == journal


def test_old_item_records_read_without_backfill_and_replay_without_new_events(client, ready_character_id):
    root = setup(client, ready_character_id)
    rid = str(uuid4())
    command = {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}
    original = act(client, root, 0, command, rid).json()
    with engine.begin() as conn:
        saved = conn.execute(select(events)).mappings().one()
        old = json.loads(saved['event_json']); old.pop('target_item_id')
        original_json = json.dumps(old)
        conn.execute(update(events).values(event_json=original_json))
    assert client.get(root + '/activity').json()['events'][0]['target_item_id'] is None
    assert act(client, root, 0, command, rid).json() == original
    engine.dispose()
    with engine.connect() as conn:
        rows = conn.execute(select(events.c.event_json)).scalars().all()
    assert rows == [original_json]


@pytest.mark.parametrize('identity,global_action', [('invalid-id', False), ('ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF', False), (str(uuid4()), True)])
def test_invalid_saved_item_identity_is_not_read_as_valid_history(client, ready_character_id, identity, global_action):
    root = setup(client, ready_character_id)
    act(client, root, 0, {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3})
    with engine.begin() as conn:
        saved = json.loads(conn.execute(select(events.c.event_json)).scalar_one())
        saved['target_item_id'] = identity
        if global_action:
            saved.update(action='undo', target_kind=None)
        conn.execute(update(events).values(event_json=json.dumps(saved)))
    response = client.get(root + '/activity')
    assert response.status_code == 500
    assert response.json()['error']['code'] == 'corrupt_state'
    assert identity not in response.text


def test_uncertain_new_item_identity_rolls_back_scene_receipt_and_event(client, ready_character_id, monkeypatch):
    from app.living import activity
    root = setup(client, ready_character_id)
    rid = str(uuid4())
    original_record = activity.record
    def ambiguous(conn, row, command, result, request_id):
        invalid = {**result, 'items': [*result['items'], {**result['items'][0], 'id': str(uuid4())}]}
        original_record(conn, row, command, invalid, request_id)
    monkeypatch.setattr(activity, 'record', ambiguous)
    command = {'action': 'place', 'kind': 'tree', 'x': .2, 'y': .3}
    assert act(client, root, 0, command, rid).status_code == 500
    assert client.get(root).json()['revision'] == 0
    assert client.get(root + '/activity').json()['events'] == []
    with engine.connect() as conn:
        assert conn.execute(select(receipts).where(receipts.c.request_id == rid)).first() is None
    monkeypatch.setattr(activity, 'record', original_record)
    result = act(client, root, 0, command, rid)
    assert result.status_code == 200
    assert client.get(root + '/activity').json()['events'][0]['target_item_id'] == result.json()['items'][0]['id']
