"""Build sprite packs from a source image and explicit, hand-authored part contours."""
from __future__ import annotations

import hashlib
import json
import math
import re
import tempfile
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from app.services.motion_assets import validate_motion_pack

VERSION = "companion-motion-rig-v1"
ARTICULATED_VERSION = "companion-motion-rig-v2"


class MotionBuildError(ValueError):
    pass


def _reject():
    raise MotionBuildError("源图、分层标注或输出目录不符合动作制作约定")


def _number(value, minimum, maximum):
    if type(value) not in (int, float) or not minimum <= value <= maximum or not math.isfinite(value):
        _reject()


def _point(point, width, height):
    if not isinstance(point, list) or len(point) != 2:
        _reject()
    _number(point[0], 0, width)
    _number(point[1], 0, height)


def read_recipe(source: Path, rig_path: Path) -> tuple[Image.Image, dict, str]:
    try:
        if source.is_symlink() or rig_path.is_symlink() or not 0 < source.stat().st_size <= 10 * 1024 * 1024 or rig_path.stat().st_size > 65536:
            _reject()
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        rig = json.loads(rig_path.read_text(encoding="utf8"))
        keys = {"version", "source_sha256", "source_size", "frame_size", "frame_count", "fps", "root", "layers"}
        if not isinstance(rig, dict) or set(rig) != keys or rig["version"] not in (VERSION, ARTICULATED_VERSION) or rig["source_sha256"] != digest:
            _reject()
        with Image.open(source) as opened:
            if opened.format not in {"JPEG", "PNG", "WEBP"} or max(opened.size) > 4096 or opened.width * opened.height > 16_000_000:
                _reject()
            image = ImageOps.exif_transpose(opened).convert("RGB")
        sw, sh = image.size
        if rig["source_size"] != [sw, sh]:
            _reject()
        size = rig["frame_size"]
        if not isinstance(size, list) or len(size) != 2 or any(type(n) is not int or not 64 <= n <= 512 for n in size):
            _reject()
        w, h = size
        count, fps = rig["frame_count"], rig["fps"]
        if (type(count) is not int or not 2 <= count <= 24 or type(fps) is not int or not 4 <= fps <= 24
                or w * h * count > 7_000_000 or w * sh != h * sw):
            _reject()
        root = rig["root"]
        if not isinstance(root, dict) or set(root) != {"pivot", "rotation", "translate_x", "bob"}:
            _reject()
        _point(root["pivot"], sw, sh)
        _number(root["rotation"], -5, 5)
        _number(root["translate_x"], -20, 20)
        _number(root["bob"], 0, 20)
        layers = rig["layers"]
        if not isinstance(layers, list) or not 2 <= len(layers) <= 8:
            _reject()
        names = set()
        for layer in layers:
            fields = {"name", "polygon", "pivot", "rotation", "translate_x", "translate_y", "phase", "lift"}
            if rig["version"] == ARTICULATED_VERSION:
                fields.add("space")
            if not isinstance(layer, dict) or set(layer) != fields:
                _reject()
            if rig["version"] == ARTICULATED_VERSION and layer["space"] not in ("body", "ground"):
                _reject()
            name, polygon = layer["name"], layer["polygon"]
            if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", name) or name in names:
                _reject()
            names.add(name)
            if not isinstance(polygon, list) or not 3 <= len(polygon) <= 80:
                _reject()
            for point in polygon:
                _point(point, sw, sh)
            area = abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(polygon, polygon[1:] + polygon[:1]))) / 2
            if area < 32:
                _reject()
            _point(layer["pivot"], sw, sh)
            _number(layer["rotation"], -25, 25)
            _number(layer["translate_x"], -32, 32)
            _number(layer["translate_y"], -32, 32)
            _number(layer["phase"], 0, math.tau)
            _number(layer["lift"], 0, 32)
        return image, rig, digest
    except MotionBuildError:
        raise
    except (OSError, ValueError, TypeError, KeyError, Image.DecompressionBombError):
        _reject()


def _background(image: Image.Image, masks: list[Image.Image]) -> Image.Image:
    """Fit only observed background pixels; keep the rest of the image unchanged."""
    w, h = image.size
    union = np.maximum.reduce([np.asarray(mask) for mask in masks])
    excluded = np.asarray(Image.fromarray(union).filter(ImageFilter.MaxFilter(21))) > 0
    y, x = np.mgrid[-1:1:complex(h), -1:1:complex(w)]
    basis = np.stack([np.ones_like(x), x, y, x*x, x*y, y*y, x*x*x, x*x*y, x*y*y, y*y*y], axis=-1)
    available = np.flatnonzero(~excluded.ravel())
    if len(available) < w * h * .15:
        _reject()
    sample = available[np.linspace(0, len(available) - 1, min(8192, len(available)), dtype=int)]
    original = np.asarray(image, dtype=np.float64)
    coefficients = np.linalg.lstsq(basis.reshape(-1, 10)[sample], original.reshape(-1, 3)[sample], rcond=None)[0]
    fill = np.clip(basis @ coefficients, 0, 255)
    removal = np.asarray(Image.fromarray(((union > 12) * 255).astype("uint8")).filter(ImageFilter.MaxFilter(13))) > 0
    fill[~removal] = original[~removal]
    # Keep observed pixels fixed and relax only the removed silhouette. This
    # preserves the local floor lighting instead of leaving a bright cutout rim.
    for _ in range(768):
        padded = np.pad(fill, ((1, 1), (1, 1), (0, 0)), mode="edge")
        neighbors = (padded[:-2, 1:-1] + padded[2:, 1:-1] + padded[1:-1, :-2] + padded[1:-1, 2:]) / 4
        fill[removal] = neighbors[removal]
    return Image.fromarray(np.rint(fill).astype("uint8"))


def _shift(image, dx, dy):
    return image.transform(image.size, Image.Transform.AFFINE, (1, 0, -dx, 0, 1, -dy),
                           resample=Image.Resampling.BICUBIC)


def _ground_wave(phase):
    # Zero velocity at takeoff and landing; the support half stays planted.
    return max(0.0, math.sin(phase)) ** 2


def _root_transform(image, root, phase, scale, *, articulated=False):
    moved = image.rotate(root["rotation"] * math.sin(phase), resample=Image.Resampling.BICUBIC,
                         center=tuple(v * scale for v in root["pivot"]))
    bounce = math.sin(phase) ** 2 if articulated else abs(math.sin(phase))
    return _shift(moved, root["translate_x"] * math.sin(phase) * scale, -root["bob"] * bounce * scale)


def _ground_attachment(part, root, phase, scale):
    """Follow the hip at the top while retaining the original sole pixels."""
    bounds = part.getbbox()
    if not bounds:
        return part
    left, top, right, bottom = bounds
    anchor = bottom - max(1, (bottom - top) // 5)
    height = max(1, anchor - top)
    x, y = (left + right) / 2, top
    px, py = (v * scale for v in root["pivot"])
    angle = math.radians(root["rotation"] * math.sin(phase))
    dx = (math.cos(angle) - 1) * (x - px) + math.sin(angle) * (y - py)
    dx += root["translate_x"] * math.sin(phase) * scale
    dy = -math.sin(angle) * (x - px) + (math.cos(angle) - 1) * (y - py)
    dy -= root["bob"] * math.sin(phase) ** 2 * scale
    # Avoid inverted or extreme deformations for arbitrary authored contours.
    dy = max(-height * .75, min(height * .5, dy))
    dx = max(-height, min(height, dx))
    sy = 1 - dy / height
    shear = dx / (height * sy)
    moved = part.transform(part.size, Image.Transform.AFFINE,
                           (1, shear, -shear * anchor, 0, 1 / sy, anchor * (1 - 1 / sy)),
                           resample=Image.Resampling.BICUBIC)
    moved.paste(part.crop((0, anchor, part.width, part.height)), (0, anchor))
    return moved


def build_motion_pack(source: Path, rig_path: Path, output: Path, *, write=False) -> dict:
    started = time.perf_counter()
    image, rig, digest = read_recipe(source, rig_path)
    if output.exists() or output.is_symlink() or any(parent.is_symlink() for parent in output.absolute().parents):
        _reject()
    w, h = rig["frame_size"]
    if not write:
        return {"state": "validated", "written": False, "source_sha256": digest, "frame_count": rig["frame_count"]}
    scale = w / image.width
    masks, parts = [], []
    for layer in rig["layers"]:
        mask = Image.new("L", image.size)
        ImageDraw.Draw(mask).polygon([tuple(point) for point in layer["polygon"]], fill=255)
        mask = mask.resize((w, h), Image.Resampling.LANCZOS)
        masks.append(mask)
        part = image.resize((w, h), Image.Resampling.LANCZOS).convert("RGBA")
        part.putalpha(mask)
        parts.append(part)
    static = image.resize((w, h), Image.Resampling.LANCZOS)
    background = _background(static, masks)
    frames = []
    root = rig["root"]
    articulated = rig["version"] == ARTICULATED_VERSION
    for n in range(rig["frame_count"]):
        phase = math.tau * n / rig["frame_count"]
        frame = Image.new("RGBA", (w, h))
        for layer, part in zip(rig["layers"], parts):
            grounded = articulated and layer["space"] == "ground"
            wave = _ground_wave(phase + layer["phase"]) if grounded else math.sin(phase + layer["phase"])
            attached = _ground_attachment(part, root, phase, scale) if grounded else part
            moved = attached.rotate(layer["rotation"] * wave, resample=Image.Resampling.BICUBIC,
                                center=tuple(v * scale for v in layer["pivot"]))
            moved = _shift(moved, layer["translate_x"] * wave * scale,
                           (layer["translate_y"] * wave - layer["lift"] * max(0, wave)) * scale)
            if articulated and not grounded:
                moved = _root_transform(moved, root, phase, scale, articulated=True)
            frame.alpha_composite(moved)
        if not articulated:
            frame = _root_transform(frame, root, phase, scale)
        frames.append(frame)
    sheet = Image.new("RGBA", (w * len(frames), h))
    for i, frame in enumerate(frames):
        sheet.paste(frame, (i * w, 0))
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".motion-build-", dir=output.parent) as temporary:
        stage = Path(temporary) / "pack"
        stage.mkdir()
        background.save(stage / "background.png")
        sheet.save(stage / "sprite.png")
        file_hash = lambda name: hashlib.sha256((stage / name).read_bytes()).hexdigest()
        manifest = {"version": "companion-motion-sprite-v1", "source_sha256": digest,
                    "frame_width": w, "frame_height": h, "frame_count": len(frames), "fps": rig["fps"],
                    "sprite_file": "sprite.png", "background_file": "background.png",
                    "sprite_sha256": file_hash("sprite.png"), "background_sha256": file_hash("background.png")}
        (stage / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
        validate_motion_pack(stage, digest)
        annotation = image.copy()
        draw = ImageDraw.Draw(annotation)
        for i, layer in enumerate(rig["layers"]):
            color = ["#ffcc00", "#00ffff", "#ff66cc", "#88ff44", "#ff7755", "#aabbee", "#ffffff", "#5555ff"][i]
            points = [tuple(point) for point in layer["polygon"]]
            draw.line(points + points[:1], fill=color, width=3)
            draw.text(points[0], layer["name"], fill=color)
        annotation.save(stage / "annotations.png")
        contact = Image.new("RGB", (w * 3, h * 2))
        contact.paste(static, (0, 0))
        for cell, index in enumerate([0, len(frames)//4, len(frames)//2, 3*len(frames)//4, len(frames)-1], start=1):
            composite = background.convert("RGBA")
            composite.alpha_composite(frames[index])
            contact.paste(composite.convert("RGB"), ((cell % 3) * w, (cell // 3) * h))
        contact.save(stage / "contact-sheet.jpg", quality=92)
        if output.exists() or output.is_symlink():
            _reject()
        stage.rename(output)
    return {"state": "built", "written": True, "source_sha256": digest, "frame_count": len(frames),
            "elapsed_ms": round((time.perf_counter() - started) * 1000), "annotation": "manual",
            "model_calls": 0}
