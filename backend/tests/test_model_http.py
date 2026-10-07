import json
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from types import SimpleNamespace

import httpx
import pytest

from app.core.config import Settings
from app.services import model_http
from app.services.model_client import ModelClient


@pytest.fixture(autouse=True)
def clean_pool():
    model_http.close_model_http_clients()
    yield
    model_http.close_model_http_clients()


def test_real_http_connection_reused_between_model_client_instances():
    ports, authorization = [], []
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            ports.append(self.client_address[1])
            authorization.append(self.headers.get("Authorization"))
            body = json.dumps({"choices": [{"finish_reason": "stop", "message": {"content": "valid"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = Settings(_env_file=None, model_base_url=f"http://127.0.0.1:{server.server_port}/v1",
                        model_api_key="fixture-one", model_http_pool_enabled=True)
    try:
        for key in ("fixture-one", "fixture-two", "fixture-one"):
            settings.model_api_key = key
            assert ModelClient()._post_chat_completions({"model": "fixture"}, settings) == "valid"
        assert len(set(ports)) == 1
        assert authorization == ["Bearer fixture-one", "Bearer fixture-two", "Bearer fixture-one"]
        assert all("authorization" not in c.headers for c in model_http._clients.values())
    finally:
        model_http.close_model_http_clients()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_image_download_reuses_connection_without_model_authorization(tmp_path):
    ports, requests = [], []
    image_bytes = b"\x89PNG\r\n\x1a\nfixture-image-bytes"

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def reply(self, body, content_type):
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            ports.append(self.client_address[1])
            requests.append(("POST", self.headers.get("Authorization")))
            body = json.dumps({"data": [{"url": f"http://127.0.0.1:{self.server.server_port}/redirect"}]}).encode()
            self.reply(body, "application/json")

        def do_GET(self):
            ports.append(self.client_address[1])
            requests.append(("GET", self.headers.get("Authorization")))
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "/image.png")
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.reply(image_bytes, "image/png")

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    settings = Settings(_env_file=None, model_base_url=f"http://127.0.0.1:{server.server_port}/v1",
                        model_api_key="fixture-one", model_http_pool_enabled=True,
                        model_max_retries=0, upload_dir=str(tmp_path))
    try:
        for key in ("fixture-one", "fixture-two"):
            settings.model_api_key = key
            result = ModelClient()._call_image_generation("杯子", "杯子小伴", settings)
            assert (tmp_path / result).read_bytes() == image_bytes
        assert len(set(ports)) == 1
        assert requests == [("POST", "Bearer fixture-one"), ("GET", None), ("GET", None),
                            ("POST", "Bearer fixture-two"), ("GET", None), ("GET", None)]
    finally:
        model_http.close_model_http_clients()
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


@pytest.fixture
def fake_clients(monkeypatch):
    made = []
    class Client:
        def __init__(self, **kwargs):
            self.is_closed = False
            self.kwargs = kwargs
            made.append(self)
        def close(self):
            self.is_closed = True
        def __enter__(self):
            return self
        def __exit__(self, *args):
            self.close()
    monkeypatch.setattr(model_http.httpx, "Client", Client)
    return made


def borrow(url="https://provider.example/v1/chat/completions", enabled=True):
    with model_http.model_http_client(SimpleNamespace(model_http_pool_enabled=enabled), url, httpx.Timeout(10)) as client:
        return client


def test_disabled_clients_close_after_each_request(fake_clients):
    assert borrow(enabled=False) is not borrow(enabled=False)
    assert all(c.is_closed for c in fake_clients)
    assert not model_http._clients


def test_pool_shared_between_threads_and_model_endpoints(fake_clients):
    with ThreadPoolExecutor(max_workers=8) as executor:
        clients = list(executor.map(lambda _: borrow(), range(32)))
    assert len(fake_clients) == 1
    assert all(c is clients[0] for c in clients)
    assert borrow("https://provider.example/v1/images/generations") is clients[0]
    limits = clients[0].kwargs["limits"]
    assert limits.max_connections == 20
    assert limits.max_keepalive_connections == 10
    assert limits.keepalive_expiry == 60


def test_origins_separate_and_pool_is_bounded(fake_clients):
    clients = [borrow(f"https://provider{i}.example/v1") for i in range(6)]
    assert len(model_http._clients) == model_http.MAX_ORIGINS == 4
    assert len(set(clients)) == 6
    assert all(not c.is_closed for c in clients[:4])
    assert all(c.is_closed for c in clients[4:])


def test_shutdown_releases_connections_and_allows_fresh_start(fake_clients):
    first = borrow()
    model_http.close_model_http_clients()
    assert first.is_closed and not model_http._clients
    assert borrow() is not first


def test_initialization_failure_leaves_no_broken_pool(monkeypatch):
    def fail(**kwargs):
        raise httpx.ConnectError("fixture")
    monkeypatch.setattr(model_http.httpx, "Client", fail)
    with pytest.raises(httpx.ConnectError):
        borrow()
    assert not model_http._clients
