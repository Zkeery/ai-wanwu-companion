"""Owner-only, versioned personality changes with immutable original snapshot."""
import json
from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import engine, get_db
from app.core.errors import api_error
from app.models.models import Character, CharacterPersonality, User
from app.services.personality import OPTIONS, CONFLICTS, MAX_CUSTOM, normalize, describe

router = APIRouter(tags=['personality'])


class PersonalityEdit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    expected_revision: StrictInt = Field(ge=0)
    mode: Literal['original', 'custom']
    tags: list[StrictStr] = Field(default_factory=list, max_length=len(OPTIONS))
    custom_text: StrictStr = Field(default='', max_length=MAX_CUSTOM)
    priority: Literal['presets', 'custom'] | None = None


def owned(db, owner_id, character_id, lock=False):
    query = db.query(Character).filter_by(id=character_id, owner_id=owner_id)
    character = (query.with_for_update() if lock else query).first()
    if character is None:
        raise api_error(404, 'not_found', '伙伴不存在')
    if character.status != 'ready':
        raise api_error(409, 'character_not_ready', '伙伴尚未生成完成')
    return character


def result(character, row):
    return dict(character_id=character.id, original_persona=row.original_persona if row else character.persona,
                effective_persona=character.persona, mode=row.mode if row else 'original',
                tags=json.loads(row.tags_json) if row else [], custom_text=row.custom_text if row else '',
                priority=row.priority if row else None, revision=row.revision if row else 0)


@router.get('/personality-options')
def options(response: Response, user: User = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'private, no-store'
    return dict(options=OPTIONS, conflicts=CONFLICTS, max_custom_length=MAX_CUSTOM, catalog_version=1)


@router.get('/characters/{character_id}/personality')
def read(character_id: int, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'private, no-store'
    # A single statement keeps revision and effective text from the same snapshot.
    pair = db.query(Character, CharacterPersonality).outerjoin(
        CharacterPersonality, CharacterPersonality.character_id == Character.id
    ).filter(Character.id == character_id, Character.owner_id == user.id).first()
    if pair is None:
        raise api_error(404, 'not_found', '伙伴不存在')
    character, row = pair
    if character.status != 'ready':
        raise api_error(409, 'character_not_ready', '伙伴尚未生成完成')
    return result(character, row)


@router.patch('/characters/{character_id}/personality')
@router.put('/characters/{character_id}/personality')
def save(character_id: int, body: PersonalityEdit, response: Response, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    response.headers['Cache-Control'] = 'private, no-store'
    owner_id = user.id
    try:
        # End auth's read transaction, then serialize both first insert and later edits.
        db.rollback()
        if engine.dialect.name == 'sqlite':
            db.execute(text('BEGIN IMMEDIATE'))
        character = owned(db, owner_id, character_id, lock=True)
        row = db.get(CharacterPersonality, character_id)
        if body.expected_revision != (row.revision if row else 0):
            raise api_error(409, 'personality_conflict', '性格已在其他页面更新，请先核对再决定是否保存')
        if body.mode == 'original':
            if body.tags or body.custom_text or body.priority is not None:
                raise api_error(422, 'invalid_personality', '恢复原始性格不能同时提交自定义设置')
            tags, custom, priority = [], '', None
        else:
            tags, custom, priority = normalize(body.tags, body.custom_text, body.priority)
        if row is None:
            row = CharacterPersonality(character_id=character_id, original_persona=character.persona, revision=0)
            db.add(row)
        row.mode, row.tags_json, row.custom_text, row.priority = body.mode, json.dumps(tags), custom, priority
        row.revision += 1
        character.persona = row.original_persona if body.mode == 'original' else describe(tags, custom, priority)
        db.flush()
        saved = result(character, row)
        db.commit()
        return saved
    except SQLAlchemyError:
        db.rollback()
        raise api_error(503, 'storage_unavailable', '暂时无法确认保存结果，请先核对性格') from None
    except Exception:
        db.rollback()
        raise
