"""R7.7 paid-call guard and offline recording; no provider requests."""
from datetime import datetime
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import sys
from zoneinfo import ZoneInfo

import httpx
import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/probe_qwen_image_3_i2i.py"
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location("qwen_image_3_i2i_pilot", SCRIPT)
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


def isolated_sources(tmp_path, monkeypatch):
    root = tmp_path / "evidence"
    root.mkdir()
    for name in ("cup.jpg", "apple.jpg", "plant.jpg", "multi.jpg", "sources.json", "plan.json"):
        (root / name).write_bytes((pilot.EVIDENCE / name).read_bytes())
    monkeypatch.setattr(pilot, "EVIDENCE", root)
    monkeypatch.setattr(pilot, "SOURCE_MANIFEST", root / "sources.json")
    monkeypatch.setattr(pilot, "PLAN", root / "plan.json")
    return root


def test_frozen_inputs_and_real_image_field():
    sources, plan = pilot.load_plan()
    assert len(sources["inputs"]) == 4 and plan["model"] == "qwen-image-3.0"
    photo = (pilot.EVIDENCE / "cup.jpg").read_bytes()
    body = pilot.request_body(photo, "cup")
    assert body["image"].startswith("data:image/jpeg;base64,")
    assert body["model"] == pilot.MODEL and body["n"] == 1
    assert "image" not in pilot.request_body(photo, "cup")["prompt"]


@pytest.mark.parametrize("budget,day,allowed", [
    ("2.00", "2026-09-25", True),
    ("0", "2026-09-25", False),
    ("2.01", "2026-09-25", False),
    ("2.00", "2026-09-24", False),
])
def test_new_budget_and_same_day_price_required(budget, day, allowed):
    at = datetime(2026, 9, 25, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
    if allowed:
        pilot.preflight(Decimal(budget), day, at)
    else:
        with pytest.raises(ValueError):
            pilot.preflight(Decimal(budget), day, at)


def test_direct_real_run_cannot_bypass_budget(tmp_path):
    output = tmp_path / "never-created"
    with pytest.raises(ValueError):
        pilot.run(output, False, key="placeholder", verified_on=pilot.now_local().date().isoformat())
    assert not output.exists()


def test_offline_eight_calls_no_network_or_release(tmp_path, monkeypatch):
    root = isolated_sources(tmp_path, monkeypatch)
    monkeypatch.setattr(httpx.Client, "post", lambda *args, **kwargs: pytest.fail("network POST"))
    report = pilot.run(root / "offline", True)
    assert report["mock"] and not report["release_passed"]
    assert report["status"] == "completed" and len(report["calls"]) == 8
    assert report["reserved_cny"] == "1.60"
    assert all(row["quality"] == "NEED_REVIEW" for row in report["calls"])
    assert len(list((root / "offline").glob("*.png"))) == 8
    with pytest.raises(ValueError):
        pilot.run(root / "offline", True)


def test_offline_failure_stops_and_preserves_first_attempt(tmp_path, monkeypatch):
    root = isolated_sources(tmp_path, monkeypatch)
    monkeypatch.setattr(pilot, "image_bytes", lambda *_: (_ for _ in ()).throw(ValueError("signed-secret-url")))
    report = pilot.run(root / "failed", True)
    persisted = json.loads((root / "failed/results.json").read_text())
    assert report["status"] == "stopped_after_failure" and len(report["calls"]) == 1
    assert persisted["calls"][0]["status"] == "failed"
    assert persisted["reserved_cny"] == "0.20" and "signed-secret-url" not in json.dumps(persisted)
    assert persisted["calls"][0]["failure_stage"] == "image_payload"


def test_real_mode_accepts_valid_base64_image_without_network(monkeypatch):
    monkeypatch.setattr(pilot, "download", lambda *_: pytest.fail("unexpected URL download"))
    raw = pilot.image_bytes(pilot.offline_response(), False)
    pilot.valid_image(raw)


def test_response_shape_excludes_signed_url_and_image_data():
    data = {"data": [{"url": "https://cdn.example/output?secret=signed-secret-url",
                      "b64_json": "private-image-content"}], "private": "do-not-save"}
    facts = pilot.response_shape(data)
    assert facts == {"data_is_list": True, "data_count": 1, "first_is_object": True,
                     "first_has_url": True, "first_has_b64_json": True}
    assert "signed-secret-url" not in json.dumps(facts)
    assert "private-image-content" not in json.dumps(facts)
