"""R8.3: a shared visit must not expose the owner's private media."""
from datetime import datetime, timedelta
from pathlib import Path
from uuid import uuid4

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal, engine
from app.core.security import hash_token
from app.models.models import Character, Session, User
from app.living.gatherings import GatheringStore
from app.living.rules import LivingError
from app.services.voice import VoiceService
from tests.test_voice import Speech, wav
from tests.auth_helpers import TEST_USER_ID


def _account(phone: str):
    user_id, token = str(uuid4()), str(uuid4())
    with SessionLocal() as db:
        db.add(User(id=user_id, phone=phone))
        db.flush()
        db.add(Session(token_hash=hash_token(token), user_id=user_id,
                       expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    return {"Authorization": f"Bearer {token}"}


def _command(client, group, action, headers=None, **fields):
    return client.post(f"/api/v1/gatherings/{group['id']}/commands", headers=headers,
                       json={"request_id": str(uuid4()), "expected_revision": group["revision"],
                             "command": {"action": action, **fields}})


def test_visit_media_permissions_are_revoked_on_leave(
        client, anon, ready_character_id, png_header, monkeypatch):
    member = _account("13900000066")
    stranger = _account("13900000067")
    image_name = f"private-{uuid4()}.png"
    upload = Path(get_settings().upload_dir)
    upload.mkdir(parents=True, exist_ok=True)
    (upload / image_name).write_bytes(png_header)
    with SessionLocal() as db:
        ch = db.get(Character, ready_character_id)
        ch.image_path = image_name
        db.commit()

    voice = VoiceService(engine, lambda: 1_800_000_000, Speech())
    monkeypatch.setattr("app.api.voice.service", voice)
    monkeypatch.setattr("app.services.voice.local_voices", lambda: [{"id": "local-test", "label": "测试音色"}])
    monkeypatch.setattr("app.services.model_client.ModelClient.chat_stream",
                        lambda *args: (_ for _ in ()).throw(AssertionError("external model forbidden")))
    voice.send(TEST_USER_ID, ready_character_id, str(uuid4()), "你好", wav(), offline=True)
    audio_ids = [item["id"] for item in voice.history(TEST_USER_ID, ready_character_id)]

    private_image = f"/uploads/{image_name}"
    voice_base = f"/api/v1/characters/{ready_character_id}/voice"
    for path in [private_image, *(f"{voice_base}/audio/{aid}" for aid in audio_ids)]:
        own = client.get(path)
        assert own.status_code == 200 and own.content
        assert own.headers["cache-control"] == "private, no-store"
        for headers, expected in [(None, 401), (member, 404), (stranger, 404)]:
            response = anon.get(path, headers=headers)
            assert response.status_code == expected
            assert response.headers["cache-control"] == "private, no-store"
            assert response.content != own.content

    created = client.post("/api/v1/gatherings", json={"request_id": str(uuid4()),
        "title": "合成小院", "display_name": "主人", "scene_type": "home"})
    assert created.status_code == 201
    group = created.json()
    invited = _command(client, group, "invite")
    assert invited.status_code == 200
    group = invited.json()
    joined = anon.post("/api/v1/gatherings/invitations/join", headers=member,
                       json={"request_id": str(uuid4()), "token": group["invitation"],
                             "display_name": "访客"})
    assert joined.status_code == 200
    group = joined.json()
    visited = _command(client, group, "visit", character_id=ready_character_id)
    assert visited.status_code == 200
    group = visited.json()
    shared_image = f"/api/v1/gatherings/{group['id']}/companions/{ready_character_id}/image"
    detail = f"/api/v1/gatherings/{group['id']}"
    assert anon.get(shared_image, headers=member).content == png_header
    assert anon.get(detail, headers=member).status_code == 200
    assert anon.get(shared_image, headers=stranger).status_code == 404
    assert anon.get(detail, headers=stranger).status_code == 404
    assert anon.get(shared_image).status_code == 401

    left = _command(anon, group, "leave", headers=member)
    assert left.status_code == 200
    for path in (shared_image, detail):
        response = anon.get(path, headers=member)
        assert response.status_code == 404
        assert response.headers["cache-control"] == "private, no-store"
        assert response.content != png_header
    assert _command(anon, group, "start_goal", headers=member).status_code == 404
    assert anon.get(private_image, headers=member).status_code == 404
    assert all(anon.get(f"{voice_base}/audio/{aid}", headers=member).status_code == 404
               for aid in audio_ids)
    assert client.get(shared_image).content == png_header
    reopened = GatheringStore(engine)
    assert reopened.read(TEST_USER_ID, group["id"])["id"] == group["id"]
    with pytest.raises(LivingError):
        reopened.read(anon.get("/api/v1/auth/me", headers=member).json()["id"], group["id"])
