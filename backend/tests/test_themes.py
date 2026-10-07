"""R5.1 theme attribution and rejection before paid work; all model output is synthetic."""
import json
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, text

from app.core.database import SessionLocal
from app.core.theme_schema import ensure_theme_columns
from app.models.models import Character, GenerationCharge, Object, Photo
from app.services.model_client import ModelClient
from app.services.parsers import ParseError, RecognizedObject, parse_recognize


def upload(client, monkeypatch, png_header, *, category="fruit", label="苹果", theme="fruit", key=None):
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: [RecognizedObject(label=label, category=category)])
    return client.post("/api/v1/photos", files={"file": ("test.png", png_header, "image/png")},
                       data={} if theme is None else {"theme_id": theme},
                       headers={"Idempotency-Key": key or str(uuid4())})


def generate(client, photo, **extra):
    return client.post("/api/v1/characters", json={"object_id": photo["objects"][0]["id"], **extra})


def result(response, parse_sse):
    assert response.status_code == 200, response.text
    events = parse_sse(response.text)
    assert events[-1][0] == "done", events
    return events[-1][1]


def test_theme_directory_is_public_and_contains_no_private_data(anon):
    themes = anon.get("/api/v1/themes").json()
    assert themes[0]["id"] == "fruit"
    assert set(themes[0]) == {"id", "title", "description", "category"}


@pytest.mark.parametrize("label", ["苹果", "橘子", "香蕉"])
def test_different_fruits_generate_private_companions_and_recover_theme(client, anon, monkeypatch, png_header, parse_sse, label):
    key = str(uuid4())
    photo = upload(client, monkeypatch, png_header, label=label, key=key).json()
    assert photo["theme_id"] == "fruit" and photo["objects"][0]["category"] == "fruit"
    ch = result(generate(client, photo), parse_sse)
    assert ch["theme_id"] == "fruit"
    cid = ch["id"]
    for path in [f"/characters/{cid}", f"/characters/by-object/{photo['objects'][0]['id']}"]:
        assert client.get("/api/v1" + path).json()["theme_id"] == "fruit"
        assert anon.get("/api/v1" + path).status_code == 401
    assert client.get("/api/v1/characters").json()[0]["theme_id"] == "fruit"
    assert client.get(f"/api/v1/photos/requests/{key}").json()["photo"]["theme_id"] == "fruit"
    assert client.patch(f"/api/v1/characters/{cid}", json={"name": "新名字"}).json()["theme_id"] == "fruit"
    with SessionLocal() as db:
        assert db.get(Character, cid).theme_id == "fruit"


@pytest.mark.parametrize("category,label", [("object", "苹果电脑"), ("unknown", "苹果"), ("plant", "小树"), ("other", "小狗")])
def test_mismatch_does_not_create_or_charge_or_call_generation(client, monkeypatch, png_header, category, label):
    photo = upload(client, monkeypatch, png_header, category=category, label=label).json()
    def unexpected(*args, **kwargs):
        pytest.fail("Rejected theme must not call generation")
    monkeypatch.setattr(ModelClient, "generate_concept", unexpected)
    response = generate(client, photo)
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "theme_mismatch"
    with SessionLocal() as db:
        assert db.query(Character).count() == 0
        assert db.query(GenerationCharge).count() == 0


def test_explicit_free_creation_preserves_source_theme_but_not_character_theme(client, monkeypatch, png_header, parse_sse):
    photo = upload(client, monkeypatch, png_header, category="object", label="杯子").json()
    ch = result(generate(client, photo, free_creation=True), parse_sse)
    assert ch["theme_id"] is None
    assert client.get(f"/api/v1/photos/{photo['id']}").json()["theme_id"] == "fruit"


def test_label_edit_cannot_reuse_old_category_even_after_failed_free_generation(client, monkeypatch, png_header, parse_sse):
    photo = upload(client, monkeypatch, png_header).json()
    assert generate(client, photo, label="电脑").status_code == 409
    def fail(*args, **kwargs):
        raise RuntimeError("synthetic failure")
    monkeypatch.setattr(ModelClient, "generate_concept", fail)
    response = generate(client, photo, label="电脑", free_creation=True)
    assert parse_sse(response.text)[-1][0] == "error"
    assert generate(client, photo).status_code == 409
    with SessionLocal() as db:
        assert db.get(Object, photo["objects"][0]["id"]).category == "unknown"


def test_idempotency_includes_theme_and_correction_preserves_it(client, monkeypatch, png_header):
    key = str(uuid4())
    photo = upload(client, monkeypatch, png_header, key=key).json()
    assert upload(client, monkeypatch, png_header, key=key).json() == photo
    assert upload(client, monkeypatch, png_header, key=key, theme=None).status_code == 409
    correction_key = str(uuid4())
    path = f"/api/v1/photos/{photo['id']}/corrections"
    corrected = client.post(path, headers={"Idempotency-Key": correction_key}).json()
    assert corrected["theme_id"] == "fruit" and corrected["objects"][0]["category"] == "fruit"
    assert client.post(path, headers={"Idempotency-Key": correction_key}).json() == corrected


@pytest.mark.parametrize("theme", ["invalid", "", " ", "../fruit"])
def test_invalid_theme_rejected_before_recognition(client, monkeypatch, png_header, theme):
    def unexpected(*args):
        pytest.fail("Invalid topic must not call vision")
    monkeypatch.setattr(ModelClient, "recognize", unexpected)
    assert client.post("/api/v1/photos", files={"file": ("test.png", png_header)}, data={"theme_id": theme}).status_code == 422


@pytest.mark.parametrize("free", [False, True])
def test_recreation_inherits_character_theme_not_source_photo_theme(client, monkeypatch, png_header, parse_sse, free):
    from app.core.config import get_settings
    monkeypatch.setattr(get_settings(), "generation_quota_enabled", True)
    photo = upload(client, monkeypatch, png_header).json()
    first = result(generate(client, photo, free_creation=free), parse_sse)
    key = str(uuid4())
    second = result(client.post(f"/api/v1/characters/{first['id']}/recreations", json={"request_id": key}), parse_sse)
    assert second["id"] != first["id"]
    assert second["theme_id"] == first["theme_id"] == (None if free else "fruit")
    assert client.get(f"/api/v1/characters/recreation-requests/{key}").json()["character"]["theme_id"] == second["theme_id"]


def test_category_parser_is_strict_but_old_outputs_remain_usable():
    assert parse_recognize('[{"label":"杯子"}]')[0].category == "unknown"
    for value in ["FRUIT", None, [], 12]:
        with pytest.raises(ParseError):
            parse_recognize(json.dumps([{"label": "苹果", "category": value}]))


def test_another_account_cannot_read_or_generate_from_themed_photo(client, monkeypatch, png_header, parse_sse):
    from datetime import datetime, timedelta
    from app.models.models import User, Session
    from app.core.security import hash_token
    photo = upload(client, monkeypatch, png_header).json()
    ch = result(generate(client, photo), parse_sse)
    with SessionLocal() as db:
        user = User(id=str(uuid4()), phone="13900000098")
        db.add(user)
        db.flush()
        db.add(Session(token_hash=hash_token("isolated-other-theme-test"), user_id=user.id,
                       expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    headers = {"Authorization": "Bearer isolated-other-theme-test"}
    for path in [f"photos/{photo['id']}", f"characters/{ch['id']}"]:
        assert client.get("/api/v1/" + path, headers=headers).status_code == 404
    assert client.post("/api/v1/characters", headers=headers,
                       json={"object_id": photo["objects"][0]["id"], "free_creation": True}).status_code == 404


def test_additive_upgrade_twice_keeps_old_rows():
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE photos (id INTEGER PRIMARY KEY, filename TEXT)"))
        conn.execute(text("CREATE TABLE objects (id INTEGER PRIMARY KEY, label TEXT)"))
        conn.execute(text("CREATE TABLE characters (id INTEGER PRIMARY KEY, name TEXT)"))
        conn.execute(text("INSERT INTO photos VALUES (1, 'old.png')"))
        conn.execute(text("INSERT INTO objects VALUES (1, '旧杯子')"))
        conn.execute(text("INSERT INTO characters VALUES (1, '旧伙伴')"))
    ensure_theme_columns(engine)
    ensure_theme_columns(engine)
    with engine.connect() as conn:
        assert tuple(conn.execute(text("SELECT name, theme_id FROM characters")).one()) == ("旧伙伴", None)
        assert tuple(conn.execute(text("SELECT label, category FROM objects")).one()) == ("旧杯子", "unknown")
        assert tuple(conn.execute(text("SELECT filename, theme_id FROM photos")).one()) == ("old.png", None)
