"""Provider protocol and one-attempt ledger; no paid request is made."""
from datetime import date
from io import BytesIO
import base64
import json
from pathlib import Path

import httpx
from PIL import Image
import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character
from app.services.motion_atlas_provider import AtlasProviderError, generate, preflight
from app.services.motion_atlas_ark import ENDPOINT as ARK_ENDPOINT, generate as ark_generate
from scripts.generate_character_atlas import run
from tests.auth_helpers import TEST_USER_ID

BASE = "https://test.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"


def png(width: int, height: int) -> bytes:
    output = BytesIO()
    Image.new("RGBA", (width, height), (180, 40, 20, 255)).save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def source(tmp_path, ready_character_id):
    file = Path(get_settings().upload_dir) / "atlas-provider-source.png"
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(png(512, 512))
    with SessionLocal() as db:
        db.get(Character, ready_character_id).image_path = file.name
        db.commit()
    return ready_character_id, file


def test_reference_edit_request_and_real_png_validation(source):
    _, file = source
    requests = []
    def handler(request):
        requests.append(request)
        if request.method == "POST":
            body = json.loads(request.content)
            assert body["model"] == "qwen-image-3.0"
            assert body["size"] == "1536x864" and body["n"] == 1
            assert body["image"].startswith("data:image/png;base64,")
            assert "Row 1 rest" in body["prompt"]
            return httpx.Response(200, json={"data": [{"url": "https://example.aliyuncs.com/result.png"}]})
        return httpx.Response(200, content=png(1536, 864))
    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
        result = generate(file, BASE, "private-key", client=client)
    assert len(requests) == 2 and result.startswith(b"\x89PNG")
    assert preflight(file, BASE)["model"] == "qwen-image-3.0"


@pytest.mark.parametrize("url", ["http://evil/compatible-mode/v1", "https://127.0.0.1/compatible-mode/v1",
                                  "https://evil.maas.aliyuncs.com@localhost/compatible-mode/v1"])
def test_invalid_endpoint_never_calls_provider(source, url):
    with pytest.raises(AtlasProviderError) as error:
        preflight(source[1], url)
    assert error.value.code == "provider_configuration_invalid"


def test_bad_result_url_or_geometry_is_rejected(source):
    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"url": "https://127.0.0.1/private.png"}]})
        raise AssertionError("unsafe download")
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError, match="provider_image_url_invalid"):
            generate(source[1], BASE, "private-key", client=client)

    def wrong_geometry(request):
        if request.method == "POST":
            return httpx.Response(200, json={"data": [{"url": "https://example.aliyuncs.com/result.png"}]})
        return httpx.Response(200, content=png(1024, 1024))
    with httpx.Client(transport=httpx.MockTransport(wrong_geometry)) as client:
        with pytest.raises(AtlasProviderError, match="provider_image_invalid"):
            generate(source[1], BASE, "private-key", client=client)


def test_changed_source_is_rejected_before_paid_post(source):
    def handler(_):
        raise AssertionError("provider must not be called")
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(AtlasProviderError, match="source_changed_before_call"):
            generate(source[1], BASE, "private-key", expected_sha256="0" * 64, client=client)


def test_dry_run_and_unknown_attempt_cannot_reuse_approval(source, tmp_path, monkeypatch):
    cid, _ = source
    settings = get_settings()
    monkeypatch.setattr(settings, "motion_atlas_base_url", BASE)
    monkeypatch.setattr(settings, "motion_atlas_api_key", "private-key")
    calls = []
    def uncertain(*_, **__):
        calls.append(1)
        raise AtlasProviderError("provider_call_unknown")
    plan = run(cid, TEST_USER_ID, ledger_dir=tmp_path, provider=uncertain)
    assert plan["state"] == "dry-run" and not calls and list(tmp_path.iterdir()) == []
    args = dict(apply=True, approval_ref="one-approved-attempt", price_verified_on=date.today().isoformat(),
                max_budget_cny="0.20", ledger_dir=tmp_path, provider=uncertain)
    with pytest.raises(AtlasProviderError, match="provider_call_unknown"):
        run(cid, TEST_USER_ID, **args)
    receipt = next(tmp_path.glob("approval-*.json"))
    assert json.loads(receipt.read_text())["state"] == "unknown"
    with pytest.raises(AtlasProviderError, match="approval_already_used"):
        run(cid, TEST_USER_ID, **args)
    assert len(calls) == 1


def test_source_change_after_request_never_publishes_candidate(source, tmp_path, monkeypatch):
    cid, file = source
    settings = get_settings()
    monkeypatch.setattr(settings, "motion_atlas_base_url", BASE)
    monkeypatch.setattr(settings, "motion_atlas_api_key", "private-key")
    def changed(*_, **__):
        file.write_bytes(png(512, 513))
        return png(1536, 864)
    with pytest.raises(AtlasProviderError, match="source_changed_after_call"):
        run(cid, TEST_USER_ID, apply=True, approval_ref="source-changed", price_verified_on=date.today().isoformat(),
            max_budget_cny="0.20", ledger_dir=tmp_path, provider=changed)
    assert not list(tmp_path.glob("character-*.png"))


def test_ark_reference_request_and_candidate_png(source):
    _, file = source
    seen = []
    def handler(request):
        seen.append(request)
        assert str(request.url) == ARK_ENDPOINT
        body = json.loads(request.content)
        assert body["model"] == "doubao-seedream-5-0-flash-260915"
        assert body["size"] == "1536x864" and body["response_format"] == "b64_json"
        assert body["watermark"] is False
        assert body["image"].startswith("data:image/png;base64,")
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(png(1536, 864)).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = ark_generate(file, "private-key", client=client)
    assert len(seen) == 1 and result.startswith(b"\x89PNG")


def test_ark_single_approval_and_unknown_result(source, tmp_path, monkeypatch):
    cid, _ = source
    monkeypatch.setattr("scripts.generate_character_atlas._project_ark_key", lambda: "private-key")
    calls = []
    def unknown(*_, **__):
        calls.append(1)
        raise AtlasProviderError("provider_call_unknown")
    plan = run(cid, TEST_USER_ID, provider_kind="ark", ledger_dir=tmp_path, provider=unknown)
    assert plan["unit_ceiling_cny"] == "0.12" and not calls
    args = dict(provider_kind="ark", apply=True, approval_ref="one-ark-approval",
                price_verified_on=date.today().isoformat(), max_budget_cny="0.12",
                ledger_dir=tmp_path, provider=unknown)
    with pytest.raises(AtlasProviderError, match="provider_call_unknown"):
        run(cid, TEST_USER_ID, **args)
    with pytest.raises(AtlasProviderError, match="approval_already_used"):
        run(cid, TEST_USER_ID, **args)
    assert len(calls) == 1
