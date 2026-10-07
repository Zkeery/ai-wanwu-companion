"""Conservative, offline atlas checks. Passing still requires human review."""
import hashlib
from pathlib import Path

import numpy as np
from PIL import Image

from app.services.motion_sheet import MotionSheetError, _checked_file, _foreground

ACTIVITIES = ("rest", "walk", "observe")


def inspect_image(image: Image.Image, *, expected_background: str | None = None) -> dict:
    if expected_background not in {None, "transparent"}:
        raise MotionSheetError("invalid expected background")
    if (not 1024 <= image.width <= 4096 or not 576 <= image.height <= 2304
            or abs(image.width * 9 - image.height * 16) > 8):
        raise MotionSheetError("expected 4x3 atlas with 4:3 cells")
    image = image.convert("RGBA")
    xs = [round(i * image.width / 4) for i in range(5)]
    ys = [round(i * image.height / 3) for i in range(4)]
    cells, issues = [], []
    for row, activity in enumerate(ACTIVITIES):
        hashes = []
        for column in range(4):
            tile = image.crop((xs[column], ys[row], xs[column + 1], ys[row + 1]))
            pixels = np.asarray(tile)
            alpha = pixels[:, :, 3]
            margin = max(4, min(tile.size) // 25)
            border = np.zeros(alpha.shape, dtype=bool)
            border[:margin] = border[-margin:] = True
            border[:, :margin] = border[:, -margin:] = True
            reasons = []
            if np.any(alpha < 255):
                background = "alpha"
                coverage = float(np.count_nonzero(alpha > 32) / alpha.size)
                if np.any(alpha[border] > 32) or not .08 <= coverage <= .6:
                    reasons.append("invalid_alpha_margin_or_coverage")
            else:
                background = "opaque"
                if expected_background == "transparent":
                    reasons.append("native_transparency_missing")
                samples = pixels[:, :, :3][border].astype(np.int16)
                center = np.median(samples, axis=0)
                deviation = float(np.percentile(np.max(np.abs(samples - center), axis=1), 99))
                if np.max(np.abs(center - 128)) > 16 or deviation > 12:
                    reasons.append("background_not_uniform_gray")
            if not reasons:
                try:
                    _foreground(tile)
                except MotionSheetError:
                    reasons.append("foreground_invalid")
            # Hidden RGB under zero alpha must not manufacture distinct poses.
            visible = pixels.copy()
            visible[alpha == 0, :3] = 0
            hashes.append(hashlib.sha256(visible.tobytes()).hexdigest())
            cells.append({"activity": activity, "column": column + 1,
                          "background": background, "issues": reasons})
            issues.extend({"activity": activity, "column": column + 1, "code": reason}
                          for reason in reasons)
        if len(set(hashes)) == 1:
            issues.append({"activity": activity, "code": "all_four_poses_identical"})
    return {"version": 1, "state": "rejected" if issues else "needs_review",
            "expected_background": expected_background,
            "human_review_required": True, "cells": cells, "issues": issues,
            "manual_checks": ["character_identity", "watermark_or_text", "anatomy",
                              "walk_steps", "observe_front_view", "natural_loop"]}


def inspect_atlas(path: Path, *, expected_background: str | None = None) -> dict:
    path = Path(path)
    _checked_file(path)
    try:
        with Image.open(path) as image:
            if image.format != "PNG":
                raise MotionSheetError("expected PNG atlas")
            result = inspect_image(image, expected_background=expected_background)
    except (OSError, Image.DecompressionBombError) as exc:
        raise MotionSheetError("invalid atlas image") from exc
    return {**result, "atlas_sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
