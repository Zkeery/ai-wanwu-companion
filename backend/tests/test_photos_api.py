"""照片上传校验测试（格式/真实类型/大小/安全文件名）。"""
from __future__ import annotations

from app.api.photos import _safe_filename

import hashlib
import json
from uuid import uuid4
from unittest.mock import Mock

import pytest
from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, PhotoRequest
from app.services.model_client import ModelClient
from app.services.parsers import ParseError, parse_recognize
from tests.auth_helpers import TEST_USER_ID


@pytest.mark.parametrize("count", [1, 5, 6])
def test_candidate_cap_and_response_exits(client, png_header, monkeypatch, count):
    labels = [f"合成物品{i}" for i in range(count)]
    parsed = parse_recognize(json.dumps([{"label": label} for label in labels]))
    assert [obj.label for obj in parsed] == labels[:5]
    recognize = Mock(return_value=parsed)
    monkeypatch.setattr(ModelClient, "recognize", recognize)
    key = str(uuid4())
    def upload():
        return client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")},
                           headers={"Idempotency-Key": key})
    response = upload()
    assert response.status_code == 201
    photo = response.json()
    assert [o["label"] for o in photo["objects"]] == labels[:5]
    assert client.get(f"/api/v1/photos/{photo['id']}").json() == photo
    assert client.get(f"/api/v1/photos/requests/{key}").json()["photo"] == photo
    assert upload().json() == photo
    assert recognize.call_count == 1
    with SessionLocal() as db:
        assert db.query(Object).count() == min(count, 5)


@pytest.mark.parametrize("bad", [[], [{}], ["invalid"], [{"label": "好"}] * 5 + [None],
                                 [{"label": "好"}] * 5 + [{"label": 1}]])
def test_all_candidates_validated_before_cap(client, png_header, monkeypatch, bad):
    with pytest.raises(ParseError):
        parse_recognize(json.dumps(bad))
    monkeypatch.setattr(ModelClient, "recognize", lambda *_: parse_recognize(json.dumps(bad)))
    response = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")})
    assert response.status_code == 502
    with SessionLocal() as db:
        assert db.query(Photo).count() == db.query(Object).count() == 0


def test_legacy_candidates_clipped_without_deleting_objects_or_character(client, png_header, monkeypatch):
    key = str(uuid4())
    with SessionLocal() as db:
        photo = Photo(filename="old.png", status="done", owner_id=TEST_USER_ID)
        db.add(photo)
        db.flush()
        # Deliberately shuffled insertion order: responses must sort by stable IDs.
        for oid in [6, 4, 2, 5, 1, 3]:
            db.add(Object(id=oid, photo_id=photo.id, label=f"旧物品{oid}"))
        db.flush()
        character = Character(object_id=6, owner_id=TEST_USER_ID, name="旧伙伴",
                              persona="测试", opening_line="你好", status="ready")
        db.add(character)
        db.add(PhotoRequest(id=key, owner_id=TEST_USER_ID,
                            digest=hashlib.sha256(png_header).hexdigest(),
                            status="ready", photo_id=photo.id))
        db.commit()
        pid, cid = photo.id, character.id
    recognize = Mock(side_effect=AssertionError("replay must not recognize"))
    monkeypatch.setattr(ModelClient, "recognize", recognize)
    replay = client.post("/api/v1/photos", files={"file": ("old.png", png_header, "image/png")},
                         headers={"Idempotency-Key": key})
    for result in [replay.json(), client.get(f"/api/v1/photos/{pid}").json(),
                   client.get(f"/api/v1/photos/requests/{key}").json()["photo"]]:
        assert [o["id"] for o in result["objects"]] == [1, 2, 3, 4, 5]
    assert client.get("/api/v1/characters/by-object/6").json()["id"] == cid
    assert client.get(f"/api/v1/characters/{cid}").json()["name"] == "旧伙伴"
    with SessionLocal() as db:
        assert db.query(Object).count() == 6
        assert db.get(Character, cid).object_id == 6
    recognize.assert_not_called()


def test_safe_filename_strips_path():
    assert _safe_filename("../../evil.png") == "evil.png"
    assert _safe_filename("a\\b\\c.jpg") == "c.jpg"
    assert _safe_filename(None) == "upload"


def test_upload_wrong_type_returns_400(client):
    res = client.post(
        "/api/v1/photos",
        files={"file": ("a.txt", b"not an image", "text/plain")},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "invalid_type"


def test_upload_too_large_returns_400(client, png_header, monkeypatch):
    monkeypatch.setattr("app.api.photos.MAX_SIZE", 10)
    res = client.post(
        "/api/v1/photos",
        files={"file": ("a.png", png_header + b"x" * 20, "image/png")},
    )
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "too_large"


def test_upload_valid_png_returns_objects(client, png_header):
    res = client.post(
        "/api/v1/photos",
        files={"file": ("cup.png", png_header, "image/png")},
    )
    assert res.status_code == 201
    data = res.json()
    assert data["status"] == "done"
    assert [o["label"] for o in data["objects"]] == ["杯子", "植物"]
