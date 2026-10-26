"""mock 模型客户端单元测试（离线可跑）。"""
from __future__ import annotations

import pytest

from app.services.model_client import ModelClient


def test_mock_recognize_returns_objects():
    objs = ModelClient().recognize(b"fake-image-bytes")
    labels = [o.label for o in objs]
    assert labels == ["杯子", "植物"]


def test_mock_generate_character_matches_label():
    result = ModelClient().generate_character("杯子")
    assert result.name == "杯子小伴"
    assert result.persona
    assert "杯子" in result.opening_line


def test_mock_generate_image_creates_svg(tmp_path, monkeypatch):
    from app.core import config
    from app.services import model_client

    fake_settings = config.Settings(upload_dir=str(tmp_path))
    monkeypatch.setattr(model_client, "get_settings", lambda: fake_settings)

    path = ModelClient().generate_image("杯子", "杯子小伴")
    assert path.endswith(".svg")


@pytest.mark.parametrize("pooled", [False, True])
def test_image_generation_uses_image_gateway_and_downloads_result(tmp_path, monkeypatch, pooled):
    import json

    import httpx

    from app.core.config import Settings
    from app.services import model_client, model_http

    settings = Settings(
        _env_file=None,
        model_base_url="https://chat.example/v1",
        image_base_url="https://images.example/v1",
        model_api_key="test-key",
        image_model="wan2.6-t2i",
        upload_dir=str(tmp_path),
        model_http_pool_enabled=pooled,
    )
    image_bytes = b"\x89PNG\r\n\x1a\n"
    requests = []

    def handle(request):
        requests.append(request)
        if request.method == "POST":
            assert str(request.url) == "https://images.example/v1/images/generations"
            body = json.loads(request.content)
            assert body["model"] == "wan2.6-t2i"
            assert body["size"] == "1024x1024"
            assert body["n"] == 1
            return httpx.Response(200, json={"data": [{"url": "https://cdn.example/avatar.png"}]})
        assert str(request.url) == "https://cdn.example/avatar.png"
        assert "authorization" not in request.headers
        return httpx.Response(200, content=image_bytes, headers={"content-type": "image/png"})

    real_client = httpx.Client
    transport = httpx.MockTransport(handle)
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kwargs: real_client(transport=transport, **kwargs))
    model_http.close_model_http_clients()
    try:
        result = ModelClient().generate_image("杯子", "杯子小伴")
        assert (tmp_path / result).read_bytes() == image_bytes
        assert len(requests) == 2
    finally:
        model_http.close_model_http_clients()


@pytest.mark.parametrize("model,size,grouped", [
    ("doubao-seedream-5-0-flash", "1K", False),
    ("doubao-seedream-5-0-lite", "2K", True),
])
def test_seedream_switch_is_one_image_and_wan_stays_default(tmp_path, monkeypatch, model, size, grouped):
    import json

    import httpx

    from app.core.config import Settings
    from app.services import model_client, model_http

    settings = Settings(
        _env_file=None,
        model_api_key="",
        image_model=model,
        ark_api_key="ark-test",
        ark_base_url="https://ark.example/api/v3",
        upload_dir=str(tmp_path),
    )
    seen = {}

    def handle(request):
        if request.method == "POST":
            seen["body"] = json.loads(request.content)
            seen["url"] = str(request.url)
            assert request.headers["authorization"] == "Bearer ark-test"
            return httpx.Response(200, json={"data": [{"b64_json": "iVBORw0KGgo="}]})
        raise AssertionError(request.method)

    real_client = httpx.Client
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    model_http.close_model_http_clients()
    try:
        ModelClient().generate_image("杯子", "杯子小伴")
    finally:
        model_http.close_model_http_clients()
    body = seen["body"]
    assert seen["url"] == "https://ark.example/api/v3/images/generations"
    assert body["model"] == model_client.SEEDREAM_MODELS[model][0]
    assert body["size"] == size and body["watermark"] is False
    assert "n" not in body and body["response_format"] == "url"
    assert ("sequential_image_generation" in body) is grouped
    assert Settings.model_fields["image_model"].default == "doubao-seedream-5-0-flash"


def test_flash_failure_falls_back_to_wan_without_raising(tmp_path, monkeypatch):
    import json

    import httpx

    from app.core.config import Settings
    from app.services import model_client, model_http

    settings = Settings(
        _env_file=None,
        model_base_url="https://chat.example/v1",
        image_base_url="https://images.example/v1",
        model_api_key="wan-test",
        image_model="doubao-seedream-5-0-flash",
        ark_api_key="ark-test",
        ark_base_url="https://ark.example/api/v3",
        upload_dir=str(tmp_path),
        model_max_retries=0,
    )
    posts = []

    def handle(request):
        if request.method != "POST":
            raise AssertionError(request.method)
        body = json.loads(request.content)
        posts.append((str(request.url), body.get("model"), request.headers["authorization"]))
        if "ark.example" in str(request.url):
            return httpx.Response(500, json={"error": {"code": "unavailable"}})
        return httpx.Response(200, json={"data": [{"b64_json": "iVBORw0KGgo="}]})

    real_client = httpx.Client
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    model_http.close_model_http_clients()
    try:
        result = ModelClient().generate_image("杯子", "杯子小伴")
    finally:
        model_http.close_model_http_clients()
    assert result.endswith(".png")
    assert posts == [
        ("https://ark.example/api/v3/images/generations", "doubao-seedream-5-0-flash-260915", "Bearer ark-test"),
        ("https://images.example/v1/images/generations", "wan2.6-t2i", "Bearer wan-test"),
    ]
