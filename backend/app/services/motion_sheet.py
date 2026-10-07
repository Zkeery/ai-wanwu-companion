"""Build a classified sprite pack from a reviewed 2x2 pose sheet."""
import hashlib
import json
import shutil
import tempfile
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

from app.services.motion_assets import VERSION, validate_motion_pack

FRAME_SIZE = (360, 270)
FPS = 8
SEQUENCES = {
    "rest": (0, 1, 2, 2, 2, 2, 2, 2, 3, 3, 1, 1, 0, 0, 0, 0),
    # Two forward cycles; the split boundary hold preserves equal phase duration.
    "walk": (0, 1, 1, 2, 2, 3, 3, 0, 0, 1, 1, 2, 2, 3, 3, 0),
    "observe": (0, 1, 2, 2, 2, 2, 3, 3, 1, 1, 0, 0, 0, 0, 0, 0),
}


class MotionSheetError(ValueError):
    pass


def _checked_file(path: Path) -> None:
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= 10 * 1024 * 1024:
        raise MotionSheetError("invalid input")


def _flood(data: bytes, width: int, height: int, starts, wanted: int) -> bytearray:
    seen = bytearray(len(data))
    queue = deque()
    for index in starts:
        if data[index] == wanted and not seen[index]:
            seen[index] = 1
            queue.append(index)
    while queue:
        index = queue.popleft()
        x, y = index % width, index // width
        for next_index, valid in ((index - 1, x > 0), (index + 1, x < width - 1),
                                  (index - width, y > 0), (index + width, y < height - 1)):
            if valid and not seen[next_index] and data[next_index] == wanted:
                seen[next_index] = 1
                queue.append(next_index)
    return seen


def _foreground(tile: Image.Image) -> tuple[Image.Image, Image.Image]:
    width, height = tile.size
    if tile.mode == "RGBA" and tile.getchannel("A").getextrema()[0] < 255:
        alpha = np.asarray(tile.getchannel("A"))
        coverage = np.count_nonzero(alpha > 32) / (width * height)
        margin = max(2, min(width, height) // 100)
        if (not .08 <= coverage <= .6 or np.any(alpha[:margin] > 32)
                or np.any(alpha[-margin:] > 32) or np.any(alpha[:, :margin] > 32)
                or np.any(alpha[:, -margin:] > 32)):
            raise MotionSheetError("invalid transparent foreground")
        # Preserve the authored alpha, including translucent edges. Do not run
        # opaque-background extraction over transparent or dark body pixels.
        if width == height:
            side = min(FRAME_SIZE)
            frame = Image.new("RGBA", FRAME_SIZE, (0, 0, 0, 0))
            frame.paste(tile.resize((side, side), Image.Resampling.LANCZOS),
                        ((FRAME_SIZE[0] - side) // 2, (FRAME_SIZE[1] - side) // 2))
        else:
            frame = tile.resize(FRAME_SIZE, Image.Resampling.LANCZOS)
        return frame, Image.new("RGB", tile.size, (128, 128, 128))
    pixels = np.asarray(tile.convert("RGB"), dtype=np.int16)
    band = max(4, width // 29)
    left = pixels[:, :band].mean(axis=1)[:, None, :]
    right = pixels[:, -band:].mean(axis=1)[:, None, :]
    column = np.linspace(0, 1, width, dtype=np.float32)[None, :, None]
    background = np.uint8(np.clip(left * (1 - column) + right * column, 0, 255))
    difference = np.max(np.abs(pixels - background.astype(np.int16)), axis=2)
    seed = np.where(difference > 34, 255, 0).astype(np.uint8)
    margin = max(4, width // 20)
    seed[:, :margin] = 0
    seed[:, -margin:] = 0
    seed[int(height * .93):] = 0
    radius = 9 if width >= 400 else 3
    closed = Image.fromarray(seed, "L").filter(ImageFilter.MaxFilter(radius)).filter(ImageFilter.MinFilter(radius))
    border = (list(range(width)) + list(range((height - 1) * width, height * width))
              + [row * width for row in range(height)] + [row * width + width - 1 for row in range(height)])
    outside = _flood(closed.tobytes(), width, height, border, 0)
    filled = bytes(0 if pixel else 255 for pixel in outside)
    center = (height // 2) * width + width // 2
    selected = _flood(filled, width, height, (center,), 255)
    coverage = sum(selected) / (width * height)
    if not .08 <= coverage <= .6:
        raise MotionSheetError("character foreground not found")
    matte = Image.frombytes("L", (width, height), bytes(255 if pixel else 0 for pixel in selected))
    matte = matte.filter(ImageFilter.MaxFilter(5 if width >= 400 else 3)).filter(ImageFilter.GaussianBlur(1.2))
    character = tile.convert("RGBA")
    character.putalpha(matte)
    return character.resize(FRAME_SIZE, Image.Resampling.LANCZOS), Image.fromarray(background, "RGB")


def build_sheet_motion(source: Path, sheet: Path, output: Path, *, activity: str, write=False) -> dict:
    source, sheet, output = Path(source), Path(sheet), Path(output)
    if activity not in SEQUENCES:
        raise MotionSheetError("invalid activity")
    _checked_file(source)
    _checked_file(sheet)
    if output.exists() or output.is_symlink():
        raise MotionSheetError("output already exists")
    try:
        with Image.open(source) as original:
            if original.format not in ("JPEG", "PNG") or original.width < 256 or original.height < 192:
                raise MotionSheetError("invalid source image")
            original.load()
    except OSError as exc:
        raise MotionSheetError("invalid source image") from exc
    with Image.open(sheet) as image:
        if image.format != "PNG" or image.width % 2 or image.height % 2 or not 512 <= image.width <= 4096 or not 384 <= image.height <= 3072:
            raise MotionSheetError("invalid 2x2 sheet")
        width, height = image.width // 2, image.height // 2
        transparent_square = (width == height and "A" in image.getbands()
                              and image.getchannel("A").getextrema()[0] < 255)
        if abs(width * 3 - height * 4) > 4 and not transparent_square:
            raise MotionSheetError("invalid frame ratio")
        image.load()
        poses = [image.convert("RGBA").crop(((i % 2) * width, (i // 2) * height,
                                            (i % 2 + 1) * width, (i // 2 + 1) * height)) for i in range(4)]
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    processed = [_foreground(pose) for pose in poses]
    if not write:
        return {"state": "dry-run", "written": False, "activity": activity, "source_sha256": source_hash}
    return _write_pack(source_hash, processed, output, activity)


def _write_pack(source_hash: str, processed: list, output: Path, activity: str) -> dict:
    frame_width, frame_height = FRAME_SIZE
    sequence = SEQUENCES[activity]
    sprite = Image.new("RGBA", (frame_width * len(sequence), frame_height))
    for index, pose in enumerate(sequence):
        sprite.paste(processed[pose][0], (index * frame_width, 0))
    background = processed[0][1].resize(FRAME_SIZE, Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".sheet-pack-", dir=output.parent))
    try:
        sprite.save(temporary / "sprite.png", optimize=True)
        background.save(temporary / "background.png", optimize=True)
        digest = lambda name: hashlib.sha256((temporary / name).read_bytes()).hexdigest()
        manifest = {"version": VERSION, "source_sha256": source_hash, "activity": activity,
                    "frame_width": frame_width, "frame_height": frame_height,
                    "frame_count": len(sequence), "fps": FPS, "sprite_file": "sprite.png",
                    "background_file": "background.png", "sprite_sha256": digest("sprite.png"),
                    "background_sha256": digest("background.png")}
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf8")
        validate_motion_pack(temporary, source_hash)
        temporary.rename(output)
        return {"state": "ready", "written": True, **manifest}
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
