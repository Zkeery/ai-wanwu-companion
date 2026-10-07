"""R7.8 offline-only protocol probe; these tests must never call a provider."""
import base64
from datetime import datetime
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

import httpx
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/probe_seedream_flash_i2i.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("seedream_flash_i2i_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def test_frozen_public_inputs_and_flash_only_request_schema():
    plan, photos = probe.load_frozen_plan()
    assert plan["approved_budget_cny"] is None
    assert plan["default_real_requests_enabled"] is False
    assert list(photos) == ["cup", "apple", "plant", "multi"]
    body = probe.request_body(photos["cup"], "cup")
    assert set(body) == {"model", "prompt", "image", "size", "response_format"}
    assert body["model"] == "doubao-seedream-5-0-flash-260915"
    assert body["size"] == "1024x1024" and body["response_format"] == "b64_json"
    assert base64.b64decode(body["image"].split(",", 1)[1], validate=True) == photos["cup"]
    assert "n" not in body and "sequential_image_generation" not in body


def test_offline_eight_records_use_only_mock_transport(tmp_path, monkeypatch):
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)
    original_client = httpx.Client

    def checked_client(*args, **kwargs):
        assert isinstance(kwargs.get("transport"), httpx.MockTransport)
        return original_client(*args, **kwargs)

    monkeypatch.setattr(probe.httpx, "Client", checked_client)
    report = probe.run_offline(tmp_path / "offline")
    persisted = json.loads((tmp_path / "offline/results.json").read_text())
    assert report == persisted
    assert report["status"] == "completed_offline" and len(report["calls"]) == 8
    assert report["network_requests"] == report["billable_requests"] == 0
    assert report["mock"] and not report["release_passed"]
    assert all(row["status"] == "offline_fixture_valid" for row in report["calls"])
    assert len(list((tmp_path / "offline").glob("mock-r78-*.png"))) == 8
    with pytest.raises(ValueError):
        probe.run_offline(tmp_path / "offline")


@pytest.mark.parametrize("payload", [
    {"data": []},
    {"data": [{"b64_json": "%%%"}]},
    {"data": [{"b64_json": base64.b64encode(b"not-an-image").decode()}]},
    {"data": [{"b64_json": "a"}, {"b64_json": "b"}]},
    {"data": [{"url": "https://example.test/signed?secret=private-value"}]},
])
def test_bad_images_stop_after_first_attempt_without_leaking_payload(tmp_path, monkeypatch, payload):
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)

    def bad_response(_request):
        return httpx.Response(200, json=payload)

    report = probe.run_offline(tmp_path / "failed", handler=bad_response)
    saved = (tmp_path / "failed/results.json").read_text()
    assert report["status"] == "stopped_after_failure" and len(report["calls"]) == 1
    assert report["calls"][0]["failure_stage"] == "image_payload"
    assert "private-value" not in saved and "not-an-image" not in saved
    assert list((tmp_path / "failed").glob("mock-r78-*")) == []


def test_cli_rejects_paid_mode_and_default_only_prints_plan():
    dry = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, check=True)
    data = json.loads(dry.stdout)
    assert data["mode"] == "dry_run" and data["billable_requests"] == 0
    paid = subprocess.run([sys.executable, str(SCRIPT), "--run"], capture_output=True, text=True)
    assert paid.returncode != 0
    assert "Real mode requires output" in paid.stderr


@pytest.mark.parametrize("budget,day,price,allowed", [
    ("1.20", "2026-09-25", "0.12", True),
    ("0", "2026-09-25", "0.12", False),
    ("1.21", "2026-09-25", "0.12", False),
    ("1.20", "2026-09-24", "0.12", False),
    ("1.20", "2026-09-25", "0.13", False),
])
def test_real_preflight_requires_new_budget_and_same_day_price(budget, day, price, allowed):
    at = datetime(2026, 9, 25, 14, tzinfo=ZoneInfo("Asia/Shanghai"))
    if allowed:
        probe.real_preflight(Decimal(budget), day, Decimal(price), "placeholder", at)
    else:
        with pytest.raises(ValueError):
            probe.real_preflight(Decimal(budget), day, Decimal(price), "placeholder", at)


def test_real_mock_success_reserves_before_each_post_without_exposing_key(tmp_path, monkeypatch):
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)
    today = probe.now_local().date().isoformat()
    output = tmp_path / "real-mock"
    attempts = []

    def handler(request):
        persisted = json.loads((output / "results.json").read_text())
        attempts.append(persisted["reserved_cny"])
        assert persisted["calls"][-1]["status"] == "reserved"
        assert request.headers["authorization"] == "Bearer private-test-key"
        return httpx.Response(200, json={"model": probe.MODEL,
                                          "data": [{"b64_json": base64.b64encode(probe.mock_image()).decode()}],
                                          "usage": {"generated_images": 1}})

    report = probe.run_real(output, key="private-test-key", approved=Decimal("1.20"),
                            verified_on=today, verified_price=Decimal("0.12"),
                            transport=httpx.MockTransport(handler))
    saved = (output / "results.json").read_text()
    assert report["status"] == "completed_local_screen" and len(attempts) == 8
    assert attempts == [str(Decimal("0.12") * n) for n in range(1, 9)]
    assert report["reserved_cny"] == "0.96" and report["billable_requests_attempted"] == 8
    assert all(row["status"] == "succeeded" and row["reported_generated_images"] == 1
               for row in report["calls"])
    assert not report["release_passed"] and "private-test-key" not in saved
    with pytest.raises(ValueError):
        probe.run_real(output, key="private-test-key", approved=Decimal("1.20"),
                       verified_on=today, verified_price=Decimal("0.12"),
                       transport=httpx.MockTransport(handler))


def test_real_mock_provider_failure_stops_and_does_not_log_body(tmp_path, monkeypatch):
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)
    today = probe.now_local().date().isoformat()
    output = tmp_path / "real-failure"

    def handler(_request):
        assert json.loads((output / "results.json").read_text())["reserved_cny"] == "0.12"
        return httpx.Response(502, json={"error": "private-provider-body"})

    report = probe.run_real(output, key="private-test-key", approved=Decimal("1.20"),
                            verified_on=today, verified_price=Decimal("0.12"),
                            transport=httpx.MockTransport(handler))
    saved = (output / "results.json").read_text()
    assert report["status"] == "stopped_after_failure" and len(report["calls"]) == 1
    assert report["reserved_cny"] == "0.12"
    assert report["calls"][0]["failure_stage"] == "provider_post"
    assert "private-provider-body" not in saved and "private-test-key" not in saved


def test_real_mock_valid_but_over_eight_seconds_stops_batch(tmp_path, monkeypatch):
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)
    today = probe.now_local().date().isoformat()
    ticks = iter((0.0, 0.0, 9.0, 9.0))

    def handler(_request):
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(probe.mock_image()).decode()}]})

    report = probe.run_real(tmp_path / "slow", key="private-test-key", approved=Decimal("1.20"),
                            verified_on=today, verified_price=Decimal("0.12"),
                            transport=httpx.MockTransport(handler), clock=lambda: next(ticks))
    assert report["status"] == "stopped_after_over_8s" and len(report["calls"]) == 1
    assert report["calls"][0]["status"] == "succeeded"
    assert report["calls"][0]["local_total_ms"] == 9000
    assert not report["calls"][0]["local_within_8s"]
    assert report["reserved_cny"] == "0.12" and not report["release_passed"]
