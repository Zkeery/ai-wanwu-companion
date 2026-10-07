"""Offline transport/contract checks for fewer calls; no real provider access."""
import json
import logging
import base64
from io import BytesIO
from pathlib import Path

import httpx
import pytest
from PIL import Image

from app.core.config import Settings, get_settings
from app.services import model_client
from app.services.model_client import ModelClient, ModelError
from app.services.parsers import ParseError, parse_character_profile
from app.services.photo_input import normalize_photo


def configure(monkeypatch, handler, **options):
    settings = Settings(_env_file=None, model_api_key="synthetic-secret", model_base_url="https://local.invalid/v1", model_max_retries=1, **options)
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    original = httpx.Client
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kw: original(transport=httpx.MockTransport(handler), **kw))
    return settings


def test_profile_and_opening_use_exactly_one_text_request(monkeypatch):
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps({"name": "小杯", "persona": "温柔的陶瓷杯", "opening_line": "你好，我是小杯。"})}}]})
    configure(monkeypatch, handler)
    client = ModelClient()
    profile = client.generate_persona("陶瓷杯")
    assert client.generate_opening(profile) == "你好，我是小杯。"
    assert len(calls) == 1 and "opening_line" in calls[0]["messages"][0]["content"]
    assert profile.name == "小杯" and profile.persona == "温柔的陶瓷杯"


def test_full_creation_uses_three_provider_requests_without_reusing_other_creatures(client, png_header, monkeypatch, parse_sse, tmp_path):
    requests = []
    def handler(request):
        body = json.loads(request.content)
        if request.url.path.endswith('/images/generations'):
            requests.append('image')
            assert body['size'] == '1024x1024'
            return httpx.Response(200, json={'data': [{'b64_json': base64.b64encode(png_header).decode()}]})
        if isinstance(body['messages'][0]['content'], list):
            requests.append('recognition')
            content = '[{"label":"杯子"}]'
        else:
            requests.append('profile')
            content = '{"name":"小杯","persona":"温柔","opening_line":"你好，我是小杯。"}'
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    configure(monkeypatch, handler, upload_dir=str(tmp_path))
    results = []
    for _ in range(2):
        photo = client.post('/api/v1/photos', files={'file': ('cup.png', png_header, 'image/png')}).json()
        events = parse_sse(client.post('/api/v1/characters', json={'object_id': photo['objects'][0]['id']}).text)
        results.append(next(data for event, data in events if event == 'done'))
    assert requests == ['recognition', 'profile', 'image'] * 2
    assert results[0]['id'] != results[1]['id']
    assert results[0]['image_path'] != results[1]['image_path']
    assert all((tmp_path / result['image_path']).is_file() for result in results)


@pytest.mark.parametrize('content', ['not json', '{"name":"小杯","persona":"温柔"}'])
def test_bad_profile_does_not_fall_back_to_extra_paid_calls(monkeypatch, content):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(200, json={'choices': [{'message': {'content': content}}]})
    configure(monkeypatch, handler)
    with pytest.raises(ParseError):
        ModelClient().generate_persona('杯子')
    assert len(calls) == 1


@pytest.mark.parametrize("opening", [None, "", "  ", [], 1, "x" * 201])
def test_invalid_bundled_opening_cannot_publish(opening):
    with pytest.raises(ParseError):
        parse_character_profile(json.dumps({"name": "小杯", "persona": "温柔", "opening_line": opening}))


@pytest.mark.parametrize("endpoint", ["text", "image"])
@pytest.mark.parametrize("status,attempts", [(400, 1), (401, 1), (422, 1), (429, 2), (503, 2)])
def test_permanent_rejections_stop_immediately_and_transient_retries_are_bounded(monkeypatch, endpoint, status, attempts):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, text="synthetic-private-provider-details")
    configure(monkeypatch, handler)
    with pytest.raises(ModelError) as failure:
        if endpoint == "image":
            ModelClient().generate_image("杯子", "小杯")
        else:
            ModelClient().generate_persona("杯子")
    assert len(calls) == attempts
    assert "synthetic-private" not in str(failure.value)


@pytest.mark.parametrize("endpoint", ["text", "image"])
@pytest.mark.parametrize("error,attempts", [(httpx.ReadTimeout, 1), (httpx.ConnectTimeout, 2)])
def test_timeout_does_not_resubmit_work_that_might_already_be_generating(monkeypatch, endpoint, error, attempts):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.extensions["timeout"]["connect"] <= 10
        raise error("synthetic", request=request)
    configure(monkeypatch, handler)
    with pytest.raises(ModelError):
        if endpoint == "image": ModelClient().generate_image("杯子", "小杯")
        else: ModelClient().generate_persona("杯子")
    assert len(calls) == attempts


def test_large_recognition_copy_is_smaller_without_changing_original_acceptance():
    output = BytesIO()
    with Image.effect_noise((4096, 3072), 60).convert("RGB") as original:
        original.save(output, "JPEG", quality=90)
    source = output.getvalue()
    result = normalize_photo(source)
    with Image.open(BytesIO(result)) as image:
        assert image.size == (2048, 1536)
        assert not image.getexif()
    with Image.open(BytesIO(source)) as original:
        assert original.size == (4096, 3072)
    assert len(result) < len(source) / 2


def test_bundled_api_publishes_only_complete_result_and_logs_safe_timings(client, png_header, monkeypatch, parse_sse, caplog):
    # Earlier TCP tests configure uvicorn with propagation disabled.
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "handlers", [*logger.handlers, caplog.handler])
    def forbidden(*args):
        pytest.fail("bundled profile must not start a second opening request")
    monkeypatch.setattr(ModelClient, "generate_opening", forbidden)
    with caplog.at_level(logging.INFO, logger="uvicorn.error"):
        photo = client.post("/api/v1/photos", files={"file": ("private-file.png", png_header, "image/png")}).json()
        oid = photo["objects"][0]["id"]
        events = parse_sse(client.post("/api/v1/characters", json={"object_id": oid, "label": "private-user-label"}).text)
    result = next(d for e, d in events if e == "done")
    assert result["name"] and result["persona"] and result["opening_line"]
    assert (Path(get_settings().upload_dir) / result["image_path"]).exists()
    assert client.post("/api/v1/characters", json={"object_id": oid}).status_code == 409
    records = [json.loads(r.message.split("generation_timing ")[1]) for r in caplog.records if "generation_timing " in r.message]
    assert {r["stage"] for r in records} == {"photo_prepare", "recognition", "profile", "image", "creation_total"}
    assert all(r["elapsed_ms"] >= 0 and r["outcome"] == "succeeded" for r in records)
    assert "private-user-label" not in json.dumps(records) and "private-file" not in json.dumps(records)


def test_bundled_profile_failure_starts_no_image_and_is_recoverable(client, png_header, monkeypatch, parse_sse):
    oid = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()["objects"][0]["id"]
    def fail(*args): raise ParseError("invalid profile")
    def forbidden(*args): pytest.fail("invalid text must not trigger a paid image")
    with monkeypatch.context() as patch:
        patch.setattr(ModelClient, "generate_persona", fail)
        patch.setattr(ModelClient, "generate_image", forbidden)
        events = parse_sse(client.post("/api/v1/characters", json={"object_id": oid}).text)
    assert events[-1][0] == "error" and all(e != "done" for e, _ in events)
    failed = client.get(f"/api/v1/characters/by-object/{oid}").json()
    assert failed["status"] == "failed" and failed["image_path"] is None
    retry = parse_sse(client.post("/api/v1/characters", json={"object_id": oid}).text)
    assert next(d for e, d in retry if e == "done")["id"] == failed["id"]
