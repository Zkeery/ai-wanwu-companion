"""角色生成（SSE）与收藏管理（账号隔离）。"""
from __future__ import annotations

import json
import re
from threading import Lock
from time import perf_counter
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import delete as sa_delete, text, select
from sqlalchemy.exc import SQLAlchemyError
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.model_availability import model_availability, require_model_available
from app.core.database import SessionLocal, engine, get_db
from app.core.config import get_settings
from app.core.errors import api_error
from app.living.store import spaces as living_spaces
from app.living.rules import LivingError
from app.models.models import Character, LivingMembership, Object, User, Recreation
from app.schemas.schemas import CharacterCreate, CharacterOut, CharacterOverview, CharacterRename
from app.services.character_overview import character_overviews
from app.services.model_client import ModelClient
from app.services.character_generation import finish_character
from app.services.generation_timing import timed_call, record_timing
from app.services.appearance import generation_brief
from app.services.generation_errors import record_failure
from app.services.character_concept import save_concept, matching_concept
from app.services.generation_stream import GenerationStreamResponse
from app.services.character_images import remove_image_file as _remove_image_file
from app.services import generation_quota as quota
from app.services.themes import require_match

router = APIRouter(prefix="/characters", tags=["characters"])
_creation_lock = Lock()  # Current deployment runs one application process.


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _owned_character(db: Session, user_id: str, character_id: int) -> Character:
    ch = db.get(Character, character_id)
    if ch is None or ch.owner_id != user_id:
        raise api_error(404, "not_found", "角色不存在")
    return ch


@router.get("", response_model=list[CharacterOut])
def list_characters(user: User = Depends(get_current_user),
                    db: Session = Depends(get_db)):
    """收藏列表：只返回当前账号已生成成功的角色。"""
    return (
        db.query(Character)
        .filter(Character.status == "ready", Character.owner_id == user.id)
        .order_by(Character.created_at.desc())
        .all()
    )


@router.get("/overview", response_model=list[CharacterOverview])
def list_overview(response: Response, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db), include_life_activity: bool = False):
    response.headers["Cache-Control"] = "private, no-store"
    response.headers["Vary"] = "Authorization"
    try:
        return character_overviews(db, user.id, include_life_activity)
    except LivingError:
        raise api_error(500, "corrupt_state", "生活记录暂时无法核对，请稍后重试") from None
    except SQLAlchemyError:
        raise api_error(503, "overview_unavailable", "暂时无法读取伙伴近况，请稍后重试") from None


@router.get("/by-object/{object_id}", response_model=CharacterOut | None)
def get_character_by_object(object_id: int, user: User = Depends(get_current_user),
                            db: Session = Depends(get_db)):
    obj = db.get(Object, object_id)
    if obj is None or obj.photo is None or obj.photo.owner_id != user.id:
        raise api_error(404, "object_not_found", "对象不存在")
    return db.query(Character).filter(Character.object_id == object_id).first()


@router.get("/generation-credits")
def generation_credits(request: Request, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    availability = model_availability(request) if getattr(request.app.state, 'model_budget', None) is not None else {}
    if not get_settings().generation_quota_enabled:
        return {"enabled": False, "available": None, **availability}
    available = quota.balance(db, user.id)
    db.commit()
    return {"enabled": True, "available": available, **availability}


@router.get("/recreation-requests/{request_id}")
def recreation_request(request_id: str, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    record = db.query(Recreation).filter_by(owner_id=user.id, request_id=request_id).first()
    if record is None:
        raise api_error(404, "not_found", "再创作任务不存在")
    ch = db.get(Character, record.character_id) if record.character_id else None
    if ch is None:
        return {"status": "deleted", "character": None}
    return {"status": ch.status, "character": CharacterOut.model_validate(ch).model_dump(mode="json")}


@router.patch("/{character_id}", response_model=CharacterOut)
@router.put("/{character_id}", response_model=CharacterOut)
def rename_character(character_id: int, payload: CharacterRename,
                     user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ch = _owned_character(db, user.id, character_id)
    if ch.status != "ready":
        raise api_error(409, "not_ready", "生成完成后才能修改名字")
    # Keep explicit self-introductions consistent without rewriting chat history
    # or replacing unrelated occurrences of short names throughout the persona.
    if ch.name and ch.name != payload.name:
        pattern = r"((?:我是|我叫|叫我|名叫|名字叫做|名字叫|名字是)[「『\"“]?)" + re.escape(ch.name)
        ch.opening_line = re.sub(pattern, lambda match: match[1] + payload.name, ch.opening_line)
    ch.name = payload.name
    db.commit()
    db.refresh(ch)
    return ch


@router.get("/{character_id}", response_model=CharacterOut)
def get_character(character_id: int, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    return _owned_character(db, user.id, character_id)


@router.delete("/{character_id}", status_code=204)
def delete_character(character_id: int, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    ch = _owned_character(db, user.id, character_id)
    image_path = ch.image_path
    from app.models.models import CharacterMotionAsset, CharacterActivityMotionAsset, MotionCleanupTask
    from app.services.motion_cleanup import cleanup_pending_motion
    motion_asset = db.get(CharacterMotionAsset, character_id)
    if motion_asset and db.get(MotionCleanupTask, motion_asset.pack_id) is None:
        db.add(MotionCleanupTask(pack_id=motion_asset.pack_id))
    activity_assets = db.query(CharacterActivityMotionAsset).filter_by(character_id=character_id).all()
    for asset in activity_assets:
        if db.get(MotionCleanupTask, asset.pack_id) is None:
            db.add(MotionCleanupTask(pack_id=asset.pack_id))
        db.delete(asset)
    # 删除该伙伴的私人空间（回执随空间级联），解除共居成员关系，保留账号共居空间与其他伙伴。
    with engine.begin() as conn:
        from app.living.gatherings import GatheringStore, visits
        visiting = conn.execute(select(visits).where(visits.c.character_id == character_id)).mappings().first()
        if visiting:
            gathering_store = GatheringStore(engine)
            group, revision = gathering_store.load(conn, visiting['group_id'])
            gathering_store.return_home(conn, group, character_id)
            gathering_store.save(conn, group, revision + 1)
        conn.execute(sa_delete(living_spaces).where(
            living_spaces.c.owner_id == user.id,
            living_spaces.c.mode == "private",
            living_spaces.c.companion_id == str(character_id),
        ))
    db.execute(sa_delete(LivingMembership).where(
        LivingMembership.companion_id == str(character_id)))
    quota.refund_character(db, character_id)
    from app.services.voice import clear_audio, preferences as voice_preferences
    clear_audio(db, character_id)
    db.execute(sa_delete(voice_preferences).where(voice_preferences.c.character_id == character_id))
    db.delete(ch)
    db.commit()
    cleanup_pending_motion(db, apply=True)
    if image_path and not db.query(Character).filter(Character.image_path == image_path).first():
        _remove_image_file(image_path)
    return None


def _reserve_character(payload: CharacterCreate, db: Session, user: User, *, commit=True):
    obj = db.get(Object, payload.object_id)
    if obj is None or obj.photo is None or obj.photo.owner_id != user.id:
        raise api_error(404, "object_not_found", "对象不存在")

    existing = db.query(Character).filter(Character.object_id == obj.id).first()
    if existing is not None and existing.status in ("generating", "ready"):
        raise api_error(409, "already_exists", "该对象已生成过角色")
    if commit and existing is not None and db.query(Recreation).filter_by(character_id=existing.id).first():
        raise api_error(409, "recreation_pending", "请从原伙伴重新发起再创作")
    theme_id = None if payload.free_creation else obj.photo.theme_id
    require_match(theme_id, obj.category, payload.label is not None and payload.label != obj.label)
    if payload.label is not None:
        if payload.label != obj.label:
            obj.category = "unknown"
        obj.label = payload.label
    if payload.visual_features is not None:
        obj.visual_features = payload.visual_features
    if existing is not None and existing.status == "failed":
        # 允许对失败记录重试：重置为生成中
        ch = existing
        ch.owner_id = user.id
        ch.name = ""
        ch.persona = ""
        ch.opening_line = ""
        ch.image_path = None
        ch.generation_brief_json = None
        ch.status = "generating"
    else:
        ch = Character(
            object_id=obj.id, owner_id=user.id, name="", persona="",
            opening_line="", status="generating"
        )
        db.add(ch)
    ch.theme_id = theme_id
    db.flush()
    quota.reserve(db, user.id, ch.id)
    if commit:
        db.commit()
        db.refresh(ch)
    concept = matching_concept(obj.character_concept_json, obj.label, obj.visual_features) if get_settings().character_bundle_enabled else None
    return ch.id, obj.label, obj.visual_features, concept


@router.post("", dependencies=[Depends(require_model_available)])
def create_character(payload: CharacterCreate, user: User = Depends(get_current_user),
                     db: Session = Depends(get_db)):
    user_id = user.id
    with _creation_lock:
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        character_id, label, visual_features, concept = _reserve_character(payload, db, user)
        charge_id = quota.active(db, character_id)
    return _generation_response(character_id, label, visual_features, concept, user_id, charge_id)


class RecreationRequest(BaseModel):
    request_id: UUID


@router.post("/{character_id}/recreations", dependencies=[Depends(require_model_available)])
def recreate(character_id: int, payload: RecreationRequest, user: User = Depends(get_current_user),
             db: Session = Depends(get_db)):
    if not get_settings().generation_quota_enabled:
        raise api_error(409, "recreation_unavailable", "再创作功能尚未开放")
    owner_id, request_id = user.id, str(payload.request_id)
    with _creation_lock:
        db.rollback()
        db.execute(text("BEGIN IMMEDIATE"))
        original = _owned_character(db, owner_id, character_id)
        if original.status != "ready":
            raise api_error(409, "not_ready", "请先等待当前伙伴生成完成")
        existing = db.query(Recreation).filter_by(owner_id=owner_id, request_id=request_id).first()
        if existing:
            if existing.source_id != character_id:
                raise api_error(409, "conflict", "相同请求标识不能用于不同的伙伴")
            ch = db.get(Character, existing.character_id) if existing.character_id else None
            if ch is None or ch.status != "ready":
                raise api_error(409, "recreation_pending", "请先核对这次再创作的结果")
            data = CharacterOut.model_validate(ch).model_dump(mode="json")
            db.commit()
            return StreamingResponse(iter([_sse_event("done", data)]), media_type="text/event-stream")
        obj = Object(photo_id=original.object.photo_id, label=original.object.label,
                     visual_features=original.object.visual_features, category=original.object.category, character_concept_json=None)
        db.add(obj)
        db.flush()
        cid, label, features, concept = _reserve_character(CharacterCreate(object_id=obj.id, free_creation=original.theme_id is None), db, user, commit=False)
        charge_id = quota.active(db, cid)
        creation_id = str(uuid4())
        previous = {"creation_id": creation_id, "name": original.name, "persona": original.persona,
                    "generation_brief": original.generation_brief_json}
        db.add(Recreation(id=creation_id, owner_id=owner_id, request_id=request_id,
                          source_id=original.id, character_id=cid, charge_id=charge_id))
        db.commit()
    return _generation_response(cid, label, features, concept, owner_id, charge_id, previous)


def _generation_response(character_id, label, visual_features, concept, user_id, charge_id=None, previous=None):

    def gen():
        started = perf_counter()
        operation_id = f"character:{character_id}"
        session = SessionLocal()
        image_path = None
        saved = False
        settled = False
        stage = "profile"
        try:
            client = ModelClient()
            yield _sse_event("started", {"character_id": character_id})
            persona = concept
            if persona is None:
                yield _sse_event("chunk", {"stage": "正在根据确认的特征完善角色构思…"})
                kwargs = {"previous_character": previous} if previous is not None else {}
                persona = timed_call("profile", operation_id, client.generate_concept, label, visual_features, **kwargs)
                # Commit before drawing so a later image failure can reuse the concept.
                current = session.get(Character, character_id)
                if current is None or current.owner_id != user_id or not quota.is_reserved(session, charge_id, character_id):
                    raise RuntimeError("角色已删除")
                current.object.character_concept_json = save_concept(label, visual_features, persona)
                session.commit()
            else:
                yield _sse_event("chunk", {"stage": "照片分析与角色构思已保存，正在准备绘图…"})
            yield _sse_event("chunk", {"stage": "名字与性格已准备好，正在绘制形象…" if persona.opening_line is not None else "正在准备开场白和角色图…"})
            stage = "image" if persona.opening_line is not None else "assets"
            result, image_path = finish_character(client, label, persona, operation_id, visual_features)

            stage = "save"
            db_ch = session.get(Character, character_id)
            if db_ch is None or db_ch.owner_id != user_id or not quota.is_reserved(session, charge_id, character_id):
                raise RuntimeError("角色已删除")
            db_ch.name = result.name
            db_ch.persona = result.persona
            db_ch.opening_line = result.opening_line
            db_ch.image_path = image_path
            db_ch.generation_brief_json = json.dumps(generation_brief(label, result.name, result.persona, visual_features, persona.appearance_description), ensure_ascii=False)
            db_ch.status = "ready"
            from app.services.motion_preparation import enqueue_preparation
            enqueue_preparation(session, db_ch)
            from app.services.motion_generation import register_request
            register_request(session, db_ch)
            quota.settle(session, charge_id, success=True)
            session.commit()
            saved = True
            settled = True
            session.refresh(db_ch)
            data = CharacterOut.model_validate(db_ch).model_dump(mode="json")
            yield _sse_event("done", data)
        except Exception as exc:
            details = record_failure(stage, operation_id, exc)
            session.rollback()
            db_ch = session.get(Character, character_id)
            if not saved and db_ch is not None and db_ch.owner_id == user_id and quota.is_reserved(session, charge_id, character_id):
                db_ch.status = "failed"
            if not saved:
                quota.settle(session, charge_id, success=False)
            session.commit()
            settled = True
            yield _sse_event(
                "error",
                {"error": {"code": "generate_failed", "message": details["message"], "reason": details["reason"]},
                 "status": "unknown" if saved else "failed", "character_id": character_id},
            )
        finally:
            # 客户端断开会关闭生成器；不要把记录永久留在 generating。
            session.rollback()
            db_ch = session.get(Character, character_id)
            if not settled and db_ch is not None and db_ch.owner_id == user_id \
                    and db_ch.status == "generating" and quota.is_reserved(session, charge_id, character_id):
                db_ch.status = "failed"
                quota.settle(session, charge_id, success=False)
                session.commit()
            if image_path and not saved:
                _remove_image_file(image_path)
            session.close()
            record_timing("creation_total", operation_id, started, "succeeded" if saved else "failed")

    return GenerationStreamResponse(gen(), character_id, charge_id)
