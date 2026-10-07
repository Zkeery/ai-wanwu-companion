"""R7.11 Klein 4B isolated offline probe. No credentials or real mode."""
from __future__ import annotations

import argparse
import base64
from decimal import Decimal
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import re
import sys
from urllib.parse import urlsplit

import httpx
from PIL import Image

from probe_seedream_flash_i2i import load_frozen_plan, PROMPTS, ORDER, PROJECT

MODEL = "flux-2-klein-4b"
ENDPOINT = "https://api.bfl.ai/v1/" + MODEL
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.11Klein零预算探针"
PLAN = EVIDENCE / "plan.json"
PROTOCOL = "r711-klein-4b-i2i-offline-v1"
RESERVE = Decimal("0.03")
CEILING = Decimal("0.30")
MAX_BYTES = 20 * 1024 * 1024
MP = 1024 * 1024


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def write_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def expected_plan() -> tuple[dict, dict[str, bytes]]:
    original, photos = load_frozen_plan()
    inputs = []
    for case_id in ORDER[:4]:
        with Image.open(BytesIO(photos[case_id])) as image:
            width, height = image.size
        billed_mp = min(4, math.ceil(width * height / MP))
        quote = Decimal("0.014") + Decimal("0.001") * billed_mp
        if quote > RESERVE:
            raise ValueError("Quote exceeds per-request reserve")
        inputs.append({"case_id": case_id, "sha256": sha256(photos[case_id]),
                       "width": width, "height": height, "input_billed_mp": billed_mp,
                       "quoted_usd": str(quote), "prompt_sha256": original["prompt_sha256"][case_id]})
    return {"protocol_id": PROTOCOL, "model": MODEL, "endpoint": ENDPOINT,
            "order": list(ORDER), "inputs": inputs,
            "source_manifest_sha256": original["source_manifest_sha256"],
            "input_format": "raw_base64_jpeg", "width": 1024, "height": 1024,
            "output_format": "jpeg", "safety_tolerance": 2,
            "mp_pixels": MP, "quoted_first_output_mp_usd": "0.014",
            "quoted_reference_mp_usd": "0.001", "price_checked_on": "2026-09-26",
            "unit_reserve_usd": str(RESERVE), "proposed_ceiling_usd": str(CEILING),
            "approved_budget_usd": None, "real_requests_enabled": False,
            "pre_screen_ms": 6000, "prd_display_ms": 8000,
            "poll_interval_seconds": 0.5, "observation_seconds": 90,
            "first_segment_count": 2}, photos


def frozen_plan() -> tuple[dict, dict[str, bytes]]:
    expected, photos = expected_plan()
    if json.loads(PLAN.read_text()) != expected:
        raise ValueError("Frozen plan differs from sources or protocol")
    return expected, photos


def request_body(photo: bytes, case_id: str) -> dict:
    return {"prompt": PROMPTS[case_id], "input_image": base64.b64encode(photo).decode("ascii"),
            "width": 1024, "height": 1024, "output_format": "jpeg", "safety_tolerance": 2}


def safe_url(value: str, kind: str) -> str:
    if not isinstance(value, str):
        raise ValueError("Missing URL")
    parsed = urlsplit(value)
    if (parsed.scheme != "https" or parsed.username is not None or parsed.password is not None
            or parsed.port not in (None, 443) or parsed.fragment):
        raise ValueError("Invalid URL")
    host = parsed.hostname or ""
    pattern = (r"api(?:\.[a-z0-9-]+)?\.bfl\.ai" if kind == "poll"
               else r"delivery\.[a-z0-9-]+\.bfl\.ai")
    if not re.fullmatch(pattern, host):
        raise ValueError("Unapproved URL host")
    return value


def safe_cost(data: dict) -> None:
    for key in ("cost", "input_mp", "output_mp"):
        value = data.get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid cost metadata")
        if key == "cost" and Decimal(str(value)) * Decimal("0.01") > RESERVE:
            raise ValueError("Reported credits exceed reserved USD")


def checked_image(raw: bytes) -> str:
    if not raw or len(raw) > MAX_BYTES:
        raise ValueError("Invalid image byte size")
    with Image.open(BytesIO(raw)) as image:
        if image.format not in ("JPEG", "PNG", "WEBP") or image.size != (1024, 1024):
            raise ValueError("Invalid output image")
        image.verify()
        return {"JPEG": "jpg", "PNG": "png", "WEBP": "webp"}[image.format]


class VirtualClock:
    """Deterministic mock time, never evidence of model or browser latency."""
    def __init__(self):
        self.value = 0.0

    def now(self) -> float:
        return self.value

    def sleep(self, seconds: float) -> None:
        self.value += seconds


class OfflineServer:
    def __init__(self):
        self.posts = 0
        self.polls: dict[str, int] = {}
        stream = BytesIO()
        Image.new("RGB", (1024, 1024), "#9bd5c8").save(stream, format="JPEG")
        self.image = stream.getvalue()

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.headers.get("x-key") or request.headers.get("authorization"):
            return httpx.Response(400)
        if request.method == "POST" and str(request.url) == ENDPOINT:
            body = json.loads(request.content)
            if set(body) != {"prompt", "input_image", "width", "height", "output_format", "safety_tolerance"}:
                return httpx.Response(400)
            if body["width"] != 1024 or body["height"] != 1024 or body["output_format"] != "jpeg" or body["safety_tolerance"] != 2:
                return httpx.Response(400)
            with Image.open(BytesIO(base64.b64decode(body["input_image"], validate=True))) as image:
                image.verify()
            self.posts += 1
            task = f"mock-{self.posts:02d}"
            return httpx.Response(200, json={"id": task, "polling_url": poll_url(task), "cost": 1.8})
        if request.method == "GET" and request.url.host == "api.bfl.ai":
            task = request.url.params.get("id", "")
            self.polls[task] = self.polls.get(task, 0) + 1
            if self.polls[task] == 1:
                return httpx.Response(200, json={"status": "Pending"})
            return httpx.Response(200, json={"status": "Ready", "cost": 1.8,
                                           "result": {"sample": "https://delivery.mock.bfl.ai/image?signature=mock-only"}})
        if request.method == "GET" and request.url.host == "delivery.mock.bfl.ai":
            return httpx.Response(200, content=self.image)
        return httpx.Response(404)


def poll_url(task_id: str) -> str:
    if not isinstance(task_id, str) or not re.fullmatch(r"mock-\d{2}", task_id):
        raise ValueError("Invalid mock task ID")
    return "https://api.bfl.ai/v1/get_result?id=" + task_id


def validate_resume(report: dict, plan: dict) -> None:
    rows = report.get("calls")
    if (report.get("protocol_id") != PROTOCOL or report.get("mock") is not True
            or report.get("plan_sha256") != sha256(PLAN.read_bytes())
            or report.get("script_sha256") != sha256(Path(__file__).read_bytes())
            or report.get("status") not in ("awaiting_offline_review", "running", "observation_timeout")
            or not isinstance(rows, list) or not 1 <= len(rows) <= 8
            or report.get("segment_limit") not in (2, 8)
            or len(rows) > report["segment_limit"]):
            raise ValueError("Not an offline resumable batch")
    if report["status"] == "awaiting_offline_review" and len(rows) != 2:
        raise ValueError("Review pause must contain exactly two cases")
    for index, row in enumerate(rows):
        if (row.get("case_id") != ORDER[index] or row.get("sample_id") != f"r711-{index + 1:02d}"
                or row.get("reserved_usd") != str(RESERVE)
                or row.get("status") not in ("succeeded", "submitted")
                or (row.get("status") == "submitted" and index != len(rows) - 1)):
            raise ValueError("Batch requires manual reconciliation; never resubmit")
        if row.get("status") == "submitted":
            poll_url(row.get("task_id"))
        if row.get("input_sha256") != plan["inputs"][index % 4]["sha256"]:
            raise ValueError("Input binding changed")
    if report.get("reserved_usd") != str(RESERVE * len(rows)):
        raise ValueError("Budget ledger mismatch")


def run_offline(output: Path, *, resume: bool = False, handler=None, clock=None) -> dict:
    plan, photos = frozen_plan()
    if output.is_symlink():
        raise ValueError("Symlink output forbidden")
    output = output.resolve()
    if output.parent != EVIDENCE.resolve() or output.is_symlink():
        raise ValueError("Output must be a direct evidence child")
    report_path = output / "results.json"
    if resume:
        report = json.loads(report_path.read_text())
        validate_resume(report, plan)
        if report["status"] == "awaiting_offline_review":
            report["segment_limit"] = 8
            report["status"] = "running"
            write_json(report_path, report)
    else:
        output.mkdir(exist_ok=False)
        report = {"protocol_id": PROTOCOL, "model": MODEL, "mock": True,
                  "plan_sha256": sha256(PLAN.read_bytes()), "script_sha256": sha256(Path(__file__).read_bytes()),
                  "network_requests": 0, "billable_requests": 0, "release_passed": False,
                  "real_requests_enabled": False, "browser_e2e_latency": "NOT_TESTED",
                  "quality": "NOT_TESTED", "clock_kind": "virtual_mock", "calls": [],
                  "status": "running", "reserved_usd": "0.00", "segment_limit": 2}
        write_json(report_path, report)
    clock = clock or VirtualClock()
    if handler is None:
        handler = OfflineServer()
        handler.posts = len(report["calls"])
    # Only an in-process MockTransport can be used; no credentials or network client exists.
    with httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False) as client:
        while (len(report["calls"]) < report["segment_limit"]
               or bool(report["calls"] and report["calls"][-1]["status"] == "submitted")):
            pending = bool(report["calls"] and report["calls"][-1]["status"] == "submitted")
            start = clock.now()
            if pending:
                row = report["calls"][-1]
                # Keep time already spent before interruption; never restart the timer.
                previous = row.get("elapsed_ms", 0) / 1000
            else:
                previous = 0
                index = len(report["calls"])
                case_id = ORDER[index]
                row = {"sample_id": f"r711-{index + 1:02d}", "case_id": case_id,
                       "repeat": index // 4 + 1, "input_sha256": sha256(photos[case_id]),
                       "prompt_sha256": sha256(PROMPTS[case_id].encode()), "status": "reserved",
                       "reserved_usd": str(RESERVE), "mock": True}
                report["calls"].append(row)
                report["reserved_usd"] = str(RESERVE * len(report["calls"]))
                report["status"] = "running"
                write_json(report_path, report)
            stage = "prepare"
            try:
                if not pending:
                    body = request_body(photos[row["case_id"]], row["case_id"])
                    row["prepare_ms"] = (clock.now() - start) * 1000
                    stage = "submit"
                    before = clock.now()
                    response = client.post(ENDPOINT, json=body)
                    response.raise_for_status()
                    data = response.json()
                    safe_cost(data)
                    task = data["id"]
                    poll_url(task)
                    address = safe_url(data["polling_url"], "poll")
                    if address != poll_url(task):
                        raise ValueError("Unexpected offline polling address")
                    row.update(status="submitted", task_id=task, submit_ms=(clock.now() - before) * 1000,
                               elapsed_ms=(clock.now() - start) * 1000, poll_count=0)
                    write_json(report_path, report)
                address = poll_url(row["task_id"])
                stage = "poll"
                before = clock.now()
                download_url = None
                observed = 0
                # On explicit recovery, allow one read-only query even after the
                # observation deadline. Its time remains in the original total.
                while observed == 0 or previous + clock.now() - start < 90:
                    clock.sleep(0.5)
                    response = client.get(safe_url(address, "poll"))
                    response.raise_for_status()
                    data = response.json()
                    safe_cost(data)
                    row["poll_count"] += 1
                    observed += 1
                    row["elapsed_ms"] = (previous + clock.now() - start) * 1000
                    row["poll_elapsed_ms"] = row.get("poll_elapsed_ms", 0) + (clock.now() - before) * 1000
                    before = clock.now()
                    write_json(report_path, report)
                    status = data["status"]
                    if status == "Ready":
                        download_url = safe_url(data["result"]["sample"], "download")
                        break
                    if status not in ("Pending", "Processing"):
                        raise ValueError("Task failed or unknown state")
                if download_url is None:
                    report["status"] = "observation_timeout"
                    write_json(report_path, report)
                    return report
                stage = "download"
                before = clock.now()
                raw = bytearray()
                with client.stream("GET", download_url) as response:
                    response.raise_for_status()
                    if response.is_redirect:
                        raise ValueError("Redirect forbidden")
                    for chunk in response.iter_bytes():
                        raw.extend(chunk)
                        if len(raw) > MAX_BYTES:
                            raise ValueError("Download too large")
                row["download_ms"] = (clock.now() - before) * 1000
                stage = "decode_save"
                before = clock.now()
                suffix = checked_image(bytes(raw))
                name = f"mock-{row['sample_id']}.{suffix}"
                temporary = output / (name + ".tmp")
                temporary.write_bytes(raw)
                temporary.replace(output / name)
                row.update(status="succeeded", artifact=name, output_sha256=sha256(raw), output_bytes=len(raw),
                           decode_save_ms=(clock.now() - before) * 1000,
                           local_total_ms=(previous + clock.now() - start) * 1000)
                row["elapsed_ms"] = row["local_total_ms"]
                if row["local_total_ms"] > 6000:
                    report["status"] = "stopped_over_8s" if row["local_total_ms"] > 8000 else "stopped_insufficient_margin"
                    write_json(report_path, report)
                    return report
            except Exception as exc:
                row.update(status="failed", failure_stage=stage, error_type=type(exc).__name__)
                report["status"] = "stopped_after_failure"
                write_json(report_path, report)
                return report
            write_json(report_path, report)
    report["status"] = "offline_completed" if report["segment_limit"] == 8 else "awaiting_offline_review"
    write_json(report_path, report)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--offline-check", action="store_true")
    modes.add_argument("--offline-continue", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        plan, _ = frozen_plan()
        if args.offline_check or args.offline_continue:
            if args.output is None:
                raise ValueError("Output required")
            report = run_offline(args.output, resume=args.offline_continue)
            print(json.dumps({"mode": "offline", "mock": True, "status": report["status"],
                              "cases": len(report["calls"]), "network_requests": 0,
                              "billable_requests": 0, "release_passed": False}))
            return 0 if report["status"] in ("offline_completed", "awaiting_offline_review") else 2
        if args.output is not None:
            raise ValueError("Output requires an offline mode")
        print(json.dumps({"mode": "dry_run", "model": MODEL, "cases": plan["order"],
                          "proposed_ceiling_usd": str(CEILING), "real_requests_enabled": False}))
        return 0
    except Exception as exc:
        print(json.dumps({"status": "refused", "error_type": type(exc).__name__}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
