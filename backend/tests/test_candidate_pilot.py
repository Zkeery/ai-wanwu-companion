"""Offline safeguards for the billable R7.5 pilot; never calls a provider."""
from datetime import datetime
from decimal import Decimal
from io import BytesIO
import importlib.util
import json
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from PIL import Image
import pytest

PATH = Path(__file__).resolve().parents[1] / "scripts/compare_generation_candidates.py"
spec = importlib.util.spec_from_file_location("candidate_pilot", PATH)
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def test_plan_has_four_pairs_with_cold_and_warm_runs():
    rows = pilot.schedule()
    assert len(rows) == 8 and len({(v, i) for v, i, _ in rows}) == 4
    assert [r for _, _, r in rows] == [1, 2] * 4
    assert sum(pilot.RESERVE[v] + pilot.RESERVE[i] for v, i, _ in rows) == Decimal("1.184")


@pytest.mark.parametrize("budget,day,now,ok", [
    (2, "2026-09-22", "2026-09-22T12:00:00", True),
    (0, "2026-09-22", "2026-09-22T12:00:00", False),
    (2, "2026-09-21", "2026-09-22T12:00:00", False),
    (2, "2026-09-24", "2026-09-24T10:00:00", False),
    (3, "2026-09-22", "2026-09-22T12:00:00", False),
])
def test_budget_and_current_price_required(budget, day, now, ok):
    instant = datetime.fromisoformat(now).replace(tzinfo=ZoneInfo("Asia/Shanghai"))
    if ok:
        pilot.preflight(budget, day, instant)
    else:
        with pytest.raises(ValueError):
            pilot.preflight(budget, day, instant)


def test_offline_cannot_network_or_approve_release(tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("offline pilot attempted network")
    monkeypatch.setattr(httpx.Client, "post", forbidden)
    monkeypatch.setattr(httpx.Client, "stream", forbidden)
    report = pilot.run(tmp_path / "pilot", True)
    assert report["mock"] and not report["release_passed"] and not report["selection_passed"]
    assert len(report["samples"]) == 8 and len(report["calls"]) == 16
    assert all(s["quality"] == "NEED_REVIEW" for s in report["samples"])
    assert report["reserved_cny"] == 1.184
    assert len(list((tmp_path / "pilot").glob("*.png"))) == 8
    with pytest.raises(FileExistsError):
        pilot.run(tmp_path / "pilot", True)


def test_vision_failure_kept_and_does_not_generate_image(tmp_path, monkeypatch):
    def failed(*args, **kwargs):
        raise ValueError("bad JSON")
    monkeypatch.setattr(pilot, "recognize", failed)
    report = pilot.run(tmp_path / "fail", True)
    assert len(report["samples"]) == 8
    assert len(report["calls"]) == 8
    assert all(r["model"] in pilot.VISIONS for r in report["calls"])
    assert all(s["status"] == "failed" and not s["local_within_8s"] for s in report["samples"])


def test_unknown_model_and_fifth_call_blocked(tmp_path):
    report = {"calls": []}
    guard = pilot.Guard(tmp_path / "record.json", report)
    with pytest.raises(ValueError):
        guard.reserve("unapproved-model", "one")
    for i in range(4):
        guard.reserve(pilot.IMAGES[0], str(i))
    with pytest.raises(ValueError):
        guard.reserve(pilot.IMAGES[0], "fifth")
    assert len(json.loads(guard.path.read_text())["calls"]) == 4


def test_provider_failure_records_only_safe_error_and_stops_on_auth(tmp_path, monkeypatch):
    class Fail:
        def post(self, *args, **kwargs):
            return httpx.Response(401, text="secret-detail", request=httpx.Request("POST", pilot.BASE))
    report = {"calls": [], "price_verified_on": "2026-09-22"}
    monkeypatch.setattr(pilot, "preflight", lambda *args: None)
    guard = pilot.Guard(tmp_path / "record.json", report)
    with pytest.raises(httpx.HTTPStatusError):
        pilot.post(Fail(), "private-credential", {"model": pilot.VISIONS[0]}, guard, "one", False)
    assert guard.stopped
    assert "secret-detail" not in guard.path.read_text() and "private-credential" not in guard.path.read_text()
    assert report["calls"][0]["status"] == "failed"


@pytest.mark.parametrize("data", [
    {"choices": [{"finish_reason": "length", "message": {"content": "[]"}}]},
    {"choices": [{"finish_reason": "stop", "message": {"content": '[{"label":"杯子"}]'}}]},
])
def test_incomplete_concepts_cannot_trigger_paid_fallback(data):
    with pytest.raises(ValueError):
        pilot.recognize(data)


@pytest.mark.parametrize("kind", ["html", "receipt", "small", "huge"])
def test_only_actual_full_size_image_is_accepted(kind):
    if kind == "small":
        b = BytesIO()
        Image.new("RGB", (16, 16)).save(b, format="PNG")
        data = b.getvalue()
    else:
        data = {"html": b"<html>error</html>", "receipt": b'{"task_id":"queued"}',
                "huge": b"x" * (pilot.MAX_BYTES + 1)}[kind]
    with pytest.raises((ValueError, OSError)):
        pilot.valid_image(data)


@pytest.mark.parametrize("url", ["http://cdn.example/a.png", "https://u:p@cdn.example/a.png", "https://cdn.example:9000/a.png"])
def test_unsafe_download_url_rejected(url):
    with pytest.raises(ValueError):
        pilot.validate_url(url)


def test_private_dns_is_rejected(monkeypatch):
    monkeypatch.setattr(pilot.socket, "getaddrinfo", lambda *a, **kw: [(2, 1, 6, "", ("127.0.0.1", 443))])
    with pytest.raises(ValueError):
        pilot.validate_url("https://cdn.example/a.png")


def test_pilot_does_not_send_unverified_qwen_thinking_parameter():
    assert pilot.vision_body(b"sample", pilot.VISIONS[0])["thinking"] == {"type": "disabled"}
    qwen = pilot.vision_body(b"sample", pilot.VISIONS[1])
    assert qwen["max_tokens"] == 4096
    assert "thinking" not in qwen and "enable_thinking" not in qwen


def test_price_expiry_blocks_call_before_reserving_or_posting(tmp_path, monkeypatch):
    def expired(*args):
        raise ValueError("expired")
    monkeypatch.setattr(pilot, "preflight", expired)
    report = {"calls": [], "price_verified_on": "2026-09-22"}
    guard = pilot.Guard(tmp_path / "r.json", report)
    with pytest.raises(ValueError):
        pilot.post(None, "", {"model": pilot.VISIONS[0]}, guard, "one", False)
    assert report["calls"] == [] and guard.total == 0


def test_dry_run_does_not_read_credentials_or_call_provider(monkeypatch, capsys):
    monkeypatch.setattr(pilot.sys, "argv", [str(PATH)])
    def forbidden(*a, **kw):
        pytest.fail("dry-run must not read a file or start a run")
    monkeypatch.setattr(pilot, "run", forbidden)
    monkeypatch.setattr(Path, "read_text", forbidden)
    pilot.main()
    result = json.loads(capsys.readouterr().out)
    assert result["dry_run"] and result["provider_calls"] == 0
