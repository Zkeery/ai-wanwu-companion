"""账号会话：签发、校验与登出（滑动续期，可持久化）。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session as DbSession

from app.core.config import get_settings
from app.core.security import hash_token, new_token
from app.models.models import Session, User


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def create_session(db: DbSession, user: User) -> str:
    token = new_token()
    now = _utcnow()
    db.add(Session(
        token_hash=hash_token(token),
        user_id=user.id,
        created_at=now,
        expires_at=now + timedelta(seconds=get_settings().session_ttl_seconds),
        last_seen_at=now,
    ))
    db.commit()
    return token


def resolve_session(db: DbSession, token: str) -> Session | None:
    """校验令牌并滑动续期；过期即删除返回 None。"""
    if not token:
        return None
    session = db.get(Session, hash_token(token))
    if session is None:
        return None
    now = _utcnow()
    if now > session.expires_at:
        db.delete(session)
        db.commit()
        return None
    session.last_seen_at = now
    session.expires_at = now + timedelta(seconds=get_settings().session_ttl_seconds)
    db.commit()
    return session


def get_user_by_session(db: DbSession, token: str) -> User | None:
    session = resolve_session(db, token)
    if session is None:
        return None
    return db.get(User, session.user_id)


def logout(db: DbSession, token: str) -> None:
    if not token:
        return
    session = db.get(Session, hash_token(token))
    if session is not None:
        db.delete(session)
        db.commit()
