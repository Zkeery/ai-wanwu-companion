"""Explicit test-only HTTP boundary; production cannot enable this simulator."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.living import living_store
from app.core.config import get_settings
from app.core.database import get_db
from app.core.errors import api_error
from app.living import life_simulation as life
from app.models.models import User


def simulation_only():
    s = get_settings()
    if s.app_env != 'test' or not s.life_simulation_enabled:
        raise api_error(404, 'not_found', '此功能未开放')


router = APIRouter(prefix='/living/spaces/{space_id}/life-simulation',
                   tags=['life-simulation'], dependencies=[Depends(simulation_only)])


class SaveRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    settings: life.Settings


class StepRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    source: Literal['viewing', 'offline']


@router.get('')
def get_life(space_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        return life.read(db.connection(), user.id, space_id, living_store._now())
    except SQLAlchemyError:
        raise api_error(503, 'storage_unavailable', '生活记录暂时无法读取') from None


def write(db, operation):
    try:
        db.execute(text('BEGIN IMMEDIATE'))
        result = operation(db.connection())
        db.commit()
        return result
    except SQLAlchemyError:
        db.rollback()
        raise api_error(503, 'storage_unavailable', '模拟结果暂时无法保存，请先刷新记录') from None


@router.put('')
def save_life(space_id: str, payload: SaveRequest, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    return write(db, lambda conn: life.save(conn, user.id, space_id, str(payload.request_id),
                 payload.expected_revision, payload.settings, living_store._now()))


@router.post('/step')
def step_life(space_id: str, payload: StepRequest, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    return write(db, lambda conn: life.step(conn, user.id, space_id, str(payload.request_id),
                                          payload.source, living_store._now()))
