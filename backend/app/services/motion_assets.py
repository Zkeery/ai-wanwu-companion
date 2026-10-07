"""Offline sprite-pack validation; no provider calls or database writes."""
import hashlib
import json
import re
from io import BytesIO
from pathlib import Path

from PIL import Image

VERSION = "companion-motion-sprite-v1"
FIELDS = {"version", "source_sha256", "frame_width", "frame_height", "frame_count", "fps",
          "sprite_file", "background_file", "sprite_sha256", "background_sha256"}


class MotionAssetError(ValueError):
    pass


def validate_motion_pack(directory: Path, expected_source_sha256: str) -> dict:
    """The caller supplies the trusted source hash, independently of the manifest."""
    def reject():
        raise MotionAssetError("动作资源不符合约定")

    def sha(value):
        return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None

    try:
        directory = Path(directory)
        manifest = directory / "manifest.json"
        if directory.is_symlink() or manifest.is_symlink() or manifest.stat().st_size > 8192:
            reject()
        data = json.loads(manifest.read_text(encoding="utf8"))
        from app.services.motion_video import VERSION as VIDEO_VERSION, validate_video_pack
        if isinstance(data, dict) and data.get("version") == VIDEO_VERSION:
            return validate_video_pack(directory, data, expected_source_sha256)
        if (not isinstance(data, dict) or set(data) not in (FIELDS, FIELDS | {"activity"})
                or data["version"] != VERSION
                or ("activity" in data and data["activity"] not in ("rest", "walk", "observe"))):
            reject()
        if not sha(expected_source_sha256) or data["source_sha256"] != expected_source_sha256:
            reject()
        for key, lo, hi in [("frame_width", 64, 512), ("frame_height", 64, 512),
                            ("frame_count", 2, 24), ("fps", 4, 24)]:
            if type(data[key]) is not int or not lo <= data[key] <= hi:
                reject()
        w, h, count = data["frame_width"], data["frame_height"], data["frame_count"]
        if w * h * count > 7_000_000:
            reject()
        for kind in ("sprite", "background"):
            filename = data[kind + "_file"]
            if not isinstance(filename, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,63}\.png", filename):
                reject()
            file = directory / filename
            digest = data[kind + "_sha256"]
            if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= 10 * 1024 * 1024 or not sha(digest):
                reject()
            encoded = file.read_bytes()
            if hashlib.sha256(encoded).hexdigest() != digest:
                reject()
            with Image.open(BytesIO(encoded)) as image:
                if image.format != "PNG" or image.size != ((w * count, h) if kind == "sprite" else (w, h)):
                    reject()
                image.load()
                alpha = image.convert("RGBA").getchannel("A").getextrema()
                if kind == "sprite":
                    if image.mode != "RGBA":
                        reject()
                    for frame in range(count):
                        lo, hi = image.crop((frame * w, 0, (frame + 1) * w, h)).getchannel("A").getextrema()
                        if lo == 255 or hi == 0:
                            reject()
                if kind == "background" and alpha != (255, 255):
                    reject()
        return data.copy()
    except MotionAssetError:
        raise
    except (OSError, ValueError, TypeError, KeyError, Image.DecompressionBombError):
        reject()
