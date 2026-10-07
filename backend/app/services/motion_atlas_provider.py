"""One-shot Qwen Image 3 reference edit. Never retry an uncertain billable call."""
from __future__ import annotations

import base64
import hashlib
from io import BytesIO
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from PIL import Image

from app.services.motion_atlas import atlas_prompt

MODEL = "qwen-image-3.0"
MAX_SOURCE = 10 * 1024 * 1024
MAX_ATLAS = 20 * 1024 * 1024


class AtlasProviderError(ValueError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _endpoint(base_url: str) -> str:
    url = urlsplit(base_url)
    host = (url.hostname or "").lower()
    if (url.scheme != "https" or url.username or url.password or url.query or url.fragment
            or url.port not in (None, 443)
            or not (host == "dashscope.aliyuncs.com" or host.endswith(".maas.aliyuncs.com"))
            or url.path.rstrip("/") != "/compatible-mode/v1"):
        raise AtlasProviderError("provider_configuration_invalid")
    return base_url.rstrip("/") + "/images/generations"


def _source(path: Path) -> tuple[bytes, str, str]:
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_SOURCE:
        raise AtlasProviderError("source_invalid")
    raw = path.read_bytes()
    try:
        with Image.open(BytesIO(raw)) as image:
            if (image.format not in {"PNG", "JPEG"} or not 384 <= image.width <= 2048
                    or not 384 <= image.height <= 2048):
                raise AtlasProviderError("source_invalid")
            mime = "image/png" if image.format == "PNG" else "image/jpeg"
            image.verify()
    except (OSError, Image.DecompressionBombError) as exc:
        raise AtlasProviderError("source_invalid") from exc
    return raw, mime, hashlib.sha256(raw).hexdigest()


def preflight(source: Path, base_url: str) -> dict:
    _endpoint(base_url)
    _, _, digest = _source(source)
    return {"model": MODEL, "size": "1536x864", "source_sha256": digest,
            "prompt_sha256": hashlib.sha256(atlas_prompt().encode()).hexdigest()}


def generate(source: Path, base_url: str, key: str, *, expected_sha256: str | None = None,
             client: httpx.Client | None = None) -> bytes:
    endpoint = _endpoint(base_url)
    if not key.strip():
        raise AtlasProviderError("provider_not_configured")
    raw, mime, digest = _source(source)
    if expected_sha256 is not None and digest != expected_sha256:
        raise AtlasProviderError("source_changed_before_call")
    body = {"model": MODEL, "prompt": atlas_prompt(),
            "image": f"data:{mime};base64," + base64.b64encode(raw).decode("ascii"),
            "size": "1536x864", "n": 1, "response_format": "url", "prompt_extend": False}
    own_client = client is None
    if own_client:
        client = httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False)
    try:
        try:
            response = client.post(endpoint, headers={"Authorization": f"Bearer {key}"}, json=body)
            if response.status_code != 200 or len(response.content) > 64 * 1024:
                raise AtlasProviderError("provider_response_invalid")
            data = response.json()
            items = data.get("data") if isinstance(data, dict) else None
            if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
                raise AtlasProviderError("provider_response_invalid")
            image_url = items[0].get("url")
            parsed = urlsplit(image_url) if isinstance(image_url, str) else None
            host = (parsed.hostname or "").lower() if parsed else ""
            if (not parsed or len(image_url) > 4096 or parsed.scheme != "https"
                    or parsed.username or parsed.password or parsed.port not in (None, 443)
                    or not host.endswith(".aliyuncs.com")):
                raise AtlasProviderError("provider_image_url_invalid")
            with client.stream("GET", image_url) as download:
                if download.status_code != 200:
                    raise AtlasProviderError("provider_image_unavailable")
                chunks, total = [], 0
                for chunk in download.iter_bytes():
                    total += len(chunk)
                    if total > MAX_ATLAS:
                        raise AtlasProviderError("provider_image_invalid")
                    chunks.append(chunk)
            atlas = b"".join(chunks)
            with Image.open(BytesIO(atlas)) as image:
                if (image.format != "PNG" or not 1024 <= image.width <= 4096
                        or not 576 <= image.height <= 2304
                        or abs(image.width * 9 - image.height * 16) > 8):
                    raise AtlasProviderError("provider_image_invalid")
                image.verify()
            return atlas
        except (httpx.HTTPError, OSError, ValueError, Image.DecompressionBombError) as exc:
            if isinstance(exc, AtlasProviderError):
                raise
            raise AtlasProviderError("provider_call_unknown") from None
    finally:
        if own_client:
            client.close()
