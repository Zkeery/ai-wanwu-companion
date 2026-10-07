"""Turn one reviewed reference-conditioned 4x3 atlas into three activity packs."""
import hashlib
import json
import shutil
import tempfile
import time
from pathlib import Path

from PIL import Image

from app.services.motion_atlas_quality import inspect_image
from app.services.motion_sheet import MotionSheetError, _checked_file, _foreground, _write_pack

ACTIVITIES = ("rest", "walk", "observe")


def atlas_prompt(*, background: str = "opaque") -> str:
    """Source-neutral instructions; identity comes from the actual reference."""
    if background not in {"opaque", "transparent"}:
        raise ValueError("invalid atlas background")
    backdrop = (
        "Keep genuine transparent alpha around every character, preserving the transparent input. "
        "Do not paint any background color. "
        if background == "transparent" else
        "Use one perfectly uniform solid neutral gray #808080 background over the whole atlas. "
    )
    return (
        "Use the attached image as the sole character identity reference. Create one animation atlas, "
        "exactly 4 columns and 3 rows, 1536x864 pixels, each cell 384x288. No borders, gutters, text, "
        "watermark, props or extra characters. Preserve the same face, body, materials, colors and style. "
        "Full body centered at the same scale in every cell; identical fixed camera and lighting. "
        "Leave at least 8 percent clear margins around all limbs in each cell. "
        + backdrop +
        "Never draw a transparency checkerboard, grid lines, separators, floor, shadow or vignette. "
        "The cell grid is an invisible placement guide, not a visible drawing. "
        "Row 1 rest: neutral; relaxed arms and half-closed eyes; eyes fully closed in peaceful rest; "
        "reopen eyes toward neutral. Row 2 walk: screen-left and screen-right always mean the viewer's "
        "sides of the image, not anatomical left/right. Column 1: screen-left foot reaches forward, "
        "screen-right foot behind. Column 2: weight on screen-left foot, screen-right foot passes "
        "under the body. Column 3: screen-right foot reaches forward, screen-left foot behind. "
        "Column 4: weight on screen-right foot, screen-left foot passes under the body. "
        "Columns 1 and 3 must clearly show opposite feet forward; do not repeat the same lifted foot. "
        "Use opposite arm swings and clear alternating steps, with feet visibly separated. "
        "Keep the body facing the camera in all four columns, not a whole-image translation. "
        "Row 3 observe: neutral; turn head and eyes toward screen right; keep looking right and point "
        "right; retract arm and return face and eyes toward the camera. "
        "Never show the back of the head or body. Rest and observe return gently toward their "
        "first pose; walk repeats its four forward phases without reversing or pausing. "
        "Do not invent an observation target."
    )


def build_motion_atlas(source: Path, atlas: Path, output: Path, *, write=False) -> dict:
    started = time.perf_counter()
    source, atlas, output = Path(source), Path(atlas), Path(output)
    _checked_file(source)
    _checked_file(atlas)
    if output.exists() or output.is_symlink() or any(p.is_symlink() for p in output.absolute().parents):
        raise MotionSheetError("output unavailable")
    try:
        with Image.open(source) as original:
            if (original.format not in ("JPEG", "PNG") or not 256 <= original.width <= 4096
                    or not 192 <= original.height <= 4096 or original.width * original.height > 16_000_000):
                raise MotionSheetError("invalid source")
            original.verify()
        source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
        atlas_hash = hashlib.sha256(atlas.read_bytes()).hexdigest()
        with Image.open(atlas) as opened:
            if (opened.format != "PNG"
                    or not 1024 <= opened.width <= 4096 or not 576 <= opened.height <= 2304
                    or abs(opened.width * 9 - opened.height * 16) > 8):
                raise MotionSheetError("expected 4x3 atlas with 4:3 cells")
            opened.load()
            quality = inspect_image(opened)
            if quality["state"] == "rejected":
                raise MotionSheetError("atlas quality rejected: " + quality["issues"][0]["code"])
            # Image editors may round the requested aspect to an integer pixel.
            # Partition all pixels once; never silently crop the last row.
            xs = [round(i * opened.width / 4) for i in range(5)]
            ys = [round(i * opened.height / 3) for i in range(4)]
            rgba = opened.convert("RGBA")
            rows = []
            for row in range(3):
                poses = [rgba.crop((xs[column], ys[row], xs[column + 1], ys[row + 1])) for column in range(4)]
                rows.append([_foreground(pose) for pose in poses])
    except (OSError, Image.DecompressionBombError) as exc:
        raise MotionSheetError("invalid image input") from exc
    result = {"state": "dry-run", "written": False, "source_sha256": source_hash,
              "atlas_sha256": atlas_hash, "activities": list(ACTIVITIES),
              "layout": {"columns": 4, "rows": 3}, "quality": "requires_review",
              "quality_check": quality}
    if not write:
        return result
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".atlas-pack-", dir=output.parent))
    try:
        packs = {}
        for activity, processed in zip(ACTIVITIES, rows):
            _write_pack(source_hash, processed, temporary / activity, activity)
            packs[activity] = hashlib.sha256((temporary / activity / "manifest.json").read_bytes()).hexdigest()
        # Both input identities must still match before publishing any pack.
        if (source.is_symlink() or atlas.is_symlink() or hashlib.sha256(source.read_bytes()).hexdigest() != source_hash
                or hashlib.sha256(atlas.read_bytes()).hexdigest() != atlas_hash):
            raise MotionSheetError("input changed during preparation")
        result.update(state="candidate", written=True, packs=packs,
                      local_pack_ms=round((time.perf_counter() - started) * 1000))
        (temporary / "atlas.json").write_text(json.dumps(result, indent=2) + "\n")
        temporary.rename(output)
        return result
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
