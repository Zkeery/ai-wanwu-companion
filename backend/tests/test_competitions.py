from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from app.core.database import engine, SessionLocal
from app.living.competitions import CompetitionStore
from app.living.gatherings import GatheringStore
from app.living.rules import LivingError
from tests.auth_helpers import TEST_USER_ID


@pytest.fixture
def arena(ready_character_id):
    from app.models.models import Character, Object, Photo
    with SessionLocal() as db:
        photo = Photo(filename='fixture.png', owner_id=TEST_USER_ID, status='done')
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label='合成石头')
        db.add(obj)
        db.flush()
        ch = Character(object_id=obj.id, owner_id=TEST_USER_ID, name='石头伙伴', persona='安静', opening_line='你好', status='ready')
        db.add(ch)
        db.commit()
        cid = ch.id
    clock = [1_800_000_000]
    return CompetitionStore(engine, lambda: clock[0]), clock, [ready_character_id, cid]


def run(s, m, action, uid=TEST_USER_ID, **kwargs):
    return s.command(uid, m['id'], str(uuid4()), dict(action=action, **kwargs))


def ready(s, ids, kind='observe'):
    m = s.create(TEST_USER_ID, str(uuid4()), kind, '我')
    for cid in ids:
        m = run(s, m, 'register', character_id=cid)
    return run(s, m, 'start')


@pytest.mark.parametrize('kind,duration', [('observe', 180), ('garden', 480), ('leaves', 180)])
def test_full_competition_restore_reward(arena, kind, duration):
    s, clock, ids = arena
    m = ready(s, ids, kind)
    clock[0] += 120
    midway = s.read(TEST_USER_ID, m['id'])
    assert midway['status'] == 'running'
    restored = CompetitionStore(engine, lambda: clock[0]).read(TEST_USER_ID, m['id'])
    assert restored == midway
    if kind == 'garden':
        clock[0] += 180
        m = s.read(TEST_USER_ID, m['id'])
        assert m['status'] == 'voting'
        m = run(s, m, 'vote', character_id=ids[1])
        with pytest.raises(LivingError):
            run(s, m, 'vote', character_id=ids[0])
        clock[0] += 180
    else:
        clock[0] += 60
    m = s.read(TEST_USER_ID, m['id'])
    assert m['status'] == 'completed'
    assert m['rewards'][TEST_USER_ID]['base'] == 10
    w = s.inventory(TEST_USER_ID)
    assert len(w['rewards']) == 1 and len(w['decorations']) == 1
    assert w['balance'] == 20
    for _ in range(3):
        s.read(TEST_USER_ID, m['id'])
    assert s.inventory(TEST_USER_ID) == w


def test_three_daily_rewards_fourth_no_resources(arena):
    s, clock, ids = arena
    for _ in range(4):
        m = ready(s, ids)
        clock[0] += 180
        m = s.read(TEST_USER_ID, m['id'])
    w = s.inventory(TEST_USER_ID)
    assert w['balance'] == 60
    assert len(w['decorations']) == 1
    assert m['rewards'][TEST_USER_ID]['base'] == m['rewards'][TEST_USER_ID]['bonus'] == 0
    clock[0] += 86400
    m = ready(s, ids)
    clock[0] += 180
    s.read(TEST_USER_ID, m['id'])
    assert s.inventory(TEST_USER_ID)['balance'] == 80


@pytest.mark.parametrize('all_exit', [False, True])
def test_partial_and_all_withdrawal(arena, all_exit):
    s, clock, ids = arena
    m = ready(s, ids)
    clock[0] += 60
    m = run(s, m, 'withdraw', character_id=ids[0])
    if all_exit:
        m = run(s, m, 'withdraw', character_id=ids[1])
    clock[0] += 120
    m = s.read(TEST_USER_ID, m['id'])
    assert m['status'] == ('cancelled' if all_exit else 'completed')
    assert bool(s.inventory(TEST_USER_ID)['rewards']) is not all_exit
    assert m['participants'][str(ids[0])]['status'] == 'withdrawn'
    assert not m['participants'][str(ids[0])].get('winner')


def test_zero_votes_no_champion_and_tie(arena):
    s, clock, ids = arena
    m = ready(s, ids, 'garden')
    clock[0] += 480
    m = s.read(TEST_USER_ID, m['id'])
    assert not any(p['winner'] for p in m['participants'].values())
    assert m['rewards'][TEST_USER_ID]['base'] == 10 and m['rewards'][TEST_USER_ID]['bonus'] == 0


def test_score_requires_valid_independent_target(arena):
    s, _, ids = arena
    m = ready(s, ids)
    p, q = m['participants'].values()
    assert s.score_target(m, p, 3)
    assert not s.score_target(m, p, 3)
    assert s.score_target(m, q, 3)
    assert not s.score_target(m, p, 20)
    assert not s.score_target(m, p, -1)
    assert not s.score_target(m, p, True)
    assert p['score'] == 1 and q['score'] == 1


def test_concurrent_settlement_exchange_and_same_key(arena):
    s, clock, ids = arena
    m = ready(s, ids)
    clock[0] += 180
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: s.read(TEST_USER_ID, m['id']), range(2)))
    assert s.inventory(TEST_USER_ID)['balance'] == 20
    rid = str(uuid4())
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: s.exchange(TEST_USER_ID, rid, 'colorful_pot'), range(2)))
    assert results[0] == results[1]
    w = s.inventory(TEST_USER_ID)
    assert w['balance'] == 0 and len(w['decorations']) == 2
    with pytest.raises(LivingError):
        s.exchange(TEST_USER_ID, str(uuid4()), 'colorful_pot')


def test_invitation_privacy_and_not_owner_registration(arena):
    s, _, ids = arena
    m = s.create(TEST_USER_ID, str(uuid4()), 'observe', '我')
    preview = s.preview(m['invitation'])
    assert set(preview) == {'id', 'kind', 'participants', 'member_count', 'duration'}
    with pytest.raises(LivingError):
        s.read('other', m['id'])
    declined = s.join('other', str(uuid4()), m['invitation'], '好友', False)
    assert declined['status'] == 'declined'
    with pytest.raises(LivingError):
        s.read('other', m['id'])
    joined = s.join('other', str(uuid4()), m['invitation'], '好友', True)
    with pytest.raises(LivingError):
        run(s, joined, 'register', uid='other', character_id=ids[0])


def test_minimum_cancel_and_no_simultaneous_matches(arena):
    s, _, ids = arena
    m = s.create(TEST_USER_ID, str(uuid4()), 'observe', '我')
    m = run(s, m, 'register', character_id=ids[0])
    with pytest.raises(LivingError):
        run(s, m, 'start')
    m = run(s, m, 'register', character_id=ids[1])
    run(s, m, 'start')
    with pytest.raises(LivingError):
        ready(s, ids, 'leaves')
    m = run(s, m, 'cancel')
    assert m['status'] == 'cancelled'
    assert not s.inventory(TEST_USER_ID)['rewards']


def test_decorations_ownership_exit_and_dissolution_return(arena):
    s, clock, ids = arena
    m = ready(s, ids)
    clock[0] += 180
    s.read(TEST_USER_ID, m['id'])
    d = s.inventory(TEST_USER_ID)['decorations'][0]
    gstore = GatheringStore(engine, lambda: clock[0])
    g = gstore.create(TEST_USER_ID, str(uuid4()), '一起生活', '我', 'home')
    s.place(TEST_USER_ID, str(uuid4()), d['id'], g['id'], 'gathering', 50, 50)
    assert s.in_space(TEST_USER_ID, g['id'], 'gathering')[0]['mine']
    with pytest.raises(LivingError):
        s.place('other', str(uuid4()), d['id'], None, 'gathering', 50, 50)
    gstore.command(TEST_USER_ID, g['id'], str(uuid4()), g['revision'], {'action': 'propose_dissolve'})
    assert s.inventory(TEST_USER_ID)['decorations'][0]['space_id'] is None


def test_private_decorations_stay_in_place_while_companion_visits(arena, client):
    from app.living.store import LivingStore
    from app.models.models import Character
    s, clock, ids = arena
    home = LivingStore(engine).create_space(TEST_USER_ID, str(uuid4()), 'home', 'private', str(ids[0]))
    with SessionLocal() as db:
        db.get(Character, ids[0]).current_space_id = home['id']
        db.commit()
    with engine.begin() as conn:
        s.decorate(conn, TEST_USER_ID, 'memorial_pot')
        s.decorate(conn, TEST_USER_ID, 'leaf_wreath')
    first, second = [item['id'] for item in s.inventory(TEST_USER_ID)['decorations']]
    s.place(TEST_USER_ID, str(uuid4()), first, home['id'], 'private', 50, 50)
    group_store = GatheringStore(engine, lambda: clock[0])
    group = group_store.create(TEST_USER_ID, str(uuid4()), '一起生活', '我', 'home')
    visiting = group_store.command(TEST_USER_ID, group['id'], str(uuid4()), group['revision'],
        {'action': 'visit', 'character_id': ids[0]})
    assert len(s.in_space(TEST_USER_ID, home['id'], 'private')) == 1
    for decoration, destination in ((first, None), (second, home['id'])):
        with pytest.raises(LivingError) as exc:
            s.place(TEST_USER_ID, str(uuid4()), decoration, destination, 'private', 50, 50)
        assert exc.value.code == 'conflict'
    denied = client.post('/api/v1/activities/decorations', json={
        'request_id': str(uuid4()), 'decoration_id': second, 'space_id': home['id'],
        'space_kind': 'private', 'x': 50, 'y': 50})
    assert denied.status_code == 409 and denied.json()['error']['code'] == 'conflict'
    placed = {item['id']: item['space_id'] for item in s.inventory(TEST_USER_ID)['decorations']}
    assert placed == {first: home['id'], second: None}
    group_store.command(TEST_USER_ID, group['id'], str(uuid4()), visiting['revision'],
        {'action': 'recall', 'character_id': ids[0]})
    assert s.place(TEST_USER_ID, str(uuid4()), second, home['id'], 'private', 50, 50)['space_id'] == home['id']


def test_activity_api_no_client_score_and_auth(client, anon, arena):
    _, _, ids = arena
    base = '/api/v1/activities'
    assert anon.get(base).status_code == 401
    response = client.post(base, json={'request_id': str(uuid4()), 'kind': 'leaves', 'display_name': '我'})
    assert response.status_code == 201
    mid = response.json()['id']
    r = client.post(base + '/' + mid + '/commands', json={'request_id': str(uuid4()), 'command': {'action': 'score', 'score': 999}})
    assert r.status_code == 422
