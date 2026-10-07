"""Prepare eight synthetic voice-reply prompts; paid calls require --run and approval.

Default and --offline-check never contact the model provider. Keep any --run
result file, including failed/in-flight rows, so a retry needs a new review.
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
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

PROJECT = Path(__file__).resolve().parents[2]
BACKEND = PROJECT / "backend"
EVIDENCE = PROJECT / "docs/PRD/版本/V1.2/验收证据/阶段5"
PRICE_PATH = EVIDENCE / "真实回复首轮价格核对.json"
MANIFEST_PATH = EVIDENCE / "真实回复首轮运行配置.json"
RESULT_PATH = EVIDENCE / "真实回复首轮原始结果.json"
MODEL = "qwen3.8-flash"
BASE_URL = "https://maas-api.antdigital.com/v1"
PRICE_URL = "https://maas.antdigital.com/api/v1/model-service/public/page-list"
MAX_INPUT_BYTES = 9000
MAX_OUTPUT_TOKENS = 1024
BUDGET_CNY = Decimal("0.20")
RESERVE_INPUT_PRICE = Decimal("2.1")
OUTPUT_PRICE = Decimal("2.7")

CASES = [
    dict(id="V01", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="今天想和你聊聊窗边的薄荷。"),
    dict(id="V02", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="你好，我今天有点累。"),
    dict(id="V03", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="我今天有点累，但我把现在的心情纠正为平静，想听你说一句晚安。", mood="calm"),
    dict(id="V04", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="我今天有点累，先随便聊聊。", automatic=False),
    dict(id="V05", persona="一只活泼、好奇的小石头伙伴。", text="我今天有点难过，不想听玩笑，只想有人听我说话。"),
    dict(id="V06", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="请种一棵树吧。", actions={"plant_tree"}),
    dict(id="V07", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="你知道我昨晚去了哪里吗？"),
    dict(id="V08", persona="一只温柔、沉稳、愿意倾听的陶瓷杯伙伴。", text="我刚才说的薄荷叫什么？",
         history=[("user", "我的薄荷叫小绿。"), ("assistant", "小绿这个名字真好记。")]),
]


def prepare_cases():
    """Use production prompt and mood assembly with an in-memory preference DB."""
    from sqlalchemy import create_engine, insert
    from sqlalchemy.orm import Session
    from app.living.store import metadata
    from app.services.chat import build_messages
    from app.services.voice import append_mood_context, preferences

    engine = create_engine("sqlite://")
    metadata.create_all(engine, tables=[preferences])
    prepared = []
    for index, case in enumerate(CASES, 1):
        history = [SimpleNamespace(role=role, content=content) for role, content in case.get("history", [])]
        character = SimpleNamespace(name="暖杯" if index != 5 else "小石头", persona=case["persona"])
        messages = build_messages(character, [], history, case["text"],
            {"rain": 0, "tree": 0, "cloud": 0, "sound": 1}, case.get("actions", set()))
        with Session(engine) as db:
            db.execute(insert(preferences).values(character_id=index, owner_id="synthetic-evaluation",
                voice="Tingting", mood=case.get("mood"), automatic=int(case.get("automatic", True)),
                mood_source="user" if case.get("mood") else "none"))
            append_mood_context(db, "synthetic-evaluation", index, messages)
            db.commit()
        input_ceiling = len(json.dumps(messages, ensure_ascii=False).encode("utf-8")) + 256
        if input_ceiling > MAX_INPUT_BYTES:
            raise SystemExit(f"{case['id']} prompt exceeds the frozen input ceiling; no call made")
        reserve = (Decimal(input_ceiling) * RESERVE_INPUT_PRICE
                   + Decimal(MAX_OUTPUT_TOKENS) * OUTPUT_PRICE) / Decimal(1_000_000)
        prepared.append(dict(case_id=case["id"], user_text=case["text"], messages=messages,
            input_token_ceiling=input_ceiling, reserved_cny=str(reserve)))
    if len(prepared) != 8 or sum(Decimal(x["reserved_cny"]) for x in prepared) > BUDGET_CNY:
        raise SystemExit("Frozen count or budget exceeded; no call made")
    return prepared


def check_price_today():
    """Require the same live public catalog price on the day of a paid run."""
    import httpx

    snapshot = json.loads(PRICE_PATH.read_text(encoding="utf-8"))
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()
    if snapshot["checked_at_utc"][:10] != today or snapshot["source"] != PRICE_URL:
        raise SystemExit("Price snapshot is not from today; no call made")
    response = httpx.get(PRICE_URL, timeout=httpx.Timeout(10.0, connect=5.0))
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
        raise SystemExit("Current price differs from the reviewed snapshot; no call made")
    return dict(catalog_updated_time=model.get("updatedTime"), checked_at_utc=datetime.now(timezone.utc).isoformat(),
                input_cny_per_million="0.8", output_cny_per_million=str(OUTPUT_PRICE))


def write_json(path, value):
    staged = path.with_suffix(path.suffix + ".tmp")
    staged.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(staged, path)


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--offline-check", action="store_true")
    modes.add_argument("--run", action="store_true", help="Paid calls: use only after this batch is approved")
    args = parser.parse_args()
    sys.path.insert(0, str(BACKEND))
    prepared = prepare_cases()
    absolute_ceiling = (Decimal(MAX_INPUT_BYTES) * RESERVE_INPUT_PRICE
        + Decimal(MAX_OUTPUT_TOKENS) * OUTPUT_PRICE) * len(prepared) / Decimal(1_000_000)
    if absolute_ceiling > BUDGET_CNY:
        raise SystemExit("Absolute cost ceiling exceeds budget; no call made")
    source_files = ["app/services/chat.py", "app/services/voice.py", "app/services/voice_reply.py",
                    "app/services/model_client.py", "scripts/run_voice_reply_smoke.py"]
    manifest = dict(batch="voice-reply-first-2026-09-24", mode="exploratory_smoke", model=MODEL,
        provider=BASE_URL, case_count=len(prepared), max_input_bytes=MAX_INPUT_BYTES,
        max_output_tokens=MAX_OUTPUT_TOKENS, max_retries=0, timeout_seconds=30,
        conservative_input_cny_per_million=str(RESERVE_INPUT_PRICE), output_cny_per_million=str(OUTPUT_PRICE),
        budget_cny=str(BUDGET_CNY), absolute_reserve_cny=str(absolute_ceiling),
        prepared_reserve_cny=str(sum(Decimal(x["reserved_cny"]) for x in prepared)),
        price_snapshot=str(PRICE_PATH.relative_to(PROJECT)), approval_required=True, cases=prepared,
        source_sha256={f: hashlib.sha256((BACKEND / f).read_bytes()).hexdigest() for f in source_files})
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    write_json(MANIFEST_PATH, manifest)

    if not args.run and not args.offline_check:
        print(json.dumps(dict(mode="dry_run", calls=0, cases=len(prepared),
                              absolute_reserve_cny=str(absolute_ceiling))))
        return

    # The real test instance and user data remain untouched. Only this process
    # sees the enablement flag. Offline check replaces all credentials in memory.
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
        raise SystemExit("Configured provider/model/options differ from frozen batch; no call made")

    if args.offline_check:
        import httpx
        calls = []

        def fake_post(_self, payload, _settings):
            calls.append(payload)
            return "离线替身：我愿意听你说。"

        with (patch.object(ModelClient, "_post_chat_completions", fake_post),
              patch.object(httpx.Client, "post", side_effect=RuntimeError("offline check forbids network"))):
            replies = [configured_reply(case["messages"]) for case in prepared]
        if (len(calls) != 8 or any(p.get("max_tokens") != MAX_OUTPUT_TOKENS or p.get("stream") is not False
                                    or p.get("model") != MODEL for p in calls)
                or any(not reply for reply in replies)):
            raise SystemExit("Offline reply boundary failed")
        print(json.dumps(dict(mode="offline_check", external_calls=0, fixture_calls=len(calls),
                              absolute_reserve_cny=str(absolute_ceiling))))
        return

    if RESULT_PATH.exists():
        raise SystemExit("Prior paid result exists; repeat batch blocked")
    price_today = check_price_today()
    results = dict(batch=manifest["batch"], model=MODEL, provider=BASE_URL,
                   started_at_utc=datetime.now(timezone.utc).isoformat(), price_check=price_today,
                   absolute_reserve_cny=str(absolute_ceiling), cases=[])
    # Exclusive file creation blocks concurrent or accidental reruns, even if
    # this process crashes while the first HTTP request is in flight.
    with RESULT_PATH.open("x", encoding="utf-8") as handle:
        handle.write(json.dumps(results, ensure_ascii=False, indent=2) + "\n")

    import httpx
    original_post = httpx.Client.post
    outbound = 0
    current = None

    def guarded_post(client, url, *post_args, **kwargs):
        nonlocal outbound
        payload = kwargs.get("json") or {}
        if (str(url) != BASE_URL + "/chat/completions" or post_args or outbound >= len(prepared)
                or payload.get("model") != MODEL or payload.get("stream") is not False
                or payload.get("max_tokens") != MAX_OUTPUT_TOKENS or payload.get("messages") != current["messages"]
                or len(json.dumps(payload["messages"], ensure_ascii=False).encode("utf-8")) + 256
                > current["input_token_ceiling"]):
            raise RuntimeError("Unapproved provider request blocked")
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
        for case in prepared:
            current = dict(case_id=case["case_id"], messages=case["messages"],
                           input_token_ceiling=case["input_token_ceiling"],
                           reserved_cny=case["reserved_cny"], status="in_flight")
            results["cases"].append(current)
            write_json(RESULT_PATH, results)
            started = time.monotonic()
            try:
                reply = configured_reply(case["messages"])
                current["reply"] = reply
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
    print(json.dumps(dict(mode="run", completed=sum(r["status"] == "completed" for r in results["cases"]),
                          outbound_calls=outbound, result=str(RESULT_PATH))))


if __name__ == "__main__":
    main()
