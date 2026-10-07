"""Native alpha request contract and forward gait; no paid model calls."""
import base64
from collections import Counter
from datetime import date
import hashlib
import json
from pathlib import Path
import subprocess
import sys

import httpx
from PIL import Image, ImageDraw
import pytest

from app.services.motion_atlas import atlas_prompt, build_motion_atlas
from app.services.motion_atlas_ark import generate, preflight
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_sheet import FRAME_SIZE, _foreground
from scripts.generate_character_atlas import run
from tests.auth_helpers import TEST_USER_ID
from tests.test_motion_atlas import inputs  # noqa: F401
from tests.test_motion_atlas_provider import source  # noqa: F401
from tests.test_motion_atlas_quality import opaque_atlas


def reference(file, mode):
    image = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((130, 100, 380, 420), fill=(200, 35, 20, 220))
    if mode in {"jpeg", "rgb", "rgba_opaque", "fake_alpha"}:
        image = Image.new("RGBA", (512, 512), (200, 35, 20, 255))
        if mode == "fake_alpha":
            image.putpixel((0, 0), (0, 0, 0, 0))
        elif mode in {"jpeg", "rgb"}:
            image = image.convert("RGB")
    elif mode == "palette":
        image = Image.new("P", (512, 512), 0)
        image.putpalette([0, 0, 0, 200, 35, 20] + [0] * 762)
        ImageDraw.Draw(image).ellipse((130, 100, 380, 420), fill=1)
        image.info["transparency"] = 0
    image.save(file, format="JPEG" if mode == "jpeg" else "PNG")


@pytest.mark.parametrize("mode,background", [
    ("jpeg", "opaque"), ("rgb", "opaque"), ("rgba_opaque", "opaque"),
    ("fake_alpha", "opaque"), ("rgba", "transparent"), ("palette", "transparent"),
])
def test_request_matches_actual_source_alpha_and_preflight(tmp_path, inputs, mode, background):
    file = tmp_path / "reference.png"
    reference(file, mode)
    _, atlas, _ = inputs
    before = file.read_bytes()
    plan = preflight(file)
    assert plan["background"] == background and plan["output_format"] == "png"
    seen = []
    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        assert body["background"] == background and body["output_format"] == "png"
        assert body["watermark"] is False
        assert base64.b64decode(body["image"].split(",", 1)[1]) == before
        assert hashlib.sha256(body["prompt"].encode()).hexdigest() == plan["prompt_sha256"]
        assert ("#808080" in body["prompt"]) == (background == "opaque")
        return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(atlas.read_bytes()).decode()}]})
    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        result = generate(file, "test-key", client=client, expected_sha256=plan["source_sha256"])
    assert result.startswith(b"\x89PNG") and len(seen) == 1
    assert file.read_bytes() == before


def test_empty_transparent_source_and_changed_alpha_are_rejected_before_request(tmp_path):
    file = tmp_path / "reference.png"
    Image.new("RGBA", (512, 512)).save(file)
    with pytest.raises(AtlasProviderError, match="source_invalid"):
        preflight(file)
    reference(file, "rgba")
    digest = preflight(file)["source_sha256"]
    reference(file, "rgba_opaque")
    def forbidden(_):
        raise AssertionError("no provider request permitted")
    with httpx.Client(transport=httpx.MockTransport(forbidden)) as client:
        with pytest.raises(AtlasProviderError, match="source_changed_before_call"):
            generate(file, "test-key", client=client, expected_sha256=digest)


@pytest.mark.parametrize("actual_alpha", [True, False])
def test_native_alpha_receipt_and_restart_reject_opaque_result(source, inputs, tmp_path, monkeypatch, actual_alpha):
    cid, file = source
    reference(file, "rgba")
    _, atlas, _ = inputs
    if not actual_alpha:
        opaque_atlas(atlas)
    monkeypatch.setattr("scripts.generate_character_atlas._project_ark_key", lambda: "test-key")
    result = run(cid, TEST_USER_ID, provider_kind="ark", apply=True, approval_ref="native-alpha",
                 price_verified_on=date.today().isoformat(), max_budget_cny="0.12",
                 ledger_dir=tmp_path / "ledger", provider=lambda *a, **kw: atlas.read_bytes())
    assert result["state"] == ("needs_review" if actual_alpha else "rejected")
    saved = json.loads(Path(result["receipt"]).read_text())
    assert saved["background"] == "transparent" and saved["output_format"] == "png"
    assert saved["quality_check"]["expected_background"] == "transparent"
    assert Path(result["candidate"]).read_bytes() == atlas.read_bytes()
    if not actual_alpha:
        assert all(i["code"] == "native_transparency_missing" for i in result["quality_check"]["issues"])
    child = subprocess.run([sys.executable, "-m", "scripts.inspect_motion_atlas", "--atlas", result["candidate"],
                            "--expected-background", "transparent"], capture_output=True, text=True, timeout=30)
    assert child.returncode == (0 if actual_alpha else 2), child.stderr
    assert json.loads(child.stdout) == saved["quality_check"]


def test_walk_sprite_advances_forward_with_equal_phase_duration_and_no_reverse(inputs):
    original, atlas, output = inputs
    build_motion_atlas(original, atlas, output, write=True)
    with Image.open(atlas) as image:
        phases = [_foreground(image.crop((i * 384, 288, (i + 1) * 384, 576)))[0].tobytes()
                  for i in range(4)]
    assert len(set(phases)) == 4
    with Image.open(output / "walk" / "sprite.png") as sprite:
        w, h = FRAME_SIZE
        order = [phases.index(sprite.crop((i * w, 0, (i + 1) * w, h)).tobytes()) for i in range(16)]
    assert order[0] == order[-1] == 0
    assert Counter(order) == {0: 4, 1: 4, 2: 4, 3: 4}
    for current, following in zip(order, order[1:] + order[:1]):
        assert following in (current, (current + 1) % 4)
    assert len([1 for a, b in zip(order, order[1:]) if a != b]) == 8


def test_background_prompts_are_mutually_exclusive():
    assert "#808080" not in atlas_prompt(background="transparent")
    assert "Do not paint any background color" not in atlas_prompt(background="opaque")
    with pytest.raises(ValueError):
        atlas_prompt(background="unsupported")
