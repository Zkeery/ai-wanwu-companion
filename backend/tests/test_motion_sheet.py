"""The three reviewed pose sheets must remain valid, distinct, looping activity packs."""
from pathlib import Path

import pytest
from PIL import Image, ImageChops, ImageDraw

from app.services.motion_assets import validate_motion_pack
from app.services.motion_sheet import MotionSheetError, build_sheet_motion

PROJECT = Path(__file__).resolve().parents[2]
SOURCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
SHEETS = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段3/C1.38原图分帧动作"


@pytest.mark.parametrize("activity", ("rest", "walk", "observe"))
def test_reviewed_sheet_builds_classified_seamless_pack(tmp_path, activity):
    output = tmp_path / activity
    sheet = SHEETS / f"{activity}-sheet.png"
    dry_run = build_sheet_motion(SOURCE, sheet, output, activity=activity)
    assert dry_run["state"] == "dry-run" and not output.exists()

    result = build_sheet_motion(SOURCE, sheet, output, activity=activity, write=True)
    assert result["activity"] == activity and result["frame_count"] == 16 and result["fps"] == 8
    assert validate_motion_pack(output, result["source_sha256"]) == {
        key: value for key, value in result.items() if key not in ("state", "written")
    }
    with Image.open(output / "sprite.png") as sprite:
        width, height = result["frame_width"], result["frame_height"]
        frame = lambda index: sprite.crop((index * width, 0, (index + 1) * width, height))
        assert ImageChops.difference(frame(0), frame(15)).getbbox() is None
        assert ImageChops.difference(frame(0), frame(1)).getbbox() is not None
        # Walk holds each phase twice; frame 3 is its next distinct phase.
        next_phase = 3 if activity == "walk" else 2
        assert ImageChops.difference(frame(1), frame(next_phase)).getbbox() is not None
    with pytest.raises(MotionSheetError):
        build_sheet_motion(SOURCE, sheet, output, activity=activity, write=True)


def test_invalid_sheet_or_activity_leaves_no_pack(tmp_path):
    bad_sheet = tmp_path / "bad.png"
    Image.new("RGB", (513, 384), "grey").save(bad_sheet)
    output = tmp_path / "pack"
    with pytest.raises(MotionSheetError):
        build_sheet_motion(SOURCE, bad_sheet, output, activity="walk", write=True)
    with pytest.raises(MotionSheetError):
        build_sheet_motion(SOURCE, SHEETS / "walk-sheet.png", output, activity="dance", write=True)
    assert not output.exists()


def test_dry_run_rejects_non_image_source_and_empty_pose_sheet(tmp_path):
    source = tmp_path / "source.jpg"
    source.write_text("not an image", encoding="utf8")
    sheet = SHEETS / "rest-sheet.png"
    output = tmp_path / "pack"
    with pytest.raises(MotionSheetError):
        build_sheet_motion(source, sheet, output, activity="rest")
    Image.new("RGB", (1024, 768), "grey").save(tmp_path / "empty.png")
    with pytest.raises(MotionSheetError):
        build_sheet_motion(SOURCE, tmp_path / "empty.png", output, activity="rest")
    assert not output.exists()


def test_square_transparent_poses_preserve_shape_in_wide_frames(tmp_path):
    sheet = Image.new("RGBA", (1024, 1024), (90, 30, 10, 0))
    draw = ImageDraw.Draw(sheet)
    for index in range(4):
        x, y = (index % 2) * 512, (index // 2) * 512
        draw.ellipse((x + 110, y + 110, x + 401, y + 401), fill=(200, 40 + index * 20, 30, 255))
    sheet_path = tmp_path / "square.png"
    sheet.save(sheet_path)
    output = tmp_path / "pack"
    result = build_sheet_motion(SOURCE, sheet_path, output, activity="walk", write=True)
    validate_motion_pack(output, result["source_sha256"])
    with Image.open(output / "sprite.png") as sprite:
        frame = sprite.crop((0, 0, 360, 270))
        alpha = frame.getchannel("A")
        left, top, right, bottom = alpha.point(lambda value: 255 if value > 32 else 0).getbbox()
        assert abs((right - left) - (bottom - top)) <= 1  # A circle must remain round.
        assert abs((left + right) / 2 - 180) <= 1
        assert alpha.crop((0, 0, 45, 270)).getextrema() == (0, 0)
        assert alpha.crop((315, 0, 360, 270)).getextrema() == (0, 0)
        assert frame.tobytes() == sprite.crop((15 * 360, 0, 16 * 360, 270)).tobytes()


@pytest.mark.parametrize("mode,size", [("RGB", (1024, 1024)), ("RGBA", (1024, 1024)),
                                      ("RGBA", (1024, 800))])
def test_square_opaque_or_other_ratio_still_rejected(tmp_path, mode, size):
    image = Image.new(mode, size, "red")
    if size != (1024, 1024):
        image.putalpha(0)
    sheet = tmp_path / "unsupported.png"
    image.save(sheet)
    output = tmp_path / "pack"
    with pytest.raises(MotionSheetError, match="invalid frame ratio"):
        build_sheet_motion(SOURCE, sheet, output, activity="walk", write=True)
    assert not output.exists()
