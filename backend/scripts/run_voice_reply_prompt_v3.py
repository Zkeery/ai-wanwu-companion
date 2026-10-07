"""Freeze and optionally run a separate paid batch for the voice style v3 prompt.

Default and --offline-check make zero provider requests. --run requires a new
batch-specific approval; the first batch's files and allowance are untouched.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import sys
import time
from unittest.mock import patch
from zoneinfo import ZoneInfo

PROJECT = Path(__file__).resolve().parents[2]
BACKEND = PROJECT / "backend"
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段5"
PRICE_PATH = EVIDENCE / "真实回复v3价格核对.json"
MANIFEST_PATH = EVIDENCE / "真实回复v3运行配置.json"
RESULT_PATH = EVIDENCE / "真实回复v3原始结果.json"
MODEL = "qwen3.8-flash"
BASE_URL = "https://maas-api.antdigital.com/v1"
PRICE_URL = "https://maas.antdigital.com/api/v1/model-service/public/page-list"
MAX_INPUT_BYTES = 9000
MAX_OUTPUT_TOKENS = 1024
RESERVE_INPUT_PRICE = Decimal("2.1")
OUTPUT_PRICE = Decimal("2.7")
BUDGET_CNY = Decimal("0.20")


def prepare_cases():
    """Reuse V01–V08 inputs while freezing both pre-style and sent messages."""
    from scripts import run_voice_reply_smoke as first
    from app.services.voice_reply import voice_dialogue_messages

    prepared = []
    for case in first.prepare_cases():
        sent = voice_dialogue_messages(case["messages"], style_version="v3")
        ceiling = len(json.dumps(sent, ensure_ascii=False).encode("utf-8")) + 256
        if ceiling > MAX_INPUT_BYTES:
            raise SystemExit(f"{case['case_id']} exceeds the reviewed input limit; no call made")
        reserve = (Decimal(ceiling) * RESERVE_INPUT_PRICE
                   + Decimal(MAX_OUTPUT_TOKENS) * OUTPUT_PRICE) / Decimal(1_000_000)
        prepared.append(dict(case_id=case["case_id"], user_text=case["user_text"],
            base_messages=case["messages"], messages=sent, input_token_ceiling=ceiling,
            reserved_cny=str(reserve)))
    if len(prepared) != 8 or sum(Decimal(c["reserved_cny"]) for c in prepared) > BUDGET_CNY:
        raise SystemExit("Case count or reserve changed; no call made")
    return prepared


def check_price_today():
    import httpx

    snapshot = json.loads(PRICE_PATH.read_text(encoding="utf-8"))
    now = datetime.now(timezone.utc)
    checked_at = datetime.fromisoformat(snapshot["checked_at_utc"].replace("Z", "+00:00"))
    today = now.astimezone(ZoneInfo("Asia/Shanghai")).date()
    if (checked_at.astimezone(ZoneInfo("Asia/Shanghai")).date() != today
            or snapshot["source"] != PRICE_URL
            or snapshot.get("model_id") != "modelservice-1788174495570001431"
            or snapshot.get("model") != MODEL
            or snapshot.get("catalog_status") != "RELEASED"
            or snapshot.get("currency") != "CNY"
            or snapshot.get("unit") != "million_tokens"
            or Decimal(str(snapshot.get("input_cny_per_million"))) != Decimal("0.8")
            or Decimal(str(snapshot.get("output_cny_per_million"))) != OUTPUT_PRICE):
        raise SystemExit("Price snapshot is not from today; no call made")
    try:
        response = httpx.get(PRICE_URL, timeout=httpx.Timeout(10.0, connect=5.0))
    except (httpx.ConnectTimeout, httpx.ReadTimeout):
        age_seconds = (now - checked_at).total_seconds()
        if not 0 <= age_seconds <= 3600:
            raise SystemExit("Official catalog timed out and price snapshot is older than 60 minutes; no call made")
        return dict(checked_at_utc=snapshot["checked_at_utc"],
                    catalog_updated_time=snapshot["catalog_updated_time"],
                    input_cny_per_million="0.8", output_cny_per_million=str(OUTPUT_PRICE),
                    source="same_day_snapshot_after_catalog_timeout", snapshot_age_seconds=round(age_seconds))
    response.raise_for_status()
    catalog = response.json()
    matches = [item for item in catalog.get("data", {}).get("items", []) if item.get("name") == MODEL]
    if len(matches) != 1 or matches[0].get("status") != "RELEASED":
        raise SystemExit("Model catalog entry changed; no call made")
    model = matches[0]
    if model.get("uniqueId") != snapshot["model_id"]:
        raise SystemExit("Model catalog identity changed; no call made")
    prices = model.get("priceInfo", {}).get("prices", [])
    if len(prices) != 1 or prices[0].get("priceCurrency") != "CNY":
        raise SystemExit("Model price structure changed; no call made")
    rates = {row["priceCode"]: (Decimal(row["priceValue"]), row.get("unitCode"))
             for row in prices[0].get("price", [])}
    if rates.get("INPUT") != (Decimal("0.8"), "M_TOKENS") or rates.get("OUTPUT") != (OUTPUT_PRICE, "M_TOKENS"):
        raise SystemExit("Current price differs from reviewed snapshot; no call made")
    return dict(checked_at_utc=datetime.now(timezone.utc).isoformat(),
                catalog_updated_time=model.get("updatedTime"), input_cny_per_million="0.8",
                output_cny_per_million=str(OUTPUT_PRICE), source="live_catalog")


def write_json(path, value):
    staged = path.with_suffix(path.suffix + ".tmp")
    staged.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(staged, path)


def manifest_for(cases):
    sources = ["app/services/chat.py", "app/services/voice.py", "app/services/voice_reply.py",
               "app/services/model_client.py", "scripts/run_voice_reply_smoke.py",
               "scripts/run_voice_reply_prompt_v3.py"]
    absolute = (Decimal(MAX_INPUT_BYTES) * RESERVE_INPUT_PRICE
        + Decimal(MAX_OUTPUT_TOKENS) * OUTPUT_PRICE) * len(cases) / Decimal(1_000_000)
    if absolute > BUDGET_CNY:
        raise SystemExit("Absolute reserve exceeds batch budget; no call made")
    return dict(batch="voice-reply-style-v3-2026-09-24", style_version="v3",
        model=MODEL, provider=BASE_URL, case_count=len(cases), max_input_bytes=MAX_INPUT_BYTES,
        max_output_tokens=MAX_OUTPUT_TOKENS, max_retries=0, timeout_seconds=30,
        conservative_input_cny_per_million=str(RESERVE_INPUT_PRICE),
        output_cny_per_million=str(OUTPUT_PRICE), budget_cny=str(BUDGET_CNY),
        absolute_reserve_cny=str(absolute),
        prepared_reserve_cny=str(sum(Decimal(c["reserved_cny"]) for c in cases)),
        approval_required=True, original_batch="voice-reply-first-2026-09-24",
        cases=[{k: v for k, v in c.items() if k != "base_messages"} for c in cases],
        source_sha256={f: hashlib.sha256((BACKEND / f).read_bytes()).hexdigest() for f in sources})


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--offline-check", action="store_true")
    modes.add_argument("--run", action="store_true", help="Paid calls: requires separate style-v3 approval")
    args = parser.parse_args()
    sys.path.insert(0, str(BACKEND))
    cases = prepare_cases()
    manifest = manifest_for(cases)
    if MANIFEST_PATH.exists():
        if json.loads(MANIFEST_PATH.read_text(encoding="utf-8")) != manifest:
            raise SystemExit("Frozen v3 manifest differs from current code or prompts; no call made")
    else:
        write_json(MANIFEST_PATH, manifest)
    if RESULT_PATH.exists():
        if args.run:
            raise SystemExit("Prior v3 result exists; repeat batch blocked")
        print(json.dumps(dict(mode="already_executed", calls=0, batch=manifest["batch"])))
        return
    if not args.run and not args.offline_check:
        print(json.dumps(dict(mode="dry_run", calls=0, cases=len(cases),
                              absolute_reserve_cny=manifest["absolute_reserve_cny"])))
        return

    os.environ["APP_ENV"] = "development"
    os.environ["VOICE_LIVE_REPLY_ENABLED"] = "true"
    if args.offline_check:
        os.environ["MODEL_BASE_URL"] = BASE_URL
        os.environ["MODEL_API_KEY"] = "offline-fixture-not-a-secret"
        os.environ["CHAT_MODEL"] = MODEL
        os.environ.pop("MODEL_ENABLE_THINKING", None)
    from app.core.config import get_settings
    from app.services.model_client import ModelClient
    from app.services.voice_reply import configured_reply

    get_settings.cache_clear()
    settings = get_settings()
    if (settings.model_base_url != BASE_URL or settings.chat_model != MODEL or settings.use_mock
            or settings.model_enable_thinking is not None or not settings.voice_live_reply_enabled):
        raise SystemExit("Configured model or options differ from v3 batch; no call made")
    import httpx
    if args.offline_check:
        payloads = []

        def fake_post(_self, payload, _settings):
            payloads.append(payload)
            return "离线替身，不代表实际口语效果。"

        with (patch.object(ModelClient, "_post_chat_completions", fake_post),
              patch.object(httpx.Client, "post", side_effect=RuntimeError("offline check forbids network"))):
            replies = [configured_reply(c["base_messages"], style_version="v3") for c in cases]
        if (len(payloads) != len(cases) or not all(replies)
                or any(p["messages"] != case["messages"] or p.get("model") != MODEL
                       or p.get("max_tokens") != MAX_OUTPUT_TOKENS or p.get("stream") is not False
                       for p, case in zip(payloads, cases))):
            raise SystemExit("V3 offline payload check failed")
        print(json.dumps(dict(mode="offline_check", external_calls=0, fixture_calls=len(payloads),
                              absolute_reserve_cny=manifest["absolute_reserve_cny"])))
        return

    price = check_price_today()
    results = dict(batch=manifest["batch"], style_version=manifest["style_version"], model=MODEL,
        started_at_utc=datetime.now(timezone.utc).isoformat(), price_check=price,
        absolute_reserve_cny=manifest["absolute_reserve_cny"], cases=[])
    with RESULT_PATH.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(results, ensure_ascii=False, indent=2) + "\n")

    original_post = httpx.Client.post
    outbound = 0
    current = None

    def guarded_post(client, url, *post_args, **kwargs):
        nonlocal outbound
        payload = kwargs.get("json") or {}
        if (str(url) != BASE_URL + "/chat/completions" or post_args or outbound >= len(cases)
                or payload.get("model") != MODEL or payload.get("stream") is not False
                or payload.get("max_tokens") != MAX_OUTPUT_TOKENS or payload.get("messages") != current["messages"]
                or len(json.dumps(payload["messages"], ensure_ascii=False).encode("utf-8")) + 256
                > current["input_token_ceiling"]):
            raise RuntimeError("Unapproved v3 request blocked")
        outbound += 1
        response = original_post(client, url, *post_args, **kwargs)
        current["http_status"] = response.status_code
        try:
            body = response.json()
            if isinstance(body, dict):
                usage = body.get("usage")
                if isinstance(usage, dict):
                    current["usage"] = {key: value for key, value in usage.items()
                                        if key in {"prompt_tokens", "completion_tokens", "total_tokens"}
                                        and type(value) is int and value >= 0}
                current["returned_model"] = body.get("model") if isinstance(body.get("model"), str) else None
        except (ValueError, TypeError):
            pass
        return response

    with patch.object(httpx.Client, "post", guarded_post):
        for case in cases:
            current = dict(case_id=case["case_id"], messages=case["messages"],
                input_token_ceiling=case["input_token_ceiling"], reserved_cny=case["reserved_cny"],
                status="in_flight")
            results["cases"].append(current)
            write_json(RESULT_PATH, results)
            started = time.monotonic()
            try:
                current["reply"] = configured_reply(case["base_messages"], style_version="v3")
                current["status"] = "completed"
            except Exception as exc:
                current["status"] = "failed"
                current["error_type"] = type(exc).__name__
            current["elapsed_seconds"] = round(time.monotonic() - started, 3)
            write_json(RESULT_PATH, results)
            if current["status"] != "completed":
                break
    results["finished_at_utc"] = datetime.now(timezone.utc).isoformat()
    results["outbound_calls"] = outbound
    write_json(RESULT_PATH, results)
    print(json.dumps(dict(mode="run", completed=sum(c["status"] == "completed" for c in results["cases"]),
                          outbound_calls=outbound, result=str(RESULT_PATH))))


if __name__ == "__main__":
    main()
