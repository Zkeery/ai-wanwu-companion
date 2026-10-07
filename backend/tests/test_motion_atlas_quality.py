"""Offline rejection regressions; synthetic poses do not establish quality."""
from datetime import date
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image, ImageDraw
import pytest

from app.services.motion_atlas import build_motion_atlas
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_atlas_quality import inspect_atlas
from app.services.motion_sheet import MotionSheetError
from scripts.generate_character_atlas import run
from tests.auth_helpers import TEST_USER_ID
from tests.test_motion_atlas import inputs  # noqa: F401
from tests.test_motion_atlas_provider import source  # noqa: F401


def opaque_atlas(path, *, checkerboard=False):
    image = Image.new("RGB", (1536, 864), (128, 128, 128))
    draw = ImageDraw.Draw(image)
    if checkerboard:
        for y in range(0, 864, 16):
            for x in range(0, 1536, 16):
                color = 110 if (x // 16 + y // 16) % 2 else 160
                draw.rectangle((x, y, x + 15, y + 15), fill=(color,) * 3)
    for row in range(3):
        for col in range(4):
            x, y = col * 384, row * 288
            draw.ellipse((x + 110, y + 55, x + 270, y + 235), fill=(180 + col * 10, 35, 35))
    image.save(path)


@pytest.mark.parametrize("background", ["alpha", "gray"])
def test_valid_background_still_requires_human_review(inputs, background):
    _, atlas, _ = inputs
    if background == "gray":
        opaque_atlas(atlas)
    result = inspect_atlas(atlas)
    assert result["state"] == "needs_review" and result["human_review_required"]
    assert len(result["cells"]) == 12 and not result["issues"]
    assert "watermark_or_text" in result["manual_checks"]


@pytest.mark.parametrize("defect", ["checkerboard", "divider", "clipped", "static", "empty", "fake_alpha"])
def test_rejected_atlas_cannot_publish_any_pack(inputs, defect):
    source_image, atlas, output = inputs
    if defect in {"checkerboard", "divider", "fake_alpha"}:
        opaque_atlas(atlas, checkerboard=defect == "checkerboard")
    with Image.open(atlas) as original:
        image = original.convert("RGBA")
    draw = ImageDraw.Draw(image)
    if defect == "divider":
        draw.line((384, 0, 384, 863), fill="white", width=6)
    elif defect == "clipped":
        draw.rectangle((0, 50, 140, 200), fill="red")
    elif defect == "static":
        tile = image.crop((0, 0, 384, 288))
        for col in range(4):
            image.paste(tile, (col * 384, 0))
    elif defect == "empty":
        draw.rectangle((0, 0, 383, 287), fill=(0, 0, 0, 0))
    elif defect == "fake_alpha":
        image.putpixel((0, 0), (128, 128, 128, 0))
    image.save(atlas)
    assert inspect_atlas(atlas)["state"] == "rejected"
    with pytest.raises(MotionSheetError, match="atlas quality rejected"):
        build_motion_atlas(source_image, atlas, output, write=True)
    assert not output.exists() and not list(output.parent.glob(".atlas-pack-*"))


@pytest.mark.parametrize("accepted", [True, False])
def test_candidate_receipt_survives_restart_and_never_retries(source, inputs, tmp_path, monkeypatch, accepted):
    cid, _ = source
    _, atlas, _ = inputs
    if not accepted:
        opaque_atlas(atlas, checkerboard=True)
    monkeypatch.setattr("scripts.generate_character_atlas._project_ark_key", lambda: "test-secret")
    calls = []
    def provider(*_, **__):
        calls.append(1)
        return atlas.read_bytes()
    ledger = tmp_path / "ledger"
    args = dict(provider_kind="ark", apply=True, approval_ref="quality-test",
                price_verified_on=date.today().isoformat(), max_budget_cny="0.12",
                ledger_dir=ledger, provider=provider)
    result = run(cid, TEST_USER_ID, **args)
    assert result["state"] == ("needs_review" if accepted else "rejected")
    assert Path(result["candidate"]).read_bytes() == atlas.read_bytes()
    saved = json.loads(Path(result["receipt"]).read_text())
    assert saved["quality_check"] == result["quality_check"]
    assert "test-secret" not in Path(result["receipt"]).read_text()
    # A fresh process can reproduce the persisted decision without a Key or database.
    child = subprocess.run([sys.executable, "-m", "scripts.inspect_motion_atlas", "--atlas",
                            result["candidate"]], capture_output=True, text=True, timeout=30)
    assert child.returncode == (0 if accepted else 2), child.stderr
    assert json.loads(child.stdout) == saved["quality_check"]
    with pytest.raises(AtlasProviderError, match="approval_already_used"):
        run(cid, TEST_USER_ID, **args)
    assert calls == [1]


def test_real_c148_candidate_is_rejected_without_editing_it(tmp_path):
    project = Path(__file__).resolve().parents[2]
    candidate = project / "docs/PRD/版本/V1.2/验收证据/阶段3/C1.48火山单张候选/seedream-atlas-unreviewed.png"
    result = inspect_atlas(candidate)
    assert result["atlas_sha256"] == "d39a6af8f3545a74aff833d434b9be54703a8615a50d807951ee115640679f68"
    assert result["state"] == "rejected"
    assert any(issue["code"] == "background_not_uniform_gray" for issue in result["issues"])


def test_inspection_cli_rejects_invalid_image_without_traceback(tmp_path):
    bad = tmp_path / "bad.png"
    bad.write_text("not an image")
    child = subprocess.run([sys.executable, "-m", "scripts.inspect_motion_atlas", "--atlas", str(bad)],
                           capture_output=True, text=True, timeout=30)
    assert child.returncode == 2 and not child.stderr
    assert json.loads(child.stdout)["error"]["code"] == "invalid_atlas"
