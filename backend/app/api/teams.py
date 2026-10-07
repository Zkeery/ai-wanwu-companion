"""Private theme teams: membership, explicit submission and revocable invitations."""
from hashlib import sha256
import json
import secrets
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from app.api.deps import get_current_user
from app.api.wall import PublishRequest, image_file, owned
from app.core.database import SessionLocal
from app.core.errors import api_error
from app.models.models import Character, Team, TeamMember, TeamSubmission, User
from app.services.themes import validate_theme

router = APIRouter(tags=["teams"])


def team_db(response: Response):
    response.headers["Cache-Control"] = "no-store"
    with SessionLocal() as db:
        # This project uses a single SQLite database. Serialize membership checks
        # with writes so leave/disband cannot race with a late submission/join.
        db.execute(text("BEGIN IMMEDIATE"))
        try:
            yield db
        finally:
            db.rollback()


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DisplayName(StrictInput):
    display_name: str

    @field_validator("display_name")
    @classmethod
    def valid_name(cls, value):
        return PublishRequest.clean_name(value)


class CreateTeam(DisplayName):
    request_id: UUID
    title: str
    theme_id: str

    @field_validator("title")
    @classmethod
    def valid_title(cls, value):
        import unicodedata
        value = value.strip()
        if not 1 <= len(value) <= 30 or any(unicodedata.category(c).startswith("C") for c in value):
            raise ValueError("invalid title")
        return value


class Invitation(StrictInput):
    token: str = Field(min_length=40, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")


class JoinTeam(Invitation, DisplayName):
    pass


def member_team(db: Session, tid: str, uid: str) -> Team:
    team = db.get(Team, tid)
    if team is None or team.status != "active" or db.get(TeamMember, (tid, uid)) is None:
        raise api_error(404, "team_not_found", "小队不存在，或你已不是成员")
    return team


def creator(team: Team, uid: str):
    if team.creator_id != uid:
        raise api_error(403, "creator_required", "只有发起人可以进行这个操作")


def summary(db: Session, team: Team, uid: str):
    return {"id": team.id, "title": team.title, "theme_id": team.theme_id,
            "is_creator": team.creator_id == uid, "invitation_active": team.invite_hash is not None,
            "member_count": db.query(TeamMember).filter_by(team_id=team.id).count()}


def detail(db: Session, team: Team, uid: str):
    members = db.query(TeamMember).filter_by(team_id=team.id).order_by(TeamMember.joined_at, TeamMember.id).all()
    submissions = db.query(TeamSubmission, Character).join(Character, TeamSubmission.character_id == Character.id).filter(
        TeamSubmission.team_id == team.id).order_by(TeamSubmission.submitted_at.desc(), TeamSubmission.id).all()
    aliases = {m.user_id: m.display_name for m in members}
    return {**summary(db, team, uid),
            "members": [{"id": m.id, "display_name": m.display_name, "is_me": m.user_id == uid,
                         "is_creator": m.user_id == team.creator_id,
                         "submission_count": sum(s.owner_id == m.user_id for s, _ in submissions)} for m in members],
            "submissions": [{"id": s.id, "name": ch.name, "introduction": ch.persona[:160],
                             "author_name": aliases[s.owner_id], "is_mine": s.owner_id == uid,
                             "image_url": f"/api/v1/teams/{team.id}/submissions/{s.id}/image",
                             "submitted_at": s.submitted_at.isoformat()} for s, ch in submissions]}


def invited(db: Session, token: str) -> Team:
    team = db.query(Team).filter_by(invite_hash=sha256(token.encode()).hexdigest(), status="active").first()
    if team is None:
        raise api_error(410, "invitation_expired", "邀请已失效或小队已解散，请向发起人获取新邀请")
    return team


@router.get("/teams")
def list_teams(user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    teams = db.query(Team).join(TeamMember, TeamMember.team_id == Team.id).filter(
        TeamMember.user_id == user.id, Team.status == "active").order_by(Team.created_at.desc()).all()
    return [summary(db, team, user.id) for team in teams]


@router.post("/teams")
def create_team(payload: CreateTeam, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    validate_theme(payload.theme_id)
    digest = sha256(json.dumps([payload.title, payload.theme_id, payload.display_name], ensure_ascii=False).encode()).hexdigest()
    tid = str(payload.request_id)
    team = db.get(Team, tid)
    if team is not None:
        if team.creator_id != user.id:
            raise api_error(404, "team_not_found", "小队不存在")
        if team.status != "active" or team.create_digest != digest:
            raise api_error(409, "create_conflict", "这次创建记录已变化，请核对后重新创建")
    else:
        team = Team(id=tid, creator_id=user.id, title=payload.title, theme_id=payload.theme_id, create_digest=digest)
        db.add(team)
        db.flush()
        db.add(TeamMember(team_id=tid, user_id=user.id, id=str(uuid4()), display_name=payload.display_name))
        db.flush()
    result = detail(db, team, user.id)
    db.commit()
    return result


@router.get("/teams/{team_id}")
def get_team(team_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    return detail(db, member_team(db, team_id, user.id), user.id)


@router.post("/teams/{team_id}/invitation")
def new_invitation(team_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    team = member_team(db, team_id, user.id)
    creator(team, user.id)
    token = secrets.token_urlsafe(32)
    team.invite_hash = sha256(token.encode()).hexdigest()
    db.commit()
    return {"token": token}


@router.delete("/teams/{team_id}/invitation", status_code=204)
def revoke_invitation(team_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    team = member_team(db, team_id, user.id)
    creator(team, user.id)
    team.invite_hash = None
    db.commit()


@router.post("/team-invitations/preview")
def preview_invitation(payload: Invitation, db: Session = Depends(team_db)):
    team = invited(db, payload.token)
    owner = db.get(TeamMember, (team.id, team.creator_id))
    return {"title": team.title, "theme_id": team.theme_id, "creator_name": owner.display_name,
            "member_count": db.query(TeamMember).filter_by(team_id=team.id).count()}


@router.post("/team-invitations/join")
def join_team(payload: JoinTeam, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    team = invited(db, payload.token)
    exists = db.get(TeamMember, (team.id, user.id)) is not None
    if not exists:
        db.add(TeamMember(team_id=team.id, user_id=user.id, id=str(uuid4()), display_name=payload.display_name))
    result = {"team_id": team.id, "already_member": exists}
    db.commit()
    return result


@router.put("/teams/{team_id}/submissions/{character_id}")
def submit(team_id: str, character_id: int, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    team = member_team(db, team_id, user.id)
    ch = owned(db, user.id, character_id)
    if ch.status != "ready" or ch.theme_id != team.theme_id or image_file(ch) is None:
        raise api_error(409, "submission_mismatch", "请选择这个主题下已完成且有形象的伙伴")
    if db.query(TeamSubmission).filter_by(team_id=team.id, character_id=ch.id).first() is None:
        db.add(TeamSubmission(id=str(uuid4()), team_id=team.id, owner_id=user.id, character_id=ch.id))
        db.flush()
    result = detail(db, team, user.id)
    db.commit()
    return result


@router.delete("/teams/{team_id}/submissions/{submission_id}", status_code=204)
def withdraw(team_id: str, submission_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    member_team(db, team_id, user.id)
    item = db.get(TeamSubmission, submission_id)
    if item is not None:
        if item.team_id != team_id or item.owner_id != user.id:
            raise api_error(404, "submission_not_found", "不能撤回这份作品")
        db.delete(item)
    db.commit()


@router.get("/teams/{team_id}/submissions/{submission_id}/image")
def submission_image(team_id: str, submission_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    member_team(db, team_id, user.id)
    item = db.get(TeamSubmission, submission_id)
    if item is None or item.team_id != team_id:
        raise api_error(404, "submission_not_found", "作品已撤回或不可见")
    ch = db.get(Character, item.character_id)
    path = image_file(ch) if ch else None
    if path is None:
        raise api_error(404, "image_not_found", "形象暂不可用")
    return FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                       "Content-Security-Policy": "default-src 'none'; sandbox"})


@router.delete("/teams/{team_id}/membership", status_code=204)
def leave_team(team_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    team = db.get(Team, team_id)
    if team and team.status == "active" and team.creator_id == user.id:
        raise api_error(409, "creator_cannot_leave", "发起人请使用解散小队，成员收藏会保留")
    db.execute(delete(TeamMember).where(TeamMember.team_id == team_id, TeamMember.user_id == user.id))
    db.commit()


@router.delete("/teams/{team_id}", status_code=204)
def dissolve_team(team_id: str, user: User = Depends(get_current_user), db: Session = Depends(team_db)):
    team = db.get(Team, team_id)
    if team is None:
        raise api_error(404, "team_not_found", "小队不存在")
    creator(team, user.id)
    team.status = "dissolved"
    team.invite_hash = None
    db.execute(delete(TeamMember).where(TeamMember.team_id == team_id))
    db.commit()
