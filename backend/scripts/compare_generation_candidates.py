"""R7.5 isolated provider pilot. Dry-run by default; never approves a release."""
from __future__ import annotations

import argparse
import base64
from datetime import datetime
from decimal import Decimal
import hashlib
from io import BytesIO
import ipaddress
import json
from pathlib import Path
import random
import socket
import sys
import time
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

import httpx
from PIL import Image

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "backend"))
from app.services import prompts
from app.services.appearance import image_prompt
from app.services.parsers import parse_recognize

BASE = "https://maas-api.antdigital.com/v1"
VISIONS = ("ling-3.0-flash-vl", "qwen3.8-flash")
IMAGES = ("wan2.6-t2i", "qwen-image-plus")
RESERVE = {VISIONS[0]: Decimal("0"), VISIONS[1]: Decimal("0.08"),
           IMAGES[0]: Decimal("0.016"), IMAGES[1]: Decimal("0.2")}
CEILING = Decimal("2")
MAX_BYTES = 20 * 1024 * 1024
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7"
SOURCE = EVIDENCE / "R7.3杯子测试图.png"
FROZEN_PLAN = EVIDENCE / "R7.5候选评测计划.json"


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def schedule():
    pairs = [(v, i) for v in VISIONS for i in IMAGES]
    random.Random(75).shuffle(pairs)
    return [(v, i, r) for v, i in pairs for r in (1, 2)]


def preflight(approved, verified, now=None):
    now = now or datetime.now(ZoneInfo("Asia/Shanghai"))
    if Decimal(str(approved)) != CEILING:
        raise ValueError("Explicit budget must match the frozen 2 CNY pilot")
    if verified != now.date().isoformat() or now >= datetime(2026, 9, 24, 10, tzinfo=ZoneInfo("Asia/Shanghai")):
        raise ValueError("Recheck prices and the free vision window before running")


def persist(path, report):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    tmp.replace(path)


class Guard:
    def __init__(self, path, report):
        self.path, self.report = path, report
        self.total = Decimal("0")
        self.counts = dict.fromkeys(RESERVE, 0)
        self.stopped = False

    def reserve(self, model, sample):
        if self.stopped or model not in RESERVE or self.counts[model] >= 4:
            raise ValueError("Provider call blocked by frozen pilot limits")
        amount = RESERVE[model]
        if self.total + amount > CEILING:
            raise ValueError("Budget exceeded")
        self.total += amount
        self.counts[model] += 1
        row = {"sample_id": sample, "model": model, "status": "started",
               "reserved_cny": float(amount)}
        self.report["calls"].append(row)
        self.report["reserved_cny"] = float(self.total)
        persist(self.path, self.report)  # Persist before a potentially billable POST.
        return row


def validate_url(url):
    p = urlsplit(url)
    if p.scheme != "https" or not p.hostname or p.username or p.password or p.port not in (None, 443):
        raise ValueError("Unsafe image URL")
    addresses = socket.getaddrinfo(p.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("Image URL does not resolve to public addresses")


def valid_image(content):
    if not content or len(content) > MAX_BYTES:
        raise ValueError("Invalid image size")
    with Image.open(BytesIO(content)) as im:
        if im.format not in {"PNG", "JPEG", "WEBP"} or im.size != (1024, 1024):
            raise ValueError("Invalid final image type or dimensions")
        im.verify()
    with Image.open(BytesIO(content)) as im:
        im.load()


def download(url):
    # Keep model authentication out of downloads; do not follow arbitrary redirects.
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        for _ in range(4):
            validate_url(url)
            with client.stream("GET", url) as r:
                if r.is_redirect:
                    url = str(r.url.join(r.headers["location"]))
                    continue
                r.raise_for_status()
                data = bytearray()
                for chunk in r.iter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise ValueError("Image download exceeds limit")
                return bytes(data)
    raise ValueError("Too many image redirects")


def post(client, key, body, guard, sample, offline):
    model = body["model"]
    if not offline:
        # Price/free-period validity is checked again before every billable POST.
        preflight(CEILING, guard.report["price_verified_on"])
    row = guard.reserve(model, sample)
    start = time.perf_counter()
    try:
        if offline:
            if model in VISIONS:
                result = {"model": model, "choices": [{"finish_reason": "stop", "message": {
                    "content": json.dumps([{"label": "测试杯", "category": "object", "visual_features": "蓝绿杯子，圆把手",
                        "concept": {"name": "模拟小杯", "persona": "温柔安静", "opening_line": "你好",
                                    "appearance_description": "蓝绿杯子拟人角色，圆把手和笑脸"}}], ensure_ascii=False)}}],
                    "usage": {"prompt_tokens": 100, "completion_tokens": 100}}
            else:
                b = BytesIO()
                Image.new("RGB", (1024, 1024), "#83cec6").save(b, format="PNG")
                result = {"data": [{"b64_json": base64.b64encode(b.getvalue()).decode()}]}
            row["http_status"] = 200
        else:
            endpoint = "/chat/completions" if model in VISIONS else "/images/generations"
            r = client.post(BASE + endpoint, headers={"Authorization": f"Bearer {key}"}, json=body)
            row["http_status"] = r.status_code
            if r.status_code in (401, 402, 403):
                guard.stopped = True
            r.raise_for_status()
            result = r.json()
        if not isinstance(result, dict):
            raise ValueError("Invalid provider response")
        row["response_model"] = result.get("model") if isinstance(result.get("model"), str) else None
        usage = result.get("usage") or {}
        row["usage"] = {k: usage[k] for k in ("prompt_tokens", "completion_tokens", "total_tokens")
                        if isinstance(usage, dict) and type(usage.get(k)) is int}
        if row["usage"].get("prompt_tokens", 0) > 32768 or row["usage"].get("completion_tokens", 0) > 4096:
            guard.stopped = True
            raise ValueError("Observed usage exceeds frozen reserve assumptions")
        row["status"] = "responded"
        return result
    except Exception as exc:
        row["status"] = "failed"
        row["error_type"] = type(exc).__name__
        raise
    finally:
        row["elapsed_ms"] = (time.perf_counter() - start) * 1000
        persist(guard.path, guard.report)


def vision_body(normalized, model):
    if model not in VISIONS or len((prompts.VISION_PROMPT + prompts.VISION_CONCEPT_PROMPT).encode()) > 6000:
        raise ValueError("Vision input differs from the frozen budget assumptions")
    body = {"model": model, "temperature": .1, "max_tokens": 4096,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompts.VISION_PROMPT + prompts.VISION_CONCEPT_PROMPT},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(normalized).decode()}}
            ]}]}
    if model == VISIONS[0]:
        body["thinking"] = {"type": "disabled"}
    return body


def recognize(data):
    c = data["choices"][0]
    if c.get("finish_reason") != "stop":
        raise ValueError("Incomplete vision output")
    obj = parse_recognize(c["message"]["content"])[0]
    if obj.concept is None or not obj.concept.appearance_description:
        raise ValueError("Missing concept; paid text fallback prohibited")
    return obj


def run(output, offline, key="", price_verified_on=None):
    raw = SOURCE.read_bytes()
    frozen = json.loads(FROZEN_PLAN.read_text())
    if digest(raw) != frozen["source_sha256"]:
        raise ValueError("Source image differs from frozen plan")
    with Image.open(BytesIO(raw)) as im:
        if im.size != (256, 256):
            raise ValueError("Pilot source must stay 256x256")
    output.mkdir(parents=True, exist_ok=False)
    path = output / "results.json"
    source_paths = [Path(__file__), PROJECT / "backend/app/services/prompts.py",
                    PROJECT / "backend/app/services/appearance.py", PROJECT / "backend/app/services/parsers.py"]
    report = {"protocol_id": "r75-candidate-pilot-v1", "mock": offline,
              "started_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
              "price_verified_on": price_verified_on,
              "status": "running", "budget_cny": 2, "reserved_cny": 0,
              "source_sha256": digest(raw), "source_kind": "synthetic_illustration_not_photo",
              "source_files": {str(p.relative_to(PROJECT)): digest(p.read_bytes()) for p in source_paths},
              "schedule": schedule(), "calls": [], "samples": [], "selection_passed": False, "release_passed": False,
              "timing_scope": "local preprocessing -> actual image download and decode; excludes browser",
              "limitation": "8 pilot runs and one illustration cannot establish broad quality or stability."}
    guard = Guard(path, report)
    persist(path, report)
    client = None
    try:
        for n, (v, i, repeat) in enumerate(schedule(), 1):
            if guard.stopped:
                break
            if repeat == 1:
                if client:
                    client.close()
                client = httpx.Client(timeout=httpx.Timeout(60, connect=10), follow_redirects=False)
            sample = {"sample_id": f"pilot-{n:02}", "vision": v, "image": i, "repeat": repeat,
                      "connection": "cold" if repeat == 1 else "warm",
                      "status": "running", "quality": "NEED_REVIEW", "timings_ms": {}}
            report["samples"].append(sample)
            persist(path, report)
            start = time.perf_counter()
            try:
                with Image.open(BytesIO(raw)) as im:
                    b = BytesIO()
                    im.convert("RGB").save(b, format="JPEG", quality=90)
                    normalized = b.getvalue()
                sample["timings_ms"]["preprocess"] = (time.perf_counter() - start) * 1000
                stamp = time.perf_counter()
                obj = recognize(post(client, key, vision_body(normalized, v), guard, sample["sample_id"], offline))
                sample["timings_ms"]["vision"] = (time.perf_counter() - stamp) * 1000
                from dataclasses import asdict
                sample["recognized"] = asdict(obj)
                concept = obj.concept
                prompt = image_prompt(obj.label, concept.name, concept.persona, obj.visual_features, concept.appearance_description)
                sample["image_prompt_sha256"] = digest(prompt.encode())
                stamp = time.perf_counter()
                data = post(client, key, {"model": i, "prompt": prompt, "n": 1, "size": "1024x1024", "response_format": "url"},
                            guard, sample["sample_id"], offline)
                sample["timings_ms"]["image_post"] = (time.perf_counter() - stamp) * 1000
                item = data["data"][0]  # Job receipts without an actual image fail here.
                stamp = time.perf_counter()
                if item.get("b64_json"):
                    if len(item["b64_json"]) > MAX_BYTES * 2:
                        raise ValueError("Encoded image too large")
                    content = base64.b64decode(item["b64_json"], validate=True)
                elif item.get("url") and not offline:
                    content = download(item["url"])
                else:
                    raise ValueError("Missing actual final image")
                sample["timings_ms"]["download"] = (time.perf_counter() - stamp) * 1000
                stamp = time.perf_counter()
                valid_image(content)
                sample["timings_ms"]["decode"] = (time.perf_counter() - stamp) * 1000
                # Preserve exact response bytes; extension reflects actual content.
                with Image.open(BytesIO(content)) as im:
                    suffix = {"PNG": "png", "JPEG": "jpg", "WEBP": "webp"}[im.format]
                name = sample["sample_id"] + "." + suffix
                (output / name).write_bytes(content)
                sample["artifact"] = name
                sample["image_sha256"] = digest(content)
                sample["status"] = "succeeded"
            except Exception as exc:
                sample["status"] = "failed"
                sample["error_type"] = type(exc).__name__
            finally:
                sample["local_total_ms"] = (time.perf_counter() - start) * 1000
                sample["local_within_8s"] = sample["status"] == "succeeded" and sample["local_total_ms"] <= 8000
                persist(path, report)
        report["status"] = "stopped" if guard.stopped else "completed"
    finally:
        if client:
            client.close()
        persist(path, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--run", action="store_true")
    modes.add_argument("--offline-check", action="store_true")
    parser.add_argument("--approved-budget-cny", type=Decimal, default=0)
    parser.add_argument("--price-verified-on")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.run and not args.offline_check:
        print(json.dumps({"dry_run": True, "provider_calls": 0, "budget_cny": 2,
                          "ceiling_reservation_cny": float(sum(RESERVE[v] + RESERVE[i] for v, i, _ in schedule())),
                          "schedule": schedule(), "release_passed": False}))
        return
    if args.output is None or not args.output.resolve().is_relative_to(PROJECT):
        parser.error("An unused output directory inside this project is required")
    key = ""
    if args.run:
        preflight(args.approved_budget_cny, args.price_verified_on)
        from app.core.config import get_settings
        settings = get_settings()
        if settings.model_base_url.rstrip("/") != BASE or (settings.image_base_url or settings.model_base_url).rstrip("/") != BASE or not settings.model_api_key:
            raise ValueError("Only this project's verified MaaS configuration is allowed")
        key = settings.model_api_key
    report = run(args.output.resolve(), args.offline_check, key, args.price_verified_on)
    print(json.dumps({"output": str(args.output), "mock": args.offline_check,
                      "samples": len(report["samples"]), "calls": len(report["calls"]),
                      "succeeded": sum(s["status"] == "succeeded" for s in report["samples"]),
                      "release_passed": False}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(json.dumps({"error_type": type(exc).__name__, "message": "Pilot blocked; inspect the frozen plan and retained results"}))
        raise SystemExit(1)
