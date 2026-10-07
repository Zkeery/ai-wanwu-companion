"""Bounded, process-local model connections. Credentials remain per request."""
from contextlib import contextmanager
from threading import Lock
from urllib.parse import urlsplit

import httpx

_lock = Lock()
_clients: dict[str, httpx.Client] = {}
MAX_ORIGINS = 4


@contextmanager
def model_http_client(settings, url: str, timeout: httpx.Timeout):
    client = None
    if getattr(settings, "model_http_pool_enabled", False):
        parsed = urlsplit(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        with _lock:
            client = _clients.get(origin)
            if client is None and len(_clients) < MAX_ORIGINS:
                client = httpx.Client(
                    timeout=timeout,
                    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=60),
                )
                _clients[origin] = client
    if client is not None:
        yield client
    else:
        with httpx.Client(timeout=timeout) as temporary:
            yield temporary


def close_model_http_clients() -> None:
    # Called after the server drains requests on shutdown, not during requests.
    with _lock:
        clients = list(_clients.values())
        _clients.clear()
    for client in clients:
        client.close()
