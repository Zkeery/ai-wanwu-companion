"""AIHubMix native protocol, credential isolation and one-attempt receipts."""
import base64
from datetime import date
import hashlib
import json

import httpx
import pytest

from app.services import motion_walk_aihubmix as api
from app.services.motion_atlas_provider import AtlasProviderError
from scripts import generate_sunburst_walk as pilot
from tests.test_sunburst_walk import png


@pytest.fixture
def source(tmp_path, monkeypatch):
    file = tmp_path / "source.png"
    file.write_bytes(png())
    monkeypatch.setattr(pilot, "SOURCE", file)
    monkeypatch.setattr(pilot, "SOURCE_SHA256", hashlib.sha256(file.read_bytes()).hexdigest())
    return file


def task(url=None):
    return {"id": "task_example", "model": api.MODEL, "status": "completed", "error": None,
            "output": [{"index": 0, "type": "file", "b64_json": None,
                        "content_url": url or "https://aihubmix.com/ai/v1/images/task_example/content/result_1"}]}


def test_native_transparent_edit_then_authenticated_download(source):
    calls, events = [], []
    def handler(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer hub-project-key"
        if request.method == "POST":
            assert str(request.url) == api.ENDPOINT
            body = json.loads(request.read())
            assert body["model"] == api.MODEL and body["async"] is False and body["n"] == 1
            assert body["extra"] == {"quality": "medium", "background": "transparent"}
            assert base64.b64decode(body["image"].split(",", 1)[1]) == source.read_bytes()
            assert body["output_format"] == "png" and body["size"] == "1024x1024"
            return httpx.Response(200, json=task())
        assert events == ["task_example"]
        return httpx.Response(200, content=png())
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        image, usage = api.generate(source, "hub-project-key", expected_sha256=pilot.SOURCE_SHA256,
                                    client=client, on_task=events.append)
    assert image == png() and usage == {} and len(calls) == 2


@pytest.mark.parametrize("url", ["http://aihubmix.com/ai/v1/images/task_example/content/r",
    "https://aihubmix.com.evil.test/ai/v1/images/task_example/content/r",
    "https://aihubmix.com@evil.test/ai/v1/images/task_example/content/r",
    "https://aihubmix.com/ai/v1/images/other_task/content/r",
    "https://aihubmix.com/ai/v1/images/task_example/content/r?token=private",
    "https://aihubmix.com/ai/v1/images/task_example/content/../private"])
def test_unsafe_result_never_receives_key(source, url):
    calls = []
    def handler(request):
        calls.append(request)
        assert request.method == "POST"
        return httpx.Response(200, json=task(url))
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError, match="provider_image_url_invalid"):
            api.generate(source, "hub-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert len(calls) == 1


@pytest.mark.parametrize("status,expected", [(401, "provider_authentication_failed"),
    (402, "provider_quota_exhausted"), (403, "provider_access_denied"),
    (429, "provider_rate_limited"), (504, "provider_request_failed")])
def test_errors_are_redacted_without_retry(source, status, expected):
    calls = []
    def handler(request):
        calls.append(1)
        return httpx.Response(status, text="secret-upstream-details")
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError, match=expected) as error:
            api.generate(source, "hub-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert len(calls) == 1 and "secret" not in str(error.value)


@pytest.mark.parametrize("status,body,expected", [
    (403, {"error": {"code": "async_not_enabled", "message": "secret-details"}},
     "provider_async_not_enabled"),
    (403, {"error": {"code": "unknown-secret-code"}}, "provider_access_denied"),
    (403, {"error": "secret-details"}, "provider_access_denied"),
    (403, ["secret-details"], "provider_access_denied"),
    (403, {"error": {"code": ["async_not_enabled"]}}, "provider_access_denied"),
    (401, {"error": {"code": "async_not_enabled"}}, "provider_authentication_failed"),
])
def test_async_activation_error_is_identified_safely(source, status, body, expected):
    calls = []
    def handler(request):
        calls.append(request)
        return httpx.Response(status, json=body)
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError) as error:
            api.generate(source, "hub-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert error.value.code == expected
    assert "secret" not in str(error.value)
    assert len(calls) == 1


def test_inline_png_avoids_download(source):
    data = task()
    data["output"][0]["b64_json"] = base64.b64encode(png()).decode()
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=data))) as client:
        raw, usage = api.generate(source, "hub-project-key", expected_sha256=pilot.SOURCE_SHA256, client=client)
    assert raw == png() and usage == {}


def test_task_saved_before_failure_and_approval_cannot_be_reused(source, tmp_path, monkeypatch):
    monkeypatch.setattr(pilot, "_aihubmix_key", lambda: "hub-project-key")
    monkeypatch.setattr(pilot, "_key", lambda: pytest.fail("must not read OpenAI key"))
    def fail_download(*args, on_task, **kwargs):
        on_task("task_example")
        record = next((tmp_path / "ledger").glob("approval-*.json"))
        assert json.loads(record.read_text())["provider_task_id"] == "task_example"
        raise AtlasProviderError("provider_image_unavailable")
    args = dict(provider_kind="aihubmix", apply=True, approval_ref="one-hub",
                price_verified_on=date.today().isoformat(), accept_metered_cost=True,
                ledger_dir=tmp_path / "ledger", provider=fail_download)
    with pytest.raises(AtlasProviderError, match="provider_image_unavailable"):
        pilot.run(**args)
    data = json.loads(next((tmp_path / "ledger").glob("approval-*.json")).read_text())
    assert data["state"] == "unknown" and data["provider_task_id"] == "task_example"
    assert data["provider"] == "aihubmix"
    with pytest.raises(AtlasProviderError, match="approval_already_used"):
        pilot.run(**args)


def test_dry_run_never_reads_either_key(source, tmp_path, monkeypatch):
    def forbidden():
        pytest.fail("credentials must not be read")
    monkeypatch.setattr(pilot, "_key", forbidden)
    monkeypatch.setattr(pilot, "_aihubmix_key", forbidden)
    result = pilot.run(provider_kind="aihubmix", ledger_dir=tmp_path / "ledger")
    assert result["state"] == "dry-run" and result["endpoint"] == api.ENDPOINT
    assert result["model"] == api.MODEL and not (tmp_path / "ledger").exists()


def test_project_key_is_separate_without_environment_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(pilot, "PROJECT", tmp_path)
    monkeypatch.setenv("AIHUBMIX_API_KEY", "wrong-global-key")
    (tmp_path / ".env").write_text("OPENAI_API_KEY=other-provider-key\n")
    assert pilot._aihubmix_key() == ""
    (tmp_path / ".env").write_text("AIHUBMIX_API_KEY=hub-project-key\nOPENAI_API_KEY=other-provider-key\n")
    assert pilot._aihubmix_key() == "hub-project-key"


def test_gateway_cost_not_estimated_using_openai_rates(source, tmp_path, monkeypatch):
    monkeypatch.setattr(pilot, "_aihubmix_key", lambda: "hub-project-key")
    result = pilot.run(provider_kind="aihubmix", apply=True, approval_ref="success",
                       price_verified_on=date.today().isoformat(), accept_metered_cost=True,
                       ledger_dir=tmp_path / "ledger", provider=lambda *a, **k: (png(), {
                           "input_tokens": 2, "output_tokens": 5,
                           "input_tokens_details": {"text_tokens": 1, "image_tokens": 1}}))
    assert result["state"] == "needs_review" and result["estimated_cost_usd"] is None


def test_incomplete_task_saved_without_second_generation(source):
    events = []
    data = {**task(), "status": "in_progress", "output": []}
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(200, json=data))) as client:
        with pytest.raises(AtlasProviderError, match="provider_task_not_completed"):
            api.generate(source, "hub-project-key", expected_sha256=pilot.SOURCE_SHA256,
                         client=client, on_task=events.append)
    assert events == ["task_example"]
