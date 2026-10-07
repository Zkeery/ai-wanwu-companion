"""One synthetic HEIC recognition; dry-run by default, no retry or character generation.

--run --confirmed-free is only for the scoped development verification after checking the
provider's current free-price announcement. Results are never overwritten.
"""
import argparse
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import sys
import tempfile
import time

PROJECT = Path(__file__).resolve().parents[2]
EVIDENCE = PROJECT / "docs/PRD/版本/V1.0/验收证据/前端阶段3"
sys.path.insert(0, str(PROJECT / "backend"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true")
    parser.add_argument("--confirmed-free", action="store_true")
    args = parser.parse_args()
    result_path = EVIDENCE / "真实识别结果.json"
    if result_path.exists():
        raise SystemExit("Existing result retained; no automatic repeat allowed.")
    if args.run and not args.confirmed_free:
        raise SystemExit("Check current official free price first; paid calls require separate approval.")
    image = (EVIDENCE / "合成杯子.heic").read_bytes()
    from app.services.photo_input import normalize_photo
    normalized = normalize_photo(image)
    from PIL import Image
    with Image.open(BytesIO(normalized)) as decoded:
        assert decoded.format == "JPEG" and decoded.size == (256, 256)
        assert not decoded.getexif()
    (EVIDENCE / "规范化杯子.jpg").write_bytes(normalized)
    manifest = {
        "fixture": "合成杯子.heic", "fixture_sha256": hashlib.sha256(image).hexdigest(),
        "normalized_sha256": hashlib.sha256(normalized).hexdigest(),
        "provider": "https://maas-api.antdigital.com/v1", "model": "ling-3.0-flash-vl",
        "max_calls": 1, "max_retries": 0, "max_output_tokens": 512,
        "budget_cny": 0, "expected_cny_if_currently_free": 0,
        "price_condition": "Only run after confirming the official temporary-free price is still active; otherwise stop.",
        "scope": "Isolated synthetic HEIC -> JPEG -> recognition; no text/image generation, no existing companion data",
        "files_sha256": {f: hashlib.sha256((PROJECT / f).read_bytes()).hexdigest() for f in
                         ["backend/app/services/photo_input.py", "backend/app/api/photos.py",
                          "backend/app/services/model_client.py", "backend/app/services/prompts.py",
                          "backend/scripts/run_photo_input_smoke.py"]},
    }
    (EVIDENCE / "真实识别运行配置.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    if not args.run:
        print(json.dumps({"dry_run": True, "model_calls": 0, "normalized_bytes": len(normalized)}))
        return
    os.environ["MODEL_MAX_RETRIES"] = "0"
    with tempfile.TemporaryDirectory(prefix="photo-input-real-", dir=PROJECT / ".runtime") as tmp:
        os.environ["DATABASE_URL"] = f"sqlite:///{tmp}/smoke.db"
        os.environ["UPLOAD_DIR"] = f"{tmp}/uploads"
        from app.core.config import get_settings
        get_settings.cache_clear()
        settings = get_settings()
        assert not settings.use_mock
        assert settings.model_base_url == manifest["provider"]
        assert settings.vision_model == manifest["model"]
        import httpx
        original = httpx.Client.post
        result = {"passed": False, "calls": [], "price_confirmed_free": True}

        def persist():
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")

        def bounded_post(client, url, **kwargs):
            if str(url).startswith("/"):
                return original(client, url, **kwargs)  # in-process TestClient only
            assert str(url) == manifest["provider"] + "/chat/completions"
            payload = kwargs["json"]
            assert payload["model"] == manifest["model"] and not result["calls"]
            image_url = payload["messages"][0]["content"][1]["image_url"]["url"]
            assert image_url == "data:image/jpeg;base64," + base64.b64encode(normalized).decode("ascii")
            payload["max_tokens"] = manifest["max_output_tokens"]
            call = {"model": payload["model"], "started_at": time.time()}
            result["calls"].append(call)
            persist()  # reserve before network I/O, including interrupted requests
            try:
                response = original(client, url, **kwargs)
                call["http_status"] = response.status_code
                if response.status_code == 200:
                    call["usage"] = response.json().get("usage")
                return response
            except Exception as exc:
                call["transport_error_type"] = type(exc).__name__
                raise
            finally:
                call["seconds"] = round(time.time() - call["started_at"], 3)
                persist()

        httpx.Client.post = bounded_post
        try:
            from fastapi.testclient import TestClient
            from app.main import app
            from uuid import uuid4
            key = str(uuid4())
            with TestClient(app) as client:
                response = client.post("/api/v1/photos", files={"file": ("synthetic-cup.heic", image, "image/heic")}, headers={"Idempotency-Key": key})
                result["http_status"] = response.status_code
                result["response"] = response.json()
                assert response.status_code == 201
                assert any("杯" in o["label"] for o in response.json()["objects"])
                receipt = client.get("/api/v1/photos/requests/" + key).json()
                assert receipt["status"] == "ready" and receipt["photo"] == response.json()
                assert len(result["calls"]) == 1
                result["passed"] = True
        except Exception as exc:
            result["error_type"] = type(exc).__name__
        finally:
            httpx.Client.post = original
            persist()
        print(json.dumps({"passed": result["passed"], "calls": len(result["calls"])}))


if __name__ == "__main__":
    main()
