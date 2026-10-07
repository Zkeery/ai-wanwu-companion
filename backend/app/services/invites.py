"""Operator-provisioned credentials, persistent throttling and revocation."""
from datetime import datetime, timedelta, timezone
import secrets
import time
from uuid import uuid4

from sqlalchemy import delete
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.orm import Session as DbSession

from app.core.errors import api_error
from app.core.security import hash_token
from app.models.models import InviteLoginWindow, LoginInvite, Session, User


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def provision(db: DbSession, *, days: int = 30, user_id: str | None = None) -> tuple[str, str]:
    if not 1 <= days <= 90:
        raise ValueError("invite_days_invalid")
    user = db.get(User, user_id) if user_id else None
    if user_id and user is None:
        raise ValueError("invite_user_not_found")
    if user is None:
        # Non-phone namespace preserves the existing NOT NULL/unique schema.
        # It can never pass normalize_phone or claim a real phone account.
        alias = "i" + secrets.token_hex(5)
        while db.query(User).filter_by(phone=alias).first():
            alias = "i" + secrets.token_hex(5)
        user = User(id=str(uuid4()), phone=alias)
        db.add(user)
        db.flush()
    code = secrets.token_urlsafe(32)
    db.add(LoginInvite(code_hash=hash_token(code), user_id=user.id,
                       expires_at=now() + timedelta(days=days)))
    db.flush()
    return code, user.id


def authenticate(db: DbSession, code: str, source: str) -> User:
    minute = int(time.time()) // 60
    source_hash = hash_token("invite-source:" + source)
    db.execute(delete(InviteLoginWindow).where(InviteLoginWindow.minute < minute - 2))
    statement = insert(InviteLoginWindow).values(source_hash=source_hash, minute=minute, attempts=1)
    db.execute(statement.on_conflict_do_update(
        index_elements=["source_hash", "minute"],
        set_={"attempts": InviteLoginWindow.attempts + 1}))
    db.commit()  # Failed requests still consume the persistent attempt allowance.
    window = db.get(InviteLoginWindow, (source_hash, minute), populate_existing=True)
    if window.attempts > 20:
        raise api_error(429, "invite_rate_limited", "尝试过于频繁，请一分钟后再试")
    invite = db.get(LoginInvite, hash_token(code.strip()))
    if invite is None or invite.revoked or invite.expires_at <= now():
        raise api_error(401, "invite_invalid", "邀请码无效或已过期，请联系邀请人")
    user = db.get(User, invite.user_id)
    if user is None:
        raise api_error(401, "invite_invalid", "邀请码无效或已过期，请联系邀请人")
    return user


def revoke(db: DbSession, user_id: str) -> None:
    for invite in db.query(LoginInvite).filter_by(user_id=user_id):
        invite.revoked = True
    db.execute(delete(Session).where(Session.user_id == user_id))
    db.commit()
