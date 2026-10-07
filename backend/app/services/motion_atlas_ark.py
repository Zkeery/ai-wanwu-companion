"""Single Seedream Flash reference edit for an unreviewed atlas candidate."""
from __future__ import annotations

import base64
import hashlib
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

from app.services.motion_atlas import atlas_prompt
from app.services.motion_atlas_provider import AtlasProviderError, MAX_ATLAS, _source

MODEL = "doubao-seedream-5-0-flash-260915"
ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations"


def _background_mode(raw: bytes, mime: str) -> str:
    if mime != "image/png":
        return "opaque"
    try:
        with Image.open(BytesIO(raw)) as image:
            histogram = image.convert("RGBA").getchannel("A").histogram()
            area = image.width * image.height
    except (OSError, ValueError, Image.DecompressionBombError):
        raise AtlasProviderError("source_invalid") from None
    # An RGBA container or one cleared pixel does not establish a transparent source.
    clear = sum(histogram[:33])
    visible = sum(histogram[33:])
    if visible < area * .05:
        raise AtlasProviderError("source_invalid")
    return "transparent" if clear >= area * .01 else "opaque"


def preflight(source: Path) -> dict:
    raw, mime, digest = _source(source)
    background = _background_mode(raw, mime)
    return {"model": MODEL, "size": "1536x864", "source_sha256": digest,
            "background": background, "output_format": "png",
            "prompt_sha256": hashlib.sha256(atlas_prompt(background=background).encode()).hexdigest()}


def generate(source: Path, key: str, *, expected_sha256: str | None = None,
             client: httpx.Client | None = None) -> bytes:
    if not key.strip():
        raise AtlasProviderError("provider_not_configured")
    raw, mime, digest = _source(source)
    if expected_sha256 is not None and digest != expected_sha256:
        raise AtlasProviderError("source_changed_before_call")
    background = _background_mode(raw, mime)
    body = {"model": MODEL, "prompt": atlas_prompt(background=background),
            "image": f"data:{mime};base64," + base64.b64encode(raw).decode("ascii"),
            "size": "1536x864", "response_format": "b64_json", "watermark": False,
            "background": background, "output_format": "png"}
    own_client = client is None
    if own_client:
        client = httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False)
    try:
        try:
            response = client.post(ENDPOINT, headers={"Authorization": f"Bearer {key}"}, json=body)
            if response.status_code != 200 or len(response.content) > MAX_ATLAS * 4 // 3 + 128 * 1024:
                raise AtlasProviderError("provider_response_invalid")
            data = response.json()
            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
                raise AtlasProviderError("provider_response_invalid")
            encoded = items[0].get("b64_json")
            if not isinstance(encoded, str) or len(encoded) > MAX_ATLAS * 4 // 3 + 8:
                raise AtlasProviderError("provider_image_invalid")
            image_bytes = base64.b64decode(encoded, validate=True)
            if not 0 < len(image_bytes) <= MAX_ATLAS:
                raise AtlasProviderError("provider_image_invalid")
            with Image.open(BytesIO(image_bytes)) as image:
                if (image.format not in {"PNG", "JPEG", "WEBP"}
                        or not 1024 <= image.width <= 4096 or not 576 <= image.height <= 2304
                        or abs(image.width * 9 - image.height * 16) > 8):
                    raise AtlasProviderError("provider_image_invalid")
                image.load()
                output = BytesIO()
                image.convert("RGBA").save(output, format="PNG")
            atlas = output.getvalue()
            if len(atlas) > MAX_ATLAS:
                raise AtlasProviderError("provider_image_invalid")
            return atlas
        except (httpx.HTTPError, OSError, ValueError, Image.DecompressionBombError) as exc:
            if isinstance(exc, AtlasProviderError):
                raise
            raise AtlasProviderError("provider_call_unknown") from None
    finally:
        if own_client:
            client.close()
