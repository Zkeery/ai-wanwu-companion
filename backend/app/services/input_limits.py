"""确定性输入约束；与前端共享 tests/fixtures/input-limits.json 边界样例。"""
from typing import Literal

from app.core.errors import api_error

MAX_CANDIDATES = 5
MESSAGE_LIMIT = 4000
MEMORY_LIMIT = 1000
TREE_LIMIT = 7

# ECMAScript String.trim whitespace, explicitly excluding Python-only whitespace.
TRIM_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def validate_text(raw: str, kind: Literal["message", "memory"]) -> str:
    if any(0xD800 <= ord(char) <= 0xDFFF for char in raw):
        raise api_error(422, "invalid_request", "请求参数不正确，请检查输入")
    value = raw.strip(TRIM_WHITESPACE)
    if not value:
        raise api_error(400, f"empty_{kind}", "消息不能为空" if kind == "message" else "记忆内容不能为空")
    limit = MESSAGE_LIMIT if kind == "message" else MEMORY_LIMIT
    if len(value) > limit:
        label = "消息" if kind == "message" else "记忆"
        raise api_error(400, f"{kind}_too_long", f"{label}不能超过 {limit} 字")
    return value
