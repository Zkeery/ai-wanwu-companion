"""聊天（SSE）与手动记忆管理。"""
from __future__ import annotations

import json
from uuid import uuid4

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from sqlalchemy import delete, exists, insert, literal, select

from app.api.deps import get_current_user
from app.api.model_availability import require_model_available
from app.core.database import SessionLocal, get_db
from app.core.errors import api_error
from app.models.models import Character, Memory, Message, SceneState, SceneProposal, User
from app.schemas.schemas import (
    ChatRequest,
    MemoryCreate,
    MemoryOut,
    MemoryUpdate,
    MessageOut,
)
from app.services.chat import HISTORY_LIMIT, build_messages, detect_scene_action
from app.services.model_client import ModelClient
from app.services.input_limits import validate_text
from app.services import scene as scene_service
from app.services import scene_bridge as bridge
from app.api.living import living_store
from app.core.config import get_settings
from app.scene_agent import chat as agent_chat

router = APIRouter(prefix="/characters", tags=["chat"])
memories_router = APIRouter(prefix="/memories", tags=["memories"])


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _get_character(character_id: int, db: Session, user_id: str) -> Character:
    ch = db.get(Character, character_id)
    if not ch or ch.owner_id != user_id:
        raise api_error(404, "not_found", "角色不存在")
    if ch.status != "ready":
        raise api_error(409, "character_not_ready", "角色尚未生成完成，无法聊天")
    return ch


# ---- 聊天 ----

@router.post("/{character_id}/chat", dependencies=[Depends(require_model_available)])
def chat(character_id: int, payload: ChatRequest, user: User = Depends(get_current_user),
         db: Session = Depends(get_db)):
    character = _get_character(character_id, db, user.id)
    text = validate_text(payload.message, "message")
    if get_settings().scene_agent_enabled:
        owner_id = user.id
        db.rollback()
        return agent_chat.prepare(owner_id, character_id, text, payload.request_id)

    # 先保存用户消息：即使客户端中途断开，已发送的消息也不丢失。
    user_msg = Message(character_id=character_id, role="user", content=text)
    db.add(user_msg)
    db.execute(delete(SceneProposal).where(SceneProposal.character_id == character_id))
    db.commit()
    db.refresh(user_msg)
    user_message_id = user_msg.id
    user_message_created_at = user_msg.created_at

    memories = (
        db.query(Memory).filter(Memory.character_id == character_id).order_by(Memory.created_at.asc()).all()
    )
    history = (
        db.query(Message)
        .filter(Message.character_id == character_id, Message.id < user_message_id)
        .order_by(Message.id.desc()).limit(HISTORY_LIMIT).all()[::-1]
    )
    visiting = bridge.visiting_group(db, character)
    row = bridge.current_space(db, living_store, character)
    if row:
        elements = bridge.elements_for(bridge.snapshot(living_store, row))
    else:
        scene = db.query(SceneState).filter(SceneState.character_id == character_id).first()
        elements, _ = scene_service.deserialize(scene.state_json if scene else None)
    messages = build_messages(character, memories, history, text, elements,
                              set(bridge.allowed_actions(row["scene_type"])) if row else None)
    from app.services.voice import append_mood_context
    append_mood_context(db, user.id, character_id, messages)
    from app.services.life_context import append_life_context
    append_life_context(db, user.id, character_id, messages)
    if row:
        from app.living.rules import CATALOG
        messages[0]["content"] += f"\n伙伴当前生活场景：{CATALOG[row['scene_type']]['name']}。可提议的操作：{', '.join(bridge.allowed_actions(row['scene_type']))}。不支持的操作请解释当前场景限制。"
    action = detect_scene_action(text)
    if visiting:
        action = None
    if row and action not in bridge.allowed_actions(row["scene_type"]):
        action = None
    bound_space = row["id"] if row else None
    bound_revision = row["revision"] if row else None
    bound_epoch = character.location_epoch
    db.commit()

    def gen():
        session = SessionLocal()
        try:
            client = ModelClient()
            parts: list[str] = []
            for chunk in client.chat_stream(messages):
                parts.append(chunk)
                yield _sse_event("chunk", {"delta": chunk})
            reply = "".join(parts).strip()
            if not reply:
                raise RuntimeError("模型返回空回复")
            # 插入与原用户消息仍存在的检查在同一 SQL 中完成。
            # 清空历史后旧回复不可写回；时间戳同时防止 SQLite 重用消息 ID。
            origin_exists = exists().where(
                Message.id == user_message_id,
                Message.character_id == character_id,
                Message.created_at == user_message_created_at,
                Message.role == "user",
            )
            statement = insert(Message).from_select(
                ["character_id", "role", "content"],
                select(literal(character_id), literal("assistant"), literal(reply)).where(origin_exists),
            ).returning(Message)
            assistant_msg = session.scalars(statement).one_or_none()
            if assistant_msg is None:
                session.rollback()
                yield _sse_event("error", {"error": {
                    "code": "chat_cancelled", "message": "历史已清空或角色已删除，本次回复已取消"
                }})
                return
            # 与助手回复同一事务保存；刷新可恢复，清空消息会级联删除提议。
            session.execute(delete(SceneProposal).where(SceneProposal.character_id == character_id))
            proposal = None
            current_character = session.get(Character, character_id)
            current_row = bridge.current_space(session, living_store, current_character)
            unchanged = (current_character.location_epoch == bound_epoch and
                         (current_row["id"] if current_row else None) == bound_space and
                         (current_row["revision"] if current_row else None) == bound_revision)
            if action and unchanged:
                proposal = {"id": str(uuid4()), "action": action}
                session.add(SceneProposal(**proposal, character_id=character_id, message_id=assistant_msg.id,
                                          space_id=bound_space, space_revision=bound_revision,
                                          location_epoch=bound_epoch))
            session.commit()
            session.refresh(assistant_msg)
            data = MessageOut.model_validate(assistant_msg).model_dump(mode="json")
            yield _sse_event(
                "done", {"message": data, "action": action, "proposal": proposal}
            )
        except Exception:
            session.rollback()
            yield _sse_event(
                "error",
                {"error": {"code": "chat_failed", "message": "聊天失败，请重试"}},
            )
        finally:
            session.close()

    return StreamingResponse(gen(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
    })


@router.get("/{character_id}/messages", response_model=list[MessageOut])
def list_messages(character_id: int, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    _get_character(character_id, db, user.id)
    return (
        db.query(Message)
        .filter(Message.character_id == character_id)
        .order_by(Message.created_at.asc())
        .all()
    )


@router.get("/{character_id}/chat/requests/{request_id}")
def get_chat_request(character_id: int, request_id: str, user: User = Depends(get_current_user)):
    return agent_chat.read_request(user.id, character_id, request_id)


@router.delete("/{character_id}/messages", status_code=204)
def clear_messages(character_id: int, user: User = Depends(get_current_user),
                   db: Session = Depends(get_db)):
    _get_character(character_id, db, user.id)
    db.query(Message).filter(Message.character_id == character_id).delete()
    from app.services.voice import clear_audio
    clear_audio(db, character_id)
    db.commit()


# ---- 记忆 ----

@router.post("/{character_id}/memories", response_model=MemoryOut, status_code=201)
def create_memory(character_id: int, payload: MemoryCreate, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    _get_character(character_id, db, user.id)
    content = validate_text(payload.content, "memory")
    memory = Memory(character_id=character_id, content=content)
    db.add(memory)
    db.commit()
    db.refresh(memory)
    return memory


@router.get("/{character_id}/memories", response_model=list[MemoryOut])
def list_memories(character_id: int, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    _get_character(character_id, db, user.id)
    return (
        db.query(Memory)
        .filter(Memory.character_id == character_id)
        .order_by(Memory.created_at.asc())
        .all()
    )


@memories_router.put("/{memory_id}", response_model=MemoryOut)
def update_memory(memory_id: int, payload: MemoryUpdate, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    memory = db.get(Memory, memory_id)
    if not memory or memory.character is None or memory.character.owner_id != user.id:
        raise api_error(404, "not_found", "记忆不存在")
    content = validate_text(payload.content, "memory")
    memory.content = content
    db.commit()
    db.refresh(memory)
    return memory


@memories_router.delete("/{memory_id}", status_code=204)
def delete_memory(memory_id: int, user: User = Depends(get_current_user),
                  db: Session = Depends(get_db)):
    memory = db.get(Memory, memory_id)
    if not memory or memory.character is None or memory.character.owner_id != user.id:
        raise api_error(404, "not_found", "记忆不存在")
    db.delete(memory)
    db.commit()
