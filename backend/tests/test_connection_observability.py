"""Loopback fake provider proves TCP reuse; external network is blocked by runner."""
import json
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

import pytest

from app.core.config import Settings
from app.services.model_client import ModelClient, ModelError
from app.services.model_http import close_model_http_clients
from app.services.generation_timing import configure_timing_log, close_timing_log


@contextmanager
def server(handler):
    instance = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join(timeout=2)


@pytest.fixture(autouse=True)
def clean():
    close_model_http_clients()
    yield
    close_model_http_clients()
    close_timing_log()


class Reply(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    def reply(self, body, content_type="application/json", status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass


def test_two_origins_reuse_their_own_connections_and_never_send_key_to_image_host(tmp_path):
    posts, downloads = [], []
    class ImageHost(Reply):
        def do_GET(self):
            downloads.append((self.client_address[1], self.headers.get("Authorization")))
            self.reply(b"synthetic-image", "image/png")
    class Provider(Reply):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            posts.append((self.client_address[1], self.headers.get("Authorization")))
            self.reply(json.dumps({"data": [{"url": image_url}]}).encode())
    with server(ImageHost) as image_host, server(Provider) as provider:
        image_url = f"http://127.0.0.1:{image_host.server_port}/image.png"
        path = tmp_path / "timings.jsonl"
        configure_timing_log(str(path))
        settings = Settings(_env_file=None, model_api_key="fake-key-a", model_http_pool_enabled=True,
                            model_base_url=f"http://127.0.0.1:{provider.server_port}/v1",
                            model_max_retries=0, upload_dir=str(tmp_path / "uploads"))
        for key in ("fake-key-a", "fake-key-b"):
            settings.model_api_key = key
            saved = ModelClient()._call_image_generation("合成杯子", "测试伙伴", settings)
            assert (tmp_path / "uploads" / saved).read_bytes() == b"synthetic-image"
        close_model_http_clients()
    assert len(posts) == len(downloads) == 2
    assert len({port for port, _ in posts}) == len({port for port, _ in downloads}) == 1
    assert [key for _, key in posts] == ["Bearer fake-key-a", "Bearer fake-key-b"]
    assert [key for _, key in downloads] == [None, None]
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    for stage in ("image_http", "image_download"):
        assert sum(r["stage"] == stage + ".connect_tcp" for r in rows) == 1
        assert sum(r["stage"] == stage + ".response_headers" for r in rows) == 2
        assert sum(r["stage"] == stage + ".response_body" for r in rows) == 2
        assert sum(r["stage"] == stage for r in rows) == 2
    assert "fake-key" not in path.read_text() and "127.0.0.1" not in path.read_text()


def test_pool_does_not_add_automatic_retries_on_provider_failure(tmp_path):
    calls = []
    class Provider(Reply):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            calls.append(1)
            self.reply(b"synthetic rejection", status=503)
    with server(Provider) as provider:
        settings = Settings(_env_file=None, model_api_key="fake-key", model_http_pool_enabled=True,
                            model_base_url=f"http://127.0.0.1:{provider.server_port}/v1",
                            model_max_retries=0, upload_dir=str(tmp_path))
        with pytest.raises(ModelError):
            ModelClient()._call_image_generation("合成杯子", "测试伙伴", settings)
        close_model_http_clients()
    assert calls == [1]
