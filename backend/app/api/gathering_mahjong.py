"""Strict authenticated API for the free, server-owned Sichuan table."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_user
from app.core.database import engine
from app.living.gathering_mahjong import MahjongStore
from app.models.models import User


router = APIRouter(prefix='/gatherings', tags=['shared-mahjong'])
store = MahjongStore(engine)


class MahjongAction(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['start', 'advance', 'new_round']


class MahjongRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    game_id: UUID | None
    expected_revision: int = Field(strict=True, ge=0, le=1000000)
    command: MahjongAction


@router.get('/{group_id}/mahjong')
def read(group_id: UUID, response: Response, user: User = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return store.read(user.id, str(group_id))


@router.post('/{group_id}/mahjong/commands')
def command(group_id: UUID, payload: MahjongRequest, response: Response,
            user: User = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'no-store'
    return store.command(user.id, str(group_id), str(payload.request_id),
                         None if payload.game_id is None else str(payload.game_id),
                         payload.expected_revision, payload.command.action)
