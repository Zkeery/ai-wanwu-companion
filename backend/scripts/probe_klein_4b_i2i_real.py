"""R7.12 guarded Klein probe. Default dry-run; paid execution needs separate approval."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime
from decimal import Decimal
import fcntl
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import uuid
from zoneinfo import ZoneInfo

import httpx

import probe_klein_4b_i2i as offline

PROJECT = offline.PROJECT
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.12Klein受控试跑"
RUNTIME = PROJECT / ".runtime/probes/klein"
KEY_FILE = PROJECT / ".env"
PROTOCOL = "r712-klein-4b-i2i-real-v1"


def atomic_json(path: Path, data: dict) -> None:
    # Exclusive temporary file prevents following an existing symlink.
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class Clock:
    def now(self) -> float:
        return time.monotonic()

    def wall(self) -> float:
        return time.time()

    def sleep(self, duration: float) -> None:
        time.sleep(duration)


def project_key() -> str:
    if not KEY_FILE.is_file() or KEY_FILE.is_symlink():
        raise ValueError("Project BFL_API_KEY unavailable")
    for line in KEY_FILE.read_text().splitlines():
        if line.startswith("BFL_API_KEY="):
            key = line.partition("=")[2].strip().strip("\"'")
            if key and not any(ch.isspace() for ch in key):
                return key
    raise ValueError("Project BFL_API_KEY unavailable")


def preflight(budget, day, first_price, reference_price, confirmed, key, at=None) -> None:
    today = (at or datetime.now(ZoneInfo("Asia/Shanghai"))).date().isoformat()
    try:
        prices_match = (Decimal(str(budget)) == offline.CEILING
                        and Decimal(str(first_price)) == Decimal("0.014")
                        and Decimal(str(reference_price)) == Decimal("0.001"))
    except Exception:
        prices_match = False
    if (not prices_match or day != today or confirmed is not True
            or not isinstance(key, str) or not key or any(c.isspace() for c in key)):
        raise ValueError("Separate approval, same-day price and project key required")


def output_path(value: Path) -> Path:
    if value.is_symlink():
        raise ValueError("Symlink output forbidden")
    output = value.resolve()
    if output.parent != EVIDENCE.resolve():
        raise ValueError("Output must be a direct R7.12 evidence child")
    return output


@contextmanager
def batch_lock(output: Path):
    RUNTIME.mkdir(parents=True, exist_ok=True)
    name = offline.sha256(str(output).encode()) + ".lock"
    fd = os.open(RUNTIME / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def runtime_file(run_id: str) -> Path:
    if not isinstance(run_id, str) or not re.fullmatch(r"[a-f0-9]{32}", run_id):
        raise ValueError("Invalid run ID")
    return RUNTIME / (run_id + ".json")


def checked_task(value) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", value):
        raise ValueError("Invalid task ID")
    return value


def public_cost(data: dict) -> dict:
    result = {}
    for field in ("cost", "input_mp", "output_mp"):
        value = data.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("Invalid price metadata")
        result[field] = value
    offline.safe_cost(data)
    return result


def validate_report(report: dict, plan: dict, mock=False) -> None:
    if (report.get("protocol_id") != PROTOCOL or report.get("mock") is not mock
            or report.get("plan_sha256") != offline.sha256(offline.PLAN.read_bytes())
            or report.get("script_sha256") != offline.sha256(Path(__file__).read_bytes())
            or report.get("approved_budget_usd") != str(offline.CEILING)
            or report.get("segment_limit") not in (2, 8)):
        raise ValueError("Batch version or approval binding mismatch")
    runtime_file(report["run_id"])
    rows = report.get("calls")
    if not isinstance(rows, list) or len(rows) > report["segment_limit"]:
        raise ValueError("Invalid batch rows")
    for index, row in enumerate(rows):
        item = plan["inputs"][index % 4]
        if (row.get("case_id") != offline.ORDER[index]
                or row.get("sample_id") != f"r712-{index + 1:02d}"
                or row.get("reserved_usd") != str(offline.RESERVE)
                or row.get("input_sha256") != item["sha256"]
                or row.get("prompt_sha256") != item["prompt_sha256"]
                or row.get("status") not in ("reserved", "submitted", "succeeded", "failed", "submission_unknown")):
            raise ValueError("Invalid sample or ledger binding")
        for name in ("started_epoch", "elapsed_ms"):
            val = row.get(name)
            if isinstance(val, bool) or not isinstance(val, (int, float)) or not math.isfinite(val) or val < 0:
                raise ValueError("Invalid persisted timer")
    if report.get("reserved_usd") != str(offline.RESERVE * len(rows)):
        raise ValueError("Budget ledger mismatch")


def run_guarded(output: Path, *, key: str, budget=None, day=None, first_price=None,
                reference_price=None, public_confirmed=False, mode="run", client=None, clock=None,
                at=None, mock=False) -> dict:
    plan, photos = offline.frozen_plan()
    if mode not in ("run", "continue", "resume"):
        raise ValueError("Invalid execution mode")
    if mode != "resume":
        preflight(budget, day, first_price, reference_price, public_confirmed, key, at)
    elif not key or any(c.isspace() for c in key):
        raise ValueError("Project key required for read-only recovery")
    output = output_path(output)
    clock = clock or Clock()
    if mock and client is None:
        raise ValueError("Mock evidence requires an injected HTTP substitute")
    with batch_lock(output):
        if mode == "run":
            output.mkdir(exist_ok=False)
            report = {"protocol_id": PROTOCOL, "model": offline.MODEL, "run_id": uuid.uuid4().hex,
                      "mock": mock, "http_substitute": mock, "release_passed": False,
                      "clock_kind": "injected_mock" if mock else "monotonic_and_wall",
                      "billable_requests": 0 if mock else None,
                      "plan_sha256": offline.sha256(offline.PLAN.read_bytes()),
                      "script_sha256": offline.sha256(Path(__file__).read_bytes()),
                      "approved_budget_usd": str(offline.CEILING), "price_verified_on": day,
                      "public_inputs_confirmed": True, "reserved_usd": "0.00", "calls": [],
                      "quality": "NOT_TESTED", "browser_e2e_latency": "NOT_TESTED",
                      "status": "running", "segment_limit": 2}
            state = {"run_id": report["run_id"], "tasks": {}}
            atomic_json(output / "results.json", report)
            atomic_json(runtime_file(report["run_id"]), state)
        else:
            if (output / "results.json").is_symlink():
                raise ValueError("Symlink report forbidden")
            report = json.loads((output / "results.json").read_text())
            validate_report(report, plan, mock)
            if report.get("http_substitute") is not mock:
                raise ValueError("Cannot mix real and substituted HTTP batches")
            private = runtime_file(report["run_id"])
            if private.is_symlink() or private.stat().st_mode & 0o077:
                raise ValueError("Private task state permissions invalid")
            state = json.loads(private.read_text())
            if state.get("run_id") != report["run_id"] or not isinstance(state.get("tasks"), dict):
                raise ValueError("Private task binding mismatch")
            if mode == "continue":
                if (report["status"] != "awaiting_review" or len(report["calls"]) != 2
                        or any(r["status"] != "succeeded" or r["local_total_ms"] > 6000 for r in report["calls"])):
                    raise ValueError("Only reviewed valid first segment may continue")
                report.update(segment_limit=8, status="running")
                report["continued_price_verified_on"] = day
                atomic_json(output / "results.json", report)
        own_client = client is None
        client = client or httpx.Client(transport=httpx.HTTPTransport(retries=0),
                                       timeout=httpx.Timeout(90, connect=10), follow_redirects=False)
        try:
            while True:
                pending = next((r for r in report["calls"]
                                if r["status"] in ("reserved", "submitted", "submission_unknown")
                                or mode == "resume" and r["status"] == "failed"
                                and r["sample_id"] in state["tasks"]), None)
                if mode == "resume" and pending is None:
                    return report
                if pending:
                    row = pending
                    task = state["tasks"].get(row["sample_id"])
                    if not task or task.get("request_sha256") != row.get("request_sha256"):
                        report["status"] = "requires_reconciliation"
                        atomic_json(output / "results.json", report)
                        return report
                    if row.get("task_id") is not None and row["task_id"] != task["id"]:
                        raise ValueError("Task ID binding mismatch")
                    row.update(status="submitted", task_id=checked_task(task["id"]))
                    poll = offline.safe_url(task["polling_url"], "poll")
                    base_elapsed = max(row["elapsed_ms"] / 1000, max(0, clock.wall() - row["started_epoch"]))
                    start = clock.now()
                else:
                    if len(report["calls"]) >= report["segment_limit"]:
                        report["status"] = ("awaiting_review" if report["segment_limit"] == 2
                                            else "mock_completed" if mock else "real_completed")
                        atomic_json(output / "results.json", report)
                        return report
                    index = len(report["calls"])
                    case_id = offline.ORDER[index]
                    start, base_elapsed = clock.now(), 0
                    started_epoch = clock.wall()
                    source = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段7/R7.7图生图小样" / (case_id + ".jpg")
                    photo = source.read_bytes()
                    if offline.sha256(photo) != plan["inputs"][index % 4]["sha256"]:
                        raise ValueError("Photo changed after preflight")
                    body = offline.request_body(photo, case_id)
                    row = {"sample_id": f"r712-{index + 1:02d}", "case_id": case_id,
                           "repeat": index // 4 + 1, "input_sha256": plan["inputs"][index % 4]["sha256"],
                           "prompt_sha256": plan["inputs"][index % 4]["prompt_sha256"],
                           "request_sha256": offline.sha256(json.dumps(body, sort_keys=True).encode()),
                           "reserved_usd": str(offline.RESERVE), "started_epoch": started_epoch,
                           "elapsed_ms": 0, "status": "reserved", "prepare_ms": (clock.now() - start) * 1000,
                           "poll_count": 0, "poll_elapsed_ms": 0}
                    report["calls"].append(row)
                    report["reserved_usd"] = str(offline.RESERVE * len(report["calls"]))
                    atomic_json(output / "results.json", report)
                stage = "submit" if not pending else "poll"
                try:
                    if not pending:
                        before = clock.now()
                        response = client.post(offline.ENDPOINT, json=body, headers={"x-key": key})
                        response.raise_for_status()
                        data = response.json()
                        task_id = checked_task(data["id"])
                        poll = offline.safe_url(data["polling_url"], "poll")
                        state["tasks"][row["sample_id"]] = {"id": task_id, "polling_url": poll,
                                                           "request_sha256": row["request_sha256"]}
                        atomic_json(runtime_file(report["run_id"]), state)
                        row.update(status="submitted", task_id=task_id, submit_ms=(clock.now() - before) * 1000,
                                   elapsed_ms=(clock.now() - start) * 1000)
                        row["deadline_exceeded"] = row["elapsed_ms"] > 8000
                        atomic_json(output / "results.json", report)
                        row["reported_metadata"] = public_cost(data)
                    stage = "poll"
                    observation_start = clock.now() if pending else start
                    ready = None
                    while clock.now() - observation_start < 90:
                        clock.sleep(0.5)
                        before = clock.now()
                        response = client.get(offline.safe_url(poll, "poll"), headers={"x-key": key})
                        response.raise_for_status()
                        data = response.json()
                        row["reported_metadata"] = {**row.get("reported_metadata", {}), **public_cost(data)}
                        row["poll_count"] = row.get("poll_count", 0) + 1
                        row["poll_elapsed_ms"] += (clock.now() - before + 0.5) * 1000
                        row["elapsed_ms"] = (base_elapsed + clock.now() - start) * 1000
                        row["deadline_exceeded"] = row["elapsed_ms"] > 8000
                        atomic_json(output / "results.json", report)
                        if data["status"] == "Ready":
                            ready = offline.safe_url(data["result"]["sample"], "download")
                            break
                        if data["status"] not in ("Pending", "Processing"):
                            raise ValueError("Task failed, moderated or status unknown")
                    if ready is None:
                        report["status"] = "awaiting_status"
                        atomic_json(output / "results.json", report)
                        return report
                    stage = "download"
                    before = clock.now()
                    raw = bytearray()
                    with client.stream("GET", ready) as response:
                        response.raise_for_status()
                        if response.is_redirect:
                            raise ValueError("Image redirect forbidden")
                        for chunk in response.iter_bytes():
                            raw.extend(chunk)
                            if len(raw) > offline.MAX_BYTES:
                                raise ValueError("Image download too large")
                    row["download_ms"] = (clock.now() - before) * 1000
                    stage = "decode_save"
                    before = clock.now()
                    suffix = offline.checked_image(bytes(raw))
                    artifact = ("mock-" if mock else "") + row["sample_id"] + "." + suffix
                    destination = output / artifact
                    temporary = destination.with_name(destination.name + "." + uuid.uuid4().hex + ".tmp")
                    if destination.is_symlink():
                        raise ValueError("Symlink image artifact forbidden")
                    if destination.exists():
                        if offline.sha256(destination.read_bytes()) != offline.sha256(raw):
                            raise ValueError("Existing artifact does not match original task")
                    else:
                        try:
                            with temporary.open("xb") as stream:
                                stream.write(raw)
                                stream.flush()
                                os.fsync(stream.fileno())
                            temporary.replace(destination)
                        finally:
                            temporary.unlink(missing_ok=True)
                    row.update(status="succeeded", artifact=artifact, output_sha256=offline.sha256(raw),
                               output_bytes=len(raw), decode_save_ms=(clock.now() - before) * 1000,
                               local_total_ms=(base_elapsed + clock.now() - start) * 1000)
                    row["elapsed_ms"] = row["local_total_ms"]
                    row["deadline_exceeded"] = row["local_total_ms"] > 8000
                    if row["local_total_ms"] > 6000:
                        report["status"] = "stopped_over_8s" if row["deadline_exceeded"] else "stopped_insufficient_margin"
                        atomic_json(output / "results.json", report)
                        return report
                    atomic_json(output / "results.json", report)
                    if mode == "resume":
                        count = len(report["calls"])
                        report["status"] = ("awaiting_review" if count == 2 and report["segment_limit"] == 2
                                            else ("mock_completed" if mock else "real_completed") if count == 8
                                            else "stopped_incomplete")
                        atomic_json(output / "results.json", report)
                        return report
                except Exception as exc:
                    row["failure_stage"] = stage
                    row["error_type"] = type(exc).__name__
                    row["status"] = "submission_unknown" if stage == "submit" and row["status"] == "reserved" else "failed"
                    report["status"] = "stopped_after_failure"
                    atomic_json(output / "results.json", report)
                    return report
        finally:
            if own_client:
                client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--run", action="store_true")
    modes.add_argument("--continue-after-review", action="store_true")
    modes.add_argument("--resume-status", action="store_true")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--approved-budget-usd")
    parser.add_argument("--price-verified-on")
    parser.add_argument("--verified-first-output-mp-usd")
    parser.add_argument("--verified-reference-mp-usd")
    parser.add_argument("--public-inputs-confirmed", action="store_true")
    args = parser.parse_args()
    try:
        plan, _ = offline.frozen_plan()
        mode = "run" if args.run else "continue" if args.continue_after_review else "resume" if args.resume_status else None
        if mode is None:
            if args.output or args.approved_budget_usd or args.public_inputs_confirmed:
                raise ValueError("Execution options require explicit mode")
            print(json.dumps({"mode": "dry_run", "model": offline.MODEL, "first_segment_count": 2,
                              "maximum_generations": 8, "proposed_ceiling_usd": str(offline.CEILING),
                              "real_execution_authorized": False, "billable_requests": 0}))
            return 0
        if args.output is None:
            raise ValueError("Output required")
        # Reject missing or invalid paid guards before reading the project key.
        if mode != "resume":
            preflight(args.approved_budget_usd, args.price_verified_on, args.verified_first_output_mp_usd,
                      args.verified_reference_mp_usd, args.public_inputs_confirmed, "guard-only")
        report = run_guarded(args.output, mode=mode, key=project_key(),
                             budget=args.approved_budget_usd, day=args.price_verified_on,
                             first_price=args.verified_first_output_mp_usd,
                             reference_price=args.verified_reference_mp_usd,
                             public_confirmed=args.public_inputs_confirmed)
        print(json.dumps({"mode": mode, "status": report["status"], "cases": len(report["calls"]),
                          "reserved_usd": report["reserved_usd"], "release_passed": False}))
        return 0 if report["status"] in ("awaiting_review", "real_completed") else 2
    except Exception as exc:
        print(json.dumps({"status": "refused", "error_type": type(exc).__name__}))
        return 2


if __name__ == "__main__":
    sys.exit(main())
