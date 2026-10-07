"""Offline authoring contract: source identity, safe publication and local motion."""
import hashlib
import json
import math
import os
import subprocess
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services import motion_builder as builder
from app.services.motion_assets import validate_motion_pack


@pytest.fixture
def recipe(tmp_path):
    source = tmp_path / "source.png"
    image = Image.new("RGB", (128, 128), (100, 130, 160))
    draw = ImageDraw.Draw(image)
    draw.rectangle((40, 30, 79, 99), fill=(180, 30, 50))
    draw.rectangle((80, 45, 102, 60), fill=(220, 160, 20))
    image.save(source)
    def layer(name, polygon, pivot, rotation):
        return dict(name=name, polygon=polygon, pivot=pivot, rotation=rotation,
                    translate_x=0, translate_y=0, phase=0, lift=0)
    rig = dict(version=builder.VERSION, source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
               source_size=[128, 128], frame_size=[128, 128], frame_count=8, fps=8,
               root=dict(pivot=[60, 90], rotation=0, translate_x=0, bob=0),
               layers=[layer("hand", [[80, 45], [102, 45], [102, 60], [80, 60]], [80, 52], 20),
                       layer("body", [[40, 30], [79, 30], [79, 99], [40, 99]], [60, 90], 0)])
    path = tmp_path / "rig.json"
    path.write_text(json.dumps(rig))
    return source, path, rig


def test_dry_run_has_no_files(recipe, tmp_path):
    source, path, _ = recipe
    output = tmp_path / "new-parent" / "pack"
    result = builder.build_motion_pack(source, path, output)
    assert result["written"] is False
    assert not output.parent.exists()


@pytest.mark.parametrize("change", [
    lambda r: r.update(version="unknown"),
    lambda r: r.update(source_sha256="0" * 64),
    lambda r: r.update(source_size=[127, 128]),
    lambda r: r.update(frame_size=[128, 64]),
    lambda r: r.update(frame_count=True),
    lambda r: r.update(frame_count=25),
    lambda r: r.update(fps=False),
    lambda r: r.update(frame_size=[513, 513]),
    lambda r: r.update(extra="not allowed"),
    lambda r: r.update(layers=[]),
    lambda r: r["root"].update(bob=float("nan")),
    lambda r: r["root"].update(bob=10**400),
    lambda r: r["layers"][0].update(rotation=True),
    lambda r: r["layers"][0].update(phase=float("inf")),
    lambda r: r["layers"][0].update(polygon=[[0, 0], [1, 1], [2, 2]]),
    lambda r: r["layers"][0].update(polygon=[[0, 0], [200, 0], [0, 100]]),
    lambda r: r["layers"][1].update(name="hand"),
])
def test_invalid_recipe_rejected(recipe, tmp_path, change):
    source, path, rig = recipe
    change(rig)
    path.write_text(json.dumps(rig))
    with pytest.raises(builder.MotionBuildError):
        builder.build_motion_pack(source, path, tmp_path / "out", write=True)
    assert not (tmp_path / "out").exists()


def test_source_type_and_size_rejected(recipe, tmp_path):
    source, path, rig = recipe
    source.write_bytes(b"not an image")
    rig["source_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
    path.write_text(json.dumps(rig))
    with pytest.raises(builder.MotionBuildError):
        builder.read_recipe(source, path)
    source.write_bytes(b"x" * (10 * 1024 * 1024 + 1))
    with pytest.raises(builder.MotionBuildError):
        builder.read_recipe(source, path)


def test_existing_and_symlink_output_protected(recipe, tmp_path):
    source, path, _ = recipe
    output = tmp_path / "existing"
    output.mkdir()
    sentinel = output / "keep.txt"
    sentinel.write_text("keep")
    link = tmp_path / "linked"
    link.symlink_to(output, target_is_directory=True)
    for target in [output, link, link / "new"]:
        with pytest.raises(builder.MotionBuildError):
            builder.build_motion_pack(source, path, target, write=True)
    assert sentinel.read_text() == "keep"
    assert list(output.iterdir()) == [sentinel]


def test_failed_validation_cleans_staging(recipe, tmp_path, monkeypatch):
    source, path, _ = recipe
    def fail(*_):
        raise ValueError("simulated validation failure")
    monkeypatch.setattr(builder, "validate_motion_pack", fail)
    with pytest.raises(ValueError):
        builder.build_motion_pack(source, path, tmp_path / "out", write=True)
    assert not (tmp_path / "out").exists()
    assert not list(tmp_path.glob(".motion-build-*"))


def test_pack_is_deterministic_and_moves_only_authored_parts(recipe, tmp_path):
    source, path, rig = recipe
    original = source.read_bytes()
    packs = [tmp_path / "one", tmp_path / "two"]
    for pack in packs:
        result = builder.build_motion_pack(source, path, pack, write=True)
        assert result["model_calls"] == 0 and result["annotation"] == "manual"
        validate_motion_pack(pack, rig["source_sha256"])
    for filename in ["sprite.png", "background.png", "manifest.json"]:
        assert (packs[0] / filename).read_bytes() == (packs[1] / filename).read_bytes()
    assert source.read_bytes() == original
    with Image.open(packs[0] / "background.png") as background, Image.open(packs[0] / "sprite.png") as sprite:
        frames = [sprite.crop((i * 128, 0, (i + 1) * 128, 128)) for i in range(8)]
        assert frames[0].crop((80, 35, 110, 70)).tobytes() != frames[2].crop((80, 35, 110, 70)).tobytes()
        assert all(f.crop((45, 40, 70, 85)).tobytes() == frames[0].crop((45, 40, 70, 85)).tobytes() for f in frames)
        for frame in frames:
            composed = background.convert("RGBA")
            composed.alpha_composite(frame)
            assert composed.getpixel((5, 5)) == (100, 130, 160, 255)


@pytest.mark.parametrize("variant", ["", "自然度修订"])
def test_saved_apple_pack_matches_original_source(variant):
    project = Path(__file__).resolve().parents[2]
    evidence = project / "docs/PRD/版本/V1.2/验收证据"
    source = evidence / "阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
    pack = evidence / "阶段1/R1.5真实样图本地动作" / variant / "apple-motion-pack"
    validate_motion_pack(pack, hashlib.sha256(source.read_bytes()).hexdigest())


@pytest.mark.parametrize("variant", ["original", "lively"])
def test_preview_script_refuses_other_database(tmp_path, variant):
    backend = Path(__file__).resolve().parents[1]
    database = tmp_path / "untouched.db"
    env = dict(os.environ, APP_ENV="test", DATABASE_URL=f"sqlite:///{database}",
               UPLOAD_DIR=str(tmp_path / "uploads"), MODEL_API_KEY="", SCENE_AGENT_ENABLED="false")
    result = subprocess.run([sys.executable, "scripts/r15_motion_preview.py", "--write", "--variant", variant],
                            cwd=backend, env=env, capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert "isolated R1.4 test configuration required" in result.stderr
    assert not database.exists()
    assert not (tmp_path / "uploads").exists()


@pytest.mark.parametrize("space", [None, "screen", True])
def test_invalid_articulation_space_rejected(recipe, space):
    source, path, rig = recipe
    rig["version"] = builder.ARTICULATED_VERSION
    for layer in rig["layers"]:
        layer["space"] = "body"
    rig["layers"][0]["space"] = space
    path.write_text(json.dumps(rig))
    with pytest.raises(builder.MotionBuildError):
        builder.read_recipe(source, path)


def test_ground_support_keeps_sole_while_hip_follows_body():
    foot = Image.new("RGBA", (128, 128))
    ImageDraw.Draw(foot).rectangle((48, 74, 72, 104), fill=(180, 60, 40, 255))
    root = dict(pivot=[64, 100], rotation=5, translate_x=-8, bob=10)
    moved = builder._ground_attachment(foot, root, math.pi / 2, 1)
    assert moved.crop((40, 100, 80, 110)).tobytes() == foot.crop((40, 100, 80, 110)).tobytes()
    assert moved.crop((30, 50, 90, 90)).tobytes() != foot.crop((30, 50, 90, 90)).tobytes()
    # Both sides of contact have vanishing velocity, avoiding a landing snap.
    for edge in (0, math.pi, math.tau):
        epsilon = .0001
        speed = abs(builder._ground_wave(edge + epsilon) - builder._ground_wave(edge - epsilon)) / (2 * epsilon)
        assert speed < .001


def test_articulated_render_has_planted_and_lifted_phases(recipe, tmp_path):
    source, path, rig = recipe
    rig["version"] = builder.ARTICULATED_VERSION
    rig["root"].update(rotation=5, translate_x=-8, bob=10)
    for layer in rig["layers"]:
        layer["space"] = "body"
    # Place the foot below the torso, so its sole cannot be occluded by a lean.
    with Image.open(source) as original:
        image = original.copy()
    draw = ImageDraw.Draw(image)
    draw.rectangle((80, 45, 102, 60), fill=(100, 130, 160))
    draw.rectangle((80, 104, 102, 120), fill=(220, 160, 20))
    image.save(source)
    rig["source_sha256"] = hashlib.sha256(source.read_bytes()).hexdigest()
    rig["layers"][0].update(space="ground", rotation=0, lift=12, pivot=[80, 104],
                            polygon=[[80, 104], [102, 104], [102, 120], [80, 120]])
    path.write_text(json.dumps(rig))
    pack = tmp_path / "articulated"
    builder.build_motion_pack(source, path, pack, write=True)
    with Image.open(pack / "sprite.png") as sprite:
        frames = [sprite.crop((128 * n, 0, 128 * (n + 1), 128)) for n in range(8)]
        sole = (85, 119, 99, 121)
        assert frames[0].crop(sole).tobytes() == frames[6].crop(sole).tobytes()
        assert frames[0].crop(sole).tobytes() != frames[2].crop(sole).tobytes()
        assert frames[0].crop((35, 25, 75, 90)).tobytes() != frames[2].crop((35, 25, 75, 90)).tobytes()


def test_v1_saved_apple_render_unchanged(tmp_path):
    evidence = Path(__file__).resolve().parents[2] / "docs/PRD/版本/V1.2/验收证据"
    root = evidence / "阶段1/R1.5真实样图本地动作"
    pack = tmp_path / "legacy"
    builder.build_motion_pack(evidence / "阶段7/R7.14古灵精怪免费体验/apple-9b.jpg",
                              root / "apple-rig.json", pack, write=True)
    for filename in ["sprite.png", "background.png", "manifest.json"]:
        assert (pack / filename).read_bytes() == (root / "apple-motion-pack" / filename).read_bytes()
