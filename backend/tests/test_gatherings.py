from concurrent.futures import ThreadPoolExecutor
import time
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.core.database import engine, SessionLocal
from app.living.gatherings import GatheringStore, inventory, visits
from app.living.rules import LivingError
from tests.auth_helpers import TEST_USER_ID


@pytest.fixture
def world():
    clock = [1_800_000_000]
    return GatheringStore(engine, lambda: clock[0]), clock


def create(s, owner=TEST_USER_ID, scene='home'):
    return s.create(owner, str(uuid4()), '一起生活', '小叶', scene)


def command(s, g, action, uid=TEST_USER_ID, **kwargs):
    return s.command(uid, g['id'], str(uuid4()), g['revision'], dict(action=action, **kwargs))


def member(s, g, uid):
    g = command(s, g, 'invite')
    return s.join(uid, str(uuid4()), g['invitation'], uid)


def test_full_life_and_home_recovery(world, ready_character_id):
    s, clock = world
    g = create(s)
    g = command(s, g, 'visit', character_id=ready_character_id)
    g = command(s, g, 'start_goal')
    for kind in ('tree', 'bench'):
        g = command(s, g, 'layout', command=dict(action='place', kind=kind, x=.3, y=.4))
    tree = next(i for i in g['items'] if i['kind'] == 'tree')
    g = command(s, g, 'layout', command=dict(action='care', item_id=tree['id']))
    assert g['goal']['status'] == 'completed'
    g = command(s, g, 'activity', character_ids=[ready_character_id], activity='observe')
    assert g['companions'][0]['activity'] == 'observe'
    reloaded = GatheringStore(engine, lambda: clock[0]).read(TEST_USER_ID, g['id'])
    assert reloaded == g
    g = command(s, g, 'recall', character_id=ready_character_id)
    assert not g['companions']
    from app.models.models import Character
    with SessionLocal() as db:
        # A companion with no previous house now gets a persistent private home.
        assert db.get(Character, ready_character_id).current_space_id is not None


def test_five_members_three_votes_and_replay(world):
    s, _ = world
    g = create(s)
    for uid in ('a', 'b', 'c', 'd'):
        g = member(s, g, uid)
    g = command(s, g, 'propose_season', settings={'mode': 'real', 'hemisphere': 'north'})
    v = g['votes'][-1]
    assert v['status'] == 'pending'
    g = command(s, g, 'vote', uid='a', vote_id=v['id'], agree=True)
    assert g['votes'][-1]['status'] == 'pending'
    g = command(s, g, 'vote', uid='b', vote_id=v['id'], agree=True)
    assert g['votes'][-1]['status'] == 'passed'
    assert g['season']['settings']['mode'] == 'real'


@pytest.mark.parametrize('change', ['join', 'leave', 'remove'])
def test_membership_change_cancels_pending_vote(world, change):
    s, _ = world
    g = member(s, create(s), 'a')
    g = command(s, g, 'propose_season', settings={'mode': 'virtual', 'weeks': 1, 'start_season': 'winter'})
    if change == 'join':
        g = member(s, g, 'b')
    elif change == 'leave':
        g = command(s, g, 'leave', uid='a')
    else:
        g = command(s, g, 'remove', member_id='a')
    assert g['votes'][-1]['status'] == 'cancelled_members_changed'
    assert g['season']['settings'] is None


def test_expired_vote_cannot_pass(world):
    s, clock = world
    g = member(s, create(s), 'a')
    g = command(s, g, 'propose_dissolve')
    clock[0] += 86400
    with pytest.raises(LivingError):
        command(s, g, 'vote', uid='a', vote_id=g['votes'][-1]['id'], agree=True)
    assert s.read('a', g['id'])['votes'][-1]['status'] == 'expired'


def test_contribution_permissions_leave_and_dissolve(world):
    s, _ = world
    g = member(s, create(s), 'a')
    g = command(s, g, 'layout', uid='a', command=dict(action='place', kind='tree', x=.4, y=.4))
    iid = g['items'][0]['id']
    for action in ('store', 'move'):
        cmd = dict(action=action, item_id=iid)
        if action == 'move':
            cmd.update(x=.5, y=.5)
        with pytest.raises(LivingError):
            command(s, g, 'layout', command=cmd)
    g = command(s, g, 'leave', uid='a')
    assert g['items'][0]['contributor_name'] == '已离开成员'
    with pytest.raises(LivingError):
        s.read('a', g['id'])
    g = command(s, g, 'propose_dissolve')
    assert g['closed']
    assert [i['id'] for i in s.personal('a')['inventory']] == [iid]
    assert s.personal('a')['memories']


def test_rejoin_recovers_contribution(world):
    s, _ = world
    g = member(s, create(s), 'a')
    g = command(s, g, 'layout', uid='a', command=dict(action='place', kind='bench', x=.3, y=.3))
    iid = g['items'][0]['id']
    g = command(s, g, 'leave', uid='a')
    g = member(s, g, 'a')
    g = command(s, g, 'layout', uid='a', command=dict(action='store', item_id=iid))
    assert not g['items']
    assert len(s.personal('a')['inventory']) == 1
    g = command(s, g, 'restore_inventory', uid='a', item_id=iid)
    assert g['items'][0]['id'] == iid
    assert not s.personal('a')['inventory']


def test_idempotency_and_revision_concurrency(world):
    s, _ = world
    g = create(s)
    rid = str(uuid4())
    cmd = {'action': 'layout', 'command': {'action': 'place', 'kind': 'tree', 'x': .3, 'y': .3}}
    def run():
        return s.command(TEST_USER_ID, g['id'], rid, 0, cmd)
    with ThreadPoolExecutor(max_workers=2) as pool:
        a, b = list(pool.map(lambda _: run(), range(2)))
    assert a == b and len(a['items']) == 1
    with pytest.raises(LivingError, match='同一请求'):
        s.command(TEST_USER_ID, g['id'], rid, 0, {'action': 'invite'})
    with pytest.raises(LivingError, match='空间已更新'):
        command(s, g, 'invite')


def test_capacity_and_manager_transfer(world):
    s, _ = world
    g = create(s)
    for uid in ('a', 'b', 'c', 'd'):
        g = member(s, g, uid)
    with pytest.raises(LivingError, match='最多 5'):
        s.join('e', str(uuid4()), s.read(TEST_USER_ID, g['id'])['invitation'], 'e')
    with pytest.raises(LivingError):
        command(s, g, 'leave')
    g = command(s, g, 'transfer', member_id='a')
    with pytest.raises(LivingError):
        command(s, g, 'invite')
    g = command(s, g, 'leave')
    assert TEST_USER_ID not in [m['id'] for m in g['members']]


@pytest.mark.parametrize('scene', ['home', 'desert', 'forest'])
def test_initial_season_and_growth_continuity(world, scene):
    s, clock = world
    g = s.create(TEST_USER_ID, str(uuid4()), '住处', '我', scene,
        {'mode': 'virtual', 'weeks': 2, 'start_season': 'spring'})
    assert g['season']['current_season'] == 'spring'
    g = command(s, g, 'layout', command=dict(action='place', kind='tree', x=.3, y=.3))
    g = command(s, g, 'layout', command=dict(action='care', item_id=g['items'][0]['id']))
    clock[0] += 3600
    g = command(s, g, 'propose_season', settings={'mode': 'virtual', 'weeks': 1, 'start_season': 'winter'})
    assert g['items'][0]['growth_seconds'] == 3600


def test_visit_single_location_and_nonowner(world, ready_character_id):
    s, _ = world
    g = create(s)
    h = create(s)
    g = command(s, g, 'visit', character_id=ready_character_id)
    with pytest.raises(LivingError):
        command(s, h, 'visit', character_id=ready_character_id)
    g = member(s, g, 'a')
    with pytest.raises(LivingError):
        command(s, g, 'recall', uid='a', character_id=ready_character_id)
    g = command(s, g, 'propose_dissolve')
    g = command(s, g, 'vote', uid='a', vote_id=g['votes'][-1]['id'], agree=True)
    with engine.connect() as conn:
        assert not conn.execute(select(visits)).first()


def test_api_auth_strict_validation_and_cache(client, anon, ready_character_id):
    path = '/api/v1/gatherings'
    assert anon.get(path).status_code == 401
    result = client.post(path, json=dict(request_id=str(uuid4()), title='庭院', display_name='我', scene_type='home'))
    assert result.status_code == 201
    assert result.headers['cache-control'] == 'private, no-store'
    g = result.json()
    p = dict(request_id=str(uuid4()), expected_revision=0, command={'action': 'visit', 'character_id': ready_character_id})
    assert client.post(f'{path}/{g["id"]}/commands', json=p).status_code == 200
    p['command'] = {'action': 'vote', 'vote_id': str(uuid4()), 'agree': 'yes'}
    assert client.post(f'{path}/{g["id"]}/commands', json=p).status_code == 422
    assert client.get(path+'/personal').status_code == 200


def test_story_requires_consent_and_recovers_after_switch_off(world, ready_character_id):
    from app.models.models import Character, Object, Photo
    s, clock = world
    with SessionLocal() as db:
        photo = Photo(owner_id=TEST_USER_ID, filename='fixture.png', status='done')
        db.add(photo); db.flush()
        obj = Object(photo_id=photo.id, label='叶子'); db.add(obj); db.flush()
        c = Character(object_id=obj.id, owner_id=TEST_USER_ID, name='叶子', persona='安静', opening_line='你好', status='ready')
        db.add(c); db.commit(); cid = c.id
    ids = [ready_character_id, cid]
    g = create(s)
    for character in ids:
        g = command(s, g, 'visit', character_id=character)
    with pytest.raises(LivingError):
        command(s, g, 'story', character_ids=ids)
    g = command(s, g, 'story_preference', enabled=True)
    with pytest.raises(LivingError, match='共同活动'):
        command(s, g, 'story', character_ids=ids)
    g = command(s, g, 'activity', character_ids=ids, activity='talk')
    g = command(s, g, 'story', character_ids=ids)
    assert not g['companions'] and g['stories'][0]['status'] == 'resting'
    g = command(s, g, 'story_preference', enabled=False)
    clock[0] += 1200
    g = s.read(TEST_USER_ID, g['id'])
    assert g['stories'][0]['status'] == 'recovered'


def test_homepage_and_private_runtime_show_visit(client, world, ready_character_id):
    s, _ = world
    g = command(s, create(s), 'visit', character_id=ready_character_id)
    overview = client.get('/api/v1/characters/overview').json()
    assert overview[0]['gathering'] == {'id': g['id'], 'title': g['title']}
    command(s, g, 'recall', character_id=ready_character_id)
    assert client.get('/api/v1/characters/overview').json()[0]['gathering'] is None


def test_personal_scene_is_readable_but_not_mutable_during_visit(client, world, ready_character_id, parse_sse):
    s, clock = world
    clock[0] = int(time.time())
    base = f'/api/v1/characters/{ready_character_id}'
    space = client.post('/api/v1/living/spaces', json={
        'scene_type': 'home', 'mode': 'private', 'companion_id': str(ready_character_id),
    })
    assert space.status_code == 201
    assert client.put(f'{base}/location', json={'space_id': space.json()['id']}).status_code == 200
    original = client.get(f'{base}/scene')
    assert original.status_code == 200
    home = original.json()['living']
    g = command(s, create(s), 'visit', character_id=ready_character_id)

    while_away = client.get(f'{base}/scene')
    assert while_away.status_code == 200
    assert while_away.json()['living'] is None
    assert while_away.json()['action_labels'] == {}
    assert while_away.json()['proposal'] is None
    assert client.get(f'{base}/messages').status_code == 200
    reply = client.post(f'{base}/chat', json={'message': '你好呀，帮我种一棵树'})
    assert reply.status_code == 200
    done = [data for event, data in parse_sse(reply.text) if event == 'done']
    assert len(done) == 1 and done[0]['proposal'] is None
    for path in (f'{base}/scene/actions/plant_tree', f'{base}/scene/undo',
                 f'{base}/scene/proposals/{uuid4()}/confirm'):
        response = client.post(path)
        assert response.status_code == 409
        assert response.json()['error']['code'] == 'scene_changed'
    assert client.get(f'{base}/location').json()['space_id'] == g['id']

    command(s, g, 'recall', character_id=ready_character_id)
    back_home = client.get(f'{base}/scene')
    assert back_home.status_code == 200
    assert back_home.json()['living']['id'] == home['id']
    assert back_home.json()['living']['revision'] == home['revision']
