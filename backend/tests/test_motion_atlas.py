"""Synthetic geometry checks; never claims semantic animation quality."""
import hashlib
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image, ImageChops, ImageDraw

from app.services.motion_assets import validate_motion_pack
from app.services.motion_atlas import ACTIVITIES, atlas_prompt, build_motion_atlas
from app.services.motion_sheet import FRAME_SIZE, MotionSheetError, _foreground


@pytest.fixture
def inputs(tmp_path):
    source = tmp_path / "source.png"
    Image.new("RGB", (512, 384), "gray").save(source)
    atlas = tmp_path / "atlas.png"
    image = Image.new("RGBA", (1536, 864))
    draw = ImageDraw.Draw(image)
    for row in range(3):
        for column in range(4):
            x, y = column * 384, row * 288
            draw.ellipse((x + 100, y + 55, x + 280, y + 245), fill=(100 + column * 25, 40 + row * 30, 20, 220))
    image.save(atlas)
    return source, atlas, tmp_path / "result"


def test_dryrun_and_three_packs_preserve_source_and_alpha(inputs):
    source, atlas, output = inputs
    result = build_motion_atlas(source, atlas, output)
    assert not result["written"] and not output.exists()
    result = build_motion_atlas(source, atlas, output, write=True)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    assert result["source_sha256"] == digest and result["state"] == "candidate"
    assert result["quality"] == "requires_review"
    for activity in ACTIVITIES:
        manifest = validate_motion_pack(output / activity, digest)
        assert manifest["activity"] == activity
        with Image.open(output / activity / "sprite.png") as sprite:
            width, height = FRAME_SIZE
            assert sprite.getchannel("A").getextrema()[0] == 0
            assert ImageChops.difference(sprite.crop((0, 0, width, height)),
                sprite.crop((15 * width, 0, 16 * width, height))).getbbox() is None
    with pytest.raises(MotionSheetError):
        build_motion_atlas(source, atlas, output, write=True)


def test_native_translucent_alpha_is_preserved_without_background_guessing():
    pose = Image.new("RGBA", FRAME_SIZE)
    ImageDraw.Draw(pose).rectangle((100, 60, 250, 220), fill=(0, 0, 0, 110))
    result, background = _foreground(pose)
    assert ImageChops.difference(pose, result).getbbox() is None
    assert result.getpixel((150, 150)) == (0, 0, 0, 110)
    assert background.mode == "RGB"


@pytest.mark.parametrize("corruption", ["empty", "clipped", "ratio", "fake_png", "source", "source_link", "output_link"])
def test_rejects_invalid_input_without_partial_output(inputs, tmp_path, corruption):
    source, atlas, output = inputs
    if corruption in ("empty", "clipped"):
        with Image.open(atlas) as original:
            image = original.copy()
        draw = ImageDraw.Draw(image)
        if corruption == "empty":
            draw.rectangle((0, 0, 383, 287), fill=(0, 0, 0, 0))
        else:
            draw.rectangle((0, 30, 140, 240), fill=(250, 0, 0, 255))
        image.save(atlas)
    elif corruption == "ratio":
        Image.new("RGBA", (1536, 1024)).save(atlas)
    elif corruption == "fake_png":
        atlas.write_text("not png")
    elif corruption == "source":
        source.write_text("not png")
    elif corruption == "source_link":
        original = source.rename(tmp_path / "original.png")
        source.symlink_to(original)
    else:
        parent = tmp_path / "linked"
        parent.symlink_to(tmp_path, target_is_directory=True)
        output = parent / "result"
    with pytest.raises(MotionSheetError):
        build_motion_atlas(source, atlas, output, write=True)
    assert not output.exists()
    assert not list(tmp_path.glob(".atlas-pack-*"))


def test_third_pack_failure_never_publishes_first_two(inputs):
    from app.services.motion_atlas import _write_pack
    source, atlas, output = inputs
    def fail_last(digest, processed, destination, activity):
        if activity == "observe":
            raise OSError("synthetic disk failure")
        return _write_pack(digest, processed, destination, activity)
    with patch("app.services.motion_atlas._write_pack", side_effect=fail_last), pytest.raises(OSError):
        build_motion_atlas(source, atlas, output, write=True)
    assert not output.exists()
    assert not list(output.parent.glob(".atlas-pack-*"))


def test_changed_source_before_publish_discards_all_packs(inputs):
    from app.services.motion_atlas import _write_pack
    source, atlas, output = inputs
    def change_source(digest, processed, destination, activity):
        result = _write_pack(digest, processed, destination, activity)
        source.write_bytes(b"changed")
        return result
    with patch("app.services.motion_atlas._write_pack", side_effect=change_source), pytest.raises(MotionSheetError):
        build_motion_atlas(source, atlas, output, write=True)
    assert not output.exists()


def test_pixel_rounding_keeps_all_twelve_cells(inputs):
    source, atlas, output = inputs
    with Image.open(atlas) as image:
        image.resize((1672, 941)).save(atlas)
    assert build_motion_atlas(source, atlas, output)["activities"] == list(ACTIVITIES)


def test_prompt_is_reference_driven_not_apple_specific():
    prompt = atlas_prompt()
    assert "sole character identity reference" in prompt
    assert all(word in prompt for word in ("rest", "walk", "observe"))
    assert "apple" not in prompt


def test_atlas_packs_use_existing_private_queue_and_delivery(inputs, ready_character_id, client):
    import shutil
    from app.core.config import get_settings
    from app.core.database import SessionLocal
    from app.models.models import Character
    from app.services.motion_preparation import process_one, submit_prepared_pack
    from tests.auth_helpers import TEST_USER_ID
    source, atlas, output = inputs
    build_motion_atlas(source, atlas, output, write=True)
    uploads = Path(get_settings().upload_dir)
    uploads.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, uploads / "atlas-source.png")
    with SessionLocal() as db:
        db.get(Character, ready_character_id).image_path = "atlas-source.png"
        db.commit()
        for activity in ACTIVITIES:
            assert submit_prepared_pack(db, ready_character_id, TEST_USER_ID,
                output / activity, activity, apply=True)["state"] == "queued"
    with SessionLocal() as db:
        assert all(process_one(db) for _ in ACTIVITIES)
    for activity in ACTIVITIES:
        metadata = client.get(f"/api/v1/characters/{ready_character_id}/motion?activity={activity}").json()
        assert metadata["state"] == "ready" and metadata["activity"] == activity
        assert client.get(metadata["sprite_url"]).status_code == 200
