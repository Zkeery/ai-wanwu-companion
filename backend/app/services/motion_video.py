"""Bounded local MP4 validation; no network or generation."""
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path

VERSION = "companion-motion-video-v1"
FIELDS = {"version", "source_sha256", "video_file", "video_sha256", "width", "height", "fps", "duration_ms"}


def probe_video(file: Path) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams",
        "-show_format", "-of", "json", str(file.resolve()),
    ], capture_output=True, timeout=5, check=True)
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if len(streams) != 1 or streams[0].get("codec_name") != "h264" or streams[0].get("codec_type") != "video":
        raise ValueError("invalid video streams")
    stream = streams[0]
    if "mp4" not in data.get("format", {}).get("format_name", "").split(","):
        raise ValueError("invalid container")
    if stream.get("avg_frame_rate") != "24/1":
        raise ValueError("invalid frame rate")
    duration = float(data["format"]["duration"])
    if not math.isfinite(duration) or not 4 <= duration <= 15:
        raise ValueError("invalid duration")
    width, height = stream["width"], stream["height"]
    if not all(type(n) is int and 64 <= n <= 1920 for n in (width, height)):
        raise ValueError("invalid dimensions")
    return {"width": width, "height": height, "fps": 24, "duration_ms": round(duration * 1000)}


def validate_video_pack(directory: Path, data: dict, source: str) -> dict:
    from app.services.motion_assets import MotionAssetError
    try:
        if (set(data) not in (FIELDS, FIELDS | {"activity"}) or data["version"] != VERSION
                or data["source_sha256"] != source
                or ("activity" in data and data["activity"] not in ("rest", "walk", "observe"))):
            raise ValueError()
        if not re.fullmatch(r"[a-f0-9]{64}", source) or data["video_file"] != "motion.mp4":
            raise ValueError()
        file = directory / "motion.mp4"
        if file.is_symlink() or not file.is_file() or not 0 < file.stat().st_size <= 10 * 1024 * 1024:
            raise ValueError()
        encoded = file.read_bytes()
        if encoded[4:8] != b"ftyp" or hashlib.sha256(encoded).hexdigest() != data["video_sha256"]:
            raise ValueError()
        actual = probe_video(file)
        if any(type(data[k]) is not int or data[k] != value for k, value in actual.items()):
            raise ValueError()
        return data.copy()
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError):
        raise MotionAssetError("动作视频不符合约定") from None
