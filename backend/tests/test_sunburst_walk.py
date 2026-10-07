"""Offline Sunburst protocol and durable single-attempt tests."""
import base64
from datetime import date
import hashlib
from io import BytesIO
import json
import subprocess
import sys

import httpx
from PIL import Image, ImageDraw
import pytest

from app.services.motion_atlas_provider import AtlasProviderError
from app.services import motion_walk_openai as api
from scripts import generate_sunburst_walk as pilot


def png(*, opaque=False, size=(1024, 1024)):
    image = Image.new("RGBA", size, (0, 0, 0, 255 if opaque else 0))
    draw = ImageDraw.Draw(image)
    for y in (0, 512):
        for x in (0, 512):
            draw.ellipse((x + 160, y + 100, x + 350, y + 400), fill=(220, 40, 20, 255))
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


@pytest.fixture
def source(tmp_path, monkeypatch):
    file = tmp_path / "source.png"
    file.write_bytes(png())
    monkeypatch.setattr(pilot, "SOURCE", file)
    monkeypatch.setattr(pilot, "SOURCE_SHA256", hashlib.sha256(file.read_bytes()).hexdigest())
    monkeypatch.setattr(pilot, "_key", lambda: "test-project-key")
    return file


def response(image=None):
    return {"data": [{"b64_json": base64.b64encode(image or png()).decode()}],
            "usage": {"input_tokens": 150, "output_tokens": 1000, "total_tokens": 1150,
                      "input_tokens_details": {"text_tokens": 50, "image_tokens": 100},
                      "untrusted_text": "must not persist"}}


def test_multipart_edit_preserves_source_and_white_lists_usage(source):
    calls = []
    def handler(request):
        calls.append(request)
        assert str(request.url) == api.ENDPOINT and request.method == "POST"
        assert request.headers["authorization"] == "Bearer test-project-key"
        assert "multipart/form-data" in request.headers["content-type"]
        raw = request.read()
        assert source.read_bytes() in raw
        for value in (api.MODEL, "medium", "transparent", "1024x1024", 'name="image[]"'):
            assert value.encode() in raw
        assert b"response_format" not in raw and b"input_fidelity" not in raw
        return httpx.Response(200, json=response())
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        image, usage = api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert len(calls) == 1 and image == png()
    assert "untrusted_text" not in usage
    assert api.estimated_cost_usd(usage) == "0.03105"


@pytest.mark.parametrize("status,code,expected", [(401, "invalid_api_key", "provider_authentication_failed"),
    (403, None, "provider_access_denied"), (429, "insufficient_quota", "provider_quota_exhausted"),
    (429, None, "provider_rate_limited"), (500, None, "provider_request_failed")])
def test_provider_errors_are_redacted_and_never_retried(source, status, code, expected):
    calls = []
    def handler(request):
        calls.append(1)
        return httpx.Response(status, json={"error": {"code": code, "message": "secret-user-document"}})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError, match=expected) as error:
            api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert str(error.value) == expected and len(calls) == 1


def test_changed_source_and_redirect_do_not_send_second_request(source):
    calls = []
    def handler(request):
        calls.append(1)
        return httpx.Response(307, headers={"location": "https://elsewhere.invalid"}, json={})
    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
        with pytest.raises(AtlasProviderError, match="source_changed_before_call"):
            api.generate(source, "test-project-key", expected_sha256="0" * 64, client=client)
        assert not calls
        with pytest.raises(AtlasProviderError, match="provider_request_failed"):
            api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert len(calls) == 1


@pytest.mark.parametrize("data", [{"data": []}, {"data": [{"b64_json": "not base64"}]},
                                  response(png(size=(512, 512))), {"data": [None]}])
def test_bad_responses_rejected(source, data):
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=data))) as client:
        with pytest.raises(AtlasProviderError):
            api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)


def test_dry_run_does_not_read_key_write_or_call(source, tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("dry run must not access key or network")
    monkeypatch.setattr(pilot, "_key", forbidden)
    folder = tmp_path / "ledger"
    result = pilot.run(ledger_dir=folder, provider=forbidden)
    assert result["state"] == "dry-run" and not folder.exists()
    assert result["api_cost_cap_supported"] is False


@pytest.mark.parametrize("change", [{"accept_metered_cost": False}, {"approval_ref": ""},
                                   {"price_verified_on": "2000-01-01"}])
def test_incomplete_approval_cannot_call(source, tmp_path, change):
    args = dict(apply=True, approval_ref="one", price_verified_on=date.today().isoformat(),
                accept_metered_cost=True, ledger_dir=tmp_path / "ledger")
    args.update(change)
    with pytest.raises(AtlasProviderError, match="approval_invalid"):
        pilot.run(**args, provider=lambda *a, **k: pytest.fail("unexpected paid call"))
    assert not (tmp_path / "ledger").exists()


def test_uncertain_attempt_is_durable_and_not_repeated(source, tmp_path):
    calls = []
    def unknown(*args, **kwargs):
        calls.append(1)
        raise httpx.ReadTimeout("secret-provider-text")
    args = dict(apply=True, approval_ref="one", price_verified_on=date.today().isoformat(),
                accept_metered_cost=True, ledger_dir=tmp_path / "ledger", provider=unknown)
    with pytest.raises(AtlasProviderError, match="candidate_unavailable"):
        pilot.run(**args)
    record = next((tmp_path / "ledger").glob("approval-*.json"))
    assert json.loads(record.read_text())["state"] == "unknown"
    assert "secret-provider-text" not in record.read_text()
    with pytest.raises(AtlasProviderError, match="approval_already_used"):
        pilot.run(**args)
    assert len(calls) == 1
    code = """
import sys
from pathlib import Path
from datetime import date
from scripts import generate_sunburst_walk as p
from app.services.motion_atlas_provider import AtlasProviderError
p.SOURCE = Path(sys.argv[1])
p.SOURCE_SHA256 = sys.argv[2]
p._key = lambda: 'test-project-key'
def forbidden(*args, **kwargs):
    raise AssertionError('a fresh process must not retry')
try:
    p.run(apply=True, approval_ref='one', price_verified_on=date.today().isoformat(),
          accept_metered_cost=True, ledger_dir=Path(sys.argv[3]), provider=forbidden)
except AtlasProviderError as exc:
    print(exc.code)
"""
    child = subprocess.run([sys.executable, "-c", code, str(source), pilot.SOURCE_SHA256,
                            str(tmp_path / "ledger")], capture_output=True, text=True, timeout=15)
    assert child.returncode == 0 and child.stdout.strip() == "approval_already_used"


def test_opaque_candidate_is_retained_but_not_accepted(source, tmp_path):
    raw = png(opaque=True)
    result = pilot.run(apply=True, approval_ref="opaque", price_verified_on=date.today().isoformat(),
                       accept_metered_cost=True, ledger_dir=tmp_path / "ledger",
                       provider=lambda *a, **k: (raw, {}))
    assert result["state"] == "rejected" and result["estimated_cost_usd"] is None
    assert result["quality_check"]["human_review_required"] is True
    assert (tmp_path / "ledger" / result["candidate_file"]).read_bytes() == raw


def test_success_retains_raw_usage_and_needs_human_review(source, tmp_path):
    usage = api._usage(response()["usage"])
    result = pilot.run(apply=True, approval_ref="success", price_verified_on=date.today().isoformat(),
                       accept_metered_cost=True, ledger_dir=tmp_path / "ledger",
                       provider=lambda *a, **k: (png(), usage))
    assert result["state"] == "needs_review" and result["estimated_cost_usd"] == "0.03105"
    assert result["actual_bill_verified"] is False
    assert result["image_sha256"] == hashlib.sha256(png()).hexdigest()


def test_client_initialization_failure_is_sanitized(source, monkeypatch):
    def broken(*args, **kwargs):
        raise ValueError("secret")
    monkeypatch.setattr(api.httpx, "Client", broken)
    with pytest.raises(AtlasProviderError, match="provider_call_unknown") as error:
        api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256)
    assert "secret" not in str(error.value)


def test_missing_or_inconsistent_usage_is_not_claimed_free():
    assert api.estimated_cost_usd({}) is None
    assert api.estimated_cost_usd({"input_tokens": 4, "output_tokens": 1,
                                  "input_tokens_details": {"text_tokens": 1, "image_tokens": 1}}) is None


def test_http_timeout_not_retried_or_leaked(source):
    calls = []
    def timeout(request):
        calls.append(1)
        raise httpx.ReadTimeout("provider-secret")
    with httpx.Client(transport=httpx.MockTransport(timeout)) as client:
        with pytest.raises(AtlasProviderError, match="provider_call_unknown") as error:
            api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert str(error.value) == "provider_call_unknown" and len(calls) == 1


def test_large_response_stopped_before_decode(source, monkeypatch):
    monkeypatch.setattr(api, "MAX_ATLAS", 10)
    with httpx.Client(transport=httpx.MockTransport(
            lambda _: httpx.Response(200, content=b"x" * 150_000))) as client:
        with pytest.raises(AtlasProviderError, match="provider_response_invalid"):
            api.generate(source, "test-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
