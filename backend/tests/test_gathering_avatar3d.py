"""Procedural object geometry facts: synthetic DB only, no network or model calls."""
import json
import re
from uuid import uuid4

import pytest
from sqlalchemy import delete

from app.core.database import engine, SessionLocal
from app.living.avatar3d import resolve_avatar3d
from app.living.gatherings import GatheringStore, visits
from app.living.rules import LivingError
from app.models.models import Character
from tests.auth_helpers import TEST_USER_ID
from tests.test_gatherings import command, create, member


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    import socket

    def blocked(*_args, **_kwargs):
        raise AssertionError('avatar3d must never use the network')

    monkeypatch.setattr(socket.socket, 'connect', blocked)
    monkeypatch.setattr(socket.socket, 'connect_ex', blocked)


@pytest.mark.parametrize('label,features,kind', [
    ('纸杯', '白色杯身，绿色图案', 'cup'),
    ('花束', '紫色花卉与绿叶', 'bouquet'),
    ('蔓藤植物', '藤蔓和叶片', 'plant'),
    ('苹果', '红色外皮与绿色叶子', 'fruit'),
    ('白衬衫', '白色衣身与蓝色纽扣', 'garment'),
    ('毛绒小熊', '棕色柔软外观', 'creature'),
    ('shirt', 'white cotton shirt', 'garment'),
])
def test_saved_object_facts_select_distinct_geometry(label, features, kind):
    avatar = resolve_avatar3d(41, label=label, visual_features=features)
    assert avatar['kind'] == kind
    assert avatar['source'] == 'procedural_existing_features'
    assert avatar['version'] == 1
    assert 0 <= avatar['seed'] <= 0xffffffff
    assert all(re.fullmatch('#[0-9a-f]{6}', avatar[key]) for key in ('body', 'accent', 'detail'))


def test_stable_identity_explicit_colors_and_category_fallback():
    original = resolve_avatar3d(23, label='杯子', visual_features='浅紫色杯身，绿色把手')
    assert original == resolve_avatar3d(23, label='杯子', visual_features='浅紫色杯身，绿色把手')
    assert original['body'] == '#b69acf'
    assert original['accent'] == '#6ca572'
    assert original['seed'] != resolve_avatar3d(24, label='杯子')['seed']
    assert resolve_avatar3d(23, label='不明主体', category='plant')['kind'] == 'plant'
    assert resolve_avatar3d(23, label='不明主体', category='fruit')['kind'] == 'fruit'


def test_unknown_is_unavailable_not_a_generic_person_or_substring_guess():
    for label in ('无法辨认', 'cupcake wrapper', 'private_secret_object'):
        value = resolve_avatar3d(21, label=label, visual_features='无法确认轮廓')
        assert value['kind'] == 'unavailable'
        assert label not in json.dumps(value)
    assert resolve_avatar3d(21, label='不明主体', category='object')['kind'] == 'unavailable'


def _visited(cid):
    store = GatheringStore(engine, lambda: 1_800_000_000)
    group = command(store, create(store), 'visit', character_id=cid)
    return store, group


def test_shared_dto_uses_saved_facts_never_name_private_text_or_paths(ready_character_id, client, monkeypatch):
    cid = ready_character_id
    with SessionLocal() as db:
        character = db.get(Character, cid)
        character.name = '名字声称是花束'
        character.persona = 'private-persona-cup-红色'
        character.opening_line = 'private-opening-bouquet'
        character.generation_brief_json = '{"appearance_description":"private-brief-shirt"}'
        character.image_path = '/uploads/private-photo-secret.png'
        character.object.label = '不明主体'
        character.object.category = 'unknown'
        character.object.visual_features = '无法确认轮廓-private-feature-secret'
        db.commit()
    store, group = _visited(cid)
    group = member(store, group, 'second-member')
    avatar = store.read('second-member', group['id'])['companions'][0]['avatar3d']
    assert avatar['kind'] == 'unavailable'  # The name and private fields cannot select geometry.
    assert set(avatar) == {'version', 'kind', 'body', 'accent', 'detail', 'seed', 'source'}
    assert 'private-' not in json.dumps(avatar)
    with SessionLocal() as db:
        db.get(Character, cid).object.label = '白色纸杯'
        db.get(Character, cid).object.visual_features = '绿色图案'
        db.commit()
    from app.api import gatherings as gathering_api
    monkeypatch.setattr(gathering_api.store, 'clock', store.clock)
    response = client.get(f"/api/v1/gatherings/{group['id']}")
    assert response.status_code == 200, response.json()
    assert response.json()['companions'][0]['avatar3d']['kind'] == 'cup'
    assert response.headers['cache-control'] == 'private, no-store'


def test_membership_is_checked_before_projection(ready_character_id, monkeypatch):
    store, group = _visited(ready_character_id)
    import app.living.avatar3d as avatar_module
    original = avatar_module.gathering_avatars
    calls = []

    def traced(conn, state, uid):
        calls.append(uid)
        return original(conn, state, uid)

    monkeypatch.setattr(avatar_module, 'gathering_avatars', traced)
    with pytest.raises(LivingError):
        store.read('not-a-member', group['id'])
    assert calls == []
    with engine.connect() as conn:
        raw, revision = store.load(conn, group['id'])
        preview = store.snapshot(raw, revision, '', 1_800_000_000, conn)
    assert preview['companions'][0]['avatar3d']['kind'] == 'unavailable'


@pytest.mark.parametrize('change', ['not_ready', 'other_space', 'changed_owner', 'missing_visit'])
def test_exact_current_visit_binding_required(ready_character_id, change):
    cid = ready_character_id
    store, group = _visited(cid)
    assert group['companions'][0]['avatar3d']['kind'] == 'cup'
    with SessionLocal() as db:
        character = db.get(Character, cid)
        if change == 'not_ready':
            character.status = 'failed'
        elif change == 'other_space':
            character.current_space_id = str(uuid4())
        elif change == 'changed_owner':
            character.owner_id = None
        else:
            db.execute(delete(visits).where(visits.c.character_id == cid))
        db.commit()
    assert store.read(TEST_USER_ID, group['id'])['companions'][0]['avatar3d']['kind'] == 'unavailable'


def test_recall_removes_appearance_and_nonowner_cannot_recall(ready_character_id):
    store, group = _visited(ready_character_id)
    group = member(store, group, 'second-member')
    before = store.read('second-member', group['id'])
    assert before['companions'][0]['avatar3d']['kind'] == 'cup'
    with pytest.raises(LivingError):
        command(store, before, 'recall', uid='second-member', character_id=ready_character_id)
    after = command(store, before, 'recall', character_id=ready_character_id)
    assert after['companions'] == []
    assert store.read('second-member', group['id'])['companions'] == []
