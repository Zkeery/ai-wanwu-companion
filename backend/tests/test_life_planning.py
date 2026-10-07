"""C1.1 offline validation; all permissions and partners are synthetic."""
from datetime import datetime
from uuid import uuid4
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import event, select, update
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import engine
from app.living import life_planning as planning, seasons
from app.living.rules import LivingError
from app.living.store import LivingStore, spaces
from app.models.models import Character
from tests.auth_helpers import TEST_USER_ID


def stamp(hour=12, minute=0, day=1):
    return int(datetime(2026, 9, day, hour, minute,
                        tzinfo=ZoneInfo('Asia/Shanghai')).timestamp())


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*args, **kwargs):
        raise AssertionError('C1.1 must not use network or paid models')
    monkeypatch.setattr('socket.socket.connect', blocked)


@pytest.fixture
def scene(ready_character_id):
    clock = [stamp()]
    store = LivingStore(engine, clock=lambda: clock[0])
    sid = str(uuid4())
    store.create_space(TEST_USER_ID, sid, 'home', 'private', str(ready_character_id))
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == ready_character_id).values(
            current_space_id=sid, location_epoch=1))
    return store, sid, ready_character_id, clock


def read(scene):
    _, sid, _, clock = scene
    with engine.connect() as conn:
        return planning.read_facts(conn, TEST_USER_ID, sid, clock[0])


def permitted(facts, **changes):
    values = dict(owner_id=facts.owner_id, space_id=facts.space_id,
                  companion_id=facts.companion_id, revision=1, enabled=True,
                  activities=('rest', 'walk', 'observe'))
    return planning.Permission(**{**values, **changes})


def basis(facts, permission):
    return planning.make_basis(facts, permission, plan_id=str(uuid4()), request_id=str(uuid4()))


def review(facts, permission, payload=None, previous=None):
    return planning.review_candidate(
        payload or {'activity': 'walk', 'reason': '在自己的庭院散步'},
        basis=previous or basis(facts, permission), facts=facts, permission=permission)


def rejected(code, operation):
    with pytest.raises(LivingError) as failure:
        operation()
    assert failure.value.code == code
    assert set(failure.value.as_dict()) == {'error'}


@pytest.mark.parametrize('scene_type', ['home', 'desert', 'forest'])
def test_existing_scenes_and_readonly_validation(scene, scene_type):
    store, sid, cid, clock = scene
    with engine.begin() as conn:
        conn.execute(update(spaces).where(spaces.c.id == sid).values(scene_type=scene_type))
    queries = []
    def trace(conn, cursor, statement, parameters, context, executemany):
        queries.append(statement)
    event.listen(engine, 'before_cursor_execute', trace)
    try:
        facts = read(scene)
        result = review(facts, permitted(facts))
    finally:
        event.remove(engine, 'before_cursor_execute', trace)
    # The fifth read checks that this companion is not executing a competition.
    assert len(queries) == 5 and all(q.lstrip().upper().startswith('SELECT') for q in queries)
    assert not any(word in '\n'.join(queries).lower()
                   for word in ('persona', 'phone', 'memories', 'life_sim', 'messages'))
    assert result.mode == 'validation_only' and result.candidate.activity == 'walk'
    assert facts.scene_type == scene_type and facts.companion_id == str(cid)
    assert facts.items == () and facts.season is None
    assert store.read_space(TEST_USER_ID, sid)['revision'] == 0
    engine.dispose()
    assert read(scene) == facts


def test_observation_needs_current_visible_target(scene):
    store, sid, _, clock = scene
    placed = store.execute(TEST_USER_ID, sid, str(uuid4()), 0,
                           {'action': 'place', 'kind': 'tree', 'x': 0.3, 'y': 0.5})
    tid = placed['items'][0]['id']
    original = read(scene)
    permission = permitted(original)
    previous = basis(original, permission)
    payload = {'activity': 'observe', 'target_id': tid, 'reason': '看看庭院里的小树'}
    assert review(original, permission, payload, previous).candidate.target_id == tid
    store.execute(TEST_USER_ID, sid, str(uuid4()), 1, {'action': 'store', 'item_id': tid})
    current = read(scene)
    assert current.items == ()
    rejected('conflict', lambda: review(current, permission, payload, previous))
    rejected('invalid_action', lambda: review(current, permission, payload))


@pytest.mark.parametrize('payload', [
    {'activity': 'delete', 'reason': '清理'},
    {'activity': 'care', 'reason': '浇水'},
    {'activity': 'place', 'reason': '种树'},
    {'activity': 'walk', 'reason': '走走', 'owner_id': 'another'},
    {'activity': 'walk', 'reason': '走走', 'enabled': True},
    {'activity': 'walk', 'reason': '走走', 'executed': True},
    {'activity': 'walk', 'reason': '走走', 'steps': []},
    {'activity': 'walk', 'reason': '走走', 'target_id': 'invented'},
    {'activity': 'walk', 'reason': ' '},
    {'activity': 'walk', 'reason': 'a' * 121},
    {'activity': 'walk', 'reason': '第一行\n第二行'},
    {'activity': 'walk', 'reason': 12},
])
def test_rejects_unsupported_or_privilege_bearing_model_output(scene, payload):
    facts = read(scene)
    rejected('invalid_request', lambda: review(facts, permitted(facts), payload))


@pytest.mark.parametrize('activity,target', [('observe', None), ('observe', 'missing'),
                                           ('rest', 'extra'), ('walk', 'extra')])
def test_target_contract(scene, activity, target):
    facts = read(scene)
    payload = {'activity': activity, 'target_id': str(uuid4()) if target else None, 'reason': '候选理由'}
    rejected('invalid_action', lambda: review(facts, permitted(facts), payload))


@pytest.mark.parametrize('change', [None, {'enabled': False}, {'activities': ('rest',)},
                                    {'owner_id': 'another'}, {'space_id': str(uuid4())},
                                    {'companion_id': 'another'}])
def test_missing_paused_or_mismatched_permission(scene, change):
    facts = read(scene)
    previous = basis(facts, permitted(facts))
    permission = permitted(facts, **change) if change is not None else None
    # A changed scope is stale even when its revision was mistakenly kept.
    code = 'conflict' if change == {'activities': ('rest',)} else 'invalid_action'
    rejected(code, lambda: review(facts, permission, previous=previous))


def test_fresh_but_unpermitted_activity_and_changed_permission_revision(scene):
    facts = read(scene)
    restricted = permitted(facts, activities=('rest',))
    rejected('invalid_action', lambda: review(facts, restricted))
    previous = basis(facts, permitted(facts))
    rejected('conflict', lambda: review(facts, permitted(facts, revision=2), previous=previous))


@pytest.mark.parametrize('hour,minute,allowed', [(6, 59, False), (7, 0, True),
                                               (21, 59, True), (22, 0, False)])
def test_night_limits_use_fresh_server_time(scene, hour, minute, allowed):
    scene[3][0] = stamp(hour=hour, minute=minute, day=2)
    facts = read(scene)
    permission = permitted(facts)
    if allowed:
        assert review(facts, permission).mode == 'validation_only'
    else:
        rejected('invalid_action', lambda: review(facts, permission))
    assert review(facts, permission, {'activity': 'rest', 'reason': '安静休息'}).candidate.activity == 'rest'


def test_plan_crossing_night_boundary_is_rechecked(scene):
    scene[3][0] = stamp(hour=21, minute=59)
    facts = read(scene)
    permission = permitted(facts)
    previous = basis(facts, permission)
    scene[3][0] = stamp(hour=22)
    rejected('invalid_action', lambda: review(read(scene), permission, previous=previous))


@pytest.mark.parametrize('elapsed', [599, 600, -1])
def test_plan_expiry_and_clock_rollback(scene, elapsed):
    scene[3][0] += 100
    facts = read(scene)
    permission = permitted(facts)
    previous = basis(facts, permission)
    scene[3][0] += elapsed
    if elapsed == 599:
        assert review(read(scene), permission, previous=previous).mode == 'validation_only'
    else:
        rejected('conflict', lambda: review(read(scene), permission, previous=previous))


def test_departure_return_epoch_and_not_ready(scene):
    _, sid, cid, _ = scene
    facts = read(scene)
    permission = permitted(facts)
    previous = basis(facts, permission)
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == cid).values(current_space_id=None, location_epoch=2))
    rejected('invalid_action', lambda: review(read(scene), permission, previous=previous))
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == cid).values(current_space_id=sid, location_epoch=3))
    rejected('conflict', lambda: review(read(scene), permission, previous=previous))
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == cid).values(status='generating'))
    rejected('invalid_action', lambda: review(read(scene), permission))


def test_season_boundary_and_config_revision_invalidate_plan(scene):
    _, sid, _, clock = scene
    settings = seasons.VirtualSettings(mode='virtual', weeks=1, start_season='autumn')
    with engine.begin() as conn:
        seasons.save(conn, TEST_USER_ID, sid, str(uuid4()), 0, settings, clock[0])
    clock[0] += 7 * 86400 - 60
    facts = read(scene)
    permission = permitted(facts)
    previous = basis(facts, permission)
    assert facts.season == 'autumn'
    clock[0] += 60
    assert read(scene).season == 'winter'
    rejected('conflict', lambda: review(read(scene), permission, previous=previous))
    previous = basis(read(scene), permission)
    with engine.begin() as conn:
        seasons.save(conn, TEST_USER_ID, sid, str(uuid4()), 1,
                     seasons.VirtualSettings(mode='virtual', weeks=2, start_season='winter'), clock[0])
    rejected('conflict', lambda: review(read(scene), permission, previous=previous))


def test_weather_change_invalidates_old_plan(scene):
    store, sid, _, _ = scene
    facts = read(scene)
    permission = permitted(facts)
    previous = basis(facts, permission)
    store.execute(TEST_USER_ID, sid, str(uuid4()), 0, {'action': 'atmosphere', 'weather': 'rain'})
    assert read(scene).rain is True
    rejected('conflict', lambda: review(read(scene), permission, previous=previous))


def test_account_space_and_character_ownership_isolation(scene):
    store, sid, cid, clock = scene
    with engine.connect() as conn:
        rejected('not_found', lambda: planning.read_facts(conn, 'another', sid, clock[0]))
        rejected('not_found', lambda: planning.read_facts(conn, TEST_USER_ID, str(uuid4()), clock[0]))
    shared = str(uuid4())
    store.create_space(TEST_USER_ID, shared, 'home', 'shared')
    with engine.connect() as conn:
        rejected('invalid_action', lambda: planning.read_facts(conn, TEST_USER_ID, shared, clock[0]))
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == cid).values(owner_id=None))
    rejected('not_found', lambda: read(scene))


@pytest.mark.parametrize('kind', ['scene', 'character', 'epoch', 'season'])
def test_damaged_saved_facts_fail_closed(scene, kind):
    _, sid, cid, clock = scene
    with engine.begin() as conn:
        if kind == 'scene':
            conn.execute(update(spaces).where(spaces.c.id == sid).values(state_json='{}'))
        elif kind == 'character':
            conn.execute(update(Character).where(Character.id == cid).values(status='unknown'))
        elif kind == 'epoch':
            conn.execute(update(Character).where(Character.id == cid).values(location_epoch=-1))
        else:
            seasons.save(conn, TEST_USER_ID, sid, str(uuid4()), 0,
                         seasons.RealSettings(mode='real', hemisphere='north'), clock[0])
            conn.execute(update(seasons.preferences).where(seasons.preferences.c.space_id == sid)
                         .values(settings_json='{}'))
    rejected('corrupt_state', lambda: read(scene))


def test_storage_failure_has_generic_error(scene, monkeypatch):
    _, sid, _, clock = scene
    with engine.connect() as conn:
        def fail(*args, **kwargs):
            raise SQLAlchemyError('private storage diagnostic')
        monkeypatch.setattr(conn, 'execute', fail)
        with pytest.raises(LivingError) as failure:
            planning.read_facts(conn, TEST_USER_ID, sid, clock[0])
        assert failure.value.code == 'storage_unavailable'
        assert 'private storage diagnostic' not in str(failure.value)


@pytest.mark.parametrize('now', [True, -1, '100', 253402300799, 253402300800])
def test_invalid_server_clock(scene, now):
    _, sid, _, _ = scene
    with engine.connect() as conn:
        rejected('invalid_request', lambda: planning.read_facts(conn, TEST_USER_ID, sid, now))
