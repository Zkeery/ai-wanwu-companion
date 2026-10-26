"""Synthetic recognition regressions; never contact a real model provider."""
import json
import logging
from uuid import uuid4

import pytest

from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, PhotoRequest
from app.services.generation_errors import record_failure
from app.services.model_client import ModelClient
from app.services.parsers import ParseError, parse_recognize
from tests.test_concept_pipeline import setup_provider, upload, generate, CONCEPT


def primary():
    return {"label": "花束", "visual_features": "合成测试的紫色花瓣", "category": "plant", "concept": dict(CONCEPT)}


@pytest.mark.parametrize("wrapper", [None, "objects", "items", "labels", "results"])
def test_secondary_null_is_optional_without_changing_primary_fields(wrapper):
    items = [primary(), {"label": "花瓶", "visual_features": "白色", "category": "object", "concept": None}]
    objects = parse_recognize(json.dumps({wrapper: items} if wrapper else items))
    assert len(objects) == 2
    assert objects[0].concept.name == CONCEPT["name"]
    assert objects[0].visual_features == items[0]["visual_features"]
    assert objects[1].concept is None and objects[1].label == "花瓶"


@pytest.mark.parametrize("fields", [{"label": ""}, {"visual_features": 123}, {"category": "flower"}])
def test_null_concept_never_bypasses_secondary_object_validation(fields):
    secondary = {"label": "花瓶", "category": "object", "concept": None, **fields}
    with pytest.raises(ParseError):
        parse_recognize(json.dumps([primary(), secondary]))


@pytest.mark.parametrize("items", [[{**primary(), "concept": None}], [primary(), {"label": "花瓶", "concept": {}}]])
def test_primary_null_and_incomplete_non_null_secondary_remain_rejected(items):
    with pytest.raises(ParseError):
        parse_recognize(json.dumps(items))


@pytest.mark.parametrize("error,code", [
    ("人设输出应为对象", "profile_type"),
    ("人设输出缺少有效的 name", "profile_name_missing"),
    ("人设输出缺少有效的 persona", "profile_persona_missing"),
    ("开场白为空", "profile_opening_empty"),
    ("角色输出缺少有效的 opening_line", "profile_opening_missing"),
    ("形象设计描述应为不超过1000字的文字", "appearance_invalid"),
    ("private-untrusted-provider-text", "schema_invalid"),
])
def test_diagnostics_return_fixed_field_code_without_raw_content(error, code, caplog, monkeypatch):
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "handlers", [caplog.handler])
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        result = record_failure("recognition_concept", "synthetic", ParseError(error))
    assert result["parse_code"] == code and result["reason"] == "invalid_output"
    assert code in caplog.text
    assert "private-untrusted-provider-text" not in str(result) + caplog.text


@pytest.mark.parametrize("field,value,code", [
    ("name", "", "profile_name_missing"),
    ("persona", None, "profile_persona_missing"),
    ("opening_line", None, "profile_opening_missing"),
    ("opening_line", " ", "profile_opening_empty"),
    ("appearance_description", [], "appearance_invalid"),
])
def test_incomplete_primary_is_specific_durable_and_never_replayed(client, png_header, monkeypatch, field, value, code):
    item = primary();item["concept"][field] = value
    calls = []
    def recognize(*args):
        calls.append(True)
        return parse_recognize(json.dumps([item]))
    monkeypatch.setattr(ModelClient, "recognize", recognize)
    key = str(uuid4())
    def post():
        return client.post("/api/v1/photos", files={"file": ("flower.jpg", png_header, "image/jpeg")}, headers={"Idempotency-Key": key})
    response = post()
    assert response.status_code == 502
    error = response.json()["error"]
    assert error["reason"] == "invalid_output" and error["parse_code"] == code
    assert "照片已读取" in error["message"] and "识别服务返回" in error["message"]
    assert "private" not in response.text and item["visual_features"] not in response.text
    assert client.get(f"/api/v1/photos/requests/{key}").json() == {"status": "failed", "photo": None}
    assert post().status_code == 409 and calls == [True]
    with SessionLocal() as db:
        assert db.get(PhotoRequest, key).status == "failed"
        assert db.query(Photo).count() == db.query(Object).count() == db.query(Character).count() == 0


def test_full_flow_with_secondary_null_stays_two_mock_calls_and_recovers(client, png_header, monkeypatch, tmp_path, parse_sse):
    calls = setup_provider(monkeypatch, tmp_path, png_header)
    original_vision = ModelClient._call_vision
    def vision(self, *args, **kwargs):
        items = json.loads(original_vision(self, *args, **kwargs))
        items.append({"label": "花瓶", "visual_features": "白色", "category": "object", "concept": None})
        return json.dumps(items)
    monkeypatch.setattr(ModelClient, "_call_vision", vision)
    oid = upload(client, png_header)
    event, result = generate(client, oid, parse_sse)
    assert event == "done" and result["name"] == CONCEPT["name"]
    assert [kind for kind, _ in calls] == ["vision", "image"]
    response = client.get(f"/api/v1/characters/{result['id']}")
    assert response.status_code == 200 and response.json()["image_path"] == result["image_path"]
    with SessionLocal() as db:
        assert db.query(Photo).count() == 1 and db.query(Object).count() == 2 and db.query(Character).count() == 1
    assert len(calls) == 2
