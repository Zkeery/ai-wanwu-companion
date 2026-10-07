"""C1.47: one reviewed-budget provider attempt for one owned character."""
from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import tempfile

from app.api.wall import image_file
from app.core.config import BASE_DIR, get_settings
from app.core.database import SessionLocal
from app.services.motion_atlas_provider import AtlasProviderError, generate, preflight
from app.services.motion_atlas_ark import generate as generate_ark, preflight as preflight_ark
from app.services.motion_atlas_quality import inspect_atlas
from app.services.motion_bindings import MotionBindingError, owned_character

UNIT_CEILING_CNY = Decimal("0.20")  # Qwen Image 3 standard, Beijing 1K input + output.
ARK_UNIT_CEILING_CNY = Decimal("0.12")  # Seedream 5.0 Flash, Beijing, one output.


def _project_ark_key() -> str:
    """Read only this project's existing credential, never a sibling project."""
    file = BASE_DIR.parent / ".env"
    if not file.is_file():
        return ""
    for line in file.read_text().splitlines():
        if line.startswith("ARK_API_KEY="):
            value = line.partition("=")[2].strip().strip('"').strip("'")
            return value if value and not any(char.isspace() for char in value) else ""
    return ""


def _receipt(path: Path, value: dict, *, first=False) -> None:
    encoded = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
    if first:
        with path.open("xb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        return
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".receipt-", delete=False) as file:
        temp = Path(file.name)
        file.write(encoded)
        file.flush()
        os.fsync(file.fileno())
    temp.replace(path)


def run(cid: int, owner: str, *, apply=False, approval_ref: str = "",
        price_verified_on: str = "", max_budget_cny: str = "0",
        ledger_dir: Path | None = None, provider=None, provider_kind: str = "qwen") -> dict:
    if provider_kind not in {"qwen", "ark"}:
        raise AtlasProviderError("provider_configuration_invalid")
    settings = get_settings()
    with SessionLocal() as db:
        ch = owned_character(db, cid, owner)
        source = image_file(ch)
        if source is None:
            raise MotionBindingError("motion_source_changed")
        original_path = ch.image_path
        if provider_kind == "ark":
            plan = preflight_ark(source)
            key = ""  # Dry-run must not read the credential.
            unit_ceiling = ARK_UNIT_CEILING_CNY
            chosen_provider = provider or generate_ark
        else:
            if not settings.motion_atlas_base_url:
                raise AtlasProviderError("provider_not_configured")
            plan = preflight(source, settings.motion_atlas_base_url)
            key = settings.motion_atlas_api_key
            unit_ceiling = UNIT_CEILING_CNY
            chosen_provider = provider or generate
    if not apply:
        return {**plan, "character_id": cid, "state": "dry-run", "written": False,
                "unit_ceiling_cny": str(unit_ceiling)}
    try:
        budget = Decimal(max_budget_cny)
    except InvalidOperation:
        raise AtlasProviderError("approval_invalid") from None
    if provider_kind == "ark":
        key = _project_ark_key()
    if (not approval_ref.strip() or len(approval_ref) > 128 or budget != unit_ceiling
            or price_verified_on != date.today().isoformat()
            or not key.strip()):
        raise AtlasProviderError("approval_invalid")
    if (provider_kind == "qwen" and ".cn-beijing.maas.aliyuncs.com" not in settings.motion_atlas_base_url.lower()
            and "dashscope.aliyuncs.com" not in settings.motion_atlas_base_url.lower()):
        raise AtlasProviderError("price_region_unverified")
    root = (ledger_dir or BASE_DIR.parent / ".runtime" /
            ("c148-atlas" if provider_kind == "ark" else "c147-atlas")).resolve()
    root.mkdir(parents=True, exist_ok=True)
    ref_hash = hashlib.sha256(approval_ref.encode()).hexdigest()
    record = root / f"approval-{ref_hash}.json"
    value = {"character_id": cid, "owner_id": owner, "source_image_path": original_path,
             "source_sha256": plan["source_sha256"], "prompt_sha256": plan["prompt_sha256"],
             "provider": provider_kind, "model": plan["model"], "budget_ceiling_cny": str(budget),
             "price_verified_on": price_verified_on, "state": "reserved"}
    if provider_kind == "ark":
        value.update(background=plan["background"], output_format=plan["output_format"])
    try:
        _receipt(record, value, first=True)
    except FileExistsError:
        raise AtlasProviderError("approval_already_used") from None
    # Any crash after this point leaves a durable uncertain attempt. Never auto-repeat.
    value["state"] = "attempted"
    _receipt(record, value)
    try:
        if provider_kind == "ark":
            atlas = chosen_provider(source, key, expected_sha256=plan["source_sha256"])
        else:
            atlas = chosen_provider(source, settings.motion_atlas_base_url, key,
                                    expected_sha256=plan["source_sha256"])
        with SessionLocal() as db:
            ch = owned_character(db, cid, owner)
            current = image_file(ch)
            if (ch.image_path != original_path or current is None
                    or hashlib.sha256(current.read_bytes()).hexdigest() != plan["source_sha256"]):
                raise AtlasProviderError("source_changed_after_call")
        candidate = root / f"character-{cid}-{plan['source_sha256'][:16]}-{ref_hash[:16]}.png"
        with candidate.open("xb") as file:
            file.write(atlas)
            file.flush()
            os.fsync(file.fileno())
        quality = inspect_atlas(candidate, expected_background=(
            "transparent" if plan.get("background") == "transparent" else None))
        value.update(state=quality["state"], candidate_file=candidate.name,
                     atlas_sha256=hashlib.sha256(atlas).hexdigest(), quality_check=quality)
        _receipt(record, value)
        return {"character_id": cid, "state": value["state"], "candidate": str(candidate),
                "atlas_sha256": value["atlas_sha256"], "receipt": str(record), "quality_check": quality}
    except Exception as exc:
        value.update(state="unknown", error_code=exc.code if isinstance(exc, AtlasProviderError)
                     else "candidate_unavailable")
        _receipt(record, value)
        if isinstance(exc, AtlasProviderError):
            raise
        raise AtlasProviderError("candidate_unavailable") from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--character-id", type=int, required=True)
    parser.add_argument("--owner-id", required=True)
    parser.add_argument("--provider", choices=("qwen", "ark"), default="qwen")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--approval-ref", default="")
    parser.add_argument("--price-verified-on", default="")
    parser.add_argument("--max-budget-cny", default="0")
    args = parser.parse_args()
    try:
        result = run(args.character_id, args.owner_id, apply=args.execute,
                     approval_ref=args.approval_ref, price_verified_on=args.price_verified_on,
                     max_budget_cny=args.max_budget_cny, provider_kind=args.provider)
    except (MotionBindingError, AtlasProviderError) as exc:
        parser.exit(2, f"{getattr(exc, 'code', 'unavailable')}\n")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))


if __name__ == "__main__":
    main()
