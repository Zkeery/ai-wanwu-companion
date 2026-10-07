"""Stage acceptance: persisted confirmation, undo, isolation, concurrent operations."""
import json
import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from tests.test_chat_api import _create_character


def propose(client, cid, parse_sse, text="种棵树吧"):
    result = client.post(f"/api/v1/characters/{cid}/chat", json={"message": text})
    return next(d for e, d in parse_sse(result.text) if e == "done")["proposal"]


def test_proposal_is_only_applied_after_confirmation_and_only_once(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    proposal = propose(client, cid, parse_sse)
    before = client.get(base).json()
    assert before["elements"]["tree"] == 0
    assert before["proposal"] == proposal
    url = base + f"/proposals/{proposal['id']}/confirm"
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: client.post(url), range(2)))
    assert sorted(r.status_code for r in results) == [200, 409]
    after = client.get(base).json()
    assert after["elements"]["tree"] == 1
    assert after["proposal"] is None


def test_reject_and_wrong_character_cannot_execute(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    other = _create_character(client, png_header, parse_sse)
    proposal = propose(client, cid, parse_sse)
    assert client.post(f"/api/v1/characters/{other}/scene/proposals/{proposal['id']}/confirm").status_code == 409
    base = f"/api/v1/characters/{cid}/scene"
    assert client.post(base + f"/proposals/{proposal['id']}/reject").status_code == 200
    state = client.get(base).json()
    assert state["elements"]["tree"] == 0 and state["proposal"] is None


def test_new_message_and_clear_history_invalidate_proposals(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    old = propose(client, cid, parse_sse)
    assert propose(client, cid, parse_sse, "不要下雨") is None
    assert client.post(base + f"/proposals/{old['id']}/confirm").status_code == 409
    propose(client, cid, parse_sse)
    client.delete(f"/api/v1/characters/{cid}/messages")
    assert client.get(base).json()["proposal"] is None


def test_undo_is_single_step_even_after_multiple_operations(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    for _ in range(2):
        assert client.post(base + "/actions/plant_tree").status_code == 200
    result = client.post(base + "/undo").json()
    assert result["elements"]["tree"] == 1 and result["can_undo"] is False
    assert client.post(base + "/undo").status_code == 409


def test_parallel_tree_actions_do_not_lose_updates(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.post(base + "/actions/plant_tree"), range(4)))
    assert all(r.status_code == 200 for r in results)
    assert client.get(base).json()["elements"]["tree"] == 4


def test_scene_and_pending_confirmation_survive_new_process(client, png_header, parse_sse):
    cid = _create_character(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    client.post(base + "/actions/light_rain")
    proposal = propose(client, cid, parse_sse)
    script = f"""
import json
from fastapi.testclient import TestClient
from app.main import app
with TestClient(app, headers={{"Authorization": "Bearer test-token-for-local-tests-only"}}) as client:
    print(json.dumps(client.get({base!r}).json()))
"""
    run = subprocess.run([sys.executable, "-c", script], cwd=Path(__file__).resolve().parents[1],
                         env=os.environ.copy(), capture_output=True, text=True, check=True)
    state = json.loads(run.stdout)
    assert state["elements"]["rain"] == state["elements"]["sound"] == 1
    assert state["proposal"] == proposal and state["can_undo"]


def test_model_context_reports_actual_scene_and_unexecuted_proposal(client, png_header, parse_sse, monkeypatch):
    from app.services.model_client import ModelClient
    cid = _create_character(client, png_header, parse_sse)
    client.post(f"/api/v1/characters/{cid}/scene/actions/plant_tree")
    captured = []

    def stream(self, messages):
        captured.extend(messages)
        yield "要下点小雨吗？"

    monkeypatch.setattr(ModelClient, "chat_stream", stream)
    propose(client, cid, parse_sse, "下点雨吧")
    assert "树=1" in captured[0]["content"]
    assert "尚未执行" in captured[0]["content"]
