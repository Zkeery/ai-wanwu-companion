"""Isolated, no-cost browser QA fixture. Run with backend/.venv/bin/python.

Never reads or modifies the real database. All model responses are mock.
Temporary files are removed when the process terminates normally.
"""
import os
from pathlib import Path
import sys
import tempfile
from time import sleep

project = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(project / "backend"))
(project / ".runtime").mkdir(exist_ok=True)

with tempfile.TemporaryDirectory(prefix="frontend-qa-", dir=project / ".runtime") as tmp:
    os.environ["MODEL_API_KEY"] = ""
    os.environ["DATABASE_URL"] = f"sqlite:///{tmp}/qa.db"
    os.environ["UPLOAD_DIR"] = f"{tmp}/uploads"
    from app.main import app
    from fastapi import Request
    from fastapi.responses import JSONResponse
    from app.core.database import SessionLocal
    from app.models.models import Photo, Object, Character, SceneState
    # Available only in this disposable fixture process, never in the real server.
    faults = {"fail_next_memory_read": False, "fail_read_after_write": False,
              "lose_photo_response": False, "lose_generation_response": False,
              "fail_next_generation": False}
    from app.services.model_client import ModelClient, ModelError
    original_generate = ModelClient.generate_persona

    def qa_generate(self, label):
        sleep(float(os.environ.get("QA_PERSONA_DELAY", "0")))
        if faults["fail_next_generation"]:
            faults["fail_next_generation"] = False
            raise ModelError("QA generation failure")
        return original_generate(self, label)

    ModelClient.generate_persona = qa_generate
    original_opening = ModelClient.generate_opening
    original_image = ModelClient.generate_image

    def qa_opening(self, persona):
        sleep(float(os.environ.get("QA_ASSET_DELAY", "0")))
        return original_opening(self, persona)

    def qa_image(self, label, name, **appearance):
        sleep(float(os.environ.get("QA_ASSET_DELAY", "0")))
        return original_image(self, label, name, **appearance)

    ModelClient.generate_opening = qa_opening
    ModelClient.generate_image = qa_image
    original_chat = ModelClient.chat_stream

    def qa_chat(self, messages):
        for chunk in original_chat(self, messages):
            sleep(float(os.environ.get("QA_CHAT_CHUNK_DELAY", "0")))
            yield chunk

    ModelClient.chat_stream = qa_chat

    @app.middleware("http")
    async def acceptance_faults(request: Request, call_next):
        if request.url.path == "/__qa/faults" and request.method == "POST":
            body = await request.json()
            for key in faults:
                faults[key] = body.get(key) is True
            return JSONResponse({"configured": True})
        memory_path = request.url.path.endswith("/memories")
        if memory_path and request.method == "GET" and faults["fail_next_memory_read"]:
            faults["fail_next_memory_read"] = False
            return JSONResponse({"error": {"code": "qa_read_failure", "message": "测试：记忆列表暂时读取失败"}}, status_code=503)
        response = await call_next(request)
        lose_photo = request.url.path == "/api/v1/photos" and faults["lose_photo_response"]
        lose_generation = request.url.path == "/api/v1/characters" and faults["lose_generation_response"]
        if request.method == "POST" and (lose_photo or lose_generation):
            faults["lose_photo_response" if lose_photo else "lose_generation_response"] = False
            # Let the real application finish persistence, then drop its response.
            async for _ in response.body_iterator:
                pass
            return JSONResponse({"error": {"code": "qa_lost_response", "message": "测试：结果返回中断"}}, status_code=503)
        if memory_path and request.method == "POST" and response.status_code == 201 and faults["fail_read_after_write"]:
            faults["fail_read_after_write"] = False
            faults["fail_next_memory_read"] = True
        return response
    with SessionLocal() as db:
        photo = Photo(filename="qa-fixture", status="done")
        db.add(photo)
        db.flush()
        for label in ["测试小叶（mock）", "测试小杯（mock）"]:
            obj = Object(photo_id=photo.id, label=label)
            db.add(obj)
            db.flush()
            db.add(Character(object_id=obj.id, name=label, persona="我是浏览器验收专用伙伴，回复来自 mock，不代表真实模型效果。", opening_line="测试小花园已准备好。", status="ready"))
        db.commit()
        if os.environ.get("QA_STAGE1_FIXTURES") == "1":
            from app.services.scene import default_elements, serialize
            for cid, count in [(1, 6), (2, 9)]:
                elements = {**default_elements(), "tree": count}
                db.add(SceneState(character_id=cid, state_json=serialize(
                    elements, [{**elements, "tree": count - 1}],
                )))
            # Old photo with six saved objects; only five should be offered by the API.
            for n in range(3, 7):
                db.add(Object(photo_id=photo.id, label=f"旧候选{n}"))
            db.commit()
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("QA_PORT", "8021")))
