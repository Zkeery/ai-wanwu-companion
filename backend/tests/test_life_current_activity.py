"""Current display is derived from persisted events, never from historical guesses."""
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, event, update

from app.core.database import engine
from app.living.life_runtime import LifeRuntime
from app.models.models import Character
from tests.auth_helpers import TEST_USER_ID as OWNER
from tests.test_life_runtime_api import preview, permission, queue  # noqa: F401
from tests.test_life_automatic import no_network  # noqa: F401
from tests.test_life_planning import stamp


def finish(client, preview, activity='rest', target=None, delay=0):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission(activities=[activity]))
    tid = queue(client, url); task = runtime.claim(OWNER, sid, tid)
    clock[0] += delay
    candidate = {'activity': activity, 'reason': 'offline current-state fixture'}
    if target: candidate['target_id'] = target
    runtime.execute_step(OWNER, sid, tid, task.token, candidate)
    return tid


@pytest.mark.parametrize('activity', ['rest', 'walk'])
def test_completed_event_has_bounded_current_state_and_read_is_side_effect_free(client, preview, activity):
    url, sid, clock, runtime = preview
    tid = finish(client, preview, activity, delay=5)
    queries = []
    def trace(_conn, _cursor, statement, *_args): queries.append(statement)
    event.listen(engine, 'before_cursor_execute', trace)
    try:
        value = runtime.snapshot(OWNER, sid).current_activity
    finally:
        event.remove(engine, 'before_cursor_execute', trace)
    assert value.model_dump() == dict(task_id=tid, activity=activity, target_id=None,
        started_at=clock[0], expires_at=clock[0] + 600, source='viewing')
    assert not any(q.lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for q in queries)
    clock[0] += 599
    assert client.get(url).json()['current_activity'] is not None
    clock[0] += 1
    assert client.get(url).json()['current_activity'] is None
    assert len(runtime.read_events(OWNER, sid)) == 1


def test_authorization_change_invalidates_current_without_erasing_history(client, preview):
    url, sid, _, runtime = preview
    finish(client, preview)
    client.put(url + '/permission', json=permission(False, 1, ['rest']))
    assert runtime.snapshot(OWNER, sid).current_activity is None
    client.put(url + '/permission', json=permission(True, 2, ['rest']))
    assert runtime.snapshot(OWNER, sid).current_activity is None
    assert len(runtime.read_events(OWNER, sid)) == 1


def test_leaving_and_returning_does_not_revive_old_location_event(client, preview):
    _, sid, _, runtime = preview
    finish(client, preview)
    cid = int(runtime.snapshot(OWNER, sid).companion_id)
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == cid).values(current_space_id=None))
    assert runtime.snapshot(OWNER, sid).current_activity is None
    with engine.begin() as conn:
        conn.execute(update(Character).where(Character.id == cid).values(current_space_id=sid, location_epoch=Character.location_epoch + 1))
    assert runtime.snapshot(OWNER, sid).current_activity is None


def test_observation_tracks_original_item_and_stops_when_stored(client, preview):
    _, sid, _, runtime = preview
    store = runtime.store
    scene = store.read_space(OWNER, sid)
    scene = store.execute(OWNER, sid, str(uuid4()), scene['revision'], {'action': 'place', 'kind': 'tree', 'x': .4, 'y': .5})
    target = scene['items'][0]['id']
    finish(client, preview, 'observe', target)
    assert runtime.snapshot(OWNER, sid).current_activity.target_id == target
    scene = store.execute(OWNER, sid, str(uuid4()), scene['revision'], {'action': 'move', 'item_id': target, 'x': .7, 'y': .6})
    assert runtime.snapshot(OWNER, sid).current_activity.target_id == target
    store.execute(OWNER, sid, str(uuid4()), scene['revision'], {'action': 'store', 'item_id': target})
    assert runtime.snapshot(OWNER, sid).current_activity is None


def test_night_boundary_stops_walking(client, preview):
    _, sid, clock, runtime = preview
    clock[0] = stamp(21, 59)
    finish(client, preview, 'walk')
    assert runtime.snapshot(OWNER, sid).current_activity is not None
    clock[0] = stamp(22)
    assert runtime.snapshot(OWNER, sid).current_activity is None


def test_new_pending_task_is_not_an_activity_and_does_not_replay_previous_one(client, preview):
    url, sid, clock, runtime = preview
    finish(client, preview, delay=10)
    clock[0] += 590
    queue(client, url)
    assert runtime.snapshot(OWNER, sid).current_activity is None


def test_restart_and_offline_source_are_preserved(client, preview):
    url, sid, clock, runtime = preview
    client.put(url + '/permission', json=permission(activities=['rest']))
    task = runtime.schedule(OWNER, sid, str(uuid4()), 'offline')
    runtime.run_fixture(OWNER, sid, task.spec.basis.plan_id)
    expected = runtime.snapshot(OWNER, sid).current_activity
    assert expected.source == 'offline'
    opened = create_engine(str(engine.url), connect_args={'check_same_thread': False})
    try:
        fresh = LifeRuntime(opened, lambda: clock[0]); fresh.initialize()
        assert fresh.snapshot(OWNER, sid).current_activity == expected
    finally: opened.dispose()


def test_clock_before_event_never_displays_future_activity(client, preview):
    _, sid, clock, runtime = preview
    finish(client, preview, delay=5)
    clock[0] -= 1
    assert runtime.snapshot(OWNER, sid).current_activity is None
