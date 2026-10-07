import importlib.util
import json
from pathlib import Path

import httpx
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/probe_expression_spin.py"
spec = importlib.util.spec_from_file_location("spin_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Client:
    def __init__(self, response=None, error=False):
        self.response = response or httpx.Response(200, json={"id": "cgt-test-1234"})
        self.error = error
        self.posts = 0

    def post(self, *_args, **_kwargs):
        self.posts += 1
        if self.error:
            raise httpx.ReadTimeout("sensitive message must not escape")
        return self.response

    def get(self, *_args, **_kwargs):
        return self.response


def test_frozen_request_uses_exact_approved_source():
    result = probe.frozen_request()
    assert result["model"] == probe.MODEL
    assert result["duration"] == 6 and result["generate_audio"] is False
    assert result["content"][1]["image_url"] == result["content"][2]["image_url"]
    assert result["content"][1]["image_url"]["url"].startswith("data:image/jpeg;base64,")


@pytest.mark.parametrize("field,value", [("approved", False), ("approved_cap_cny", 5),
                                        ("max_generation_posts", 2), ("plan_sha256", "wrong")])
def test_authorization_changes_rejected(tmp_path, monkeypatch, field, value):
    for name in ["trial-plan.json", "本批授权.json", "官方价格摘录.json"]:
        (tmp_path / name).write_bytes((probe.EVIDENCE / name).read_bytes())
    approval = json.loads((tmp_path / "本批授权.json").read_text())
    approval[field] = value
    (tmp_path / "本批授权.json").write_text(json.dumps(approval))
    monkeypatch.setattr(probe, "EVIDENCE", tmp_path)
    with pytest.raises(ValueError):
        probe.frozen_request()


def test_one_post_even_across_reopen(tmp_path):
    client = Client()
    file = tmp_path / "ledger.db"
    with probe.ledger(file) as db:
        assert probe.submit(db, client, {}, "test-key")["state"] == "queued"
    with probe.ledger(file) as db:
        assert probe.status(db)["reserve_cny"] == 4
        with pytest.raises(ValueError, match="already_submitted"):
            probe.submit(db, client, {}, "test-key")
    assert client.posts == 1


def test_unknown_outcome_cannot_resubmit(tmp_path):
    client = Client(error=True)
    with probe.ledger(tmp_path / "ledger.db") as db:
        result = probe.submit(db, client, {}, "test-key")
        assert result["state"] == "unknown"
        assert "sensitive" not in json.dumps(result)
        with pytest.raises(ValueError):
            probe.submit(db, client, {}, "test-key")
        assert result["reserve_cny"] == 4
    assert client.posts == 1


def test_rejection_is_sanitized_and_does_not_retry(tmp_path):
    client = Client(httpx.Response(403, json={"error": {"code": "ModelNotOpen", "message": "secret"}}))
    with probe.ledger(tmp_path / "ledger.db") as db:
        result = probe.submit(db, client, {}, "test-key")
        assert result["state"] == "rejected" and result["provider_code"] == "ModelNotOpen"
        assert "secret" not in json.dumps(result)
        with pytest.raises(ValueError):
            probe.submit(db, client, {}, "test-key")
    assert client.posts == 1


def test_missing_receipt_is_unknown(tmp_path):
    with probe.ledger(tmp_path / "ledger.db") as db:
        result = probe.submit(db, Client(httpx.Response(200, json={})), {}, "test-key")
        assert result["state"] == "unknown"


def test_poll_success_keeps_url_out_of_report(tmp_path):
    result_file = tmp_path / "private-result.json"
    with probe.ledger(tmp_path / "ledger.db") as db:
        probe.submit(db, Client(), {}, "test-key")
        client = Client(httpx.Response(200, json={"status": "succeeded", "usage": {"completion_tokens": 130417},
                                                "content": {"video_url": "https://example.com/signed?secret=value"}}))
        result = probe.poll(db, client, "test-key", result_file)
        assert result["state"] == "succeeded"
        assert "secret" not in json.dumps(result) and "https" not in json.dumps(result)
        assert result["estimated_cny"] < 4
        assert result_file.stat().st_mode & 0o777 == 0o600
        assert client.posts == 0


def test_unsubmitted_task_cannot_poll(tmp_path):
    with probe.ledger(tmp_path / "ledger.db") as db:
        with pytest.raises(ValueError):
            probe.poll(db, Client(), "test-key", tmp_path / "result")
