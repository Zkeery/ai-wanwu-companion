"""R3.4: persisted user facts only, current-residence isolation and bounded reads."""
import json
from time import perf_counter
from uuid import uuid4

import pytest
from sqlalchemy import event, insert, update

from app.core.database import SessionLocal, engine
from app.living.activity import ActivityEvent, event_text, events
from app.living.store import LivingStore, spaces
from app.models.models import Character, LivingMembership
from app.services.character_overview import character_overviews
from tests.auth_helpers import TEST_USER_ID
from tests.test_character_overview import home, seed
from tests.test_life_journal import act, setup

URL = '/api/v1/characters/overview?include_life_activity=true'


def attach(cid, sid):
    with SessionLocal() as db:
        db.get(Character, cid).current_space_id = sid
        db.commit()


def test_real_actions_latest_three_and_old_request_compatibility(client, ready_character_id):
    root = setup(client, ready_character_id)
    attach(ready_character_id, root.rsplit('/', 1)[-1])
    for revision, weather in enumerate(['clear', 'rain', 'quiet', 'clear']):
        assert act(client, root, revision, {'action': 'atmosphere', 'weather': weather}).status_code == 200
    response = client.get(URL)
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'private, no-store'
    data = response.json()[0]['recent_activity']
    assert [e['revision'] for e in data] == [4, 3, 2]
    assert [e['text'] for e in data] == ['让庭院放晴', '让庭院安静下来', '开启了小雨']
    assert all(e['source'] == 'user' and e['occurred_at'].endswith('Z') for e in data)
    assert 'request_id' not in response.text and 'event_json' not in response.text
    assert client.get('/api/v1/characters/overview').json()[0]['recent_activity'] == []
    assert client.get(root).json()['revision'] == 4
    engine.dispose()
    assert client.get(URL).json()[0]['recent_activity'] == data


@pytest.mark.parametrize('invalid', ['foreign_owner', 'other_companion', 'shared', 'missing'])
def test_no_private_facts_from_invalid_or_shared_residence(client, ready_character_id, invalid):
    root = setup(client, ready_character_id)
    sid = root.rsplit('/', 1)[-1]
    attach(ready_character_id, sid)
    assert act(client, root, 0, {'action': 'atmosphere', 'weather': 'rain'}).status_code == 200
    with engine.begin() as conn:
        values = {'foreign_owner': {'owner_id': 'someone-else'},
                  'other_companion': {'companion_id': '999999'},
                  'shared': {'mode': 'shared', 'companion_id': None}}
        if invalid != 'missing':
            conn.execute(update(spaces).where(spaces.c.id == sid).values(**values[invalid]))
    if invalid == 'missing':
        attach(ready_character_id, str(uuid4()))
    if invalid == 'shared':
        with SessionLocal() as db:
            db.add(LivingMembership(space_id=sid, companion_id=str(ready_character_id)))
            db.commit()
        assert client.get(URL).json()[0]['residence']['mode'] == 'shared'
    assert client.get(URL).json()[0]['recent_activity'] == []


def test_switching_home_does_not_show_previous_space_history(client, ready_character_id):
    root = setup(client, ready_character_id)
    attach(ready_character_id, root.rsplit('/', 1)[-1])
    act(client, root, 0, {'action': 'atmosphere', 'weather': 'rain'})
    sid = str(uuid4())
    LivingStore(engine).create_space(TEST_USER_ID, sid, 'desert', 'private', str(ready_character_id))
    attach(ready_character_id, sid)
    row = client.get(URL).json()[0]
    assert row['residence']['space_id'] == sid and row['recent_activity'] == []


def test_corrupt_latest_event_is_not_silently_hidden(client, ready_character_id):
    root = setup(client, ready_character_id)
    attach(ready_character_id, root.rsplit('/', 1)[-1])
    act(client, root, 0, {'action': 'atmosphere', 'weather': 'rain'})
    with engine.begin() as conn:
        conn.execute(update(events).values(event_json='{"secret":"do-not-expose"}'))
    response = client.get(URL)
    assert response.status_code == 500 and response.json()['error']['code'] == 'corrupt_state'
    assert 'secret' not in response.text and 'do-not-expose' not in response.text
    assert client.get('/api/v1/characters/overview').status_code == 200


def test_100_companions_use_four_selects_and_no_writes():
    with SessionLocal() as db:
        ids = [seed(db).id for _ in range(100)]
        db.commit()
    for cid in ids:
        sid = home(TEST_USER_ID, cid)
        attach(cid, sid)
        with engine.begin() as conn:
            rows = []
            for revision in range(1, 6):
                item = ActivityEvent(revision=revision, request_id=str(uuid4()), created_at=100,
                    source='user', action='atmosphere', target_kind=None, weather='rain')
                rows.append({'space_id': sid, 'revision': revision, 'request_id': item.request_id,
                             'event_json': item.model_dump_json()})
            conn.execute(insert(events), rows)
    statements = []
    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip().split()[0].upper())
    event.listen(engine, 'before_cursor_execute', record)
    try:
        with SessionLocal() as db:
            started = perf_counter()
            rows = character_overviews(db, TEST_USER_ID, True)
            elapsed = perf_counter() - started
    finally:
        event.remove(engine, 'before_cursor_execute', record)
    assert statements == ['SELECT'] * 4
    assert len(rows) == 100 and all([e.revision for e in r.recent_activity] == [5, 4, 3] for r in rows)
    assert elapsed < 1
    print(json.dumps({'companions': 100, 'queries': 4, 'elapsed_ms': round(elapsed * 1000, 2)}))


@pytest.mark.parametrize('action,target,weather,label', [
    ('place', 'tree', None, '放置了小树'), ('move', 'bench', None, '移动了长椅'),
    ('care', 'tree', None, '照料了小树'), ('store', 'shade', None, '收纳了遮阴处'),
    ('restore', 'cushion', None, '摆出了坐垫'), ('atmosphere', None, 'rain', '开启了小雨'),
    ('undo', None, None, '撤销了上一步布置'),
])
def test_only_fixed_factual_action_labels(action, target, weather, label):
    item = ActivityEvent(revision=1, request_id=str(uuid4()), created_at=0, source='user',
                         action=action, target_kind=target, weather=weather)
    assert event_text(item) == label
