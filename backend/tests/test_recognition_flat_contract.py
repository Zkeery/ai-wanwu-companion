"""Flat live contract and lossless legacy wrappers; no real model requests."""
import json
import logging
from uuid import uuid4

import pytest

from app.core.database import SessionLocal
from app.models.models import Character, Object, Photo, PhotoRequest
from app.services.generation_errors import record_failure
from app.services.model_client import ModelClient
from app.services.parsers import ParseError, parse_recognize
from tests.test_concept_pipeline import CONCEPT, generate, setup_provider, upload

FIELDS = {"character_name": "name", "character_persona": "persona", "opening_line": "opening_line", "appearance_description": "appearance_description"}


def base():
    return {"label": "合成杯子", "visual_features": "private-synthetic-photo-features", "category": "object"}


def flat():
    return {**base(), **{key: CONCEPT[target] for key, target in FIELDS.items()}}


@pytest.mark.parametrize("extra", [{}, {"concept": None}, {"concept": CONCEPT}, {"concept": json.dumps(CONCEPT)}, {"concept": [CONCEPT]}])
def test_flat_contract_preserves_exact_profile_and_accepts_matching_legacy(extra):
    result = parse_recognize(json.dumps([{**flat(), **extra}]))[0]
    assert result.label == base()["label"] and result.visual_features == base()["visual_features"]
    assert result.concept.name == CONCEPT["name"]
    assert result.concept.persona == CONCEPT["persona"]
    assert result.concept.opening_line == CONCEPT["opening_line"]
    assert result.concept.appearance_description == CONCEPT["appearance_description"]


@pytest.mark.parametrize("value", [CONCEPT, json.dumps(CONCEPT), [CONCEPT], json.dumps([CONCEPT]), '```json\n'+json.dumps(CONCEPT)+'\n```'])
def test_legacy_wrappers_are_unwrapped_without_inventing_content(value):
    profile = parse_recognize(json.dumps([{**base(), "concept": value}]))[0].concept
    assert profile.name == CONCEPT["name"] and profile.appearance_description == CONCEPT["appearance_description"]


@pytest.mark.parametrize("value,kind", [(None, "null"), ([], "array"), ([CONCEPT, CONCEPT], "array"), (1, "number"), (False, "boolean"), ('private-not-json', "string"), (json.dumps(None), "string")])
def test_no_guessing_when_legacy_data_is_missing_ambiguous_or_invalid(value, kind):
    with pytest.raises(ParseError) as caught:
        parse_recognize(json.dumps([{**base(), "concept": value}]))
    assert caught.value.candidate_index == 0
    assert caught.value.profile_contract == "legacy" and caught.value.profile_input_kind == kind


@pytest.mark.parametrize("field,value", [("character_name", None), ("character_name", ""), ("character_persona", []), ("opening_line", None), ("opening_line", " "), ("appearance_description", ""), ("appearance_description", 'x'*1001)])
def test_flat_fields_keep_required_value_type_and_length_checks(field, value):
    with pytest.raises(ParseError) as caught:
        parse_recognize(json.dumps([{**flat(), field: value}]))
    assert caught.value.candidate_index == 0 and caught.value.profile_contract == "flat"


def test_partial_flat_primary_never_succeeds_by_filling_fields():
    with pytest.raises(ParseError):
        parse_recognize(json.dumps([{**base(), "character_name": "name"}]))


def test_flat_secondary_null_fields_are_optional_but_partial_data_is_not():
    secondary = {**base(), **{key: None for key in FIELDS}}
    result = parse_recognize(json.dumps([flat(), secondary]))
    assert result[1].concept is None
    with pytest.raises(ParseError):
        parse_recognize(json.dumps([flat(), {**secondary, "character_name": "nonempty"}]))


def test_conflicting_profiles_are_not_silently_merged():
    with pytest.raises(ParseError, match="角色资料存在冲突"):
        parse_recognize(json.dumps([{**flat(), "concept": {**CONCEPT, "name": "different"}}]))


def test_legacy_profile_does_not_treat_unrelated_root_metadata_as_flat_contract():
    result = parse_recognize(json.dumps([{**base(), "concept": CONCEPT, "opening_line": "unused legacy root metadata"}]))[0]
    assert result.concept.opening_line == CONCEPT["opening_line"]


def test_structural_diagnostics_only_log_enum_values_and_candidate_index(caplog, monkeypatch):
    monkeypatch.setattr(logging.getLogger("uvicorn.error"), "handlers", [caplog.handler])
    with pytest.raises(ParseError) as caught:
        parse_recognize(json.dumps([flat(), {**base(), "concept": "private-not-json"}]))
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        details = record_failure("recognition_concept", "synthetic", caught.value)
    assert details["candidate_index"] == 1 and details["profile_input_kind"] == "string"
    assert details["profile_contract"] == "legacy"
    for secret in ["private-not-json", base()["visual_features"], CONCEPT["name"]]:
        assert secret not in str(details) + caplog.text
    error = ParseError("private-exception")
    error.profile_contract = error.profile_input_kind = "private-injected-enum"
    error.candidate_index = True
    with caplog.at_level(logging.WARNING, logger="uvicorn.error"):
        sanitized = record_failure("recognition_concept", "synthetic", error)
    assert "private-" not in str(sanitized) + caplog.text
    assert "candidate_index" not in sanitized


@pytest.mark.parametrize("representation", ["flat", "string", "array"])
def test_full_flow_preserves_two_calls_style_and_refresh(client, png_header, monkeypatch, tmp_path, parse_sse, representation):
    calls = setup_provider(monkeypatch, tmp_path, png_header)
    original = ModelClient._call_vision
    def vision(self, *args, **kwargs):
        items = json.loads(original(self, *args, **kwargs))
        profile = items[0].pop("concept")
        if representation == "flat":
            items[0].update({key: profile[target] for key, target in FIELDS.items()})
        else:
            items[0]["concept"] = json.dumps(profile) if representation == "string" else [profile]
        return json.dumps(items)
    monkeypatch.setattr(ModelClient, "_call_vision", vision)
    oid = upload(client, png_header)
    event, result = generate(client, oid, parse_sse)
    assert event == "done" and result["name"] == CONCEPT["name"]
    assert [kind for kind, _ in calls] == ["vision", "image"]
    prompt = calls[0][1]["messages"][0]["content"][0]["text"]
    assert '"character_name"' in prompt and '"character_persona"' in prompt
    assert '"concept":' not in prompt
    assert calls[1][1]["n"] == 1 and calls[1][1]["size"] == "1024x1024"
    assert client.get(f"/api/v1/characters/{result['id']}").json()["image_path"] == result["image_path"]
    assert len(calls) == 2


def test_missing_flat_profile_keeps_failed_receipt_without_retry_or_image(client, png_header, monkeypatch):
    calls = []
    def recognize(*args):
        calls.append("vision")
        return parse_recognize(json.dumps([{**flat(), "character_persona": None}]))
    monkeypatch.setattr(ModelClient, "recognize", recognize)
    key = str(uuid4())
    def post():
        return client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}, headers={"Idempotency-Key": key})
    response = post()
    assert response.status_code == 502 and response.json()["error"]["parse_code"] == "profile_persona_missing"
    assert "照片已读取" in response.json()["error"]["message"]
    assert post().status_code == 409 and calls == ["vision"]
    with SessionLocal() as db:
        assert db.get(PhotoRequest, key).status == "failed"
        assert db.query(Photo).count() == db.query(Object).count() == db.query(Character).count() == 0
