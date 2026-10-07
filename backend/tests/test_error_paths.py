"""错误路径测试（无 Key / 模型超时 / 校验失败 → 统一错误结构）。"""
from __future__ import annotations

import httpx
import pytest

from app.core import config
from app.services import model_client


def test_real_call_without_config_raises(monkeypatch):
    fake = config.Settings(model_api_key="k", model_base_url="")
    monkeypatch.setattr(model_client, "get_settings", lambda: fake)
    with pytest.raises(model_client.ModelError):
        model_client.ModelClient().recognize(b"x")


def test_real_call_timeout_raises_after_retries(monkeypatch):
    fake = config.Settings(
        model_api_key="k",
        model_base_url="https://example.com",
        model_max_retries=1,
    )
    monkeypatch.setattr(model_client, "get_settings", lambda: fake)

    class FakeClient:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def post(self, *a, **k):
            raise httpx.TimeoutException("timeout")

    monkeypatch.setattr(model_client.httpx, "Client", FakeClient)
    with pytest.raises(model_client.ModelError):
        model_client.ModelClient().recognize(b"x")


def test_recognize_failure_maps_to_502(client, png_header, monkeypatch):
    def boom(*a, **k):
        raise model_client.ModelError("模拟失败")

    monkeypatch.setattr(model_client.ModelClient, "recognize", boom)
    res = client.post(
        "/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}
    )
    assert res.status_code == 502
    assert res.json()["error"]["code"] == "recognize_failed"
