"""显式认领与旧花园迁移。"""
from __future__ import annotations

from sqlalchemy import select

from app.core.database import SessionLocal, engine
from app.living.store import LivingStore, spaces as living_spaces
from app.models.models import Character, Object, Photo, SceneState
from app.services import scene as scene_service
from tests.auth_helpers import TEST_USER_ID


def _seed_legacy() -> int:
    with SessionLocal() as db:
        photo = Photo(filename="old.png", status="done")  # owner 留 NULL
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label="旧杯子")
        db.add(obj)
        db.flush()
        ch = Character(object_id=obj.id, name="旧伙伴", persona="p", opening_line="hi",
                       status="ready")
        db.add(ch)
        db.flush()
        elements = scene_service.default_elements()
        elements["tree"] = 8  # 超限旧存档
        elements["flower"] = 2
        elements["pond"] = 1
        elements["rain"] = 1
        db.add(SceneState(character_id=ch.id,
                          state_json=scene_service.serialize(elements, [])))
        db.commit()
        return ch.id


def test_claim_assigns_and_migrates(client, monkeypatch):
    from app.core.config import get_settings
    monkeypatch.setattr(get_settings(), "legacy_claim_user_id", TEST_USER_ID)
    cid = _seed_legacy()

    res = client.post("/api/v1/auth/claim")
    assert res.status_code == 200
    body = res.json()
    assert body["claimed_characters"] >= 1
    assert body["migrated_scenes"] >= 1

    assert client.get(f"/api/v1/characters/{cid}").status_code == 200

    store = LivingStore(engine)
    with store.engine.connect() as conn:
        row = conn.execute(select(living_spaces).where(
            living_spaces.c.owner_id == TEST_USER_ID,
            living_spaces.c.companion_id == str(cid),
            living_spaces.c.scene_type == "home",
        )).mappings().one()

    snapshot = store.read_space(TEST_USER_ID, row["id"])
    kinds = [item["kind"] for item in snapshot["items"]]
    assert kinds.count("tree") == 8  # 超限保留，不裁剪
    assert kinds.count("flower") == 2
    assert kinds.count("pond") == 1

    assert client.get(f"/api/v1/characters/{cid}/location").json()["space_id"] == row["id"]

    # 重复认领幂等，不再迁移
    again = client.post("/api/v1/auth/claim").json()
    assert again["claimed_characters"] == 0 and again["migrated_scenes"] == 0
