"""Transactional chat host; decisions never directly modify a living space."""
import json
from uuid import uuid4

from fastapi.responses import StreamingResponse
from sqlalchemy import delete, select, text

from app.core.database import SessionLocal, engine
from app.core.config import get_settings
from app.core.errors import api_error
from app.models.models import Character, Memory, Message, SceneAgentChat, SceneProposal
from app.schemas.schemas import MessageOut
from app.services import scene_bridge as bridge
from app.services.chat import HISTORY_LIMIT, build_messages
from app.living.store import LivingStore
from app.living.rules import CATALOG
from app.scene_agent.adapter import ProviderAdapter
from app.scene_agent.runtime import AgentError, Runtime

runtime = Runtime(engine)
living_store = LivingStore(engine)


def initialize():
    runtime.initialize()
    # Cascades also cover direct SQL history/character/account deletion.
    with engine.begin() as conn:
        conn.execute(text("""CREATE TRIGGER IF NOT EXISTS scene_agent_chat_cleanup
            AFTER DELETE ON scene_agent_chats BEGIN
            DELETE FROM scene_agent_runs
            WHERE owner_id = OLD.owner_id AND request_id = OLD.request_id;
            END"""))


def recover_interrupted():
    runtime.recover_interrupted()
    with SessionLocal() as db:
        db.query(SceneAgentChat).filter_by(status="running").update(
            {"status": "failed", "error_code": "interrupted"})
        db.commit()


def _event(kind, data):
    return f"event: {kind}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _owned(db, owner_id, character_id):
    character = db.get(Character, character_id)
    if not character or character.owner_id != owner_id:
        raise api_error(404, "not_found", "角色不存在")
    if character.status != "ready":
        raise api_error(409, "character_not_ready", "角色尚未生成完成")
    return character


def _binding_matches(character, row, context):
    return (row is not None and row["id"] == context["space_id"] and
            row["revision"] == context["revision"] and character.location_epoch == context["location_epoch"])


def _public_result(db, record, character):
    result = json.loads(record.result_json)
    if result.get("proposal"):
        proposal = db.get(SceneProposal, result["proposal"]["id"])
        row = bridge.current_space(db, living_store, character)
        context = json.loads(record.context_json)
        if proposal is None or not _binding_matches(character, row, context):
            result["proposal"], result["action"] = None, None
    return result


def read_request(owner_id, character_id, request_id):
    with SessionLocal() as db:
        character = _owned(db, owner_id, character_id)
        record = db.query(SceneAgentChat).filter_by(owner_id=owner_id, character_id=character_id,
                                                  request_id=request_id).first()
        if record is None:
            if not get_settings().scene_agent_enabled:
                return {"request_id": request_id, "status": "untracked", "result": None, "error": None}
            raise api_error(404, "not_found", "聊天任务不存在")
        result = _public_result(db, record, character) if record.status == "completed" else None
        db.commit()  # Persist any legacy import performed by current_space.
        return {"request_id": request_id, "status": record.status, "result": result,
                "error": _error(record.error_code) if record.status == "failed" else None}


def _error(code):
    messages = {"interrupted": "上次对话已中断，请重新发送。", "chat_cancelled": "对话已更新，本次回复已取消。",
                "timed_out": "这次思考超时了，请稍后再试。", "in_progress": "这条消息仍在处理中，请核对结果。"}
    return {"code": code or "agent_failed", "message": messages.get(code, "这次回复没有完成，请稍后再试。")}


def prepare(owner_id, character_id, message, request_id=None):
    request_id = request_id or str(uuid4())
    with SessionLocal() as db:
        db.execute(text("BEGIN IMMEDIATE"))
        character = _owned(db, owner_id, character_id)
        record = db.query(SceneAgentChat).filter_by(owner_id=owner_id, request_id=request_id).first()
        if record:
            origin = db.get(Message, record.source_message_id)
            if record.character_id != character_id or origin is None or origin.content != message:
                raise api_error(409, "conflict", "相同请求标识不能用于不同的消息")
        else:
            row = bridge.current_space(db, living_store, character)
            history = db.query(Message).filter_by(character_id=character_id).order_by(Message.id.desc()).limit(HISTORY_LIMIT).all()[::-1]
            memories = db.query(Memory).filter_by(character_id=character_id).order_by(Memory.id).all()
            elements = bridge.elements_for(bridge.snapshot(living_store, row)) if row else {}
            background = build_messages(character, memories, history, message, elements,
                                        set(bridge.allowed_actions(row["scene_type"])) if row else set())[:-1]
            from app.services.voice import append_mood_context
            append_mood_context(db, owner_id, character_id, background, message)
            from app.services.life_context import append_life_context
            append_life_context(db, owner_id, character_id, background)
            origin = Message(character_id=character_id, role="user", content=message)
            db.add(origin)
            db.flush()
            context = {"companion_id": character_id, "source_message_id": origin.id,
                       "name": character.name[:40], "persona": character.persona,
                       "space_id": row["id"] if row else None, "scene_type": row["scene_type"] if row else None,
                       "revision": row["revision"] if row else None,
                       "location_epoch": character.location_epoch,
                       "elements": {k: v for k, v in elements.items() if k in {"rain", "cloud", "sound", *CATALOG[row["scene_type"]]["items"]}} if row else {},
                       "conversation": json.dumps(background, ensure_ascii=False)[-30000:]}
            record = SceneAgentChat(id=str(uuid4()), owner_id=owner_id, request_id=request_id,
                                    character_id=character_id, source_message_id=origin.id,
                                    context_json=json.dumps(context, ensure_ascii=False), status="running")
            db.add(record)
            db.execute(delete(SceneProposal).where(SceneProposal.character_id == character_id))
        db.commit()
        record_id = record.id

    def generate():
        yield _event("task", {"request_id": request_id})
        try:
            saved = read_request(owner_id, character_id, request_id)
            if saved["status"] == "completed":
                yield _event("done", saved["result"])
                return
            if saved["status"] == "failed":
                yield _event("error", {"error": saved["error"]})
                return
            with SessionLocal() as db:
                record = db.get(SceneAgentChat, record_id)
                if record is None:
                    raise AgentError("chat_cancelled", "对话已清空")
                context = json.loads(record.context_json)

            def guard(conn):
                # Same transaction as runtime insertion prevents resurrection after deletion.
                exists = conn.execute(select(SceneAgentChat.id).where(
                    SceneAgentChat.id == record_id, SceneAgentChat.owner_id == owner_id,
                    SceneAgentChat.status == "running")).first()
                if exists is None:
                    raise AgentError("chat_cancelled", "对话已取消")

            run = runtime.start(owner_id, request_id, context, message, ProviderAdapter(), guard=guard)
            if run.status == "running":
                yield _event("error", {"error": _error("in_progress")})
                return
            if run.status == "failed":
                raise AgentError(run.error_code, "对话失败")
            with SessionLocal() as db:
                db.execute(text("BEGIN IMMEDIATE"))
                record = db.get(SceneAgentChat, record_id)
                if record is None or record.status == "failed":
                    raise AgentError("chat_cancelled", "对话已取消")
                character = _owned(db, owner_id, character_id)
                if record.status == "completed":
                    result = _public_result(db, record, character)
                else:
                    latest = db.query(Message.id).filter_by(character_id=character_id, role="user").order_by(Message.id.desc()).first()
                    if latest is None or latest[0] != record.source_message_id:
                        raise AgentError("chat_cancelled", "已有更新的对话")
                    row = bridge.current_space(db, living_store, character)
                    valid = _binding_matches(character, row, context)
                    action = run.action if valid else None
                    reply = run.reply if valid or not run.action else "住处或布置已经变化，这条建议已取消。我们可以重新商量。"
                    assistant = Message(character_id=character_id, role="assistant", content=reply)
                    db.add(assistant)
                    db.flush()
                    proposal = None
                    if action:
                        db.execute(delete(SceneProposal).where(SceneProposal.character_id == character_id))
                        proposal = {"id": str(uuid4()), "action": action}
                        db.add(SceneProposal(**proposal, character_id=character_id, message_id=assistant.id,
                                             space_id=context["space_id"], space_revision=context["revision"],
                                             location_epoch=context["location_epoch"]))
                    result = {"message": MessageOut.model_validate(assistant).model_dump(mode="json"),
                              "action": action, "proposal": proposal}
                    record.status, record.result_json = "completed", json.dumps(result, ensure_ascii=False)
                db.commit()
            yield _event("chunk", {"delta": result["message"]["content"]})
            yield _event("done", result)
        except Exception as exc:
            code = exc.code if isinstance(exc, AgentError) else "agent_failed"
            try:
                with SessionLocal() as db:
                    db.query(SceneAgentChat).filter_by(id=record_id, status="running").update(
                        {"status": "failed", "error_code": code})
                    db.commit()
            except Exception:
                code = "storage_unavailable"
            yield _event("error", {"error": _error(code)})

    return StreamingResponse(generate(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"})
