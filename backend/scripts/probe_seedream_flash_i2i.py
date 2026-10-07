"""R7.8/R7.9 Seedream Flash isolated photo-edit probe; dry-run by default."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
from decimal import Decimal
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import time
from typing import Callable
from zoneinfo import ZoneInfo

import httpx
from PIL import Image

from probe_qwen_image_3_i2i import EVIDENCE as SOURCE_EVIDENCE
from probe_qwen_image_3_i2i import PROMPTS, load_plan as load_source_plan


PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.8Seedream隔离小样"
PLAN = EVIDENCE / "plan.json"
MODEL = "doubao-seedream-5-0-flash-260915"
ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/images/generations"
ORDER = ("cup", "apple", "plant", "multi") * 2
MAX_BYTES = 20 * 1024 * 1024
KEY_FILE = PROJECT / ".env"
UNIT_RESERVE = Decimal("0.12")
CEILING = Decimal("1.20")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def now_local() -> datetime:
    return datetime.now(ZoneInfo("Asia/Shanghai"))


def load_project_key() -> str:
    if not KEY_FILE.exists():
        raise ValueError("Project ARK_API_KEY is not configured")
    for line in KEY_FILE.read_text().splitlines():
        if line.startswith("ARK_API_KEY="):
            value = line.partition("=")[2].strip().strip('"').strip("'")
            if value and not any(char.isspace() for char in value):
                return value
    raise ValueError("Project ARK_API_KEY is not configured")


def real_preflight(approved: Decimal, verified_on: str, verified_price: Decimal,
                   key: str, at: datetime | None = None) -> None:
    at = at or now_local()
    if approved != CEILING or verified_on != at.date().isoformat() or verified_price != UNIT_RESERVE:
        raise ValueError("New budget approval and same-day frozen price are required")
    if not key or any(char.isspace() for char in key):
        raise ValueError("Project ARK_API_KEY is not configured")


def load_frozen_plan() -> tuple[dict, dict[str, bytes]]:
    sources, _ = load_source_plan()
    plan = json.loads(PLAN.read_text())
    expected = {
        "protocol_id": "r78-seedream-flash-i2i-offline-v1",
        "model": MODEL,
        "endpoint": ENDPOINT,
        "order": list(ORDER),
        "source_manifest_sha256": sha256((SOURCE_EVIDENCE / "sources.json").read_bytes()),
        "prompt_sha256": {key: sha256(value.encode()) for key, value in PROMPTS.items()},
        "size": "1024x1024",
        "response_format": "b64_json",
        "quoted_output_price_cny": "0.12",
        "quoted_input_price_cny": "0.00",
        "price_checked_on": "2026-09-25",
        "estimated_max_cny": "0.96",
        "proposed_ceiling_cny": "1.20",
        "approved_budget_cny": None,
        "default_real_requests_enabled": False,
    }
    if plan != expected:
        raise ValueError("Frozen offline plan differs from source or script")
    photos = {item["id"]: (SOURCE_EVIDENCE / item["file"]).read_bytes() for item in sources["inputs"]}
    return plan, photos


def request_body(photo: bytes, case_id: str) -> dict:
    if case_id not in PROMPTS:
        raise ValueError("Unknown case")
    return {
        "model": MODEL,
        "prompt": PROMPTS[case_id],
        "image": "data:image/jpeg;base64," + base64.b64encode(photo).decode("ascii"),
        "size": "1024x1024",
        "response_format": "b64_json",
    }


def mock_image() -> bytes:
    image = Image.new("RGB", (1024, 1024), "#9bd5c8")
    stream = BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def mock_transport(request: httpx.Request) -> httpx.Response:
    if request.method != "POST" or str(request.url) != ENDPOINT or request.headers.get("authorization"):
        return httpx.Response(400, json={"error": {"code": "mock_request_rejected", "message": "Invalid offline request"}})
    body = json.loads(request.content)
    if (set(body) != {"model", "prompt", "image", "size", "response_format"}
            or body["model"] != MODEL or body["size"] != "1024x1024"
            or body["response_format"] != "b64_json"
            or not body["image"].startswith("data:image/jpeg;base64,")):
        return httpx.Response(400, json={"error": {"code": "mock_schema_rejected", "message": "Invalid offline request"}})
    return httpx.Response(200, json={"data": [{"b64_json": base64.b64encode(mock_image()).decode("ascii")}], "model": MODEL})


def response_shape(response_data: dict) -> dict:
    items = response_data.get("data")
    first = items[0] if isinstance(items, list) and items else None
    return {
        "data_is_list": isinstance(items, list),
        "data_count": len(items) if isinstance(items, list) else None,
        "first_is_object": isinstance(first, dict),
        "first_has_b64_json": isinstance(first, dict) and isinstance(first.get("b64_json"), str),
        "first_has_url": isinstance(first, dict) and isinstance(first.get("url"), str),
    }


def image_bytes(response_data: dict) -> tuple[bytes, str]:
    items = response_data.get("data")
    first = items[0] if isinstance(items, list) and items else None
    if not isinstance(items, list) or len(items) != 1 or not isinstance(first, dict):
        raise ValueError("Expected exactly one output image")
    encoded = first.get("b64_json")
    if not isinstance(encoded, str) or len(encoded) > MAX_BYTES * 4 // 3 + 8:
        raise ValueError("Missing or oversized image data")
    raw = base64.b64decode(encoded, validate=True)
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Invalid image size")
    with Image.open(BytesIO(raw)) as image:
        if image.format not in {"JPEG", "PNG", "WEBP"} or image.size != (1024, 1024):
            raise ValueError("Invalid output image format or dimensions")
        image.verify()
        suffix = {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}[image.format]
    return raw, suffix


def run_offline(output: Path, handler: Callable[[httpx.Request], httpx.Response] = mock_transport) -> dict:
    plan, photos = load_frozen_plan()
    output = output.resolve()
    if output.parent != EVIDENCE.resolve() or output.exists():
        raise ValueError("Output must be a new direct child of R7.8 evidence")
    output.mkdir()
    report_path = output / "results.json"
    report = {
        "protocol_id": plan["protocol_id"], "model": MODEL,
        "mock": True, "network_requests": 0, "billable_requests": 0,
        "real_requests_enabled": False, "release_passed": False,
        "quality": "NOT_TESTED", "browser_e2e_latency": "NOT_TESTED",
        "status": "running", "calls": [],
        "source_manifest_sha256": plan["source_manifest_sha256"],
        "script_sha256": sha256(Path(__file__).read_bytes()),
    }
    write_json(report_path, report)
    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
        for index, case_id in enumerate(ORDER, 1):
            row = {
                "sample_id": f"r78-{index:02}", "case_id": case_id,
                "repeat": 1 if index <= 4 else 2,
                "input_sha256": sha256(photos[case_id]),
                "prompt_sha256": sha256(PROMPTS[case_id].encode()),
                "status": "started", "mock": True,
            }
            report["calls"].append(row)
            write_json(report_path, report)
            stage = "request_body"
            try:
                body = request_body(photos[case_id], case_id)
                stage = "mock_post"
                response = client.post(ENDPOINT, json=body)
                row["http_status"] = response.status_code
                response.raise_for_status()
                stage = "response_shape"
                data = response.json()
                if not isinstance(data, dict):
                    raise ValueError("Invalid response object")
                row["response_shape"] = response_shape(data)
                stage = "image_payload"
                raw, suffix = image_bytes(data)
                stage = "save"
                filename = f"mock-r78-{index:02}.{suffix}"
                (output / filename).write_bytes(raw)
                row.update({"status": "offline_fixture_valid", "artifact": filename, "output_sha256": sha256(raw)})
            except Exception as exc:
                row.update({"status": "failed", "failure_stage": stage, "error_type": type(exc).__name__})
                report["status"] = "stopped_after_failure"
                write_json(report_path, report)
                break
            write_json(report_path, report)
        else:
            report["status"] = "completed_offline"
    write_json(report_path, report)
    return report


def run_real(output: Path, *, key: str, approved: Decimal, verified_on: str,
             verified_price: Decimal, transport: httpx.BaseTransport | None = None,
             clock: Callable[[], float] = time.perf_counter) -> dict:
    real_preflight(approved, verified_on, verified_price, key)
    plan, photos = load_frozen_plan()
    output = output.resolve()
    if output.parent != EVIDENCE.resolve() or output.exists():
        raise ValueError("Output must be a new direct child of R7.8 evidence")
    output.mkdir()
    report_path = output / "results.json"
    report = {
        "protocol_id": "r79-seedream-flash-i2i-real-v1", "source_protocol_id": plan["protocol_id"],
        "model": MODEL, "mock": False, "status": "running", "calls": [],
        "max_calls": len(ORDER), "unit_reserve_cny": str(UNIT_RESERVE),
        "approved_ceiling_cny": str(CEILING), "reserved_cny": "0.00",
        "price_verified_on": verified_on, "billable_requests_attempted": 0,
        "release_passed": False, "quality": "NEED_REVIEW", "browser_e2e_latency": "NOT_TESTED",
        "timing_scope": "local preprocess through validated image save; excludes browser upload/display",
        "source_manifest_sha256": plan["source_manifest_sha256"],
        "script_sha256": sha256(Path(__file__).read_bytes()),
    }
    write_json(report_path, report)
    client_options = {"timeout": httpx.Timeout(90, connect=10), "follow_redirects": False}
    if transport is not None:
        client_options["transport"] = transport
    with httpx.Client(**client_options) as client:
        for index, case_id in enumerate(ORDER, 1):
            try:
                real_preflight(approved, verified_on, verified_price, key)
            except ValueError:
                report["status"] = "stopped_preflight"
                write_json(report_path, report)
                break
            row = {
                "sample_id": f"r79-{index:02}", "case_id": case_id,
                "repeat": 1 if index <= 4 else 2,
                "input_sha256": sha256(photos[case_id]),
                "prompt_sha256": sha256(PROMPTS[case_id].encode()),
                "status": "reserved", "reserved_cny": str(UNIT_RESERVE),
            }
            report["calls"].append(row)
            report["reserved_cny"] = str(UNIT_RESERVE * index)
            report["billable_requests_attempted"] = index
            write_json(report_path, report)  # An uncertain charge cannot be retried in this directory.
            started = clock()
            stage = "request_body"
            try:
                body = request_body(photos[case_id], case_id)
                stage = "provider_post"
                post_started = clock()
                try:
                    response = client.post(ENDPOINT, json=body,
                                           headers={"Authorization": f"Bearer {key}"})
                finally:
                    row["model_post_ms"] = round((clock() - post_started) * 1000, 3)
                row["http_status"] = response.status_code
                response.raise_for_status()
                stage = "response_shape"
                data = response.json()
                if not isinstance(data, dict):
                    raise ValueError("Invalid response object")
                row["response_shape"] = response_shape(data)
                if isinstance(data.get("model"), str):
                    row["response_model_matches"] = data["model"] == MODEL
                    if not row["response_model_matches"]:
                        raise ValueError("Provider returned another model")
                usage = data.get("usage")
                if isinstance(usage, dict) and type(usage.get("generated_images")) is int:
                    count = usage["generated_images"]
                    if 0 <= count <= 1:
                        row["reported_generated_images"] = count
                stage = "image_payload"
                raw, suffix = image_bytes(data)
                stage = "save"
                filename = f"r79-{index:02}.{suffix}"
                (output / filename).write_bytes(raw)
                row.update({"status": "succeeded", "artifact": filename,
                            "output_sha256": sha256(raw), "quality": "NEED_REVIEW"})
            except Exception as exc:
                row.update({"status": "failed", "failure_stage": stage,
                            "error_type": type(exc).__name__})
                report["status"] = "stopped_after_failure"
            finally:
                row["local_total_ms"] = round((clock() - started) * 1000, 3)
                row["local_within_8s"] = row["status"] == "succeeded" and row["local_total_ms"] <= 8000
                if row["status"] == "succeeded" and not row["local_within_8s"]:
                    report["status"] = "stopped_after_over_8s"
                write_json(report_path, report)
            if report["status"] != "running":
                break
        else:
            report["status"] = "completed_local_screen"
    write_json(report_path, report)
    return report


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline-check", action="store_true", help="Run only in-process HTTP fixtures")
    parser.add_argument("--run", action="store_true", help="Explicitly run the separately approved real batch")
    parser.add_argument("--output", type=Path, help="New R7.8 evidence subdirectory")
    parser.add_argument("--approved-budget-cny", type=Decimal)
    parser.add_argument("--price-verified-on")
    parser.add_argument("--verified-output-price-cny", type=Decimal)
    args = parser.parse_args(argv)
    plan, _ = load_frozen_plan()
    if args.run and args.offline_check:
        parser.error("Select only one mode")
    if args.run:
        if args.output is None or args.approved_budget_cny is None or not args.price_verified_on or args.verified_output_price_cny is None:
            parser.error("Real mode requires output, new budget approval, same-day price date and output price")
        # No key is read until all non-secret guards have been checked.
        real_preflight(args.approved_budget_cny, args.price_verified_on,
                       args.verified_output_price_cny, "configured-placeholder")
        output = args.output.resolve()
        if output.parent != EVIDENCE.resolve() or output.exists():
            parser.error("Real output must be a new R7.8 evidence subdirectory")
        key = load_project_key()
        report = run_real(output, key=key, approved=args.approved_budget_cny,
                          verified_on=args.price_verified_on,
                          verified_price=args.verified_output_price_cny)
        print(json.dumps({"mode": "real", "status": report["status"],
                          "attempted": len(report["calls"]), "reserved_cny": report["reserved_cny"],
                          "release_passed": False}, ensure_ascii=False))
        if report["status"] != "completed_local_screen":
            sys.exit(2)
        return
    if not args.offline_check:
        if any(value is not None for value in (args.output, args.approved_budget_cny,
                                              args.price_verified_on, args.verified_output_price_cny)):
            parser.error("Extra options require --run or --offline-check")
        print(json.dumps({"mode": "dry_run", "model": MODEL, "planned_cases": plan["order"],
                          "real_requests_enabled": False, "billable_requests": 0,
                          "proposed_ceiling_cny": plan["proposed_ceiling_cny"]}, ensure_ascii=False))
        return
    if args.output is None:
        parser.error("--offline-check requires --output")
    if any(value is not None for value in (args.approved_budget_cny, args.price_verified_on,
                                          args.verified_output_price_cny)):
        parser.error("Approval options cannot be used in offline mode")
    report = run_offline(args.output)
    print(json.dumps({"mode": "offline_fixture", "status": report["status"],
                      "cases": len(report["calls"]), "billable_requests": 0,
                      "release_passed": False}, ensure_ascii=False))
    if report["status"] != "completed_offline":
        sys.exit(2)


if __name__ == "__main__":
    main()
