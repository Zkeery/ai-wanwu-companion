"""FastAPI 入口。"""
from __future__ import annotations

from pathlib import Path
from contextlib import asynccontextmanager
import asyncio
import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import HTTPException, RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import auth, characters, chat, living, photos, scene, themes, wall, teams, private_images, personality, motion
from app.core.config import get_settings
from app.core.database import Base, engine, SessionLocal
from app.core.generation_schema import ensure_generation_columns
from app.core.scene_schema import ensure_scene_columns
from app.core.theme_schema import ensure_theme_columns
from app.core.voice_schema import ensure_voice_columns
from app.models.models import Character, PhotoRequest
from app.scene_agent import chat as agent_chat
from app.services import generation_quota
from app.services.model_http import close_model_http_clients
from app.api import life_simulation, life_runtime, gatherings, voice, competitions

Base.metadata.create_all(bind=engine)
ensure_generation_columns(engine)
ensure_scene_columns(engine)
ensure_theme_columns(engine)
living.living_store.initialize()
ensure_voice_columns(engine)
if get_settings().app_env == 'test' and get_settings().life_simulation_enabled:
    life_simulation.life.metadata.create_all(engine)
if get_settings().life_runtime_active:
    life_runtime.selected_runtime().initialize()
agent_chat.initialize()


async def cleanup_expired_audio(stop: asyncio.Event):
    while not stop.is_set():
        try:
            await asyncio.to_thread(voice.service.cleanup)
        except Exception:
            logging.getLogger(__name__).warning('audio_cleanup_unavailable')
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
        except asyncio.TimeoutError:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.services.motion_cleanup import cleanup_pending_motion
    with SessionLocal() as db:
        cleanup_pending_motion(db, apply=True)
    agent_chat.recover_interrupted()
    voice.service.recover()
    from app.services import motion_generation
    motion_generation.recover_interrupted()
    # 当前 MVP 采用单进程。上次进程退出时未完成的任务允许重新生成。
    with SessionLocal() as session:
        session.query(Character).filter(Character.status == "generating").update(
            {Character.status: "failed"}, synchronize_session=False
        )
        session.query(PhotoRequest).filter(PhotoRequest.status == "running").update(
            {PhotoRequest.status: "failed"}, synchronize_session=False
        )
        generation_quota.recover(session)
        session.commit()
    stop_cleanup = asyncio.Event()
    cleanup_task = asyncio.create_task(cleanup_expired_audio(stop_cleanup))
    from app.services.motion_preparation import consume as consume_motion
    motion_worker = asyncio.create_task(consume_motion(stop_cleanup))
    generation_worker = (asyncio.create_task(motion_generation.consume(stop_cleanup))
                         if get_settings().motion_generation_enabled else None)
    life_worker = None
    shared_worker = None
    if get_settings().life_runtime_active:
        from app.living.life_worker import consume
        selected = life_runtime.selected_runtime()
        async def execute_life(owner, sid, tid):
            await life_runtime.execute_requested(selected, owner, sid, tid)
        life_worker = asyncio.create_task(consume(selected, execute_life))
    if gatherings.automatic_available():
        from app.living.gathering_automatic import consume as consume_shared
        shared_worker = asyncio.create_task(consume_shared(gatherings.automatic_store, gatherings.automatic_client))
    try:
        yield
    finally:
        if life_worker is not None:
            life_worker.cancel()
            await asyncio.gather(life_worker, return_exceptions=True)
        if shared_worker is not None:
            shared_worker.cancel()
            await asyncio.gather(shared_worker, return_exceptions=True)
        stop_cleanup.set()
        await cleanup_task
        await motion_worker
        if generation_worker is not None:
            await generation_worker
        close_model_http_clients()


app = FastAPI(title="AI万物伙伴", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def private_api_no_cache(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith(("/uploads/", "/api/v1/")):
        cache_control = response.headers.get("Cache-Control", "")
        if not cache_control:
            response.headers["Cache-Control"] = "private, no-store"
        elif "no-store" not in (part.strip().lower() for part in cache_control.split(",")):
            response.headers["Cache-Control"] = f"{cache_control}, no-store"
        vary = [part.strip() for part in response.headers.get("Vary", "").split(",") if part.strip()]
        if not any(part.lower() == "authorization" for part in vary):
            vary.append("Authorization")
        response.headers["Vary"] = ", ".join(vary)
    return response


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "invalid_request", "message": "请求参数不正确，请检查输入"}},
    )


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict) and "error" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": "http_error", "message": str(exc.detail)}},
    )


app.include_router(auth.router, prefix="/api/v1")
app.include_router(photos.router, prefix="/api/v1")
app.include_router(themes.router, prefix="/api/v1")
app.include_router(wall.router, prefix="/api/v1")
app.include_router(teams.router, prefix="/api/v1")
app.include_router(personality.router, prefix="/api/v1")
app.include_router(characters.router, prefix="/api/v1")
app.include_router(chat.router, prefix="/api/v1")
app.include_router(chat.memories_router, prefix="/api/v1")
app.include_router(scene.router, prefix="/api/v1")
app.include_router(living.router, prefix="/api/v1")
app.include_router(living.location_router, prefix="/api/v1")
app.include_router(life_simulation.router, prefix="/api/v1")
app.include_router(life_runtime.router, prefix="/api/v1")
app.include_router(gatherings.router, prefix="/api/v1")
app.include_router(voice.router, prefix="/api/v1")
app.include_router(competitions.router, prefix="/api/v1")

static_dir = Path(__file__).parent / "static"
static_dir.mkdir(exist_ok=True)

upload_dir = Path(get_settings().upload_dir).resolve()
upload_dir.mkdir(parents=True, exist_ok=True)
app.include_router(private_images.router)
app.include_router(motion.router, prefix="/api/v1")
from app.api import motion_candidates
app.include_router(motion_candidates.router, prefix="/api/v1")
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")


from app.living.rules import LivingError


@app.exception_handler(LivingError)
async def living_exception_handler(request: Request, exc: LivingError):
    status = {"invalid_request": 422, "not_found": 404, "conflict": 409,
              "invalid_action": 409, "corrupt_state": 500, "storage_unavailable": 503,
              "audio_unavailable": 503, "voice_session_unavailable": 409,
              "voice_session_busy": 409, "budget_exhausted": 409}.get(exc.code, 500)
    return JSONResponse(status_code=status, content=exc.as_dict())
