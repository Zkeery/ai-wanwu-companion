"""Prepare a silent private video pack from an existing clip; dry-run by default."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.motion_assets import validate_motion_pack
from app.services.motion_video import VERSION, probe_video


def build(source: Path, video: Path, output: Path, *, activity: str | None = None, write=False):
    if activity is not None and activity not in ("rest", "walk", "observe"):
        raise ValueError("invalid activity")
    if any(p.is_symlink() or not p.is_file() or not 0 < p.stat().st_size <= 10 * 1024 * 1024 for p in (source, video)):
        raise ValueError("invalid input")
    if output.exists() or output.is_symlink():
        raise ValueError("output already exists")
    if not write:
        return {"state": "dry-run", "written": False}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".video-pack-", dir=output.parent))
    try:
        target = temporary / "motion.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", str(video.resolve()),
                        "-map", "0:v:0", "-c:v", "copy", "-an", "-map_metadata", "-1", "-movflags", "+faststart", str(target)],
                       check=True, capture_output=True, timeout=30)
        data = {"version": VERSION, "source_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "video_file": "motion.mp4", "video_sha256": hashlib.sha256(target.read_bytes()).hexdigest(), **probe_video(target)}
        if activity is not None:
            data["activity"] = activity
        (temporary / "manifest.json").write_text(json.dumps(data, indent=2) + "\n")
        validate_motion_pack(temporary, data["source_sha256"])
        temporary.rename(output)
        return {"state": "ready", "written": True, **data}
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser()
    for name in ("source", "video", "output"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--activity", choices=("rest", "walk", "observe"))
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(build(args.source, args.video, args.output, activity=args.activity, write=args.write)))
    except (OSError, ValueError, subprocess.SubprocessError):
        print(json.dumps({"error": {"code": "video_pack_invalid", "message": "视频素材或输出目录无法核对"}}, ensure_ascii=False))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
