"""Loopback-only demo. No production app/database/config imports."""
from __future__ import annotations

import argparse
import json
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from runtime import DemoError, Runtime

ROOT = Path(__file__).resolve().parent


class MessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=4000)
    request_key: str = Field(min_length=1, max_length=80)


class DecisionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    run_id: str
    proposal_id: str
    decision: str


class ChangeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str


def create_app(data_dir=ROOT / ".data"):
    runtime = Runtime(Path(data_dir) / "demo.sqlite3")
    runtime.recover()
    app = FastAPI(title="果果的小花园 · 离线 Agent Demo", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.runtime = runtime

    @app.middleware("http")
    async def session(request: Request, call_next):
        host = request.headers.get("host", "")
        if host.split(":")[0] not in ("127.0.0.1", "localhost", "testserver"):
            return JSONResponse({"error": {"code": "invalid_host", "message": "仅支持本机访问。"}}, status_code=403)
        origin = request.headers.get("origin")
        if request.method == "POST" and origin and origin != f"http://{host}":
            return JSONResponse({"error": {"code": "invalid_origin", "message": "请在 demo 页面操作。"}}, status_code=403)
        sid = request.cookies.get("garden_demo_session", "")
        try:
            sid = str(uuid.UUID(sid))
        except (ValueError, AttributeError):
            sid = str(uuid.uuid4())
        runtime.ensure_session(sid)
        request.state.sid = sid
        response = await call_next(request)
        response.set_cookie("garden_demo_session", sid, httponly=True, samesite="strict", max_age=60 * 60 * 24 * 30)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    @app.exception_handler(DemoError)
    async def known_error(request, exc):
        return JSONResponse({"error": {"code": exc.code, "message": exc.message}}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def bad_input(request, exc):
        return JSONResponse({"error": {"code": "invalid_request", "message": "输入不正确，请检查后重试。"}}, status_code=422)

    @app.exception_handler(Exception)
    async def unexpected(request, exc):
        return JSONResponse({"error": {"code": "internal_error", "message": "暂时无法完成，请刷新核对状态后重试。"}}, status_code=500)

    @app.get("/api/state")
    def state(request: Request):
        return runtime.state(request.state.sid)

    @app.post("/api/chat")
    def chat(payload: MessageInput, request: Request):
        runtime.start(request.state.sid, payload.text, payload.request_key)
        return runtime.state(request.state.sid)

    @app.post("/api/decide")
    def decide(payload: DecisionInput, request: Request):
        runtime.decide(request.state.sid, payload.run_id, payload.proposal_id, payload.decision)
        return runtime.state(request.state.sid)

    @app.post("/api/garden")
    def garden(payload: ChangeInput, request: Request):
        runtime.change(request.state.sid, payload.action)
        return runtime.state(request.state.sid)

    app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="demo")
    return app


if __name__ == "__main__":
    config = json.loads((ROOT / "demo.json").read_text())
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=config["port"])
    args = parser.parse_args()
    uvicorn.run(create_app(), host="127.0.0.1", port=args.port, access_log=False, log_level="warning")
