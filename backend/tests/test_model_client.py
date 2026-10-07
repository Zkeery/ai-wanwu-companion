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
