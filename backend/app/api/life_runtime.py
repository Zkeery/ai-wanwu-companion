"""Authenticated life runtime, with explicit real and isolated preview modes."""
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_user
from app.api.model_availability import require_model_available
from app.api.living import living_store
from app.core.config import get_settings
from app.core.database import engine
from app.core.errors import api_error
from app.living import life_planning as planning
from app.living.life_runtime import LifeRuntime, RuntimeSnapshot, RuntimeHistory, ViewingLease
from app.living.life_live_planner import run_real_planner
from app.living.life_provider import BASE_URL, MODEL, MaaSLifePlannerAdapter
from app.models.models import User

runtime = LifeRuntime(engine, lambda: living_store._now())
live_runtime = LifeRuntime(engine, lambda: living_store._now(), origin='real_provider')


def selected_runtime() -> LifeRuntime:
    settings = get_settings()
    return live_runtime if settings.life_runtime_enabled or settings.life_live_planner_preview_enabled else runtime


def require_runtime():
    settings = get_settings()
    if not settings.life_runtime_active:
        raise api_error(404, 'not_found', '此功能未开放')


router = APIRouter(prefix='/living/spaces/{space_id}/life-runtime',
                   tags=['life-runtime'], dependencies=[Depends(require_runtime)])


class StrictRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')


class PermissionRequest(StrictRequest):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    enabled: bool = Field(strict=True)
    activities: list[planning.Activity] = Field(max_length=3)


class ScheduleRequest(StrictRequest):
    request_id: UUID


class AutomaticRequest(StrictRequest):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    enabled: bool = Field(strict=True)


class ViewingRequest(StrictRequest):
    expected_revision: int = Field(ge=0, strict=True)
    enabled: bool = Field(strict=True)


@router.put('/viewing/{lease_id}', response_model=ViewingLease)
def save_viewing(space_id: str, lease_id: str, payload: ViewingRequest, user: User = Depends(get_current_user)):
    selected = selected_runtime()
    if payload.enabled and selected.origin == 'real_provider':
        selected.snapshot(user.id, space_id)
        check_live_configuration(selected)
    return selected.save_viewing(user.id, space_id, lease_id, payload.expected_revision, payload.enabled)


@router.put('/automatic', response_model=RuntimeSnapshot)
def save_automatic(space_id: str, payload: AutomaticRequest, user: User = Depends(get_current_user)):
    selected = selected_runtime()
    if payload.enabled and selected.origin == 'real_provider':
        selected.snapshot(user.id, space_id)
        check_live_configuration(selected)
    selected.save_automatic(user.id, space_id, str(payload.request_id), payload.expected_revision, payload.enabled)
    return selected.snapshot(user.id, space_id)


@router.get('', response_model=RuntimeSnapshot)
def read(space_id: str, user: User = Depends(get_current_user)):
    return selected_runtime().snapshot(user.id, space_id)


@router.get('/history', response_model=RuntimeHistory)
def history(space_id: str, before: str | None = Query(default=None, max_length=60), user: User = Depends(get_current_user)):
    return selected_runtime().history(user.id, space_id, before)


@router.put('/permission', response_model=RuntimeSnapshot)
def save_permission(space_id: str, payload: PermissionRequest, user: User = Depends(get_current_user)):
    selected_runtime().save_permission(user.id, space_id, str(payload.request_id), payload.expected_revision,
                             payload.enabled, tuple(payload.activities))
    return selected_runtime().snapshot(user.id, space_id)


@router.post('/tasks', response_model=RuntimeSnapshot)
def schedule(space_id: str, payload: ScheduleRequest, user: User = Depends(get_current_user)):
    selected_runtime().schedule(user.id, space_id, str(payload.request_id), 'viewing')
    return selected_runtime().snapshot(user.id, space_id)


@router.post('/tasks/{task_id}/run', response_model=RuntimeSnapshot, dependencies=[Depends(require_model_available)])
async def run(space_id: str, task_id: str, payload: StrictRequest, user: User = Depends(get_current_user)):
    selected = selected_runtime()
    await execute_requested(selected, user.id, space_id, task_id)
    return selected.snapshot(user.id, space_id)


def check_live_configuration(selected: LifeRuntime):
    if selected.origin == 'real_provider':
        settings = get_settings()
        if (settings.model_base_url != BASE_URL or settings.chat_model != MODEL
                or not settings.model_api_key.strip()):
            raise api_error(503, 'configuration_error', '真实规划配置未准备好')


async def execute_requested(selected: LifeRuntime, owner: str, space_id: str, task_id: str):
    # Resolve the scope before configuration checks; never expose another owner's task.
    selected.read_task(owner, space_id, task_id)
    check_live_configuration(selected)
    if selected.origin == 'real_provider':
        settings = get_settings()
        await run_real_planner(selected, owner, space_id, task_id,
                               lambda: MaaSLifePlannerAdapter(settings.model_api_key))
    else:
        selected.run_fixture(owner, space_id, task_id)


@router.post('/tasks/{task_id}/dispatch', status_code=202, response_model=RuntimeSnapshot, dependencies=[Depends(require_model_available)])
def dispatch(space_id: str, task_id: str, payload: StrictRequest, user: User = Depends(get_current_user)):
    selected = selected_runtime()
    selected.read_task(user.id, space_id, task_id)
    check_live_configuration(selected)
    selected.request_dispatch(user.id, space_id, task_id)
    return selected.snapshot(user.id, space_id)
