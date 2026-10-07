"""场景状态、受控操作与撤销测试。"""
from __future__ import annotations


def _create_character(client, png_header, parse_sse):
    res = client.post(
        "/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}
    )
    assert res.status_code == 201
    obj_id = res.json()["objects"][0]["id"]
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    done = [d for e, d in parse_sse(res.text) if e == "done"]
    assert len(done) == 1
    return done[0]["id"]


def test_get_scene_default(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    res = client.get(f"/api/v1/characters/{cid}/scene")
    assert res.status_code == 200
    data = res.json()
    assert data["scene_name"] == "小花园"
    assert data["elements"] == {"rain": 0, "tree": 0, "cloud": 0, "sound": 1,
                                "flower": 0, "mushroom": 0, "pond": 0,
                                "bench": 0, "campfire": 0, "fireflies": 0}
    assert data["can_undo"] is False


def test_action_changes_elements(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/scene/actions/light_rain")
    assert res.status_code == 200
    data = res.json()
    assert data["elements"]["rain"] == 1
    assert data["elements"]["cloud"] == 1
    assert data["can_undo"] is True
    assert data["feedback"]


def test_plant_tree_increments(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    client.post(f"/api/v1/characters/{cid}/scene/actions/plant_tree")
    res = client.post(f"/api/v1/characters/{cid}/scene/actions/plant_tree")
    assert res.json()["elements"]["tree"] == 2


def test_rain_after_quiet_restores_sound_and_undo_restores_quiet(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    quiet = client.post(base + "/actions/quiet").json()["elements"]
    assert quiet["sound"] == 0
    rain = client.post(base + "/actions/light_rain").json()["elements"]
    assert rain["rain"] == rain["sound"] == 1
    assert client.get(base).json()["elements"] == rain
    assert client.post(base + "/undo").json()["elements"] == quiet


def test_undo_restores(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    client.post(f"/api/v1/characters/{cid}/scene/actions/light_rain")
    res = client.post(f"/api/v1/characters/{cid}/scene/undo")
    assert res.status_code == 200
    data = res.json()
    assert data["elements"]["rain"] == 0
    assert data["elements"]["cloud"] == 0
    assert data["can_undo"] is False


def test_undo_nothing_returns_409(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/scene/undo")
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "nothing_to_undo"


def test_invalid_action_returns_400(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/scene/actions/explode")
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_action"


def test_scene_not_ready_character_returns_409(client):
    from app.core.database import SessionLocal
    from app.models.models import Character, Object, Photo
    from tests.auth_helpers import TEST_USER_ID

    db = SessionLocal()
    try:
        photo = Photo(filename="x.png", status="done")
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label="杯子")
        db.add(obj)
        db.flush()
        ch = Character(
            object_id=obj.id, owner_id=TEST_USER_ID, name="", persona="",
            opening_line="", status="failed"
        )
        db.add(ch)
        db.commit()
        cid = ch.id
    finally:
        db.close()

    res = client.get(f"/api/v1/characters/{cid}/scene")
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "character_not_ready"


def test_scene_persists_after_restart(client, png_header, parse_sse):
    import sqlite3

    from app.core.config import get_settings

    cid = _create_character(client, png_header, parse_sse)
    client.post(f"/api/v1/characters/{cid}/scene/actions/plant_tree")

    # 绕过 ORM 直查 SQLite，验证状态已落盘
    settings = get_settings()
    db_path = settings.database_url.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute(
            "SELECT state_json FROM scene_states WHERE character_id = ?", (cid,)
        ).fetchall()
    finally:
        conn.close()
    assert rows
    assert '"tree": 1' in rows[0][0]
