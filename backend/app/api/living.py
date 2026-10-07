"""多场景 HTTP：把 R1 的 LivingStore 接到正式 HTTP，加上成员与位置。

owner_id 来自会话，不再接受浏览器声明的 ID；companion_id 使用 str(character.id)。
"""
from __future__ import annotations

from uuid import UUID, uuid4
from typing import Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy import delete as sa_delete, select, text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.core.database import engine, get_db
from app.core.errors import api_error
from app.living.store import LivingStore, spaces as living_spaces, receipts
from app.living import seasons, activity
from app.models.models import Character, LivingMembership, SceneProposal, User

router = APIRouter(prefix="/living", tags=["living"])
location_router = APIRouter(prefix="/characters", tags=["living-location"])

living_store = LivingStore(engine)


class SeasonPreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    settings: seasons.Settings


class SeasonSaveRequest(SeasonPreviewRequest):
    request_id: UUID
    expected_revision: int = Field(ge=0, strict=True)


@router.get("/spaces/{space_id}/season")
def get_season(space_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return seasons.read(db.connection(), user.id, space_id, living_store._now())


@router.post("/spaces/{space_id}/season/preview")
def preview_season(space_id: str, payload: SeasonPreviewRequest,
                   user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return seasons.preview(db.connection(), user.id, space_id, payload.settings, living_store._now())


@router.put("/spaces/{space_id}/season")
def save_season(space_id: str, payload: SeasonSaveRequest,
                user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        _require_private_companion_home(db.connection(), living_store._row(db.connection(), user.id, space_id), user.id)
        result = seasons.save(db.connection(), user.id, space_id, str(payload.request_id),
                              payload.expected_revision, payload.settings, living_store._now())
        db.commit()
        return result
    except SQLAlchemyError:
        db.rollback()
        raise api_error(503, "storage_unavailable", "四季设置暂时无法保存，请先核对状态") from None


class CreateSpaceRequest(BaseModel):
    scene_type: str
    mode: str
    companion_id: str | None = None


class ActionRequest(BaseModel):
    request_id: str
    expected_revision: int = Field(ge=0)
    command: dict


class MembershipRequest(BaseModel):
    companion_id: str


class LocationRequest(BaseModel):
    space_id: str


def _map_living_error(error: Exception):
    from app.living.rules import LivingError
    if isinstance(error, LivingError):
        status = {
            "invalid_request": 422, "not_found": 404, "conflict": 409,
            "invalid_action": 409, "corrupt_state": 500, "storage_unavailable": 503,
        }.get(error.code, 500)
        raise api_error(status, error.code, error.message) from None
    raise error


def _owned_character(db: Session, user_id: str, character_id: int) -> Character:
    ch = db.get(Character, character_id)
    if ch is None or ch.owner_id != user_id:
        raise api_error(404, "not_found", "伙伴不存在")
    return ch


def _owned_space(user_id: str, space_id: str) -> dict:
    with living_store.engine.connect() as conn:
        row = conn.execute(select(living_spaces).where(
            living_spaces.c.id == space_id, living_spaces.c.owner_id == user_id
        )).mappings().first()
    if row is None:
        raise api_error(404, "not_found", "空间不存在或无权访问")
    return dict(row)


def _require_private_companion_home(conn, row: dict, user_id: str) -> None:
    if row["mode"] != "private" or not row["companion_id"] or not row["companion_id"].isdigit():
        return
    from app.living.gatherings import visits
    away = conn.execute(select(visits.c.character_id).where(
        visits.c.character_id == int(row["companion_id"]),
        visits.c.owner_id == user_id,
    )).first()
    if away:
        raise api_error(409, "conflict", "伙伴正在共同空间，原住处只可查看；请先召回")


def _member_names(db: Session, space_id: str) -> list[dict]:
    memberships = db.query(LivingMembership).filter(
        LivingMembership.space_id == space_id
    ).order_by(LivingMembership.companion_id.asc()).all()
    result = []
    for membership in memberships:
        name = None
        if membership.companion_id.isdigit():
            ch = db.get(Character, int(membership.companion_id))
            if ch is not None:
                name = ch.name
        result.append({"companion_id": membership.companion_id, "name": name})
    return result


@router.get("/spaces")
def list_spaces(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    with living_store.engine.connect() as conn:
        rows = conn.execute(select(living_spaces).where(
            living_spaces.c.owner_id == user.id
        ).order_by(living_spaces.c.scene_type, living_spaces.c.id)).mappings().all()
    result = []
    for row in rows:
        item = {"id": row["id"], "scene_type": row["scene_type"], "mode": row["mode"],
                "companion_id": row["companion_id"], "revision": row["revision"]}
        if row["mode"] == "shared":
            item["members"] = _member_names(db, row["id"])
        result.append(item)
    return result


@router.post("/spaces", status_code=201)
def create_space(payload: CreateSpaceRequest, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    companion_id = None
    if payload.mode == "private":
        if not payload.companion_id:
            raise api_error(422, "invalid_request", "独居空间必须绑定一个伙伴")
        ch = _owned_character(db, user.id, int(payload.companion_id)) if payload.companion_id.isdigit() else None
        if ch is None:
            raise api_error(404, "not_found", "伙伴不存在")
        companion_id = str(ch.id)
    elif payload.mode == "shared":
        if payload.companion_id:
            raise api_error(422, "invalid_request", "共居空间不绑定单个伙伴")
    else:
        raise api_error(422, "invalid_request", "请选择独居或同住")
    if payload.mode == "private" and payload.scene_type == "home":
        from app.services.scene_bridge import ensure_home, snapshot as read_snapshot
        # A new or pre-existing home must receive the old garden exactly once.
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        ch = _owned_character(db, user.id, int(companion_id))
        existing = db.connection().execute(select(living_spaces.c.id).where(
            living_spaces.c.owner_id == user.id, living_spaces.c.companion_id == companion_id,
            living_spaces.c.scene_type == "home", living_spaces.c.mode == "private")).first()
        if existing:
            raise api_error(409, "conflict", "该伙伴已有此类私人空间，请读取已有空间")
        row = ensure_home(db, living_store, ch, create=True)
        result = read_snapshot(living_store, row)
        db.commit()
        return result
    try:
        snapshot = living_store.create_space(user.id, str(uuid4()), payload.scene_type,
                                             payload.mode, companion_id)
    except Exception as error:
        _map_living_error(error)
    return snapshot


@router.get("/spaces/{space_id}")
def get_space(space_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        row = _owned_space(user.id, space_id)
        if row["mode"] == "private" and row["scene_type"] == "home" and row["companion_id"].isdigit():
            from app.services.scene_bridge import ensure_home
            db.execute(text("BEGIN IMMEDIATE"))
            ch = _owned_character(db, user.id, int(row["companion_id"]))
            ensure_home(db, living_store, ch)
            db.commit()
        return living_store.read_space(user.id, space_id)
    except Exception as error:
        _map_living_error(error)


@router.post("/spaces/{space_id}/actions")
def do_action(space_id: str, payload: ActionRequest, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    try:
        db.execute(text("BEGIN IMMEDIATE"))
        row = living_store._row(db.connection(), user.id, space_id)
        _require_private_companion_home(db.connection(), row, user.id)
        if row["mode"] == "private" and row["scene_type"] == "home" and row["companion_id"].isdigit():
            from app.services.scene_bridge import ensure_home
            ch = _owned_character(db, user.id, int(row["companion_id"]))
            ensure_home(db, living_store, ch)
        row = living_store._row(db.connection(), user.id, space_id)
        replay = db.connection().execute(select(receipts.c.request_id).where(
            receipts.c.space_id == space_id, receipts.c.request_id == payload.request_id)).first()
        result = living_store.execute(user.id, space_id, payload.request_id,
                                      payload.expected_revision, payload.command, connection=db.connection())
        if row['mode'] == 'private' and replay is None:
            activity.record(db.connection(), row, payload.command, result, payload.request_id)
        db.commit()
        return result
    except Exception as error:
        db.rollback()
        if isinstance(error, SQLAlchemyError):
            raise api_error(503, 'storage_unavailable', '操作暂时无法保存，请先核对场景') from None
        _map_living_error(error)


@router.get('/spaces/{space_id}/activity')
def get_activity(space_id: str, before_revision: int | None = Query(default=None, gt=0, le=9007199254740991),
                 category: Literal['all', 'care', 'layout', 'atmosphere'] = 'all',
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    try:
        return activity.read(db.connection(), user.id, space_id, before_revision, category)
    except SQLAlchemyError:
        raise api_error(503, 'storage_unavailable', '生活记录暂时无法读取，请稍后刷新') from None


@router.get("/spaces/{space_id}/members")
def list_members(space_id: str, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    row = _owned_space(user.id, space_id)
    if row["mode"] != "shared":
        raise api_error(409, "invalid_action", "只有共居空间有成员")
    return _member_names(db, space_id)


@router.post("/spaces/{space_id}/members", status_code=201)
def add_member(space_id: str, payload: MembershipRequest, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    row = _owned_space(user.id, space_id)
    if row["mode"] != "shared":
        raise api_error(409, "invalid_action", "只有共居空间有成员")
    if not payload.companion_id.isdigit():
        raise api_error(404, "not_found", "伙伴不存在")
    ch = _owned_character(db, user.id, int(payload.companion_id))
    existing = db.get(LivingMembership, (space_id, str(ch.id)))
    if existing is None:
        db.add(LivingMembership(space_id=space_id, companion_id=str(ch.id)))
        db.commit()
    return {"space_id": space_id, "companion_id": str(ch.id)}


@router.delete("/spaces/{space_id}/members/{companion_id}", status_code=204)
def remove_member(space_id: str, companion_id: str, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    row = _owned_space(user.id, space_id)
    if row["mode"] != "shared":
        raise api_error(409, "invalid_action", "只有共居空间有成员")
    db.execute(sa_delete(LivingMembership).where(
        LivingMembership.space_id == space_id,
        LivingMembership.companion_id == companion_id,
    ))
    db.query(Character).filter(
        Character.current_space_id == space_id,
        Character.id == int(companion_id) if companion_id.isdigit() else -1,
    ).update({Character.current_space_id: None, Character.location_epoch: Character.location_epoch + 1})
    db.commit()
    return None


@router.delete("/spaces/{space_id}", status_code=204)
def delete_space(space_id: str, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    _owned_space(user.id, space_id)
    try:
        with living_store.engine.begin() as conn:
            conn.execute(sa_delete(living_spaces).where(
                living_spaces.c.id == space_id, living_spaces.c.owner_id == user.id
            ))
    except Exception as error:
        _map_living_error(error)
    db.execute(sa_delete(LivingMembership).where(LivingMembership.space_id == space_id))
    db.query(Character).filter(Character.current_space_id == space_id).update(
        {Character.current_space_id: None, Character.location_epoch: Character.location_epoch + 1})
    db.commit()
    return None


@location_router.get("/{character_id}/location")
def get_location(character_id: int, user: User = Depends(get_current_user),
                 db: Session = Depends(get_db)):
    ch = _owned_character(db, user.id, character_id)
    return {"character_id": ch.id, "space_id": ch.current_space_id}


@location_router.put("/{character_id}/location")
def set_location(character_id: int, payload: LocationRequest,
                 user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.execute(text("BEGIN IMMEDIATE"))
    ch = _owned_character(db, user.id, character_id)
    from app.living.gatherings import visits
    if db.execute(select(visits).where(visits.c.character_id == ch.id)).first():
        raise api_error(409, 'conflict', '伙伴正在共同空间，请先在那里召回')
    row = _owned_space(user.id, payload.space_id)
    if row["mode"] == "private":
        if row["companion_id"] != str(ch.id):
            raise api_error(403, "forbidden", "这是其他伙伴的独居空间")
    else:
        membership = db.get(LivingMembership, (payload.space_id, str(ch.id)))
        if membership is None:
            raise api_error(403, "forbidden", "该伙伴不是这个共居空间的成员")
    from app.services.scene_bridge import ensure_home
    # Preserve an old garden even when the first chosen destination is not home.
    from app.models.models import SceneState
    if db.query(SceneState).filter_by(character_id=ch.id).first() is not None:
        ensure_home(db, living_store, ch, create=True)
    if ch.current_space_id != payload.space_id:
        ch.location_epoch += 1
        db.query(SceneProposal).filter_by(character_id=ch.id).delete()
    ch.current_space_id = payload.space_id
    db.commit()
    return {"character_id": ch.id, "space_id": ch.current_space_id}
