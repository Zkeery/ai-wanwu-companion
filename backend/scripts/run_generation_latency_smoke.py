"""One isolated generation latency smoke; dry-run by default.

--run requires explicit approval for this batch. --offline-check exercises the
same API and cost guards with synthetic HTTP responses and zero provider calls.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import tempfile
from threading import Lock, Thread
import time

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "docs/PRD/版本/V1.0/验收证据/前端阶段4"
LABEL = "一只米白色陶瓷杯，带圆形把手"
TEXT_RESERVE = (6000 * 2.1 + 1024 * 2.7) / 1_000_000
CEILING = 2 * TEXT_RESERVE + 0.016


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--run", action="store_true")
    modes.add_argument("--offline-check", action="store_true")
    args = parser.parse_args()
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    source_files = sorted((PROJECT / "backend/app").rglob("*.py")) + [Path(__file__)]
    manifest = {
        "scope": "One synthetic object; isolated database and uploads; real localhost TCP/SSE timing",
        "label": LABEL, "calls": {"vision": 0, "text": 2, "image": 1},
        "models": {"chat": "qwen3.8-flash", "image": "wan2.6-t2i"},
        "budget_cny": 0.05, "preflight_ceiling_cny": CEILING, "max_retries": 0,
        "max_input_text_bytes": 6000, "max_tokens_per_text_call": 1024,
        "image_count": 1, "image_size": "1024x1024", "threshold_seconds": 30,
        "prices": {"chat_input_conservative_cny_per_million": 2.1,
                   "chat_output_cny_per_million": 2.7, "image_cny_each": 0.016},
        "price_evidence": "价格核对.json", "approval_required": True,
        "source_sha256": {str(p.relative_to(PROJECT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files},
        "limitation": "One sample is not a P95 or a causal serial/parallel provider comparison.",
    }
    result_path = EVIDENCE / ("离线冒烟脚本自检.json" if args.offline_check else "真实生成计时结果.json")
    if args.run and result_path.exists():
        raise SystemExit("Existing real result retained; repeat execution blocked.")
    assert CEILING <= manifest["budget_cny"]
    if not args.offline_check:
        (EVIDENCE / "真实生成计时运行配置.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    if not (args.run or args.offline_check):
        print(json.dumps({"dry_run": True, "provider_calls": 0, "ceiling_cny": CEILING}))
        return
    if args.run:
        prices = json.loads((EVIDENCE / "价格核对.json").read_text())
        assert prices["verified"] is True and prices["date"] == time.strftime("%Y-%m-%d"), "Recheck current prices before calling provider"
        assert prices["input_cny_per_million"] <= 2.1 and prices["output_cny_per_million"] <= 2.7
        assert prices["image_cny_each"] <= 0.016
        # Exclusive creation is also a cross-process lock. Failed runs stay here.
        with result_path.open("x") as out:
            out.write('{"passed":false,"status":"started"}\n')

    sys.path.insert(0, str(PROJECT / "backend"))
    (PROJECT / ".runtime").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="latency-smoke-", dir=PROJECT / ".runtime") as tmp:
        os.environ["DATABASE_URL"] = f"sqlite:///{tmp}/smoke.db"
        os.environ["UPLOAD_DIR"] = f"{tmp}/uploads"
        os.environ["MODEL_MAX_RETRIES"] = "0"
        if args.offline_check:
            os.environ["MODEL_API_KEY"] = "offline-fixture-not-a-secret"
            os.environ["MODEL_BASE_URL"] = "https://maas-api.antdigital.com/v1"
            os.environ["IMAGE_BASE_URL"] = "https://maas-api.antdigital.com/v1"
            os.environ["CHAT_MODEL"] = "qwen3.8-flash"
            os.environ["IMAGE_MODEL"] = "wan2.6-t2i"
        from app.core.config import get_settings
        settings = get_settings()
        assert not settings.use_mock
        assert settings.model_base_url == "https://maas-api.antdigital.com/v1"
        assert (settings.image_base_url or settings.model_base_url) == settings.model_base_url
        assert settings.chat_model == manifest["models"]["chat"] and settings.image_model == manifest["models"]["image"]
        import httpx
        import uvicorn
        original_post = httpx.Client.post
        lock = Lock()
        counts = Counter()
        origin = time.perf_counter()
        result = {"mock": args.offline_check, "manifest": manifest,
                  "calls": [], "checks": {}, "passed": False}

        def persist():
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

        def bounded_post(client, url, **kwargs):
            if not str(url).startswith(settings.model_base_url + "/"):
                return original_post(client, url, **kwargs)
            payload = kwargs.get("json", {})
            model = payload.get("model")
            with lock:
                limits = {settings.chat_model: 2, settings.image_model: 1}
                assert model in limits and counts[model] < limits[model], "Unexpected provider call blocked"
                is_image = model == settings.image_model
                assert str(url) == settings.model_base_url + ("/images/generations" if is_image else "/chat/completions")
                if is_image:
                    assert payload["n"] == 1 and payload["size"] == "1024x1024"
                else:
                    assert len(json.dumps(payload["messages"], ensure_ascii=False).encode()) <= 6000
                    payload["max_tokens"] = 1024
                reserve = 0.016 if is_image else TEXT_RESERVE
                assert sum(c["reserved_cny"] for c in result["calls"]) + reserve <= 0.05
                counts[model] += 1
                kind = "image" if is_image else "persona" if counts[model] == 1 else "opening"
                call = {"kind": kind, "model": model, "reserved_cny": reserve,
                        "start_seconds": time.perf_counter() - origin}
                result["calls"].append(call)
                persist()
            try:
                if args.offline_check:
                    import base64
                    time.sleep(0.1)
                    if is_image:
                        from run_creation_smoke import synthetic_cup
                        data = {"data": [{"b64_json": base64.b64encode(synthetic_cup()).decode()}]}
                    else:
                        content = json.dumps({"name": "合成小杯", "persona": "一只温柔的杯子"}, ensure_ascii=False) if kind == "persona" else "嗨，我是合成小杯。"
                        data = {"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 100, "completion_tokens": 30}}
                    response = httpx.Response(200, json=data, request=httpx.Request("POST", url))
                else:
                    response = original_post(client, url, **kwargs)
                with lock:
                    call["http_status"] = response.status_code
                    if response.status_code == 200:
                        call["usage"] = response.json().get("usage")
                return response
            except Exception as exc:
                with lock:
                    call["error_type"] = type(exc).__name__
                raise
            finally:
                with lock:
                    call["end_seconds"] = time.perf_counter() - origin
                    call["seconds"] = call["end_seconds"] - call["start_seconds"]
                    persist()

        httpx.Client.post = bounded_post
        sock = socket.socket()
        server = thread = None
        try:
            from app.main import app
            from app.core.database import SessionLocal
            from app.models.models import Photo, Object
            with SessionLocal() as db:
                photo = Photo(filename="synthetic-object-no-photo-upload", status="done")
                db.add(photo)
                db.flush()
                obj = Object(photo_id=photo.id, label=LABEL)
                db.add(obj)
                db.commit()
                oid = obj.id
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
            server = uvicorn.Server(uvicorn.Config(app, log_level="critical"))
            thread = Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
            thread.start()
            deadline = time.monotonic() + 5
            while not server.started and time.monotonic() < deadline:
                time.sleep(0.01)
            assert server.started
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=180) as client:
                start = time.perf_counter()
                event, events, done = "", [], None
                with client.stream("POST", "/api/v1/characters", json={"object_id": oid}) as response:
                    assert response.status_code == 200
                    for line in response.iter_lines():
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            data = json.loads(line[5:])
                            events.append({"event": event, "data": data, "seconds": time.perf_counter() - start})
                            if event == "done":
                                done = data
                                result["generation_seconds"] = time.perf_counter() - start
                result["events"] = events
                assert done and done["status"] == "ready", "Generation did not finish successfully"
                saved = client.get(f"/api/v1/characters/by-object/{oid}").json()
                assert saved == done
                image_file = Path(settings.upload_dir) / saved["image_path"]
                assert image_file.is_file() and image_file.stat().st_size > 256
                if not args.offline_check:
                    artifact = "真实并行生成杯子" + image_file.suffix
                    shutil.copyfile(image_file, EVIDENCE / artifact)
                    result["image_artifact"] = artifact
                result["checks"] = {"ready_and_persisted": True, "image_saved": True,
                                    "within_30_seconds": result["generation_seconds"] <= 30}
                by_kind = {c["kind"]: c for c in result["calls"]}
                a, b = by_kind["opening"], by_kind["image"]
                result["provider_overlap_seconds"] = max(0, min(a["end_seconds"], b["end_seconds"]) - max(a["start_seconds"], b["start_seconds"]))
                result["checks"]["parallel_calls_overlap"] = result["provider_overlap_seconds"] > 0
                result["checks"]["exact_call_counts"] = dict(counts) == {settings.chat_model: 2, settings.image_model: 1}
                result["passed"] = all(result["checks"].values())
        except Exception as exc:
            result["error_type"] = type(exc).__name__
        finally:
            if server:
                server.should_exit = True
            if thread:
                thread.join(185)
            httpx.Client.post = original_post
            sock.close()
            result["reserved_cny"] = sum(c["reserved_cny"] for c in result["calls"])
            result["provider_calls"] = 0 if args.offline_check else sum(counts.values())
            persist()
        print(json.dumps({"passed": result["passed"], "mock": args.offline_check,
                          "provider_calls": result["provider_calls"], "reserved_cny": result["reserved_cny"]}))
        raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
