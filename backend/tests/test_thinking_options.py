import json
import httpx
import pytest
from app.core.config import Settings
from app.services import model_client
from app.services.model_client import ModelClient, ModelError


@pytest.mark.parametrize("thinking", [None, False, True])
def test_text_and_stream_requests_use_explicit_supported_setting(monkeypatch, thinking):
    settings = Settings(_env_file=None, model_api_key="fixture-only", chat_model="qwen3.8-flash",
                        model_base_url="https://example.invalid/v1", model_enable_thinking=thinking)
    calls = []
    def handle(request):
        payload = json.loads(request.content)
        calls.append(payload)
        if payload.get("stream"):
            return httpx.Response(200, text='data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n')
        return httpx.Response(200, json={"choices": [{"message": {"content": "你好"}}]})
    original = httpx.Client
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kw: original(transport=httpx.MockTransport(handle), **kw))
    client = ModelClient()
    assert client._call_chat("一句开场白", settings) == "你好"
    assert "".join(client.chat_stream([{"role": "user", "content": "你好"}])) == "你好"
    for payload in calls:
        if thinking is None:
            assert "enable_thinking" not in payload
        else:
            assert payload["enable_thinking"] is thinking


def test_unsupported_model_is_blocked_before_network():
    settings = Settings(_env_file=None, chat_model="different-model", model_enable_thinking=False)
    with pytest.raises(ModelError):
        ModelClient()._call_chat("你好", settings)


@pytest.mark.parametrize("thinking", [None, False, True])
def test_vision_uses_maas_parameter_without_changing_chat(monkeypatch, thinking):
    settings = Settings(_env_file=None, model_api_key="fixture-only",
                        vision_model="ling-3.0-flash-vl", chat_model="qwen3.8-flash",
                        model_base_url="https://maas-api.antdigital.com/v1/",
                        vision_enable_thinking=thinking, model_enable_thinking=True)
    calls = []
    def handle(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": "[]"}}]})
    original = httpx.Client
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kw: original(transport=httpx.MockTransport(handle), **kw))
    client = ModelClient()
    assert client._call_vision(b"\x89PNG\r\n\x1a\n", settings) == "[]"
    payload = calls[0]
    assert "enable_thinking" not in payload
    assert "chat_template_kwargs" not in payload
    if thinking is None:
        assert "thinking" not in payload
        assert "max_tokens" not in payload
    else:
        assert payload["thinking"] == {"type": "enabled" if thinking else "disabled"}
        assert payload["max_tokens"] == 4096
    assert client._text_options(settings) == {"enable_thinking": True}


@pytest.mark.parametrize("model, endpoint", [
    ("unknown", "https://maas-api.antdigital.com/v1"),
    ("ling-3.0-flash-vl", "https://another.example/v1"),
    ("ling-3.0-flash-vl", "http://maas-api.antdigital.com/v1"),
    ("ling-3.0-flash-vl", "https://maas-api.antdigital.com/v2"),
    ("ling-3.0-flash-vl", "https://maas-api.antdigital.com/v1?route=another"),
])
def test_unverified_vision_thinking_fails_before_network(monkeypatch, model, endpoint):
    settings = Settings(_env_file=None, vision_model=model, model_base_url=endpoint,
                        model_api_key="fixture-only", vision_enable_thinking=False)
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid vision configuration must not call the provider")
    monkeypatch.setattr(ModelClient, "_post_chat_completions", forbidden)
    with pytest.raises(ModelError, match="VISION_ENABLE_THINKING"):
        ModelClient()._call_vision(b"test", settings)


@pytest.mark.parametrize("choice", [
    {"finish_reason": "length", "message": {"content": '[{"label":"杯子"}]'}},
    {"finish_reason": "content_filter", "message": {"content": '[{"label":"杯子"}]'}},
    None,
    [],
])
def test_incomplete_non_stream_result_is_not_accepted_or_retried(monkeypatch, choice):
    settings = Settings(_env_file=None, model_api_key="fixture-only",
                        model_base_url="https://example.invalid/v1", model_max_retries=2)
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, json={"choices": [choice]})
    original = httpx.Client
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kw: original(transport=httpx.MockTransport(handle), **kw))
    with pytest.raises(ModelError):
        ModelClient()._post_chat_completions({"model": "fixture"}, settings)
    assert len(calls) == 1
