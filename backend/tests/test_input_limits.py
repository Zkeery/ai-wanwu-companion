"""跨语言文本边界与 API 拒绝请求的无副作用保证。"""
import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.core.database import SessionLocal
from app.models.models import Message, SceneProposal
from app.services.model_client import ModelClient

CASES = json.loads((Path(__file__).parents[2] / "tests/fixtures/input-limits.json").read_text())


def pending_proposal(cid, token):
    with SessionLocal() as db:
        message = Message(character_id=cid, role="assistant", content="可以种树")
        db.add(message)
        db.flush()
        db.add(SceneProposal(id=token, character_id=cid, message_id=message.id, action="plant_tree"))
        db.commit()


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"])
def test_shared_text_samples(client, ready_character_id, case):
    response = client.post(f"/api/v1/characters/{ready_character_id}/memories",
                           content=json.dumps({"content": case["input"]}),
                           headers={"Content-Type": "application/json"})
    expected = 422 if not case["validUnicode"] else 400 if not case["count"] else 201
    assert response.status_code == expected
    if expected == 201:
        assert response.json()["content"] == case["normalized"]
        assert len(response.json()["content"]) == case["count"]
    else:
        assert response.json()["error"]["code"] == ("invalid_request" if expected == 422 else "empty_memory")


@pytest.mark.parametrize("size", [3999, 4000, 4001])
def test_chat_boundary_before_any_side_effect(client, ready_character_id, monkeypatch, size, parse_sse):
    stream = Mock(return_value=iter(["收到"]))
    monkeypatch.setattr(ModelClient, "chat_stream", stream)
    pending_proposal(ready_character_id, "keep-proposal")
    base = f"/api/v1/characters/{ready_character_id}"
    before = client.get(base + "/messages").json()
    message = "\ufeff　" + "🌱" * size + " \n"
    result = client.post(base + "/chat", json={"message": message})
    if size <= 4000:
        assert result.status_code == 200
        assert parse_sse(result.text)[-1][0] == "done"
        assert client.get(base + "/messages").json()[-2]["content"] == "🌱" * size
        assert stream.call_count == 1
    else:
        assert result.status_code == 400
        assert result.headers["content-type"].startswith("application/json")
        assert result.json()["error"] == {"code": "message_too_long", "message": "消息不能超过 4000 字"}
        assert client.get(base + "/messages").json() == before
        assert stream.call_count == 0
        with SessionLocal() as db:
            assert db.get(SceneProposal, "keep-proposal") is not None


@pytest.mark.parametrize("size", [999, 1000, 1001])
def test_memory_create_and_edit_boundary(client, ready_character_id, size):
    base = f"/api/v1/characters/{ready_character_id}/memories"
    saved = client.post(base, json={"content": "旧内容"}).json()
    content = " \ufeff" + "🌱" * size + "　"
    added = client.post(base, json={"content": content})
    edited = client.put(f"/api/v1/memories/{saved['id']}", json={"content": content})
    if size <= 1000:
        assert added.status_code == 201 and edited.status_code == 200
        assert added.json()["content"] == edited.json()["content"] == "🌱" * size
    else:
        assert added.status_code == edited.status_code == 400
        assert added.json()["error"] == edited.json()["error"] == {"code": "memory_too_long", "message": "记忆不能超过 1000 字"}
        assert client.get(base).json() == [saved]


@pytest.mark.parametrize("value,code", [("\ud800", "invalid_request"), ("\udfff", "invalid_request"),
                                       ("\ufeff　\n", "empty_message")])
def test_invalid_chat_preserves_history_and_proposal(client, ready_character_id, monkeypatch, value, code):
    stream = Mock(side_effect=AssertionError("invalid text must not call model"))
    monkeypatch.setattr(ModelClient, "chat_stream", stream)
    base = f"/api/v1/characters/{ready_character_id}"
    pending_proposal(ready_character_id, "pending")
    before = client.get(base + "/messages").json()
    result = client.post(base + "/chat", content=json.dumps({"message": value}),
                         headers={"Content-Type": "application/json"})
    assert result.status_code == (400 if code == "empty_message" else 422)
    assert result.json()["error"]["code"] == code
    assert client.get(base + "/messages").json() == before
    stream.assert_not_called()
    with SessionLocal() as db:
        assert db.get(SceneProposal, "pending") is not None


@pytest.mark.parametrize("body", [{}, {"content": 123}, {"content": None}, {"content": "\ud800"}])
def test_invalid_memory_bodies_do_not_change_existing_memory(client, ready_character_id, body):
    base = f"/api/v1/characters/{ready_character_id}/memories"
    saved = client.post(base, json={"content": "保留这条记忆"}).json()
    for method, url in [(client.post, base), (client.put, f"/api/v1/memories/{saved['id']}")]:
        result = method(url, content=json.dumps(body), headers={"Content-Type": "application/json"})
        assert result.status_code == 422
        assert result.json()["error"]["code"] == "invalid_request"
    assert client.get(base).json() == [saved]


def test_missing_entities_checked_before_text_length(client):
    assert client.post("/api/v1/characters/999/chat", json={"message": "x" * 4001}).status_code == 404
    assert client.post("/api/v1/characters/999/memories", json={"content": "x" * 1001}).status_code == 404
    assert client.put("/api/v1/memories/999", json={"content": "x" * 1001}).status_code == 404
