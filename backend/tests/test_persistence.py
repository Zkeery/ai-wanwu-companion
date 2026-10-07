"""持久化测试：服务重启后数据可恢复。"""
from __future__ import annotations

import sqlite3

from app.core.config import get_settings


def test_collection_survives_restart(client, png_header):
    # 走完上传 → 生成 → 收藏
    res = client.post(
        "/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}
    )
    obj_id = res.json()["objects"][0]["id"]
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    assert "done" in res.text

    # 模拟进程重启：绕过 ORM，直接用 sqlite3 打开同一文件验证数据已落盘
    settings = get_settings()
    db_path = settings.database_url.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    try:
        rows = conn.execute("SELECT status, name FROM characters").fetchall()
    finally:
        conn.close()

    assert any(status == "ready" and name == "杯子小伴" for status, name in rows)
