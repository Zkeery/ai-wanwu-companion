"""One metered edit of the archived apple. Default: offline preflight only."""
from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
import os
from pathlib import Path
import time

from dotenv import dotenv_values

from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_walk_openai import generate, preflight, inspect_sheet, estimated_cost_usd
from app.services.motion_walk_aihubmix import generate as generate_aihubmix, preflight as preflight_aihubmix
from scripts.generate_character_atlas import _receipt

PROJECT = Path(__file__).resolve().parents[2]
SOURCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg"
SOURCE_SHA256 = "7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c"


def _key() -> str:
    # Never fall back to global environment or another project's credentials.
    value = dotenv_values(PROJECT / ".env").get("OPENAI_API_KEY")
    return value if isinstance(value, str) else ""


def _aihubmix_key() -> str:
    value = dotenv_values(PROJECT / ".env", interpolate=False).get("AIHUBMIX_API_KEY")
    return value if isinstance(value, str) else ""


def run(*, apply=False, approval_ref="", price_verified_on="", accept_metered_cost=False,
        ledger_dir: Path | None = None, provider=None, provider_kind="openai") -> dict:
    if provider_kind not in {"openai", "aihubmix"}:
        raise AtlasProviderError("provider_configuration_invalid")
    selected_preflight = preflight_aihubmix if provider_kind == "aihubmix" else preflight
    plan = selected_preflight(SOURCE)
    if plan["source_sha256"] != SOURCE_SHA256:
        raise AtlasProviderError("source_not_approved")
    if not apply:
        return {**plan, "state": "dry-run", "written": False, "generation_requests": 0}
    if (not approval_ref.strip() or len(approval_ref) > 128 or not accept_metered_cost
            or price_verified_on != date.today().isoformat()):
        raise AtlasProviderError("approval_invalid")
    key = _aihubmix_key() if provider_kind == "aihubmix" else _key()
    if not key.strip():
        raise AtlasProviderError("provider_not_configured")
    root = (ledger_dir or PROJECT / ".runtime" / (
        "c155-aihubmix-walk" if provider_kind == "aihubmix" else "c154-sunburst-walk")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(approval_ref.encode()).hexdigest()
    record = root / f"approval-{digest}.json"
    candidate = root / f"walk-{digest}.png"
    value = {**plan, "provider": provider_kind, "state": "reserved", "request_limit": 1,
             "price_verified_on": price_verified_on, "accept_metered_cost": True,
             "actual_bill_verified": False}
    try:
        _receipt(record, value, first=True)
    except FileExistsError:
        raise AtlasProviderError("approval_already_used") from None
    value["state"] = "attempted"
    _receipt(record, value)
    started = time.monotonic()
    try:
        if provider_kind == "aihubmix":
            def save_task(task_id: str) -> None:
                value["provider_task_id"] = task_id
                _receipt(record, value)
            image, usage = (provider or generate_aihubmix)(
                SOURCE, key, expected_sha256=SOURCE_SHA256, on_task=save_task)
        else:
            image, usage = (provider or generate)(SOURCE, key, expected_sha256=SOURCE_SHA256)
        # Retain returned bytes for review even if later validation fails.
        with candidate.open("xb") as file:
            file.write(image)
            file.flush()
            os.fsync(file.fileno())
        value.update(candidate_file=candidate.name, image_sha256=hashlib.sha256(image).hexdigest(),
                     usage=usage, estimated_cost_usd=(
                         estimated_cost_usd(usage) if provider_kind == "openai" else None))
        quality = inspect_sheet(image)
        if preflight(SOURCE)["source_sha256"] != SOURCE_SHA256:
            raise AtlasProviderError("source_changed_after_call")
        value.update(state=quality["state"], quality_check=quality,
                     elapsed_ms=round((time.monotonic() - started) * 1000))
        _receipt(record, value)
        return {**value, "receipt": str(record), "candidate": str(candidate)}
    except Exception as exc:
        value.update(state="unknown", elapsed_ms=round((time.monotonic() - started) * 1000),
                     error_code=exc.code if isinstance(exc, AtlasProviderError) else "candidate_unavailable")
        _receipt(record, value)
        raise AtlasProviderError(value["error_code"]) from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--provider", choices=("openai", "aihubmix"), default="openai")
    parser.add_argument("--approval-ref", default="")
    parser.add_argument("--price-verified-on", default="")
    parser.add_argument("--accept-metered-cost", action="store_true")
    args = parser.parse_args()
    try:
        result = run(apply=args.execute, approval_ref=args.approval_ref,
                     price_verified_on=args.price_verified_on,
                     accept_metered_cost=args.accept_metered_cost, provider_kind=args.provider)
    except AtlasProviderError as exc:
        parser.exit(2, json.dumps({"error": {"code": exc.code, "message": exc.code}}) + "\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
