"""Public wall contracts, ownership, revocation and persistence without model calls."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.core.security import hash_token
from app.models.models import Character, ThemePublication, Session, User


@pytest.fixture
def shareable(ready_character_id, png_header):
    root = Path(get_settings().upload_dir)
    root.mkdir(exist_ok=True, parents=True)
    filename = f"wall-{uuid4()}.png"
    (root / filename).write_bytes(png_header)
    with SessionLocal() as db:
        ch = db.get(Character, ready_character_id)
        ch.theme_id = "fruit"
        ch.image_path = filename
        db.commit()
    return ready_character_id


def publish(client, cid, **extra):
    r = client.put(f"/api/v1/wall/characters/{cid}", json={"author_name": "小桃", **extra})
    assert r.status_code == 200, r.text
    return r.json()["publication_id"]


def test_preview_is_private_and_does_not_publish(client, anon, shareable):
    path = f"/api/v1/wall/characters/{shareable}"
    assert anon.get(path).status_code == 401
    r = client.get(path)
    assert r.headers["cache-control"] == "no-store"
    assert r.json()["publication_id"] is None
    assert r.json()["author_name"] == "小小创作者"
    assert anon.get("/api/v1/themes/fruit/works").json() == {"items": [], "total": 0, "next_offset": None}


def test_publish_is_idempotent_and_public_view_has_only_approved_fields(client, anon, shareable):
    pid = publish(client, shareable)
    assert publish(client, shareable, author_name="重复请求") == pid
    r = anon.get("/api/v1/themes/fruit/works")
    assert r.headers["cache-control"] == "no-store"
    assert r.json()["total"] == 1
    item = r.json()["items"][0]
    assert set(item) == {"id", "theme_id", "name", "introduction", "author_name", "image_url", "published_at"}
    assert item["author_name"] == "小桃"
    assert "/uploads/" not in str(item)
    image = anon.get(item["image_url"])
    assert image.status_code == 200 and image.headers["content-type"] == "image/png"
    assert image.headers["cache-control"] == "no-store"
    assert anon.get(f"/api/v1/characters/{shareable}").status_code == 401
    assert anon.get(f"/api/v1/themes/fruit/works/{pid}").json() == item


def test_withdraw_revokes_detail_and_image_keeps_private_character(client, anon, shareable):
    pid = publish(client, shareable)
    url = f"/api/v1/themes/fruit/works/{pid}"
    for _ in range(2):
        assert client.delete(f"/api/v1/wall/characters/{shareable}").status_code == 204
    for suffix in ["", "/image"]:
        assert anon.get(url + suffix).status_code == 404
    assert anon.get("/api/v1/themes/fruit/works").json()["total"] == 0
    assert client.get(f"/api/v1/characters/{shareable}").status_code == 200
    assert publish(client, shareable) != pid


def test_rename_updates_public_view_and_delete_cascades(client, anon, shareable):
    pid = publish(client, shareable)
    client.patch(f"/api/v1/characters/{shareable}", json={"name": "新名字"})
    url = f"/api/v1/themes/fruit/works/{pid}"
    assert anon.get(url).json()["name"] == "新名字"
    assert client.delete(f"/api/v1/characters/{shareable}").status_code == 204
    assert anon.get(url).status_code == 404
    assert anon.get(url + "/image").status_code == 404
    with SessionLocal() as db:
        assert db.query(ThemePublication).count() == 0


def test_other_account_can_view_but_cannot_publish_withdraw_or_read_private(client, shareable):
    pid = publish(client, shareable)
    uid = str(uuid4())
    with SessionLocal() as db:
        db.add(User(id=uid, phone="13900000088"))
        db.flush()
        db.add(Session(token_hash=hash_token("other-wall-account"), user_id=uid,
                       expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    headers = {"Authorization": "Bearer other-wall-account"}
    path = f"/api/v1/wall/characters/{shareable}"
    assert client.get(path, headers=headers).status_code == 404
    assert client.put(path, json={"author_name": "别人"}, headers=headers).status_code == 404
    assert client.delete(path, headers=headers).status_code == 404
    for tail in ["", "/messages", "/memories", "/scene"]:
        assert client.get(f"/api/v1/characters/{shareable}" + tail, headers=headers).status_code == 404
    assert client.get(f"/api/v1/themes/fruit/works/{pid}", headers=headers).status_code == 200


@pytest.mark.parametrize("changes", [{"theme_id": None}, {"theme_id": "missing"}, {"status": "generating"},
                                      {"status": "failed"}, {"image_path": None}, {"image_path": "../secret.png"},
                                      {"image_path": "/etc/passwd"}, {"image_path": "missing.png"}])
def test_unpublishable_rejected(client, shareable, changes):
    with SessionLocal() as db:
        ch = db.get(Character, shareable)
        for key, value in changes.items():
            setattr(ch, key, value)
        db.commit()
    assert client.put(f"/api/v1/wall/characters/{shareable}", json={"author_name": "小桃"}).status_code == 409


@pytest.mark.parametrize("name", ["", "  ", "长" * 21, "小\x00桃", "小\u202e桃", "13900000088"])
def test_invalid_public_alias(client, shareable, name):
    assert client.put(f"/api/v1/wall/characters/{shareable}", json={"author_name": name}).status_code == 422


def test_unknown_fields_and_bad_pagination(client, anon, shareable):
    assert client.put(f"/api/v1/wall/characters/{shareable}", json={"author_name": "小桃", "owner_id": "other"}).status_code == 422
    for query in ["limit=0", "limit=51", "offset=-1"]:
        assert anon.get("/api/v1/themes/fruit/works?" + query).status_code == 422


def test_concurrent_publish_and_new_session_persist_single_record(client, anon, shareable):
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(lambda _: publish(client, shareable), range(4)))
    assert len(set(ids)) == 1
    with SessionLocal() as db:
        assert db.query(ThemePublication).count() == 1
        assert db.query(ThemePublication).one().id == ids[0]
    assert anon.get("/api/v1/themes/fruit/works?offset=1&limit=1").json() == {"items": [], "total": 1, "next_offset": None}


def test_pagination_order_and_introduction_limit(client, anon, shareable):
    first = publish(client, shareable)
    with SessionLocal() as db:
        ch = db.get(Character, shareable)
        second = Character(object_id=ch.object_id, owner_id=ch.owner_id, theme_id="fruit", name="后来者",
                           persona="暖" * 200, opening_line="你好", image_path=ch.image_path, status="ready")
        db.add(second)
        db.commit()
        cid = second.id
    last = publish(client, cid)
    page = anon.get("/api/v1/themes/fruit/works?limit=1").json()
    assert page["total"] == 2 and page["next_offset"] == 1
    assert page["items"][0]["id"] == last and len(page["items"][0]["introduction"]) == 160
    assert anon.get("/api/v1/themes/fruit/works?limit=1&offset=1").json()["items"][0]["id"] == first
