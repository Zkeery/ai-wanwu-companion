"""One approved video generation; durable reservation, no generation retries."""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sqlite3
import time
from pathlib import Path

import httpx

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段1/R1.6表情与转圈小样"
RUNTIME = PROJECT / ".runtime/motion-r16"
PLAN_SHA = "16a29617d33f4dc2b083d5abcfd61d01370f1fa779e0c4dc7f57567bd1c519f7"
ENDPOINT = "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks"
MODEL = "doubao-seedance-2-0-mini-260615"
RUN = "r16-apple-first"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def frozen_request():
    raw = (EVIDENCE / "trial-plan.json").read_bytes()
    approval = json.loads((EVIDENCE / "本批授权.json").read_text())
    price = json.loads((EVIDENCE / "官方价格摘录.json").read_text())
    if (sha(raw) != PLAN_SHA or approval.get("plan_sha256") != PLAN_SHA
            or approval.get("approved") is not True or approval.get("approved_cap_cny") != 4
            or approval.get("max_generation_posts") != 1
            or price.get("price_cny_per_million_tokens") != 23 or price.get("model") != MODEL):
        raise ValueError("frozen_plan_or_authorization_mismatch")
    plan = json.loads(raw)
    source = (PROJECT / plan["source"]).resolve()
    if not source.is_relative_to(PROJECT) or source.stat().st_size > 10 * 1024 * 1024:
        raise ValueError("source_mismatch")
    data = source.read_bytes()
    if sha(data) != plan["source_sha256"]:
        raise ValueError("source_mismatch")
    request = plan["request"]
    for item in request["content"]:
        if item["type"] == "image_url":
            item["image_url"]["url"] = "data:image/jpeg;base64," + base64.b64encode(data).decode()
    return request


def project_key():
    for line in (PROJECT / ".env").read_text().splitlines():
        if line.startswith("ARK_API_KEY="):
            value = line.partition("=")[2].strip().strip("\"'")
            if value and not any(ch.isspace() for ch in value):
                return value
    raise ValueError("project_key_missing")


def ledger(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=5)
    db.execute("PRAGMA synchronous=FULL")
    db.execute("CREATE TABLE IF NOT EXISTS trial (id TEXT PRIMARY KEY, state TEXT NOT NULL, task_id TEXT, "
               "reserve_cny REAL NOT NULL, started REAL NOT NULL, updated REAL NOT NULL, "
               "provider_code TEXT, tokens INTEGER, estimated_cny REAL)")
    db.commit()
    return db


def status(db):
    db.row_factory = sqlite3.Row
    row = db.execute("SELECT * FROM trial WHERE id=?", (RUN,)).fetchone()
    return dict(row) if row else {"state": "not_submitted"}


def save(db, state, *, task_id=None, code=None, tokens=None):
    db.execute("UPDATE trial SET state=?,task_id=coalesce(?,task_id),updated=?,provider_code=?,"
               "tokens=coalesce(?,tokens),estimated_cny=coalesce(?,estimated_cny) WHERE id=?",
               (state, task_id, time.time(), code, tokens,
                tokens * 23 / 1_000_000 if tokens is not None else None, RUN))
    db.commit()
    return status(db)


def safe_code(response):
    try:
        code = response.json().get("error", {}).get("code", "")
        if isinstance(code, str) and re.fullmatch(r"[A-Z][A-Za-z.]{1,70}", code):
            return code
    except (ValueError, AttributeError):
        pass
    return f"provider_http_{response.status_code}"


def submit(db, client, request, key):
    # The single fixed primary key prevents repeated runs with changed prompts.
    now = time.time()
    try:
        db.execute("INSERT INTO trial VALUES (?,?,NULL,?,?,?,NULL,NULL,NULL)",
                   (RUN, "submitting", 4, now, now))
        db.commit()
    except sqlite3.IntegrityError:
        db.rollback()
        raise ValueError("already_submitted_no_retry") from None
    try:
        response = client.post(ENDPOINT, json=request, headers={"Authorization": f"Bearer {key}"})
        if response.status_code != 200:
            return save(db, "rejected", code=safe_code(response))
        task_id = response.json().get("id")
        if not isinstance(task_id, str) or not re.fullmatch(r"cgt-[A-Za-z0-9-]{4,100}", task_id):
            return save(db, "unknown", code="invalid_task_receipt")
        return save(db, "queued", task_id=task_id)
    except (httpx.HTTPError, ValueError, AttributeError):
        return save(db, "unknown", code="submission_outcome_unknown")


def poll(db, client, key, private_result):
    previous = status(db)
    task_id = previous.get("task_id")
    if not task_id or previous["state"] in {"rejected", "unknown", "failed", "cancelled", "expired"}:
        raise ValueError("no_pollable_task")
    try:
        response = client.get(f"{ENDPOINT}/{task_id}", headers={"Authorization": f"Bearer {key}"})
        if response.status_code != 200:
            return {"state": "poll_error", "provider_code": safe_code(response)}
        data = response.json()
        state = data.get("status")
        if state not in {"queued", "running", "succeeded", "failed", "cancelled", "expired"}:
            return {"state": "poll_error", "provider_code": "invalid_task_status"}
        tokens = data.get("usage", {}).get("completion_tokens")
        if type(tokens) is not int or tokens < 0:
            tokens = None
        if state == "succeeded":
            url = data.get("content", {}).get("video_url")
            if not isinstance(url, str) or not url.startswith("https://"):
                return {"state": "poll_error", "provider_code": "missing_video_url"}
            private_result.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(private_result, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as handle:
                json.dump({"video_url": url, "task_id": task_id}, handle)
        return save(db, state, tokens=tokens, code=safe_code(response) if state == "failed" else None)
    except (httpx.HTTPError, ValueError, AttributeError):
        return {"state": "poll_error", "provider_code": "poll_unavailable"}


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--submit", action="store_true")
    group.add_argument("--poll", action="store_true")
    args = parser.parse_args()
    try:
        request = frozen_request()
        if not args.submit and not args.poll:
            print(json.dumps({"state": "validated", "model": MODEL, "approved_cap_cny": 4,
                              "max_generation_posts": 1, "network_calls": 0}))
            return 0
        key = project_key()
        with ledger(RUNTIME / "trial.db") as db, httpx.Client(timeout=45, follow_redirects=False,
                                                             transport=httpx.HTTPTransport(retries=0)) as client:
            result = (submit(db, client, request, key) if args.submit
                      else poll(db, client, key, RUNTIME / "private-result.json"))
        (EVIDENCE / "运行记录.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (ValueError, OSError, sqlite3.Error):
        print(json.dumps({"error": {"code": "pilot_precondition_failed",
                                    "message": "计划、授权或任务状态不允许本次操作；未自动重试"}}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
