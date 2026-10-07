from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_user
from app.api.gatherings import no_cache
from app.core.database import engine
from app.living.competitions import CompetitionStore
from app.living.competition_ai import CompetitionAIStore, CompetitionAdapter, run_suggestion
from app.core.errors import api_error
from app.models.models import User

store = CompetitionStore(engine)
ai_store = CompetitionAIStore(engine)
router = APIRouter(prefix='/activities', tags=['activities'], dependencies=[Depends(no_cache)])


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Create(Strict):
    request_id: UUID
    kind: Literal['observe', 'garden', 'leaves']
    display_name: str = Field(min_length=1, max_length=20)


class Invitation(Strict):
    token: str = Field(min_length=20, max_length=100)


class Join(Invitation):
    request_id: UUID
    display_name: str = Field(min_length=1, max_length=20)
    accept: bool = Field(strict=True)


class Simple(Strict):
    action: Literal['start', 'cheer', 'cancel']


class Participant(Strict):
    action: Literal['register', 'withdraw', 'vote']
    character_id: int = Field(gt=0, strict=True)


class Command(Strict):
    request_id: UUID
    command: Annotated[Simple | Participant, Field(discriminator='action')]


class AIRequest(Strict):
    request_id: UUID
    grant_id: UUID
    character_id: int = Field(gt=0, strict=True)
    phase: Literal['strategy', 'reflection']


class Exchange(Strict):
    request_id: UUID
    kind: Literal['colorful_pot', 'warm_lights', 'swing']


class Place(Strict):
    request_id: UUID
    decoration_id: UUID
    space_id: UUID | None
    space_kind: Literal['private', 'gathering']
    x: int = Field(ge=0, le=100, strict=True)
    y: int = Field(ge=0, le=100, strict=True)


@router.get('')
def list_activities(user: User = Depends(get_current_user)):
    return store.list(user.id)


@router.post('', status_code=201)
def create(payload: Create, user: User = Depends(get_current_user)):
    return store.create(user.id, str(payload.request_id), payload.kind, payload.display_name)


@router.post('/invitations/preview')
def preview(payload: Invitation, user: User = Depends(get_current_user)):
    return store.preview(payload.token)


@router.post('/invitations/join')
def join(payload: Join, user: User = Depends(get_current_user)):
    return store.join(user.id, str(payload.request_id), payload.token, payload.display_name, payload.accept)


@router.get('/inventory')
def inventory(user: User = Depends(get_current_user)):
    return store.inventory(user.id)


@router.post('/exchange')
def exchange(payload: Exchange, user: User = Depends(get_current_user)):
    return store.exchange(user.id, str(payload.request_id), payload.kind)


@router.post('/decorations')
def place(payload: Place, user: User = Depends(get_current_user)):
    return store.place(user.id, str(payload.request_id), str(payload.decoration_id),
        str(payload.space_id) if payload.space_id else None, payload.space_kind, payload.x, payload.y)


@router.get('/decorations/{space_kind}/{space_id}')
def decorations(space_kind: Literal['private', 'gathering'], space_id: UUID, user: User = Depends(get_current_user)):
    return store.in_space(user.id, str(space_id), space_kind)


@router.get('/{match_id}')
def read(match_id: UUID, user: User = Depends(get_current_user)):
    return store.read(user.id, str(match_id))


@router.post('/{match_id}/commands')
def command(match_id: UUID, payload: Command, user: User = Depends(get_current_user)):
    return store.command(user.id, str(match_id), str(payload.request_id), payload.command.model_dump())


def ai_available():
    from app.core.config import get_settings
    settings = get_settings()
    return settings.competition_ai_enabled and bool(settings.model_api_key.strip())


@router.get('/{match_id}/ai')
def ai_status(match_id: UUID, user: User = Depends(get_current_user)):
    return dict(**ai_store.status(user.id, str(match_id)), available=ai_available())


@router.post('/{match_id}/ai')
async def ai_start(match_id: UUID, payload: AIRequest, user: User = Depends(get_current_user)):
    from app.core.config import get_settings
    if not ai_available():
        raise api_error(409, 'competition_ai_unavailable', '比赛AI尚未开放，已有内容仍可查看')
    task, fresh = ai_store.prepare(user.id, str(match_id), payload.character_id, payload.phase,
                                  str(payload.request_id), str(payload.grant_id))
    if fresh:
        await run_suggestion(ai_store, task, lambda: CompetitionAdapter(get_settings().model_api_key))
    return dict(**ai_store.status(user.id, str(match_id)), available=ai_available())
