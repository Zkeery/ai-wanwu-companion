"""Offline diagnostics: synthetic requests only; no provider or business data."""
import json
import logging
from pathlib import Path
from uuid import uuid4

import pytest

from app.services import generation_timing as timing


@pytest.fixture(autouse=True)
def clean_sink():
    timing.close_timing_log()
    yield
    timing.close_timing_log()


def rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def test_append_sink_survives_uvicorn_error_level_and_keeps_fractional_ms(tmp_path, monkeypatch):
    path = tmp_path / "timing.jsonl"
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "level", logging.ERROR)
    assert timing.configure_timing_log(str(path))
    clock = iter([10, 10.001234, 20, 20.002345])
    monkeypatch.setattr(timing, "perf_counter", lambda: next(clock))
    assert timing.timed_call("fixture", "anonymous", lambda: 3) == 3
    timing.close_timing_log()
    assert timing.configure_timing_log(str(path))
    with pytest.raises(ValueError):
        timing.timed_call("fixture", "anonymous", lambda: (_ for _ in ()).throw(ValueError("private-error")))
    assert [r["elapsed_ms"] for r in rows(path)] == [1.234, 2.345]
    assert [r["outcome"] for r in rows(path)] == ["succeeded", "failed"]
    assert "private-error" not in path.read_text()
    assert path.stat().st_mode & 0o777 == 0o600
    assert timing.current_operation_id() is None


def test_disabled_or_unwritable_diagnostics_do_not_block_work(tmp_path):
    assert timing.configure_timing_log("") is False
    file = tmp_path / "not-a-directory"
    file.write_text("preserve")
    assert timing.configure_timing_log(str(file / "timings")) is False
    assert timing.timed_call("fixture", "anonymous", lambda: 4) == 4
    assert file.read_text() == "preserve"


def test_http_trace_reports_failure_and_ignores_private_event_details(tmp_path, monkeypatch):
    path = tmp_path / "trace.jsonl"
    timing.configure_timing_log(str(path))
    clock = iter([1, 1.01, 2, 2.02, 3, 3.03])
    monkeypatch.setattr(timing, "perf_counter", lambda: next(clock))
    trace = timing.http_trace("image_http", "anonymous")
    for event in ("connection.connect_tcp.started", "connection.connect_tcp.complete",
                  "connection.start_tls.started", "connection.start_tls.complete",
                  "http11.receive_response_headers.started", "http11.receive_response_headers.failed"):
        trace(event, {"url": "private-url", "authorization": "private-token", "exception": "private-error"})
    trace("http11.response_closed.complete", {"private": "ignored"})
    assert [r["stage"] for r in rows(path)] == ["image_http.connect_tcp", "image_http.tls", "image_http.response_headers"]
    assert rows(path)[-1]["outcome"] == "failed"
    assert "private" not in path.read_text()


def test_one_anonymous_trace_links_photo_and_generation_without_changing_saved_data(client, png_header, parse_sse, tmp_path):
    path = tmp_path / "flow.jsonl"
    timing.configure_timing_log(str(path))
    trace_id = str(uuid4())
    photo = client.post("/api/v1/photos", files={"file": ("private-photo.png", png_header, "image/png")},
                        headers={"X-Generation-Trace": trace_id}).json()
    response = client.post("/api/v1/characters", json={"object_id": photo["objects"][0]["id"]},
                           headers={"X-Generation-Trace": trace_id})
    saved = next(value for event, value in parse_sse(response.text) if event == "done")
    result = rows(path)
    assert {r["operation_id"] for r in result} == {"trace:" + trace_id}
    assert {r["stage"] for r in result} >= {"photo_prepare", "recognition", "photo_store", "image", "character_store", "creation_total"}
    assert all(set(r) == {"stage", "operation_id", "elapsed_ms", "outcome"} for r in result)
    assert "private-photo" not in path.read_text()
    assert "trace" not in saved and saved["status"] == "ready"
    assert client.get(f"/api/v1/characters/{saved['id']}").json()["image_path"] == saved["image_path"]


@pytest.mark.parametrize("value", [None, "private-photo", "https://private.example/", "x" * 1000, "00000000-0000-0000-0000-not-a-uuid00"])
def test_invalid_correlation_never_enters_logs(value):
    assert timing.diagnostic_operation_id(value, "safe-fallback") == "safe-fallback"
