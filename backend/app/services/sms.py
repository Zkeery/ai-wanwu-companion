"""短信发送适配层与验证码生命周期。

验证码生成、存储、过期、限流与校验都在服务层；短信发送只走适配层一个动作。
隔离验证使用 MockSmsProvider，真实平台接入前需费用授权。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Protocol

from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError, OperationalError

from app.core.config import get_settings
from app.core.security import hash_code, new_verification_code, normalize_phone
from app.models.models import SmsDailyQuota, VerificationCode


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class SmsProvider(Protocol):
    def send_code(self, phone: str, code: str) -> None: ...


class MockSmsProvider:
    """不真正发短信；仅用于隔离验证验证码生命周期与登录。"""

    def __init__(self) -> None:
        self.sent: list[tuple[str, str]] = []

    def send_code(self, phone: str, code: str) -> None:
        self.sent.append((phone, code))


def _settings():
    return get_settings()


def _reserve_budget(db: Session, day: str) -> None:
    limit = _settings().sms_daily_limit
    if not 0 < limit <= 10000:
        raise SmsError('sms_budget_exhausted', '短信发送额度尚未开放，请稍后再试')
    if db.get(SmsDailyQuota, day) is None:
        try:
            with db.begin_nested():
                db.add(SmsDailyQuota(day=day, used=0))
                db.flush()
        except IntegrityError:
            pass  # Another worker created today's counter.
    changed = db.query(SmsDailyQuota).filter(SmsDailyQuota.day == day, SmsDailyQuota.used < limit).update(
        {SmsDailyQuota.used: SmsDailyQuota.used + 1}, synchronize_session=False)
    if not changed:
        raise SmsError('sms_budget_exhausted', '今天短信发送额度已用完，请明天再试')


def issue_code(phone: str, db: Session, provider: SmsProvider) -> None:
    """生成并发送验证码；覆盖同号旧码，执行重发与单日限流。"""
    normalized = normalize_phone(phone)
    if not normalized:
        raise SmsError("phone_invalid", "请输入正确的手机号")
    preflight = getattr(provider, 'preflight', None)
    if preflight:
        preflight()
    now = _utcnow()
    record = db.query(VerificationCode).filter(VerificationCode.phone == normalized).first()
    today = now.strftime("%Y-%m-%d")
    if record is not None:
        if (now - record.last_sent_at).total_seconds() < _settings().code_resend_seconds:
            raise SmsError("rate_limited", "发送太频繁，请稍后再试")
        if record.send_day == today and record.send_count >= _settings().code_daily_limit:
            raise SmsError("rate_limited", "今天发送次数已达上限，请明天再试")
    code = new_verification_code()
    digest = hash_code(code)
    try:
        if getattr(provider, 'requires_budget', False):
            _reserve_budget(db, today)
        values = dict(code_hash=digest, expires_at=now + timedelta(seconds=_settings().code_ttl_seconds),
                      attempts=0, last_sent_at=now, send_day=today,
                      send_count=record.send_count + 1 if record is not None and record.send_day == today else 1)
        if record is None:
            db.add(VerificationCode(phone=normalized, **values))
        else:
            changed = db.query(VerificationCode).filter(
                VerificationCode.id == record.id, VerificationCode.last_sent_at == record.last_sent_at,
                VerificationCode.code_hash == record.code_hash).update(values, synchronize_session=False)
            if not changed:
                raise SmsError('rate_limited', '发送太频繁，请稍后再试')
        db.commit()  # Reserve before any network call; never retry an uncertain send.
    except SmsError:
        db.rollback()
        raise
    except (IntegrityError, OperationalError):
        db.rollback()
        raise SmsError('rate_limited', '发送请求正在处理中，请稍后再试') from None
    try:
        provider.send_code(normalized, code)
    except SmsError as error:
        if error.code != 'sms_unknown':
            db.query(VerificationCode).filter(VerificationCode.phone == normalized,
                VerificationCode.code_hash == digest, VerificationCode.last_sent_at == now).update(
                    {VerificationCode.expires_at: now - timedelta(seconds=1)}, synchronize_session=False)
            db.commit()
        raise
    except Exception:
        raise SmsError('sms_unknown', '发送结果暂未确认，请等待一分钟；若已收到短信，可直接填写验证码登录') from None


def verify_code(phone: str, code: str, db: Session) -> str:
    """校验验证码；返回 'ok' / 'expired' / 'invalid'。成功即一次性作废。
    开发过渡：配置 dev_sms_fixed_code 后，该固定码直接通过（正式环境必须留空）。"""
    fixed = _settings().dev_sms_fixed_code
    if fixed and code == fixed:
        return "ok"
    normalized = normalize_phone(phone)
    if not normalized or not isinstance(code, str) or not code.isdigit() or len(code) != 6:
        return "invalid"
    record = db.query(VerificationCode).filter(VerificationCode.phone == normalized).first()
    if record is None:
        return "invalid"
    now = _utcnow()
    if now > record.expires_at:
        return "expired"
    if record.attempts >= _settings().code_max_attempts:
        return "expired"
    if record.code_hash != hash_code(code):
        db.query(VerificationCode).filter(VerificationCode.id == record.id,
            VerificationCode.code_hash == record.code_hash,
            VerificationCode.attempts < _settings().code_max_attempts).update(
                {VerificationCode.attempts: VerificationCode.attempts + 1}, synchronize_session=False)
        db.commit()
        return "invalid"
    consumed = db.query(VerificationCode).filter(VerificationCode.id == record.id,
        VerificationCode.code_hash == hash_code(code), VerificationCode.expires_at >= now,
        VerificationCode.expires_at == record.expires_at,
        VerificationCode.attempts < _settings().code_max_attempts).update(
            {VerificationCode.expires_at: now - timedelta(seconds=1)}, synchronize_session=False)
    db.commit()
    return "ok" if consumed else "invalid"


class SmsError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message
