"""Free regression checks for ordinary chat latency settings and streaming."""
import json
from contextlib import contextmanager

import httpx
import pytest

from app.core.config import Settings
from app.services import model_client
from app.services.model_client import ModelClient, ModelError


def settings(**overrides):
    return Settings(_env_file=None, model_api_key="test-only-secret",
                    model_base_url="https://maas-api.antdigital.com/v1",
                    chat_model="qwen3.8-flash", model_max_retries=0, **overrides)


def test_chat_override_does_not_change_other_text_requests():
    config = settings(chat_enable_thinking=False)
    assert ModelClient._chat_options(config)["enable_thinking"] is False
    assert "enable_thinking" not in ModelClient._text_options(config)
    assert "enable_thinking" not in ModelClient._chat_options(settings())


@pytest.mark.parametrize("field,value", [
    ("chat_model", "unverified"),
    ("model_base_url", "https://maas-api.antdigital.com.evil/v1"),
    ("model_base_url", "https://user@maas-api.antdigital.com/v1"),
    ("model_base_url", "https://maas-api.antdigital.com/v1?x=1"),
])
def test_unverified_override_is_rejected(field, value):
    config = settings(chat_enable_thinking=False)
    setattr(config, field, value)
    with pytest.raises(ModelError, match="尚未验证"):
        ModelClient._chat_options(config)


def install_stream(monkeypatch, tail="[DONE]"):
    config = settings(chat_enable_thinking=False)
    records, requests, progress = [], [], []

    class Body(httpx.SyncByteStream):
        def __iter__(self):
            yield b'data: {"choices":[{"delta":{"reasoning_content":"private-reasoning"}}]}\n\n'
            yield b'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'
            progress.append("tail-read")
            if tail:
                yield ("data: " + tail + "\n\n").encode()

    def handle(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, stream=Body())

    @contextmanager
    def pooled(*args):
        with httpx.Client(transport=httpx.MockTransport(handle)) as client:
            yield client

    monkeypatch.setattr(model_client, "get_settings", lambda: config)
    monkeypatch.setattr(model_client, "model_http_client", pooled)
    monkeypatch.setattr(model_client, "record_timing", lambda *args: records.append(args))
    return ModelClient().chat_stream([]), records, requests, progress


def test_first_content_is_delivered_before_tail_and_timings_are_private(monkeypatch):
    stream, records, requests, progress = install_stream(monkeypatch)
    assert next(stream) == "hello"
    assert progress == []
    assert [r[0] for r in records] == ["chat_first_reasoning_delta", "chat_first_token"]
    assert list(stream) == []
    assert records[-1][0] == "chat_stream_total" and records[-1][-1] == "succeeded"
    assert len(requests) == 1 and requests[0]["enable_thinking"] is False
    assert "private-reasoning" not in repr(records)
    assert "test-only-secret" not in repr(records)
    assert "hello" not in repr(records)


def test_cancelled_stream_is_not_marked_success(monkeypatch):
    stream, records, requests, _ = install_stream(monkeypatch)
    assert next(stream) == "hello"
    stream.close()
    assert records[-1][-1] == "cancelled" and len(requests) == 1


def test_incomplete_stream_is_not_marked_success_or_retried(monkeypatch):
    stream, records, requests, _ = install_stream(monkeypatch, tail=None)
    assert next(stream) == "hello"
    with pytest.raises(ModelError):
        list(stream)
    assert records[-1][-1] == "failed" and len(requests) == 1


def test_real_stream_reuses_connection_and_keeps_auth_per_request(monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from threading import Thread
    from app.services import model_http

    ports, auth = [], []

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            ports.append(self.client_address[1])
            auth.append(self.headers.get("Authorization"))
            body = b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n'
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    model_http.close_model_http_clients()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    config = Settings(_env_file=None, model_base_url=f"http://127.0.0.1:{server.server_port}/v1",
                      model_api_key="one", model_http_pool_enabled=True)
    monkeypatch.setattr(model_client, "get_settings", lambda: config)
    try:
        for key in ("one", "two"):
            config.model_api_key = key
            assert list(ModelClient().chat_stream([])) == ["ok"]
        assert len(set(ports)) == 1
        assert auth == ["Bearer one", "Bearer two"]
        assert all("authorization" not in c.headers for c in model_http._clients.values())
    finally:
        model_http.close_model_http_clients()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
