"""One OpenAI edit for a four-pose walking candidate; no automatic retry."""
from __future__ import annotations

import base64
from decimal import Decimal
import hashlib
from io import BytesIO
import json
from pathlib import Path

import httpx
from PIL import Image

from app.services.motion_atlas_provider import AtlasProviderError, MAX_ATLAS, _source

MODEL = "gpt-image-2.5-sunburst-2026-09-08"
ENDPOINT = "https://api.openai.com/v1/images/edits"
SIZE = "1024x1024"
QUALITY = "medium"
PROMPT = """Edit the provided reference character into a 2 by 2 animation contact sheet.
Preserve exactly its identity, face, distinctive features, colors, material and existing limbs.
Four equally sized 512 by 512 cells, reading top-left, top-right, bottom-left,
bottom-right. One complete character centered in each cell, same scale, fixed
camera, same front three-quarter direction and ground baseline, walking in place.
Frame 1: screen-left foot forward touching ground, screen-right foot back.
Frame 2: screen-left foot supports the body, screen-right foot passes forward lifted.
Frame 3: screen-right foot forward touching ground, screen-left foot back.
Frame 4: screen-right foot supports the body, screen-left foot passes forward lifted.
Use a small natural alternating arm swing and subtle body bob. Make the four
poses form a forward walk cycle, including the transition from frame 4 to frame 1.
Keep the body and all existing appendages inside each cell with clear empty margins.
Output actual transparent alpha around every character. Remove the reference
background. No ground plane, cast shadow, grid, dividers, text, frame numbers,
watermark or painted checkerboard. Do not draw new objects or extra limbs.
"""


def preflight(source: Path) -> dict:
    _, _, digest = _source(source)
    return {"model": MODEL, "endpoint": ENDPOINT, "source_sha256": digest,
            "prompt_sha256": hashlib.sha256(PROMPT.encode()).hexdigest(),
            "size": SIZE, "quality": QUALITY, "background": "transparent",
            "output_format": "png", "n": 1, "layout": "2x2", "activity": "walk",
            "billing": "metered_tokens", "api_cost_cap_supported": False}


def _usage(value: object) -> dict:
    """Persist only numeric billing fields, never arbitrary provider text."""
    if not isinstance(value, dict):
        return {}
    result = {}
    for name in ("input_tokens", "output_tokens", "total_tokens"):
        count = value.get(name)
        if type(count) is int and 0 <= count <= 100_000_000:
            result[name] = count
    details = value.get("input_tokens_details")
    if isinstance(details, dict):
        result["input_tokens_details"] = {
            k: v for k, v in details.items() if k in {"text_tokens", "image_tokens"}
            and type(v) is int and 0 <= v <= 100_000_000}
    return result


def estimated_cost_usd(usage: dict) -> str | None:
    details = usage.get("input_tokens_details", {})
    text, image = details.get("text_tokens"), details.get("image_tokens")
    output = usage.get("output_tokens")
    if any(type(v) is not int or v < 0 for v in (text, image, output)):
        return None
    if usage.get("input_tokens") != text + image:
        return None
    # Official standard Image API rates, verified 2026-09-28; not a bill.
    return str(Decimal(text * 5 + image * 8 + output * 30) / Decimal(1_000_000))


def inspect_sheet(raw: bytes) -> dict:
    """Basic file/alpha check only. Walking quality requires visual review."""
    try:
        with Image.open(BytesIO(raw)) as image:
            if image.format != "PNG" or image.size != (1024, 1024):
                raise AtlasProviderError("provider_image_invalid")
            image.load()
            alpha = image.convert("RGBA").getchannel("A")
            cells = []
            for y in (0, 512):
                for x in (0, 512):
                    histogram = alpha.crop((x, y, x + 512, y + 512)).histogram()
                    clear = sum(histogram[:33]) / (512 * 512)
                    visible = sum(histogram[33:]) / (512 * 512)
                    cells.append({"clear_fraction": round(clear, 6),
                                  "visible_fraction": round(visible, 6),
                                  "native_alpha": clear >= .01 and visible >= .05})
    except (OSError, ValueError, Image.DecompressionBombError):
        raise AtlasProviderError("provider_image_invalid") from None
    valid = all(cell["native_alpha"] for cell in cells)
    return {"state": "needs_review" if valid else "rejected",
            "human_review_required": True, "cells": cells,
            "issues": [] if valid else ["native_alpha_missing_or_empty_cell"]}


def generate(source: Path, key: str, *, expected_sha256: str,
             client: httpx.Client | None = None) -> tuple[bytes, dict]:
    if not key.strip() or any(c.isspace() for c in key):
        raise AtlasProviderError("provider_not_configured")
    raw, mime, digest = _source(source)
    if digest != expected_sha256:
        raise AtlasProviderError("source_changed_before_call")
    own_client = client is None
    try:
        if own_client:
            client = httpx.Client(timeout=httpx.Timeout(180, connect=10), follow_redirects=False)
        body = {"model": MODEL, "prompt": PROMPT, "size": SIZE, "quality": QUALITY,
                "n": "1", "background": "transparent", "output_format": "png"}
        with client.stream("POST", ENDPOINT, headers={"Authorization": f"Bearer {key}"},
                           data=body, files={"image[]": ("reference.png" if mime == "image/png"
                                                      else "reference.jpg", raw, mime)},
                           follow_redirects=False) as response:
            chunks, length = [], 0
            limit = MAX_ATLAS * 4 // 3 + 128 * 1024 if response.status_code == 200 else 64 * 1024
            for chunk in response.iter_bytes():
                length += len(chunk)
                if length > limit:
                    raise AtlasProviderError("provider_response_invalid")
                chunks.append(chunk)
            data = json.loads(b"".join(chunks))
            if response.status_code != 200:
                error = data.get("error", {}) if isinstance(data, dict) else {}
                code = error.get("code") if isinstance(error, dict) else None
                if code == "insufficient_quota":
                    reason = "provider_quota_exhausted"
                else:
                    reason = {401: "provider_authentication_failed", 403: "provider_access_denied",
                              429: "provider_rate_limited"}.get(response.status_code, "provider_request_failed")
                raise AtlasProviderError(reason)
        items = data.get("data") if isinstance(data, dict) else None
        if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
            raise AtlasProviderError("provider_response_invalid")
        encoded = items[0].get("b64_json")
        if not isinstance(encoded, str) or len(encoded) > MAX_ATLAS * 4 // 3 + 8:
            raise AtlasProviderError("provider_image_invalid")
        image = base64.b64decode(encoded, validate=True)
        if not 0 < len(image) <= MAX_ATLAS:
            raise AtlasProviderError("provider_image_invalid")
        inspect_sheet(image)
        return image, _usage(data.get("usage"))
    except AtlasProviderError:
        raise
    except (httpx.HTTPError, OSError, ValueError, TypeError):
        raise AtlasProviderError("provider_call_unknown") from None
    finally:
        if own_client and client is not None:
            client.close()
