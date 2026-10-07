import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/probe_klein_4b_i2i.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("klein_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@pytest.fixture
def area(tmp_path, monkeypatch):
    plan, photos = probe.expected_plan()
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)
    monkeypatch.setattr(probe, "PLAN", tmp_path / "plan.json")
    probe.write_json(probe.PLAN, plan)
    return tmp_path, plan, photos


def test_frozen_base64_bytes_dimensions_and_quotes(area):
    _, plan, photos = area
    assert probe.frozen_plan()[0] == plan
    for item in plan["inputs"]:
        body = probe.request_body(photos[item["case_id"]], item["case_id"])
        assert base64.b64decode(body["input_image"], validate=True) == photos[item["case_id"]]
        assert item["input_billed_mp"] == 1 and item["quoted_usd"] == "0.015"
        assert set(body) == {"prompt", "input_image", "width", "height", "output_format", "safety_tolerance"}
    plan["width"] = 512
    probe.write_json(probe.PLAN, plan)
    with pytest.raises(ValueError):
        probe.frozen_plan()


def test_first_two_pause_then_six_resume_and_no_repeat(area):
    root, _, _ = area
    report = probe.run_offline(root / "batch")
    assert report["status"] == "awaiting_offline_review"
    assert len(report["calls"]) == 2 and report["reserved_usd"] == "0.06"
    report = probe.run_offline(root / "batch", resume=True)
    assert report["status"] == "offline_completed" and len(report["calls"]) == 8
    assert [r["case_id"] for r in report["calls"]] == list(probe.ORDER)
    assert len({r["task_id"] for r in report["calls"]}) == 8
    assert report["reserved_usd"] == "0.24"
    assert report["network_requests"] == report["billable_requests"] == 0
    assert report["release_passed"] is False
    for row in report["calls"]:
        assert row["poll_elapsed_ms"] == 1000 and row["poll_count"] == 2
        assert row["local_total_ms"] == 1000
        assert probe.sha256((root / "batch" / row["artifact"]).read_bytes()) == row["output_sha256"]
    with pytest.raises(ValueError):
        probe.run_offline(root / "batch", resume=True)
    with pytest.raises(FileExistsError):
        probe.run_offline(root / "batch")


def test_reserve_before_submit_and_task_id_before_poll(area):
    root, _, _ = area
    output = root / "batch"
    server = probe.OfflineServer()
    def handler(request):
        report = json.loads((output / "results.json").read_text())
        row = report["calls"][-1]
        if request.method == "POST":
            assert row["status"] == "reserved" and row["reserved_usd"] == "0.03"
        elif request.url.host == "api.bfl.ai":
            assert row["status"] == "submitted" and row["task_id"]
        return server(request)
    assert probe.run_offline(output, handler=handler)["status"] == "awaiting_offline_review"


@pytest.mark.parametrize("url,kind", [
    ("http://api.bfl.ai/v1/get_result", "poll"),
    ("https://api.bfl.ai.evil.example/query", "poll"),
    ("https://bfl.ai@evil.example/query", "poll"),
    ("https://secret@api.bfl.ai/query", "poll"),
    ("https://api.bfl.ai:444/query", "poll"),
    ("https://127.0.0.1/image", "download"),
    ("https://delivery.eu.bfl.ai.evil.example/image", "download"),
    ("https://api.bfl.ai/image", "download"),
])
def test_unapproved_url_rejected(url, kind):
    with pytest.raises(ValueError):
        probe.safe_url(url, kind)


@pytest.mark.parametrize("fault", ["bad_poll", "bad_delivery", "redirect", "bad_image", "too_expensive", "unknown", "no_id", "error_body"])
def test_fault_stops_one_post_and_sensitive_data_not_written(area, fault):
    root, _, _ = area
    server = probe.OfflineServer()
    secret = "PRIVATE_SENTINEL_DO_NOT_LOG"
    def handler(request):
        response = server(request)
        if request.method == "POST":
            if fault == "error_body":
                return httpx.Response(500, json={"error": secret})
            data = response.json()
            if fault == "bad_poll":
                data["polling_url"] = "https://evil.example/" + secret
            if fault == "too_expensive":
                data["cost"] = 4.0
            if fault == "no_id":
                data.pop("id")
            return httpx.Response(200, json=data)
        if request.url.host == "api.bfl.ai":
            data = response.json()
            if fault == "unknown":
                data["status"] = secret
            if fault == "bad_delivery" and data["status"] == "Ready":
                data["result"]["sample"] = "https://evil.example/" + secret
            return httpx.Response(200, json=data)
        if fault == "redirect":
            return httpx.Response(302, headers={"location": "https://evil.example/" + secret})
        if fault == "bad_image":
            return httpx.Response(200, content=secret.encode())
        return response
    report = probe.run_offline(root / fault, handler=handler)
    assert report["status"] == "stopped_after_failure" and len(report["calls"]) == 1
    assert server.posts == 1
    stored = (root / fault / "results.json").read_text()
    assert secret not in stored and "https://" not in stored and "signature=" not in stored
    with pytest.raises(ValueError):
        probe.run_offline(root / fault, resume=True)


@pytest.mark.parametrize("delay,status", [(5.5, "stopped_insufficient_margin"), (8, "stopped_over_8s")])
def test_download_delay_included_and_stops_batch(area, delay, status):
    root, _, _ = area
    clock = probe.VirtualClock()
    server = probe.OfflineServer()
    def handler(request):
        if request.url.host == "delivery.mock.bfl.ai":
            assert request.headers.get("x-key") is None and request.headers.get("authorization") is None
            clock.sleep(delay)
        return server(request)
    report = probe.run_offline(root / "slow", handler=handler, clock=clock)
    assert report["status"] == status and server.posts == 1
    row = report["calls"][0]
    assert row["download_ms"] == delay * 1000 and row["local_total_ms"] == (delay + 1) * 1000


def test_submitted_recovery_queries_original_without_resubmit(area, monkeypatch):
    root, _, _ = area
    output = root / "crash"
    original_write = probe.write_json
    class Interrupted(BaseException):
        pass
    def crash_after_poll(path, data):
        original_write(path, data)
        if data["calls"] and data["calls"][-1].get("poll_count") == 1:
            raise Interrupted()
    monkeypatch.setattr(probe, "write_json", crash_after_poll)
    with pytest.raises(Interrupted):
        probe.run_offline(output)
    saved = json.loads((output / "results.json").read_text())
    assert saved["calls"][0]["status"] == "submitted" and saved["calls"][0]["elapsed_ms"] == 500
    monkeypatch.setattr(probe, "write_json", original_write)
    server = probe.OfflineServer()
    server.posts = 1
    seen = []
    def handler(request):
        seen.append((request.method, str(request.url)))
        if request.method == "GET" and request.url.host == "api.bfl.ai" and "mock-01" in str(request.url):
            return httpx.Response(200, json={"status": "Ready", "result": {"sample": "https://delivery.mock.bfl.ai/image"}})
        return server(request)
    report = probe.run_offline(output, resume=True, handler=handler)
    assert seen[0] == ("GET", probe.poll_url("mock-01"))
    assert server.posts == 2 and report["calls"][0]["local_total_ms"] == 1000
    assert report["status"] == "awaiting_offline_review" and len(report["calls"]) == 2
    report = probe.run_offline(output, resume=True)
    assert report["status"] == "offline_completed" and len(report["calls"]) == 8


def test_ambiguous_reserved_resume_refuses_post(area):
    root, _, _ = area
    output = root / "reserved"
    class Interrupted(BaseException):
        pass
    def crash(request):
        raise Interrupted()
    with pytest.raises(Interrupted):
        probe.run_offline(output, handler=crash)
    with pytest.raises(ValueError):
        probe.run_offline(output, resume=True, handler=lambda request: pytest.fail("Must not send HTTP"))


def test_pending_timeout_then_late_read_only_result(area):
    root, _, _ = area
    server = probe.OfflineServer()
    def pending(request):
        if request.method == "GET":
            return httpx.Response(200, json={"status": "Pending"})
        return server(request)
    report = probe.run_offline(root / "timeout", handler=pending)
    assert report["status"] == "observation_timeout" and server.posts == 1
    assert report["calls"][0]["elapsed_ms"] == 90000
    def ready(request):
        assert request.method != "POST"
        if request.url.host == "api.bfl.ai":
            return httpx.Response(200, json={"status": "Ready", "result": {"sample": "https://delivery.mock.bfl.ai/image"}})
        return server(request)
    report = probe.run_offline(root / "timeout", resume=True, handler=ready)
    assert report["status"] == "stopped_over_8s" and len(report["calls"]) == 1
    assert report["calls"][0]["local_total_ms"] == 90500


def test_default_and_cli_two_plus_six_cross_process():
    root = probe.EVIDENCE / "test-cli-temporary"
    assert not root.exists()
    try:
        result = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True)
        assert result.returncode == 0 and json.loads(result.stdout)["mode"] == "dry_run"
        assert not root.exists()
        result = subprocess.run([sys.executable, str(SCRIPT), "--run"], capture_output=True, text=True)
        assert result.returncode == 2
        for flag, count in [("--offline-check", 2), ("--offline-continue", 8)]:
            result = subprocess.run([sys.executable, str(SCRIPT), flag, "--output", str(root)], capture_output=True, text=True)
            assert result.returncode == 0, result.stdout + result.stderr
            assert json.loads(result.stdout)["cases"] == count
        assert json.loads((root / "results.json").read_text())["release_passed"] is False
    finally:
        import shutil
        if root.exists():
            shutil.rmtree(root)
