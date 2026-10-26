"""Guest accounts stay inside the normal owner boundary, with their own durable limits."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import secrets
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi import Request
from sqlalchemy import delete, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import api_error
from app.core.security import hash_token
from app.models.models import Character, GuestAccount, GuestDaily, GuestSignup, User

DAILY_COMPANION_LIMIT = "今天的游客伙伴名额已经用完，明天再来。已有的伙伴还在，也可以用邀请码登录。"
DAILY_CHAT_LIMIT = "今天的游客聊天名额已经用完，明天再来。已有的聊天还在。"
IP_LIMIT = "这个网络一小时内开启的体验账号已经够多了，请稍后再试，或使用邀请码登录。"
RECOGNITION_LIMIT = "今天识别照片的次数已经用完，明天再来，或使用邀请码登录。"


def _companion_limit() -> str:
    return f"体验账号最多认识 {get_settings().guest_companions_per_user} 个伙伴。已有的伙伴还在，可以用邀请码登录后继续。"


def _chat_limit() -> str:
    return f"体验账号最多聊 {get_settings().guest_messages_per_user} 句。之前的聊天还在，可以用邀请码登录后继续。"


def is_guest(user) -> bool:
    phone = getattr(user, "phone", None)
    return isinstance(phone, str) and len(phone) == 11 and phone.startswith("g")


def request_source(request: Request) -> str:
    peer = request.client.host if request.client else ""
    if peer in {"127.0.0.1", "::1"}:
        forwarded = request.headers.get("x-real-ip", "").strip()
        if forwarded and len(forwarded) <= 64 and "\n" not in forwarded and "\r" not in forwarded:
            return forwarded
    return peer or "unknown"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def shanghai_day(moment: datetime | None = None) -> str:
    current = moment or _now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return current.astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()


def _account(db: Session, user_id: str) -> GuestAccount:
    row = db.get(GuestAccount, user_id)
    if row is None:
        row = GuestAccount(user_id=user_id, companions=0, messages=0, recognitions=0, recognition_day="")
        db.add(row)
        db.flush()
    return row


def _daily(db: Session, day: str | None = None) -> GuestDaily:
    key = day or shanghai_day()
    row = db.get(GuestDaily, key)
    if row is None:
        row = GuestDaily(day=key, companions=0, messages=0)
        db.add(row)
        db.flush()
    return row


def create_guest(db: Session, source: str) -> User:
    settings = get_settings()
    source_hash = hash_token("guest-ip:" + source[:128])
    cutoff = _now() - timedelta(hours=1)
    db.rollback()
    db.execute(text("BEGIN IMMEDIATE"))
    db.execute(delete(GuestSignup).where(GuestSignup.created_at < cutoff))
    used = db.query(GuestSignup).filter(
        GuestSignup.source_hash == source_hash, GuestSignup.created_at >= cutoff).count()
    if used >= settings.guest_accounts_per_ip_per_hour:
        db.rollback()
        raise api_error(429, "guest_ip_limited", IP_LIMIT)
    alias = "g" + secrets.token_hex(5)
    while db.query(User).filter_by(phone=alias).first():
        alias = "g" + secrets.token_hex(5)
    user = User(id=str(uuid4()), phone=alias)
    db.add(user)
    db.flush()
    db.add(GuestAccount(user_id=user.id, companions=0, messages=0, recognitions=0, recognition_day=""))
    db.add(GuestSignup(source_hash=source_hash, created_at=_now()))
    db.commit()
    db.refresh(user)
    return user


def _raise_if_companion_full(db: Session, user: User) -> tuple[GuestAccount, GuestDaily]:
    settings = get_settings()
    account, daily = _account(db, user.id), _daily(db)
    if account.companions >= settings.guest_companions_per_user:
        raise api_error(429, "guest_companion_limit", _companion_limit())
    if daily.companions >= settings.guest_companions_per_day:
        raise api_error(429, "guest_daily_companion_limit", DAILY_COMPANION_LIMIT)
    return account, daily


def reserve_guest_companion(db: Session, user: User) -> None:
    if not is_guest(user):
        return
    account, daily = _raise_if_companion_full(db, user)
    account.companions += 1
    daily.companions += 1


def release_guest_companion(db: Session, user_id: str | None) -> None:
    if not user_id:
        return
    user = db.get(User, user_id)
    if not is_guest(user):
        return
    account = db.get(GuestAccount, user_id)
    if account is not None and account.companions > 0:
        account.companions -= 1
    daily = db.get(GuestDaily, shanghai_day())
    if daily is not None and daily.companions > 0:
        daily.companions -= 1


def release_interrupted_guest_companions(db: Session) -> None:
    rows = db.query(Character).filter(Character.status == "generating").all()
    for character in rows:
        release_guest_companion(db, character.owner_id)


def _guest_recognition_state(db: Session, user: User) -> GuestAccount | None:
    if not is_guest(user):
        return None
    _raise_if_companion_full(db, user)
    settings = get_settings()
    account = _account(db, user.id)
    today = shanghai_day()
    if account.recognition_day != today:
        account.recognition_day = today
        account.recognitions = 0
    if account.recognitions >= settings.guest_recognitions_per_day:
        raise api_error(429, "guest_recognition_limit", RECOGNITION_LIMIT)
    return account


def ensure_guest_recognition_room(db: Session, user: User) -> None:
    _guest_recognition_state(db, user)


def note_guest_recognition(db: Session, user: User) -> None:
    account = _guest_recognition_state(db, user)
    if account is None:
        return
    account.recognitions += 1
    db.commit()


def accept_guest_message(db: Session, user: User) -> None:
    if not is_guest(user):
        return
    settings = get_settings()
    account, daily = _account(db, user.id), _daily(db)
    if account.messages >= settings.guest_messages_per_user:
        raise api_error(429, "guest_chat_limit", _chat_limit())
    if daily.messages >= settings.guest_messages_per_day:
        raise api_error(429, "guest_daily_chat_limit", DAILY_CHAT_LIMIT)
    account.messages += 1
    daily.messages += 1
