"""R7.7 isolated Qwen-Image-3.0 I2I pilot; dry-run unless explicitly authorized."""
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
from zoneinfo import ZoneInfo

import httpx
from PIL import Image

from compare_generation_candidates import MAX_BYTES, download, valid_image

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "backend"))

EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.7图生图小样"
SOURCE_MANIFEST = EVIDENCE / "sources.json"
PLAN = EVIDENCE / "plan.json"
BASE = "https://maas-api.antdigital.com/v1"
MODEL = "qwen-image-3.0"
UNIT_RESERVE = Decimal("0.20")
CEILING = Decimal("2.00")
ORDER = ("cup", "apple", "plant", "multi") * 2
PROMPTS = {
    "cup": "以参考照片中盛着咖啡的白色陶瓷杯为唯一主体，把它变成一个完整、温暖、可爱的拟人伙伴。保留白色陶瓷质感、左侧圆把手、杯口与浅棕色咖啡；让杯身自然长出表情与四肢，姿态活泼。背景简洁，不要把盘子或食物变成伙伴。1024像素正方形角色图。",
    "apple": "以参考照片中的一颗苹果为唯一主体，把它变成一个完整、温暖、可爱的拟人伙伴。保留红黄斑驳表皮、圆润苹果轮廓和顶部果梗；让果身自然长出表情与四肢，姿态活泼。背景简洁，不要变成普通人或其他水果。1024像素正方形角色图。",
    "plant": "以参考照片中白色花盆里的黄色非洲菊为唯一主体，把整盆花变成一个完整、温暖、可爱的拟人伙伴。保留黄色长花瓣、棕黄花心、深绿叶片与白色圆花盆；让花和花盆自然组合出表情与四肢，姿态活泼。不要把窗外景物变成伙伴。1024像素正方形角色图。",
    "multi": "以参考照片中倒放的白色陶瓷杯为唯一主体，把白杯变成一个完整、温暖、可爱的拟人伙伴。保留白色陶瓷质感、圆把手、杯口和侧放姿态的识别性；让杯身自然长出表情与四肢。咖啡豆只作陪衬，不要把它们变成主角。1024像素正方形角色图。",
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def now_local() -> datetime:
    return datetime.now(ZoneInfo("Asia/Shanghai"))


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def load_plan() -> tuple[dict, dict]:
    sources = json.loads(SOURCE_MANIFEST.read_text())
    plan = json.loads(PLAN.read_text())
    if plan != {
        "protocol_id": "r77-qwen-image-3-i2i-v1",
        "model": MODEL,
        "endpoint": BASE + "/images/generations",
        "unit_reserve_cny": "0.20",
        "approved_ceiling_cny": "2.00",
        "order": list(ORDER),
        "sources_sha256": sha256(SOURCE_MANIFEST.read_bytes()),
        "prompts_sha256": {key: sha256(value.encode()) for key, value in PROMPTS.items()},
    }:
        raise ValueError("Frozen plan differs from the script or sources")
    if [item["id"] for item in sources["inputs"]] != list(ORDER[:4]):
        raise ValueError("Frozen source order differs")
    for item in sources["inputs"]:
        file = EVIDENCE / item["file"]
        if file.parent != EVIDENCE or file.suffix.lower() != ".jpg":
            raise ValueError("Unexpected source path")
        data = file.read_bytes()
        if item["license"] != "CC0" or sha256(data) != item["sha256"] or len(data) > 10_000_000:
            raise ValueError("Source photo changed or is too large")
        with Image.open(BytesIO(data)) as image:
            if image.format != "JPEG" or min(image.size) < 384 or max(image.size) > 2048:
                raise ValueError("Source photo has unsupported dimensions or type")
            image.verify()
    return sources, plan


def request_body(photo: bytes, case_id: str) -> dict:
    if case_id not in PROMPTS:
        raise ValueError("Unknown case")
    return {
        "model": MODEL,
        "prompt": PROMPTS[case_id],
        "image": "data:image/jpeg;base64," + base64.b64encode(photo).decode(),
        "size": "1024x1024",
        "n": 1,
        "response_format": "url",
    }


def preflight(approved: Decimal, verified_on: str, at: datetime | None = None) -> None:
    at = at or now_local()
    if approved != CEILING or verified_on != at.date().isoformat():
        raise ValueError("New 2.00 CNY approval and same-day price verification are required")


def image_bytes(data: dict, offline: bool) -> bytes:
    items = data.get("data")
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict):
        raise ValueError("Expected exactly one generated image")
    item = items[0]
    if isinstance(item.get("b64_json"), str):
        if len(item["b64_json"]) > MAX_BYTES * 4 // 3 + 8:
            raise ValueError("Encoded image exceeds size limit")
        raw = base64.b64decode(item["b64_json"], validate=True)
    elif not offline and isinstance(item.get("url"), str):
        raw = download(item["url"])
    else:
        raise ValueError("Final image URL is missing")
    return raw


def response_shape(data: dict) -> dict:
    """Only fixed, non-sensitive structure facts; never record signed URLs or body text."""
    items = data.get("data")
    first = items[0] if isinstance(items, list) and items else None
    return {
        "data_is_list": isinstance(items, list),
        "data_count": len(items) if isinstance(items, list) else None,
        "first_is_object": isinstance(first, dict),
        "first_has_url": isinstance(first, dict) and isinstance(first.get("url"), str),
        "first_has_b64_json": isinstance(first, dict) and isinstance(first.get("b64_json"), str),
    }


def offline_response() -> dict:
    stream = BytesIO()
    Image.new("RGB", (1024, 1024), "#9bd5c8").save(stream, format="PNG")
    return {"data": [{"b64_json": base64.b64encode(stream.getvalue()).decode()}]}


def run(output: Path, offline: bool, key: str = "", verified_on: str | None = None,
        approved_budget: Decimal = Decimal("0")) -> dict:
    if not offline:
        preflight(approved_budget, verified_on or "")
        if not key:
            raise ValueError("MaaS credential is required for the approved real run")
    sources, plan = load_plan()
    output = output.resolve()
    if output.parent != EVIDENCE.resolve() or output.exists():
        raise ValueError("Output must be a new direct child of the R7.7 evidence directory")
    output.mkdir()
    report_path = output / "results.json"
    report = {
        "protocol_id": plan["protocol_id"], "mock": offline,
        "started_at": now_local().isoformat(), "price_verified_on": verified_on,
        "model": MODEL, "max_calls": len(ORDER), "budget_cny": str(CEILING),
        "unit_reserve_cny": str(UNIT_RESERVE), "reserved_cny": "0.00",
        "status": "running", "calls": [], "release_passed": False,
        "timing_scope": "local preprocess through image validation and save; excludes browser upload/display",
        "source_manifest_sha256": sha256(SOURCE_MANIFEST.read_bytes()),
        "script_sha256": sha256(Path(__file__).read_bytes()),
    }
    write_json(report_path, report)
    photos = {item["id"]: (EVIDENCE / item["file"]).read_bytes() for item in sources["inputs"]}
    try:
        with httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False) if not offline else _NoClient() as client:
            for index, case_id in enumerate(ORDER, 1):
                if not offline:
                    preflight(approved_budget, verified_on or "")
                row = {
                    "sample_id": f"r77-{index:02}", "case_id": case_id,
                    "repeat": 1 if index <= 4 else 2,
                    "input_sha256": sha256(photos[case_id]),
                    "prompt_sha256": sha256(PROMPTS[case_id].encode()),
                    "status": "reserved", "reserved_cny": str(UNIT_RESERVE),
                    "timings_ms": {}, "quality": "NEED_REVIEW",
                }
                report["calls"].append(row)
                report["reserved_cny"] = str(UNIT_RESERVE * index)
                write_json(report_path, report)  # Never repeat an uncertain billable attempt.
                start = time.perf_counter()
                stage = "preprocess"
                try:
                    stamp = time.perf_counter()
                    body = request_body(photos[case_id], case_id)
                    row["timings_ms"]["preprocess"] = (time.perf_counter() - stamp) * 1000
                    stage = "provider_post"
                    stamp = time.perf_counter()
                    if offline:
                        data = offline_response()
                        row["http_status"] = 200
                    else:
                        response = client.post(plan["endpoint"], headers={"Authorization": f"Bearer {key}"}, json=body)
                        row["http_status"] = response.status_code
                        row["request_id"] = response.headers.get("x-request-id")
                        response.raise_for_status()
                        data = response.json()
                    row["timings_ms"]["model_post"] = (time.perf_counter() - stamp) * 1000
                    if not isinstance(data, dict):
                        raise ValueError("Invalid provider response")
                    row["response_shape"] = response_shape(data)
                    row["response_model"] = data.get("model") if isinstance(data.get("model"), str) else None
                    stage = "image_payload"
                    stamp = time.perf_counter()
                    raw = image_bytes(data, offline)
                    row["timings_ms"]["download"] = (time.perf_counter() - stamp) * 1000
                    stage = "decode"
                    stamp = time.perf_counter()
                    valid_image(raw)
                    row["timings_ms"]["decode"] = (time.perf_counter() - stamp) * 1000
                    stage = "save"
                    stamp = time.perf_counter()
                    with Image.open(BytesIO(raw)) as image:
                        suffix = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[image.format]
                    filename = row["sample_id"] + "." + suffix
                    (output / filename).write_bytes(raw)
                    row["timings_ms"]["save"] = (time.perf_counter() - stamp) * 1000
                    row["artifact"] = filename
                    row["output_sha256"] = sha256(raw)
                    row["status"] = "succeeded"
                except Exception as exc:
                    row["status"] = "failed"
                    row["failure_stage"] = stage
                    row["error_type"] = type(exc).__name__
                    # Response and body details may contain temporary URLs or secrets.
                finally:
                    row["local_total_ms"] = (time.perf_counter() - start) * 1000
                    row["local_within_8s"] = row["status"] == "succeeded" and row["local_total_ms"] <= 8000
                    write_json(report_path, report)
                if row["status"] != "succeeded":
                    report["status"] = "stopped_after_failure"
                    break
            else:
                report["status"] = "completed"
    finally:
        if report["status"] == "running":
            report["status"] = "interrupted"
        write_json(report_path, report)
    return report


class _NoClient:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--run", action="store_true")
    mode.add_argument("--offline-check", action="store_true")
    parser.add_argument("--approved-budget-cny", type=Decimal, default=Decimal("0"))
    parser.add_argument("--price-verified-on")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    load_plan()
    if not args.run and not args.offline_check:
        print(json.dumps({"dry_run": True, "provider_calls": 0, "model": MODEL,
                          "max_calls": len(ORDER), "max_reservation_cny": str(UNIT_RESERVE * len(ORDER)),
                          "approved_ceiling_cny": str(CEILING), "release_passed": False}))
        return
    if args.output is None:
        parser.error("A new output directory is required")
    key = ""
    if args.run:
        preflight(args.approved_budget_cny, args.price_verified_on or "")
        from app.core.config import get_settings
        settings = get_settings()
        if settings.model_base_url.rstrip("/") != BASE or not settings.model_api_key:
            raise ValueError("Only this project's existing MaaS configuration is allowed")
        key = settings.model_api_key
    result = run(args.output, args.offline_check, key, args.price_verified_on,
                 args.approved_budget_cny)
    print(json.dumps({"output": str(args.output), "mock": args.offline_check,
                      "calls": len(result["calls"]), "succeeded": sum(r["status"] == "succeeded" for r in result["calls"]),
                      "status": result["status"], "release_passed": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error_type": type(exc).__name__, "message": "Pilot blocked; inspect frozen plan and retained results"}))
        raise SystemExit(1)
