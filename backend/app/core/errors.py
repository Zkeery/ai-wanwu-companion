"""统一错误结构：{"error": {"code", "message"}}，不泄露堆栈。"""
from __future__ import annotations

from fastapi import HTTPException


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )
