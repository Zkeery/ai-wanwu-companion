from datetime import datetime
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from zoneinfo import ZoneInfo

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/probe_klein_4b_i2i_real.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("klein_real_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
KEY = "mock-credential-not-a-real-key"
AT = datetime(2026, 9, 26, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
GUARDS = dict(key=KEY, budget="0.30", day="2026-09-26", first_price="0.014",
              reference_price="0.001", public_confirmed=True, at=AT, mock=True)


class Clock(probe.Clock):
    def __init__(self):
        self.value = 0
        self.epoch = AT.timestamp()
    def now(self):
        return self.value
    def wall(self):
        return self.epoch + self.value
    def sleep(self, seconds):
        self.value += seconds


class Server:
    def __init__(self):
        self.server = probe.offline.OfflineServer()
        self.seen = []
    @property
    def posts(self):
        return self.server.posts
    def __call__(self, request):
        self.seen.append((request.method, str(request.url), request.headers.get("x-key")))
        # Assert credentials go only to approved API domains, not the CDN.
        if request.url.host == "delivery.mock.bfl.ai":
            assert request.headers.get("x-key") is None
        else:
            assert request.headers.get("x-key") == KEY
        if "x-key" in request.headers:
            del request.headers["x-key"]
        return self.server(request)


@pytest.fixture
def area(tmp_path, monkeypatch):
    evidence = tmp_path / "evidence"
    evidence.mkdir()
    monkeypatch.setattr(probe, "EVIDENCE", evidence)
    monkeypatch.setattr(probe, "RUNTIME", tmp_path / "private")
    monkeypatch.setattr(probe, "KEY_FILE", tmp_path / "absent.env")
    return evidence


def run(output, server=None, clock=None, mode="run", **changes):
    server = server or Server()
    args = {**GUARDS, **changes}
    with httpx.Client(transport=httpx.MockTransport(server), follow_redirects=False) as client:
        return probe.run_guarded(output, client=client, clock=clock or Clock(), mode=mode, **args)


def test_two_then_reviewed_six_no_duplicate_and_private_permissions(area):
    server, clock = Server(), Clock()
    report = run(area / "batch", server, clock)
    assert report["status"] == "awaiting_review" and server.posts == 2
    private = probe.runtime_file(report["run_id"])
    assert private.stat().st_mode & 0o077 == 0
    state = json.loads(private.read_text())
    assert len(state["tasks"]) == 2
    public = (area / "batch/results.json").read_text()
    assert KEY not in public and "https://" not in public and "signature=" not in public
    report = run(area / "batch", server, clock, mode="continue")
    assert report["status"] == "mock_completed" and server.posts == 8
    assert report["reserved_usd"] == "0.24" and report["release_passed"] is False
    assert report["mock"] is True and all(r["artifact"].startswith("mock-") for r in report["calls"])
    assert len({r["task_id"] for r in report["calls"]}) == 8
    with pytest.raises(ValueError):
        run(area / "batch", server, clock, mode="continue")
    with pytest.raises(FileExistsError):
        run(area / "batch", server, clock)


@pytest.mark.parametrize("field,value", [("budget", None), ("budget", "0.31"), ("day", "2026-09-25"),
    ("first_price", "0.015"), ("reference_price", "0.002"), ("public_confirmed", False), ("key", "")])
def test_missing_paid_guards_zero_post(area, field, value):
    server = Server()
    with pytest.raises(ValueError):
        run(area / "refused", server, **{field: value})
    assert server.posts == 0 and not (area / "refused").exists()


def test_reserve_persisted_before_post_and_id_private_before_poll(area):
    output = area / "batch"
    server = Server()
    def handler(request):
        report = json.loads((output / "results.json").read_text())
        row = report["calls"][-1]
        if request.method == "POST":
            assert row["status"] == "reserved" and report["reserved_usd"] == str(probe.offline.RESERVE * len(report["calls"]))
        elif request.url.host == "api.bfl.ai":
            state = json.loads(probe.runtime_file(report["run_id"]).read_text())
            assert state["tasks"][row["sample_id"]]["id"] == row["task_id"]
        return server(request)
    assert run(output, handler)["status"] == "awaiting_review"


@pytest.mark.parametrize("fault", ["http_error", "unknown", "bad_poll", "bad_delivery", "redirect", "bad_image", "too_expensive"])
def test_failure_stops_after_one_and_no_body_or_url_leak(area, fault):
    server = Server()
    secret = "MOCK_SENSITIVE_BODY_SENTINEL"
    def handler(request):
        response = server(request)
        if request.method == "POST":
            if fault == "http_error":
                return httpx.Response(500, text=secret)
            data = response.json()
            if fault == "bad_poll":
                data["polling_url"] = "https://evil.example/" + secret
            if fault == "too_expensive":
                data["cost"] = 4
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
    report = run(area / fault, handler)
    assert report["status"] == "stopped_after_failure" and server.posts == 1
    stored = (area / fault / "results.json").read_text()
    assert secret not in stored and KEY not in stored and "https://" not in stored


@pytest.mark.parametrize("delay,status", [(5.5, "stopped_insufficient_margin"), (8, "stopped_over_8s")])
def test_download_counted_and_late_image_stops(area, delay, status):
    server, clock = Server(), Clock()
    def handler(request):
        if request.url.host == "delivery.mock.bfl.ai":
            clock.sleep(delay)
        return server(request)
    report = run(area / "slow", handler, clock)
    assert report["status"] == status and server.posts == 1
    row = report["calls"][0]
    assert row["local_total_ms"] == (delay + 1) * 1000 and row["download_ms"] == delay * 1000


def test_private_committed_before_public_crash_recovers_original_only(area, monkeypatch):
    output = area / "crash"
    server, clock = Server(), Clock()
    original = probe.atomic_json
    class Interrupted(BaseException):
        pass
    def stop_before_public(path, data):
        if path.name == "results.json" and data["calls"] and data["calls"][-1]["status"] == "submitted":
            raise Interrupted()
        original(path, data)
    monkeypatch.setattr(probe, "atomic_json", stop_before_public)
    with pytest.raises(Interrupted):
        run(output, server, clock)
    assert json.loads((output / "results.json").read_text())["calls"][0]["status"] == "reserved"
    monkeypatch.setattr(probe, "atomic_json", original)
    clock.epoch += 10  # downtime must remain in the original duration
    report = run(output, server, clock, mode="resume")
    assert server.posts == 1 and report["status"] == "stopped_over_8s"
    assert report["calls"][0]["local_total_ms"] == 11000


def test_unknown_submission_no_repost_and_budget_tamper_refused(area):
    server = Server()
    def fail_submit(request):
        server(request)
        return httpx.Response(500, json={"error": "unknown submission"})
    report = run(area / "unknown", fail_submit)
    assert report["calls"][0]["status"] == "submission_unknown"
    report = run(area / "unknown", server, mode="resume")
    assert report["status"] == "requires_reconciliation" and server.posts == 1
    report["reserved_usd"] = "0.00"
    probe.atomic_json(area / "unknown/results.json", report)
    with pytest.raises(ValueError):
        run(area / "unknown", server, mode="resume")


def test_batch_lock_prevents_concurrent_execution(area):
    output = area / "locked"
    with probe.batch_lock(output):
        with pytest.raises(BlockingIOError):
            run(output)
    assert not output.exists()


def test_poll_failure_can_read_only_recover_without_completing_missing_cases(area):
    server = Server()
    def failed_poll(request):
        response = server(request)
        if request.method == "GET" and request.url.host == "api.bfl.ai":
            return httpx.Response(503)
        return response
    report = run(area / "failed-poll", failed_poll)
    assert report["status"] == "stopped_after_failure" and server.posts == 1
    report = run(area / "failed-poll", server, mode="resume")
    assert report["status"] == "stopped_incomplete" and server.posts == 1
    with pytest.raises(ValueError):
        run(area / "failed-poll", server, mode="continue")


def test_default_cli_dry_run_and_missing_guards_do_not_read_key(monkeypatch):
    monkeypatch.setattr(probe, "project_key", lambda: pytest.fail("Default or refused mode must not read key"))
    monkeypatch.setattr(sys, "argv", [str(SCRIPT)])
    assert probe.main() == 0
    monkeypatch.setattr(sys, "argv", [str(SCRIPT), "--run", "--output", "not-used"])
    assert probe.main() == 2
    result = subprocess.run([sys.executable, str(SCRIPT)], text=True, capture_output=True)
    assert result.returncode == 0 and json.loads(result.stdout)["real_execution_authorized"] is False


def test_guarded_two_plus_six_cross_process(area):
    code = '''
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("guarded_harness", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
output = Path(sys.argv[2])
m.probe.EVIDENCE = output.parent
m.probe.RUNTIME = output.parent / "private"
server = m.Server()
if sys.argv[3] == "continue":
    server.server.posts = len(json.loads((output / "results.json").read_text())["calls"])
report = m.run(output, server, mode=sys.argv[3])
print(json.dumps({"status": report["status"], "count": len(report["calls"]), "mock": report["mock"]}))
'''
    for mode, expected in [("run", "awaiting_review"), ("continue", "mock_completed")]:
        result = subprocess.run([sys.executable, "-c", code, str(Path(__file__).resolve()),
                                 str(area / "cross-process"), mode], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr
        summary = json.loads(result.stdout)
        assert summary["status"] == expected and summary["mock"] is True
    report = json.loads((area / "cross-process/results.json").read_text())
    assert len(report["calls"]) == 8 and len({r["task_id"] for r in report["calls"]}) == 8
