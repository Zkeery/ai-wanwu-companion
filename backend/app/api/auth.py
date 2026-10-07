"""账号：验证码登录、登出与当前用户。"""
from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.deps import get_bearer_token, get_current_user, get_sms_provider
from app.core.database import get_db
from app.core.config import get_settings
from app.core.errors import api_error
from app.core.security import normalize_phone
from app.models.models import Character, Photo, PhotoRequest, User
from app.services.auth import create_session, logout
from app.services.sms import SmsError, SmsProvider, issue_code, verify_code

router = APIRouter(prefix="/auth", tags=["auth"])


class CodeRequest(BaseModel):
    phone: str = Field(min_length=1, max_length=32)


class LoginRequest(BaseModel):
    phone: str = Field(min_length=1, max_length=32)
    code: str = Field(min_length=6, max_length=6)


class InviteRequest(BaseModel):
    code: str = Field(min_length=1, max_length=128, repr=False)


def _user_out(user: User) -> dict:
    return {"id": user.id, "phone": "" if user.phone.startswith("i") else user.phone}


def require_sms_mode() -> None:
    if get_settings().auth_mode != "sms":
        raise api_error(403, "sms_disabled", "当前使用邀请码登录")


@router.post("/invite")
def invite_login(payload: InviteRequest, request: Request, db: Session = Depends(get_db)):
    from app.services.invites import authenticate
    if get_settings().auth_mode != "invite":
        raise api_error(403, "invite_disabled", "邀请码登录未开放")
    user = authenticate(db, payload.code, request.client.host if request.client else "unknown")
    return {"token": create_session(db, user), "user": _user_out(user)}


@router.post("/code")
def send_code(payload: CodeRequest, db: Session = Depends(get_db),
              provider: SmsProvider = Depends(get_sms_provider)):
    require_sms_mode()
    try:
        issue_code(payload.phone, db, provider)
    except SmsError as error:
        status = 422 if error.code == "phone_invalid" else 429 if error.code in ("rate_limited", "sms_budget_exhausted") else 503
        raise api_error(status, error.code, error.message) from None
    return {"sent": True}


@router.post("/login")
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    require_sms_mode()
    phone = normalize_phone(payload.phone)
    if not phone:
        raise api_error(422, "phone_invalid", "请输入正确的手机号")
    result = verify_code(phone, payload.code, db)
    if result != "ok":
        raise api_error(400, "code_" + result, "验证码错误或已过期，请重新获取")
    user = db.query(User).filter(User.phone == phone).first()
    if user is None:
        user = User(id=str(uuid4()), phone=phone)
        db.add(user)
        db.commit()
        db.refresh(user)
    token = create_session(db, user)
    return {"token": token, "user": _user_out(user)}


@router.post("/logout", status_code=204)
def do_logout(token: str | None = Depends(get_bearer_token),
              db: Session = Depends(get_db)):
    logout(db, token or "")
    return Response(status_code=204)


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return _user_out(user)


@router.post("/claim")
def claim(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """显式认领历史无主数据（不自动分配），并把旧花园转换为家庭庭院私人空间。"""
    require_legacy_claim(user.id)
    from app.api.living import living_store
    from app.services.migration import migrate_scene_to_living

    photos = db.query(Photo).filter(Photo.owner_id.is_(None)).update(
        {Photo.owner_id: user.id}, synchronize_session=False)
    requests = db.query(PhotoRequest).filter(PhotoRequest.owner_id.is_(None)).update(
        {PhotoRequest.owner_id: user.id}, synchronize_session=False)
    characters = db.query(Character).filter(Character.owner_id.is_(None)).all()
    for ch in characters:
        ch.owner_id = user.id
    db.commit()  # 先提交认领，释放写锁后再迁移场景

    migrated = 0
    for ch in characters:
        if migrate_scene_to_living(db, living_store, user.id, ch):
            migrated += 1
    db.commit()
    return {"claimed_photos": photos, "claimed_requests": requests,
            "claimed_characters": len(characters), "migrated_scenes": migrated}


def require_legacy_claim(user_id: str) -> None:
    settings = get_settings()
    if settings.app_env == "production" or not settings.legacy_claim_user_id or settings.legacy_claim_user_id != user_id:
        raise api_error(403, "claim_disabled", "当前账号未开放历史数据认领")
