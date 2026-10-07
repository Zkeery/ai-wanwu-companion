"""Shared delivery uses synthetic packs; no provider requests."""
import hashlib
from uuid import uuid4

import pytest

from app.core.database import SessionLocal, engine
from app.living.gatherings import GatheringStore
from app.models.models import Character, User
from tests.auth_helpers import TEST_USER_ID
from tests.test_gatherings import create, command
from tests.test_multi_activity_motion import classified, add
from tests.test_private_motion import pack  # noqa: F401


def setup(pack, tmp_path, activity='rest', other_owner=False):
    cid, original, _ = pack
    add(cid, classified(original, tmp_path / activity, activity), activity)
    owner = TEST_USER_ID
    if other_owner:
        owner = 'shared-motion-owner'
        with SessionLocal() as db:
            db.add(User(id=owner, phone='13900990011'))
            db.flush()
            db.get(Character, cid).owner_id = owner
            db.commit()
    store = GatheringStore(engine)
    g = create(store, owner=owner)
    if other_owner:
        g = command(store, g, 'invite', uid=owner)
        g = store.join(TEST_USER_ID, str(uuid4()), g['invitation'], '访客')
    g = command(store, g, 'visit', uid=owner, character_id=cid)
    g = command(store, g, 'activity', uid=owner, character_ids=[cid], activity=activity)
    return store, g, f"/api/v1/gatherings/{g['id']}/companions/{cid}/motion", owner


@pytest.mark.parametrize('activity', ['rest', 'walk', 'observe'])
def test_member_reads_only_current_bound_activity(client, anon, pack, tmp_path, activity):
    _, g, base, _ = setup(pack, tmp_path, activity)
    response = client.get(base, params={'activity': activity})
    assert response.status_code == 200
    data = response.json()
    assert data['state'] == 'ready' and data['activity'] == activity
    assert data['sprite_url'].startswith(base + '/activity/' + activity)
    for kind in ('sprite', 'background'):
        result = client.get(data[kind + '_url'])
        assert result.status_code == 200
        assert result.headers['cache-control'] == 'private, no-store'
        assert result.headers['vary'] == 'Authorization'
        assert hashlib.sha256(result.content).hexdigest() == data[kind + '_sha256']
        assert anon.get(data[kind + '_url']).status_code == 401
    assert anon.get(base, params={'activity': activity}).status_code == 401
    assert client.get(base, params={'activity': 'talk'}).status_code == 422
    assert client.get(base, params={'activity': 'walk' if activity == 'rest' else 'rest'}).status_code == 404
    assert client.get(data['sprite_url'].replace(data['pack_id'], 'f' * 32)).status_code == 404


@pytest.mark.parametrize('change', ['recall', 'activity', 'dissolve', 'location', 'source'])
def test_old_urls_stop_when_scene_or_source_changes(client, pack, tmp_path, change):
    s, g, base, owner = setup(pack, tmp_path)
    media = client.get(base + '?activity=rest').json()['sprite_url']
    if change == 'recall':
        command(s, g, 'recall', character_id=pack[0])
    elif change == 'activity':
        command(s, g, 'activity', character_ids=[pack[0]], activity='walk')
    elif change == 'dissolve':
        command(s, g, 'propose_dissolve')
    elif change == 'location':
        with SessionLocal() as db:
            db.get(Character, pack[0]).current_space_id = None
            db.commit()
    else:
        pack[2].write_bytes(b'changed')
    for url in (base + '?activity=rest', media):
        result = client.get(url)
        assert result.status_code == (409 if change == 'source' else 404)
        assert 'error' in result.json()


@pytest.mark.parametrize('change', ['leave', 'remove'])
def test_other_member_sees_shared_motion_but_not_private_and_loses_access(client, pack, tmp_path, change):
    s, g, base, owner = setup(pack, tmp_path, other_owner=True)
    assert client.get(f'/api/v1/characters/{pack[0]}/motion?activity=rest').status_code == 404
    response = client.get(base + '?activity=rest')
    assert response.status_code == 200
    media = response.json()['sprite_url']
    assert client.get(media).status_code == 200
    if change == 'leave':
        command(s, g, 'leave')
    else:
        command(s, g, 'remove', uid=owner, member_id=TEST_USER_ID)
    assert client.get(base + '?activity=rest').status_code == 404
    assert client.get(media).status_code == 404


def test_missing_pack_never_falls_back_to_other_activity(client, pack, tmp_path):
    s, g, base, _ = setup(pack, tmp_path)
    command(s, g, 'activity', character_ids=[pack[0]], activity='observe')
    assert client.get(base + '?activity=observe').json() == {'state': 'missing'}
