"""场景状态与受控操作。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import delete, text
from sqlalchemy.dialects.sqlite import insert

from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.errors import api_error
from app.models.models import Character, SceneState, SceneProposal, SceneImport, User
from app.schemas.schemas import SceneOut
from app.services import scene as scene_service
from app.services import scene_bridge as bridge
from app.api.living import living_store
from app.living.rules import CATALOG
from uuid import uuid4

router = APIRouter(prefix="/characters", tags=["scene"])


def _get_ready_character(character_id: int, db: Session, user_id: str) -> Character:
    ch = db.get(Character, character_id)
    if not ch or ch.owner_id != user_id:
        raise api_error(404, "not_found", "角色不存在")
    if ch.status != "ready":
        raise api_error(409, "character_not_ready", "角色尚未生成完成，无法操作场景")
    return ch


def _get_or_create_state(character_id: int, db: Session) -> SceneState:
    if db.get(SceneImport, character_id) is not None:
        raise api_error(409, "scene_required", "请先选择生活场景，旧花园存档已保留")
    state = (
        db.query(SceneState).filter(SceneState.character_id == character_id).first()
    )
    if state is None:
        db.execute(insert(SceneState).values(
            character_id=character_id,
            state_json=scene_service.serialize(scene_service.default_elements(), []),
        ).on_conflict_do_nothing(index_elements=["character_id"]))
        state = db.query(SceneState).filter(SceneState.character_id == character_id).one()
    return state


def _scene_out(state: SceneState, db: Session, feedback: str | None = None) -> SceneOut:
    elements, history = scene_service.deserialize(state.state_json)
    return SceneOut(
        scene_name=scene_service.SCENE_NAME,
        elements=elements,
        can_undo=bool(history),
        action_labels=scene_service.ACTION_LABELS,
        feedback=feedback,
        proposal=db.query(SceneProposal).filter(SceneProposal.character_id == state.character_id).first(),
    )


def _living_out(ch, row, db, feedback=None, snap=None):
    snap = snap or bridge.snapshot(living_store, row)
    proposal = db.query(SceneProposal).filter_by(character_id=ch.id).first()
    if proposal and (proposal.space_id != row["id"] or
                     proposal.space_revision != snap["revision"] or
                     proposal.location_epoch != ch.location_epoch):
        db.delete(proposal)
        proposal = None
    return SceneOut(scene_name=CATALOG[row["scene_type"]]["name"],
                    living=snap, elements=bridge.elements_for(snap),
                    can_undo=snap["can_undo"], action_labels=bridge.allowed_actions(row["scene_type"]),
                    feedback=feedback, proposal=proposal)


def _reject_gathering(db: Session, ch: Character) -> None:
    if bridge.visiting_group(db, ch):
        raise api_error(409, "scene_changed", "伙伴正在共同空间，请先召回再操作住处")


@router.get("/{character_id}/scene", response_model=SceneOut)
def get_scene(character_id: int, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    db.execute(text("BEGIN IMMEDIATE"))
    ch = _get_ready_character(character_id, db, user.id)
    if bridge.visiting_group(db, ch):
        result = SceneOut(scene_name="共同空间", elements=scene_service.default_elements(),
                          can_undo=False, action_labels={})
        db.commit()
        return result
    row = bridge.current_space(db, living_store, ch)
    if row:
        result = _living_out(ch, row, db)
        db.commit()
        return result
    state = _get_or_create_state(character_id, db)
    result = _scene_out(state, db)
    db.commit()
    return result


@router.post("/{character_id}/scene/actions/{action}", response_model=SceneOut)
def do_action(character_id: int, action: str, user: User = Depends(get_current_user),
              db: Session = Depends(get_db)):
    # SQLite在读取旧状态前取得写锁，避免连续/并发操作丢失增量。
    db.execute(text("BEGIN IMMEDIATE"))
    ch = _get_ready_character(character_id, db, user.id)
    if action not in scene_service.ACTIONS:
        raise api_error(400, "invalid_action", "不支持的操作")
    _reject_gathering(db, ch)
    row = bridge.current_space(db, living_store, ch)
    if row:
        snap, feedback = bridge.apply_action(db, living_store, ch, row, action)
        db.query(SceneProposal).filter_by(character_id=ch.id).delete()
        result = _living_out(ch, row, db, feedback, snap)
        db.commit()
        return result
    state = _get_or_create_state(character_id, db)
    elements, history = scene_service.deserialize(state.state_json)
    before = dict(elements)
    elements = scene_service.apply_action(elements, action)
    if elements == before and action in {"plant_tree", "plant_flower", "grow_mushroom", "add_pond", "place_bench", "light_campfire", "release_fireflies"}:
        db.commit()
        return _scene_out(state, db, feedback=scene_service.unchanged_feedback(action, elements))
    history = [before]
    db.execute(delete(SceneProposal).where(SceneProposal.character_id == character_id))
    state.state_json = scene_service.serialize(elements, history)
    db.commit()
    return _scene_out(state, db, feedback=scene_service.feedback_for(action))


@router.post("/{character_id}/scene/undo", response_model=SceneOut)
def undo_scene(character_id: int, user: User = Depends(get_current_user),
               db: Session = Depends(get_db)):
    db.execute(text("BEGIN IMMEDIATE"))
    ch = _get_ready_character(character_id, db, user.id)
    _reject_gathering(db, ch)
    row = bridge.current_space(db, living_store, ch)
    if row:
        if not bridge.snapshot(living_store, row)["can_undo"]:
            raise api_error(409, "nothing_to_undo", "没有可撤销的操作")
        snap = living_store.execute(user.id, row["id"], str(uuid4()), row["revision"],
                                    {"action": "undo"}, connection=db.connection())
        db.query(SceneProposal).filter_by(character_id=ch.id).delete()
        result = _living_out(ch, row, db, "已撤销上一次操作。", snap)
        db.commit()
        return result
    state = _get_or_create_state(character_id, db)
    elements, history = scene_service.deserialize(state.state_json)
    if not history:
        raise api_error(409, "nothing_to_undo", "没有可撤销的操作")
    elements = history.pop()
    db.execute(delete(SceneProposal).where(SceneProposal.character_id == character_id))
    state.state_json = scene_service.serialize(elements, history)
    db.commit()
    return _scene_out(state, db, feedback="已撤销上一次操作。")


@router.post("/{character_id}/scene/proposals/{proposal_id}/{decision}", response_model=SceneOut)
def decide_proposal(character_id: int, proposal_id: str, decision: str,
                    user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    db.execute(text("BEGIN IMMEDIATE"))
    ch = _get_ready_character(character_id, db, user.id)
    if decision not in ("confirm", "reject"):
        raise api_error(400, "invalid_decision", "请选择确认或拒绝")
    _reject_gathering(db, ch)
    row = bridge.current_space(db, living_store, ch)
    if row:
        proposal = db.query(SceneProposal).filter_by(id=proposal_id, character_id=character_id).first()
        if (proposal is None or proposal.space_id != row["id"] or
                proposal.space_revision != row["revision"] or proposal.location_epoch != ch.location_epoch):
            raise api_error(409, "proposal_expired", "场景已变化，请重新提出建议")
        snap = bridge.snapshot(living_store, row)
        feedback = "已拒绝，场景未改变。"
        if decision == "confirm":
            snap, feedback = bridge.apply_action(db, living_store, ch, row, proposal.action, proposal.id)
        db.delete(proposal)
        db.flush()
        result = _living_out(ch, row, db, feedback, snap)
        db.commit()
        return result
    old_proposal = db.query(SceneProposal).filter_by(id=proposal_id, character_id=character_id).first()
    if old_proposal and old_proposal.space_id is not None:
        raise api_error(409, "proposal_expired", "原场景已变化，请重新提出建议")
    action = db.execute(delete(SceneProposal).where(
        SceneProposal.id == proposal_id, SceneProposal.character_id == character_id,
    ).returning(SceneProposal.action)).scalar_one_or_none()
    if action is None:
        raise api_error(409, "proposal_expired", "该提议已处理或已失效，请刷新场景")
    state = _get_or_create_state(character_id, db)
    feedback = "已拒绝，场景未改变。"
    if decision == "confirm":
        elements, _ = scene_service.deserialize(state.state_json)
        updated = scene_service.apply_action(elements, action)
        if updated == elements:
            feedback = scene_service.unchanged_feedback(action, elements)
        else:
            state.state_json = scene_service.serialize(updated, [elements])
            feedback = scene_service.feedback_for(action)
    db.commit()
    return _scene_out(state, db, feedback=feedback)
