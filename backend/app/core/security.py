"""令牌、哈希与手机号规范化（确定性代码，模型不参与）。"""
from __future__ import annotations

import hashlib
import re
import secrets

_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def hash_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)


def new_verification_code() -> str:
    return f"{secrets.randbelow(1_000_000):06d}"


def normalize_phone(raw: str) -> str:
    """去掉空格与 +86/86 前缀，返回 11 位国内手机号；非法返回空串。"""
    if not isinstance(raw, str):
        return ""
    value = re.sub(r"[\s-]", "", raw.strip())
    if value.startswith("+86"):
        value = value[3:]
    elif value.startswith("86") and len(value) == 13:
        value = value[2:]
    return value if _PHONE_RE.match(value) else ""
