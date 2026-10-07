"""One non-thinking candidate: generation and three chats; dry-run by default.

--run requires explicit approval for this batch. --offline-check exercises the
same API and cost guards with synthetic HTTP responses and zero provider calls.
"""
import argparse
from collections import Counter
from contextlib import contextmanager
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
EVIDENCE = PROJECT / "docs/PRD/版本/V1.1/验收证据/网页体验整改"
LABEL = "一只米白色陶瓷杯，带圆形把手"
TEXT_RESERVE = (6000 * 2.1 + 1024 * 2.7) / 1_000_000
CEILING = 5 * TEXT_RESERVE + 0.016


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
        "label": LABEL, "calls": {"vision": 0, "text": 5, "image": 1},
        "models": {"chat": "qwen3.8-flash", "image": "wan2.6-t2i"},
        "budget_cny": 0.10, "preflight_ceiling_cny": CEILING, "max_retries": 0,
        "max_input_text_bytes": 6000, "max_tokens_per_text_call": 1024,
        "image_count": 1, "image_size": "1024x1024", "threshold_seconds": 30, "enable_thinking": False,
        "chat_cases": ["今天工作有点累，只想找你聊聊。", "种一簇花", "不要加水池，陪我聊会儿。"],
        "prices": {"chat_input_conservative_cny_per_million": 2.1,
                   "chat_output_cny_per_million": 2.7, "image_cny_each": 0.016},
        "price_evidence": "价格核对.json", "approval_required": True,
        "source_sha256": {str(p.relative_to(PROJECT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files},
        "limitation": "One sample is not a P95 or a causal serial/parallel provider comparison.",
    }
    result_path = EVIDENCE / ("非思考模式离线自检.json" if args.offline_check else "非思考模式真实结果.json")
    if args.run and result_path.exists():
        raise SystemExit("Existing real result retained; repeat execution blocked.")
    assert CEILING <= manifest["budget_cny"]
    if not args.offline_check:
        (EVIDENCE / "非思考模式运行配置.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
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
        os.environ["MODEL_ENABLE_THINKING"] = "false"
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
        original_stream = httpx.Client.stream
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
                    assert payload.get("enable_thinking") is False
                    payload["max_tokens"] = 1024
                reserve = 0.016 if is_image else TEXT_RESERVE
                assert sum(c["reserved_cny"] for c in result["calls"]) + reserve <= 0.10
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

        @contextmanager
        def bounded_stream(client, method, url, **kwargs):
            if not str(url).startswith(settings.model_base_url + "/"):
                with original_stream(client, method, url, **kwargs) as response:
                    yield response
                return
            payload = kwargs.get("json", {})
            with lock:
                assert method == "POST" and str(url) == settings.model_base_url + "/chat/completions"
                assert payload.get("model") == settings.chat_model and 2 <= counts[settings.chat_model] < 5
                assert payload.get("enable_thinking") is False and payload.get("stream") is True
                assert len(json.dumps(payload["messages"], ensure_ascii=False).encode()) <= 6000
                assert sum(c["reserved_cny"] for c in result["calls"]) + TEXT_RESERVE <= 0.10
                payload["max_tokens"] = 1024
                payload["stream_options"] = {"include_usage": True}
                counts[settings.chat_model] += 1
                call = {"kind": f"chat_{counts[settings.chat_model] - 2}", "model": settings.chat_model,
                        "reserved_cny": TEXT_RESERVE, "start_seconds": time.perf_counter() - origin,
                        "reasoning_chunks": 0}
                result["calls"].append(call)
                persist()

            class ObservedResponse:
                def __init__(self, response):
                    self.response = response

                def raise_for_status(self):
                    self.response.raise_for_status()

                def iter_lines(self):
                    for line in self.response.iter_lines():
                        if line.startswith("data:") and line[5:].strip() != "[DONE]":
                            chunk = json.loads(line[5:])
                            if chunk.get("usage"):
                                call["usage"] = chunk["usage"]
                            choices = chunk.get("choices") or []
                            delta = choices[0].get("delta", {}) if choices else {}
                            if delta.get("reasoning_content"):
                                call["reasoning_chunks"] += 1
                        yield line

            try:
                if args.offline_check:
                    text = "我在这儿陪你，我们慢慢聊。"
                    lines = ["data: " + json.dumps({"choices": [{"delta": {"content": c}}]}, ensure_ascii=False) for c in text]
                    lines += ['data: {"usage":{"prompt_tokens":100,"completion_tokens":30},"choices":[]}', 'data: [DONE]']
                    response = httpx.Response(200, text="\n\n".join(lines), request=httpx.Request("POST", url))
                    call["http_status"] = 200
                    yield ObservedResponse(response)
                else:
                    with original_stream(client, method, url, **kwargs) as response:
                        call["http_status"] = response.status_code
                        yield ObservedResponse(response)
            except Exception as exc:
                call["error_type"] = type(exc).__name__
                raise
            finally:
                with lock:
                    call["end_seconds"] = time.perf_counter() - origin
                    call["seconds"] = call["end_seconds"] - call["start_seconds"]
                    persist()

        httpx.Client.post = bounded_post
        httpx.Client.stream = bounded_stream
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
                    artifact = "非思考模式合成杯子" + image_file.suffix
                    shutil.copyfile(image_file, EVIDENCE / artifact)
                    result["image_artifact"] = artifact
                result["checks"] = {"ready_and_persisted": True, "image_saved": True,
                                    "within_30_seconds": result["generation_seconds"] <= 30}
                by_kind = {c["kind"]: c for c in result["calls"]}
                a, b = by_kind["opening"], by_kind["image"]
                result["provider_overlap_seconds"] = max(0, min(a["end_seconds"], b["end_seconds"]) - max(a["start_seconds"], b["start_seconds"]))
                result["checks"]["parallel_calls_overlap"] = result["provider_overlap_seconds"] > 0
                result["chat_cases"] = []
                base = f"/api/v1/characters/{saved['id']}"
                before_scene = client.get(base + "/scene").json()["elements"]
                for message, expected_action in zip(manifest["chat_cases"], [None, "plant_flower", None]):
                    chat_started = time.perf_counter()
                    first_chunk = chat_done = None
                    reply = ""
                    with client.stream("POST", base + "/chat", json={"message": message}) as response:
                        assert response.status_code == 200
                        for line in response.iter_lines():
                            if line.startswith("event:"):
                                event = line[6:].strip()
                            elif line.startswith("data:"):
                                data = json.loads(line[5:])
                                if event == "chunk":
                                    if first_chunk is None:
                                        first_chunk = time.perf_counter() - chat_started
                                    reply += data["delta"]
                                elif event == "done":
                                    chat_done = data
                    case = {"message": message, "reply": reply, "first_chunk_seconds": first_chunk,
                            "total_seconds": time.perf_counter() - chat_started, "done": chat_done}
                    result["chat_cases"].append(case)
                    persist()
                    assert chat_done and reply.strip(), "Chat did not finish"
                    proposal = chat_done.get("proposal")
                    assert (proposal["action"] if proposal else None) == expected_action
                    assert client.get(base + "/scene").json()["elements"] == before_scene, "Chat changed garden without confirmation"
                    if proposal:
                        client.post(base + f"/scene/proposals/{proposal['id']}/reject").raise_for_status()
                result["checks"]["chat_finished_and_confirmation_preserved"] = True
                result["checks"]["no_streamed_reasoning"] = all(c.get("reasoning_chunks", 0) == 0 for c in result["calls"])
                result["checks"]["exact_call_counts"] = dict(counts) == {settings.chat_model: 5, settings.image_model: 1}
                result["quality_review"] = "pending human review of persona, image and three replies; timing alone is not acceptance"
                result["passed"] = all(result["checks"].values())
        except Exception as exc:
            result["error_type"] = type(exc).__name__
        finally:
            if server:
                server.should_exit = True
            if thread:
                thread.join(185)
            httpx.Client.post = original_post
            httpx.Client.stream = original_stream
            sock.close()
            result["reserved_cny"] = sum(c["reserved_cny"] for c in result["calls"])
            result["provider_calls"] = 0 if args.offline_check else sum(counts.values())
            persist()
        print(json.dumps({"passed": result["passed"], "mock": args.offline_check,
                          "provider_calls": result["provider_calls"], "reserved_cny": result["reserved_cny"]}))
        raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
