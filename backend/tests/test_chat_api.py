"""聊天（SSE）与记忆接口测试。"""
from __future__ import annotations

import pytest


def _create_character(client, png_header, parse_sse):
    res = client.post(
        "/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}
    )
    assert res.status_code == 201
    obj_id = res.json()["objects"][0]["id"]
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    done = [d for e, d in parse_sse(res.text) if e == "done"]
    assert len(done) == 1
    return done[0]["id"]


def test_chat_stream_and_persist(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)

    res = client.post(f"/api/v1/characters/{cid}/chat", json={"message": "你好呀"})
    assert res.status_code == 200
    events = parse_sse(res.text)
    assert any(e == "chunk" for e, _ in events)
    done = [d for e, d in events if e == "done"]
    assert len(done) == 1
    assert "你好" in done[0]["message"]["content"]

    # 消息已持久化：user + assistant 各一条
    res = client.get(f"/api/v1/characters/{cid}/messages")
    assert res.status_code == 200
    messages = res.json()
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert messages[0]["content"] == "你好呀"


def test_chat_empty_message_returns_400(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/chat", json={"message": "   "})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "empty_message"


def test_chat_character_not_found_returns_404(client):
    res = client.post("/api/v1/characters/9999/chat", json={"message": "hi"})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "not_found"


def test_clear_messages(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    client.post(f"/api/v1/characters/{cid}/chat", json={"message": "你好"})
    res = client.get(f"/api/v1/characters/{cid}/messages")
    assert len(res.json()) == 2

    res = client.delete(f"/api/v1/characters/{cid}/messages")
    assert res.status_code == 204
    res = client.get(f"/api/v1/characters/{cid}/messages")
    assert res.json() == []


def test_memory_crud(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)

    # 创建
    res = client.post(f"/api/v1/characters/{cid}/memories", json={"content": "我喜欢下雨天"})
    assert res.status_code == 201
    memory = res.json()
    mid = memory["id"]
    assert memory["content"] == "我喜欢下雨天"

    # 列表
    res = client.get(f"/api/v1/characters/{cid}/memories")
    assert [m["content"] for m in res.json()] == ["我喜欢下雨天"]

    # 纠正
    res = client.put(f"/api/v1/memories/{mid}", json={"content": "我更喜欢晴天"})
    assert res.status_code == 200
    assert res.json()["content"] == "我更喜欢晴天"

    # 删除
    res = client.delete(f"/api/v1/memories/{mid}")
    assert res.status_code == 204
    res = client.get(f"/api/v1/characters/{cid}/memories")
    assert res.json() == []


def test_memory_empty_content_returns_400(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/memories", json={"content": "  "})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "empty_memory"


def test_delete_character_cascades_messages_and_memories(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    client.post(f"/api/v1/characters/{cid}/chat", json={"message": "你好"})
    client.post(f"/api/v1/characters/{cid}/memories", json={"content": "记忆"})

    res = client.delete(f"/api/v1/characters/{cid}")
    assert res.status_code == 204

    # 删除角色后，消息与记忆应级联清理
    from app.core.database import SessionLocal
    from app.models.models import Memory, Message

    db = SessionLocal()
    try:
        assert db.query(Message).filter(Message.character_id == cid).count() == 0
        assert db.query(Memory).filter(Memory.character_id == cid).count() == 0
    finally:
        db.close()


def test_current_message_is_sent_to_model_once(client, png_header, parse_sse, monkeypatch):
    from app.services.model_client import ModelClient

    cid = _create_character(client, png_header, parse_sse)
    captured = []

    def stream(self, messages):
        captured.extend(messages)
        yield "收到"

    monkeypatch.setattr(ModelClient, "chat_stream", stream)
    client.post(f"/api/v1/characters/{cid}/chat", json={"message": "唯一消息"})
    assert sum(m["content"] == "唯一消息" for m in captured) == 1


@pytest.mark.parametrize("restart_chat", [False, True])
def test_clear_during_stream_never_restores_old_reply(
    client, png_header, parse_sse, monkeypatch, restart_chat
):
    from app.services.model_client import ModelClient

    cid = _create_character(client, png_header, parse_sse)

    def stream(self, messages):
        if messages[-1]["content"] == "新对话":
            yield "新回复"
            return
        yield "旧回复前半"
        assert client.delete(f"/api/v1/characters/{cid}/messages").status_code == 204
        if restart_chat:
            # SQLite may reuse the deleted user ID: timestamps must also match.
            client.post(f"/api/v1/characters/{cid}/chat", json={"message": "新对话"})
        yield "旧回复后半"

    monkeypatch.setattr(ModelClient, "chat_stream", stream)
    res = client.post(f"/api/v1/characters/{cid}/chat", json={"message": "旧对话"})
    events = parse_sse(res.text)
    assert not any(e == "done" for e, _ in events)
    assert any(e == "error" and d["error"]["code"] == "chat_cancelled" for e, d in events)
    saved = client.get(f"/api/v1/characters/{cid}/messages").json()
    assert [m["content"] for m in saved] == (["新对话", "新回复"] if restart_chat else [])


def test_incomplete_reply_is_not_persisted(client, png_header, parse_sse, monkeypatch):
    from app.services.model_client import ModelClient, ModelError

    cid = _create_character(client, png_header, parse_sse)

    def stream(self, messages):
        yield "不完整"
        raise ModelError("连接中断")

    monkeypatch.setattr(ModelClient, "chat_stream", stream)
    res = client.post(f"/api/v1/characters/{cid}/chat", json={"message": "你好"})
    assert [e for e, _ in parse_sse(res.text)] == ["chunk", "error"]
    assert [m["role"] for m in client.get(f"/api/v1/characters/{cid}/messages").json()] == ["user"]


@pytest.mark.parametrize("body", [{}, {"message": 123}, {"message": None}])
def test_invalid_chat_body_has_uniform_error(client, png_header, parse_sse, body):
    cid = _create_character(client, png_header, parse_sse)
    res = client.post(f"/api/v1/characters/{cid}/chat", json=body)
    assert res.status_code == 422
    assert res.json()["error"]["code"] == "invalid_request"


def test_chat_not_ready_character_returns_409(client):
    from app.core.database import SessionLocal
    from app.models.models import Character, Object, Photo
    from tests.auth_helpers import TEST_USER_ID

    db = SessionLocal()
    try:
        photo = Photo(filename="x.png", status="done")
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label="杯子")
        db.add(obj)
        db.flush()
        ch = Character(
            object_id=obj.id, owner_id=TEST_USER_ID, name="", persona="",
            opening_line="", status="failed"
        )
        db.add(ch)
        db.commit()
        cid = ch.id
    finally:
        db.close()

    res = client.post(f"/api/v1/characters/{cid}/chat", json={"message": "hi"})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "character_not_ready"
