"""Authenticated shared-life API; every command has a strict, bounded schema."""
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_user
from app.core.database import engine
from app.core.database import get_db
from app.core.errors import api_error
from sqlalchemy.orm import Session
from app.living.gatherings import GatheringStore
from app.living.rules import Place, Care, Move, Store
from app.living.seasons import Settings
from app.models.models import User
from app.living.gathering_dialogue import DialogueStore, MaaSDialogueAdapter, run_exchange
from app.living.gathering_automatic import AutomaticDialogueStore

store = GatheringStore(engine)
dialogue_store = DialogueStore(engine)
automatic_store = AutomaticDialogueStore(engine)


def no_cache(response: Response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Vary'] = 'Authorization'


router = APIRouter(prefix='/gatherings', tags=['shared-life'], dependencies=[Depends(no_cache)])


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Create(Strict):
    request_id: UUID
    title: str = Field(min_length=1, max_length=30)
    display_name: str = Field(min_length=1, max_length=20)
    scene_type: Literal['home', 'desert', 'forest']
    season: Settings | None = None


class Invitation(Strict):
    token: str = Field(min_length=20, max_length=100)


class Join(Invitation):
    request_id: UUID
    display_name: str = Field(min_length=1, max_length=20)


class Simple(Strict):
    action: Literal['invite', 'revoke_invitation', 'leave', 'propose_dissolve', 'start_goal']


class Member(Strict):
    action: Literal['transfer', 'remove']
    member_id: str = Field(min_length=1, max_length=128)


class Character(Strict):
    action: Literal['visit', 'recall']
    character_id: int = Field(gt=0, strict=True)


class Layout(Strict):
    action: Literal['layout']
    command: Annotated[Place | Care | Move | Store, Field(discriminator='action')]


class Season(Strict):
    action: Literal['propose_season']
    settings: Settings


class Vote(Strict):
    action: Literal['vote']
    vote_id: UUID
    agree: bool = Field(strict=True)


class Activity(Strict):
    action: Literal['activity']
    character_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(min_length=1, max_length=2)
    activity: Literal['rest', 'walk', 'observe', 'talk']


class Preference(Strict):
    action: Literal['story_preference']
    enabled: bool = Field(strict=True)


class DialogueSpace(Strict):
    action: Literal['dialogue_space']
    enabled: bool = Field(strict=True)


class DialogueConsent(Strict):
    action: Literal['dialogue_consent']
    character_id: int = Field(gt=0, strict=True)
    enabled: bool = Field(strict=True)


class DialogueRequest(Strict):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    character_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(min_length=2, max_length=2)
    grant_id: UUID


class Story(Strict):
    action: Literal['story']
    character_ids: list[Annotated[int, Field(gt=0, strict=True)]] = Field(min_length=2, max_length=2)


class Reconcile(Strict):
    action: Literal['reconcile']
    story_id: UUID


class Restore(Strict):
    action: Literal['restore_inventory']
    item_id: UUID


class CommandRequest(Strict):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    command: Annotated[Simple | Member | Character | Layout | Season | Vote | Activity | Preference | DialogueSpace | DialogueConsent | Story | Reconcile | Restore,
                       Field(discriminator='action')]


@router.get('')
def list_spaces(user: User = Depends(get_current_user)):
    return store.list(user.id)


@router.post('', status_code=201)
def create(payload: Create, user: User = Depends(get_current_user)):
    return store.create(user.id, str(payload.request_id), payload.title, payload.display_name,
        payload.scene_type, payload.season.model_dump() if payload.season else None)


@router.get('/personal')
def personal(user: User = Depends(get_current_user)):
    return store.personal(user.id)


@router.post('/invitations/preview')
def preview(payload: Invitation, user: User = Depends(get_current_user)):
    return store.preview(payload.token)


@router.post('/invitations/join')
def join(payload: Join, user: User = Depends(get_current_user)):
    return store.join(user.id, str(payload.request_id), payload.token, payload.display_name)


@router.get('/{group_id}')
def read(group_id: UUID, user: User = Depends(get_current_user)):
    return store.read(user.id, str(group_id))


@router.get('/{group_id}/companions/{character_id}/image')
def image(group_id: UUID, character_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.models.models import Character as CharacterModel
    from app.api.wall import image_file
    g = store.read(user.id, str(group_id))
    if not any(c['id'] == character_id for c in g['companions']):
        raise api_error(404, 'not_found', '伙伴已经回家')
    c = db.get(CharacterModel, character_id)
    path = image_file(c) if c else None
    if path is None:
        raise api_error(404, 'not_found', '形象暂不可用')
    return FileResponse(path, headers={'Cache-Control': 'private, no-store', 'Vary': 'Authorization',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"})


@router.post('/{group_id}/commands')
def command(group_id: UUID, payload: CommandRequest, user: User = Depends(get_current_user)):
    return store.command(user.id, str(group_id), str(payload.request_id), payload.expected_revision,
        payload.command.model_dump(mode='json'))


def dialogue_available():
    from app.core.config import get_settings
    settings = get_settings()
    return settings.gathering_dialogue_enabled and bool(settings.model_api_key.strip())


def dialogue_client():
    from app.core.config import get_settings
    return MaaSDialogueAdapter(get_settings().model_api_key)


def automatic_available():
    from app.core.config import get_settings
    return get_settings().gathering_dialogue_automatic_enabled and dialogue_available()


def automatic_client():
    if not automatic_available():
        raise api_error(409, 'dialogue_unavailable', '后台自动交流尚未开放')
    return dialogue_client()


class AutomaticRequest(Strict):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)
    enabled: bool = Field(strict=True)
    session_id: UUID | None = None


class DialogueViewer(Strict):
    viewer_id: UUID
    active: bool = Field(strict=True)


@router.get('/{group_id}/dialogue/automatic')
def automatic_status(group_id: UUID, user: User = Depends(get_current_user)):
    return dict(**automatic_store.status(user.id, str(group_id)), available=automatic_available())


@router.post('/{group_id}/dialogue/automatic')
def automatic_configure(group_id: UUID, payload: AutomaticRequest, user: User = Depends(get_current_user)):
    if payload.enabled and not automatic_available():
        raise api_error(409, 'dialogue_unavailable', '后台自动交流尚未开放，仍可暂停已有安排')
    result = automatic_store.configure(user.id, str(group_id), str(payload.request_id), payload.expected_revision,
        payload.enabled, str(payload.session_id) if payload.session_id else None)
    return dict(**result, available=automatic_available())


@router.put('/{group_id}/dialogue/viewer')
def automatic_viewer(group_id: UUID, payload: DialogueViewer, user: User = Depends(get_current_user)):
    return automatic_store.viewing(user.id, str(group_id), str(payload.viewer_id), payload.active)


@router.get('/{group_id}/dialogue')
def dialogue_status(group_id: UUID, user: User = Depends(get_current_user)):
    return dict(**dialogue_store.read(user.id, str(group_id)), available=dialogue_available())


@router.post('/{group_id}/dialogue')
async def dialogue_start(group_id: UUID, payload: DialogueRequest, user: User = Depends(get_current_user)):
    if not dialogue_available():
        raise api_error(409, 'dialogue_unavailable', '真实交流尚未开放，已有记录仍可查看')
    task, fresh = dialogue_store.prepare(user.id, str(group_id), str(payload.request_id), payload.expected_revision,
        payload.character_ids, str(payload.grant_id))
    if fresh:
        await run_exchange(dialogue_store, task, dialogue_client)
    return dict(**dialogue_store.read(user.id, str(group_id)), available=dialogue_available())


def shared_motion(db, uid, gid, cid, activity):
    from app.models.models import Character as CharacterModel, CharacterActivityMotionAsset, CharacterMotionAsset
    from app.services.motion_bindings import read_binding
    g = store.read(uid, gid)
    participant = next((c for c in g['companions'] if c['id'] == cid), None)
    ch = db.get(CharacterModel, cid)
    if (not participant or not ch or ch.status != 'ready' or ch.current_space_id != gid
            or ch.owner_id != participant['owner_id'] or participant['activity'] != activity):
        raise api_error(404, 'not_found', '伙伴或当前活动已变化，请刷新近况')
    binding = db.get(CharacterActivityMotionAsset, (cid, activity))
    if binding is None:
        binding = db.get(CharacterMotionAsset, cid)
    if binding is None:
        return None
    directory, data = read_binding(ch, binding)
    if data.get('activity') != activity:
        return None
    return binding, directory, data


@router.get('/{group_id}/companions/{character_id}/motion')
def motion_metadata(group_id: UUID, character_id: int, activity: Literal['rest', 'walk', 'observe'],
                    response: Response, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.api.motion import HEADERS, describe, unavailable
    from app.services.motion_bindings import MotionBindingError
    response.headers.update(HEADERS)
    try:
        selected = shared_motion(db, user.id, str(group_id), character_id, activity)
        if selected is None:
            return {'state': 'missing'}
        binding, _, data = selected
        base = f'/api/v1/gatherings/{group_id}/companions/{character_id}/motion/activity/{activity}/{binding.pack_id}'
        return describe(binding.pack_id, binding.source_sha256, data, base, slot='activity')
    except MotionBindingError as exc:
        raise unavailable(exc)


@router.get('/{group_id}/companions/{character_id}/motion/activity/{activity}/{pack_id}/{kind}')
def motion_resource(group_id: UUID, character_id: int, activity: Literal['rest', 'walk', 'observe'],
                    pack_id: str, kind: Literal['sprite', 'background', 'video'],
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    from app.api.motion import media, unavailable
    from app.services.motion_bindings import MotionBindingError
    try:
        selected = shared_motion(db, user.id, str(group_id), character_id, activity)
        if selected is None or selected[0].pack_id != pack_id:
            raise MotionBindingError('motion_not_found', 404)
        return media(selected[1], selected[2], kind)
    except MotionBindingError as exc:
        raise unavailable(exc)
    except OSError:
        raise unavailable(MotionBindingError()) from None
