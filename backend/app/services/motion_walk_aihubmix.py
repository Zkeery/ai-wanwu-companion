"""AIHubMix native reference edit with explicit transparent background support."""
from __future__ import annotations

import base64
import hashlib
from collections.abc import Callable
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

import httpx

from app.services.motion_atlas_provider import AtlasProviderError, MAX_ATLAS, _source
from app.services.motion_walk_openai import QUALITY, SIZE, _usage, inspect_sheet
from app.services.motion_activity_prompts import prompt_for
from app.services.motion_walk_openai import preflight as openai_preflight

MODEL = "gpt-image-2.5-sunburst"
ENDPOINT = "https://aihubmix.com/ai/v1/images/generations"


def preflight(source: Path, *, activity: str = 'walk') -> dict:
    prompt = prompt_for(activity)
    return {**openai_preflight(source), "activity": activity,
            "prompt_sha256": hashlib.sha256(prompt.encode()).hexdigest(), "model": MODEL, "endpoint": ENDPOINT,
            "billing": "aihubmix_metered", "model_snapshot_pinned": False}


def _read(response: httpx.Response, limit: int) -> bytes:
    chunks, total = [], 0
    for chunk in response.iter_bytes():
        total += len(chunk)
        if total > limit:
            raise AtlasProviderError("provider_response_invalid")
        chunks.append(chunk)
    return b"".join(chunks)


def _download_url(value: object, task_id: str) -> str:
    if not isinstance(value, str) or len(value) > 1024:
        raise AtlasProviderError("provider_image_url_invalid")
    url = urlsplit(value)
    if (url.scheme != "https" or url.netloc != "aihubmix.com" or url.query or url.fragment
            or not re.fullmatch(r"/ai/v1/images/" + re.escape(task_id) + r"/content/[A-Za-z0-9_-]+", url.path)):
        raise AtlasProviderError("provider_image_url_invalid")
    return value


def generate(source: Path, key: str, *, expected_sha256: str,
             activity: str = 'walk',
             client: httpx.Client | None = None, on_task: Callable[[str], None] | None = None
             ) -> tuple[bytes, dict]:
    prompt = prompt_for(activity)
    if not key.strip() or any(c.isspace() for c in key):
        raise AtlasProviderError("provider_not_configured")
    raw, mime, digest = _source(source)
    if digest != expected_sha256:
        raise AtlasProviderError("source_changed_before_call")
    own_client = client is None
    try:
        if own_client:
            client = httpx.Client(timeout=httpx.Timeout(180, connect=10), follow_redirects=False)
        headers = {"Authorization": f"Bearer {key}"}
        body = {"model": MODEL, "prompt": prompt, "image": f"data:{mime};base64," + base64.b64encode(raw).decode(),
                "size": SIZE, "n": 1, "output_format": "png", "async": False,
                "extra": {"quality": QUALITY, "background": "transparent"}}
        with client.stream("POST", ENDPOINT, headers=headers, json=body, follow_redirects=False) as response:
            payload = _read(response, MAX_ATLAS * 4 // 3 + 128 * 1024 if response.status_code == 200 else 65536)
            if response.status_code != 200:
                reason = {401: "provider_authentication_failed", 402: "provider_quota_exhausted",
                          403: "provider_access_denied", 429: "provider_rate_limited"}.get(
                              response.status_code, "provider_request_failed")
                if response.status_code == 403:
                    try:
                        failure = json.loads(payload)
                    except (ValueError, UnicodeError):
                        failure = None
                    error = failure.get("error") if isinstance(failure, dict) else None
                    if isinstance(error, dict) and error.get("code") == "async_not_enabled":
                        reason = "provider_async_not_enabled"
                raise AtlasProviderError(reason)
            data = json.loads(payload)
        if not isinstance(data, dict) or data.get("model") != MODEL:
            raise AtlasProviderError("provider_response_invalid")
        task_id = data.get("id")
        if not isinstance(task_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", task_id):
            raise AtlasProviderError("provider_response_invalid")
        if on_task:
            on_task(task_id)
        if data.get("status") != "completed" or data.get("error") is not None:
            raise AtlasProviderError("provider_task_not_completed")
        output = data.get("output")
        if (not isinstance(output, list) or len(output) != 1 or not isinstance(output[0], dict)
                or output[0].get("type") != "file" or type(output[0].get("index")) is not int
                or output[0]["index"] != 0):
            raise AtlasProviderError("provider_response_invalid")
        encoded = output[0].get("b64_json")
        if encoded is not None:
            if not isinstance(encoded, str) or not encoded or len(encoded) > MAX_ATLAS * 4 // 3 + 8:
                raise AtlasProviderError("provider_image_invalid")
            image = base64.b64decode(encoded, validate=True)
        else:
            url = _download_url(output[0].get("content_url"), task_id)
            with client.stream("GET", url, headers=headers, follow_redirects=False) as response:
                if response.status_code != 200:
                    raise AtlasProviderError("provider_image_unavailable")
                image = _read(response, MAX_ATLAS)
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
