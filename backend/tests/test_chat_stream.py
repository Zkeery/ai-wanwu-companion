"""Upstream streaming failures must never look like completed replies."""
import json

import httpx
import pytest

from app.core.config import Settings
from app.services import model_client
from app.services.model_client import ModelClient, ModelError


def _client(monkeypatch, sequences):
    attempts = []

    class Response:
        def __init__(self, sequence):
            self.sequence = sequence

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def raise_for_status(self):
            pass

        def iter_lines(self):
            for item in self.sequence:
                if isinstance(item, Exception):
                    raise item
                yield "data: " + (item if isinstance(item, str) else json.dumps(item))

    class Client:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def stream(self, *args, **kwargs):
            attempts.append(kwargs)
            return Response(sequences[len(attempts) - 1])

    settings = Settings(_env_file=None, model_api_key="test-key",
                        model_base_url="https://example.invalid/v1", model_max_retries=1)
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    monkeypatch.setattr(model_client.httpx, "Client", Client)
    return ModelClient(), attempts


TOKEN = {"choices": [{"delta": {"content": "前半"}}]}


def test_complete_stream(monkeypatch):
    client, attempts = _client(monkeypatch, [[TOKEN, "[DONE]"]])
    assert list(client.chat_stream([])) == ["前半"]
    assert len(attempts) == 1


@pytest.mark.parametrize("tail", [[], [httpx.ReadTimeout("interrupted")]])
def test_partial_eof_or_timeout_fails_without_retry(monkeypatch, tail):
    client, attempts = _client(monkeypatch, [[TOKEN, *tail]])
    stream = client.chat_stream([])
    assert next(stream) == "前半"
    with pytest.raises(ModelError):
        list(stream)
    assert len(attempts) == 1


def test_retry_before_any_output_is_allowed(monkeypatch):
    client, attempts = _client(monkeypatch, [[httpx.ReadTimeout("early")], [TOKEN, "[DONE]"]])
    assert list(client.chat_stream([])) == ["前半"]
    assert len(attempts) == 2


@pytest.mark.parametrize("chunk", [
    "not json", {"error": {"message": "failed"}},
    {"choices": [None]}, {"choices": "bad"},
    {"choices": [{"delta": "bad"}]},
    {"choices": [{"delta": {"content": ["bad"]}}]},
    {"choices": [{"finish_reason": "length"}]},
    {"choices": [{"finish_reason": "content_filter"}]},
])
def test_invalid_or_truncated_stream_fails(monkeypatch, chunk):
    client, attempts = _client(monkeypatch, [[chunk, "[DONE]"]])
    with pytest.raises(ModelError):
        list(client.chat_stream([]))
    assert len(attempts) == 1
