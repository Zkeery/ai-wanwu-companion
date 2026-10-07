"""认证依赖：从 Authorization 提取会话并解析当前用户。"""
from __future__ import annotations

from uuid import uuid4

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import get_db
from app.core.errors import api_error
from app.models.models import User
from app.services.auth import get_user_by_session
from app.services.sms import MockSmsProvider, SmsProvider

bearer = HTTPBearer(auto_error=False)

_sms_provider: SmsProvider | None = None

DEV_USER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff"
DEV_PHONE = "10000000000"


def get_sms_provider() -> SmsProvider:
    if _sms_provider is not None:
        return _sms_provider
    settings = get_settings()
    if settings.sms_provider == 'volcengine':
        from app.services.sms_volcengine import VolcengineSmsProvider
        return VolcengineSmsProvider(settings)
    return MockSmsProvider()


def set_sms_provider(provider: SmsProvider | None) -> None:
    global _sms_provider
    _sms_provider = provider


def _dev_user(db: Session, token: str) -> User | None:
    settings = get_settings()
    if not settings.dev_auth_token or token != settings.dev_auth_token:
        return None
    user = db.get(User, DEV_USER_ID)
    if user is None:
        user = User(id=DEV_USER_ID, phone=DEV_PHONE)
        db.add(user)
        db.commit()
        db.refresh(user)
    return user


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: Session = Depends(get_db),
) -> User:
    token = credentials.credentials if credentials else None
    user = _dev_user(db, token) if token else None
    if user is None:
        user = get_user_by_session(db, token)
    if user is None:
        raise api_error(401, "unauthorized", "请先登录")
    return user


def get_bearer_token(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
) -> str | None:
    return credentials.credentials if credentials else None
