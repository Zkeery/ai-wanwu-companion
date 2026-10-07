"""角色状态机流转测试（generating → ready / failed）。"""
from __future__ import annotations

from app.core.database import SessionLocal
from app.models.models import Character
from app.services import model_client


def _upload(client, png_header):
    res = client.post(
        "/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}
    )
    return res.json()["objects"][0]["id"]


def _character_by_object(obj_id):
    db = SessionLocal()
    try:
        return db.query(Character).filter(Character.object_id == obj_id).first()
    finally:
        db.close()


def test_character_reaches_ready(client, png_header, parse_sse):
    obj_id = _upload(client, png_header)
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    assert any(e == "done" for e, _ in parse_sse(res.text))
    assert _character_by_object(obj_id).status == "ready"


def test_character_failed_on_model_error(client, png_header, parse_sse, monkeypatch):
    def boom(*a, **k):
        raise model_client.ModelError("模拟失败")

    monkeypatch.setattr(model_client.ModelClient, "generate_persona", boom)
    obj_id = _upload(client, png_header)
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    assert any(e == "error" for e, _ in parse_sse(res.text))
    assert _character_by_object(obj_id).status == "failed"
