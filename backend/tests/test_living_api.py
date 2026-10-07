"""多场景 HTTP：空间、成员、位置与权限隔离。"""
from __future__ import annotations

from uuid import uuid4
import pytest


def _private(client, cid, scene="home"):
    return client.post("/api/v1/living/spaces", json={
        "scene_type": scene, "mode": "private", "companion_id": str(cid)})


def test_private_space_lifecycle(client, ready_character_id):
    res = _private(client, ready_character_id)
    assert res.status_code == 201
    space = res.json()
    assert space["mode"] == "private" and space["companion_id"] == str(ready_character_id)
    sid = space["id"]

    assert any(s["id"] == sid for s in client.get("/api/v1/living/spaces").json())

    act = client.post(f"/api/v1/living/spaces/{sid}/actions", json={
        "request_id": str(uuid4()), "expected_revision": 0,
        "command": {"action": "place", "kind": "tree", "x": 0.3, "y": 0.4}})
    assert act.status_code == 200
    assert len(act.json()["items"]) == 1

    loc = client.put(f"/api/v1/characters/{ready_character_id}/location", json={"space_id": sid})
    assert loc.status_code == 200
    assert client.get(f"/api/v1/characters/{ready_character_id}/location").json()["space_id"] == sid


def test_private_home_is_read_only_during_gathering_visit(client, ready_character_id):
    home = _private(client, ready_character_id).json()
    sid = home["id"]
    base = f"/api/v1/living/spaces/{sid}"
    first_request = {"request_id": str(uuid4()), "expected_revision": 0,
                     "command": {"action": "place", "kind": "tree", "x": .3, "y": .4}}
    assert client.post(base + "/actions", json=first_request).status_code == 200
    season_request = {"request_id": str(uuid4()), "expected_revision": 0,
                      "settings": {"mode": "virtual", "weeks": 1, "start_season": "spring"}}
    assert client.put(base + "/season", json=season_request).status_code == 200
    assert client.put(f"/api/v1/characters/{ready_character_id}/location", json={"space_id": sid}).status_code == 200

    group = client.post("/api/v1/gatherings", json={"request_id": str(uuid4()),
        "title": "一起生活", "display_name": "主人", "scene_type": "home"}).json()
    group_url = f"/api/v1/gatherings/{group['id']}/commands"
    def group_action(snapshot, action):
        return client.post(group_url, json={"request_id": str(uuid4()),
            "expected_revision": snapshot["revision"], "command": action})
    visited = group_action(group, {"action": "visit", "character_id": ready_character_id})
    assert visited.status_code == 200
    assert len(client.get(base).json()["items"]) == 1
    assert client.get(base + "/season").json()["settings"] == season_request["settings"]
    for request in (first_request, {"request_id": str(uuid4()), "expected_revision": 1,
                    "command": {"action": "place", "kind": "bench", "x": .6, "y": .4}}):
        denied = client.post(base + "/actions", json=request)
        assert denied.status_code == 409 and denied.json()["error"]["code"] == "conflict"
    denied = client.put(base + "/season", json=season_request)
    assert denied.status_code == 409 and denied.json()["error"]["code"] == "conflict"
    assert client.get(base).json()["revision"] == 1
    assert client.get(base + "/season").json()["revision"] == 1

    recalled = group_action(visited.json(), {"action": "recall", "character_id": ready_character_id})
    assert recalled.status_code == 200
    resumed = client.post(base + "/actions", json={"request_id": str(uuid4()),
        "expected_revision": 1, "command": {"action": "place", "kind": "bench", "x": .6, "y": .4}})
    assert resumed.status_code == 200 and len(resumed.json()["items"]) == 2


def test_private_space_unique_per_companion(client, ready_character_id):
    assert _private(client, ready_character_id).status_code == 201
    assert _private(client, ready_character_id).status_code == 409
    assert _private(client, ready_character_id, scene="desert").status_code == 201


def test_private_requires_owned_companion(client, ready_character_id):
    assert client.post("/api/v1/living/spaces", json={
        "scene_type": "home", "mode": "private"}).status_code == 422
    assert client.post("/api/v1/living/spaces", json={
        "scene_type": "home", "mode": "private", "companion_id": "9999"}).status_code == 404


def test_shared_members_add_remove_and_location(client, ready_character_id):
    shared = client.post("/api/v1/living/spaces", json={"scene_type": "desert", "mode": "shared"})
    assert shared.status_code == 201
    sid = shared.json()["id"]

    assert client.post(f"/api/v1/living/spaces/{sid}/members",
                       json={"companion_id": str(ready_character_id)}).status_code == 201
    members = client.get(f"/api/v1/living/spaces/{sid}/members").json()
    assert [m["companion_id"] for m in members] == [str(ready_character_id)]

    assert client.put(f"/api/v1/characters/{ready_character_id}/location",
                      json={"space_id": sid}).status_code == 200
    assert client.delete(f"/api/v1/living/spaces/{sid}/members/{ready_character_id}").status_code == 204
    assert client.get(f"/api/v1/characters/{ready_character_id}/location").json()["space_id"] is None


def test_not_member_cannot_enter_shared(client, ready_character_id):
    shared = client.post("/api/v1/living/spaces", json={"scene_type": "forest", "mode": "shared"}).json()
    res = client.put(f"/api/v1/characters/{ready_character_id}/location",
                     json={"space_id": shared["id"]})
    assert res.status_code == 403


def test_delete_space_clears_location(client, ready_character_id):
    sid = _private(client, ready_character_id).json()["id"]
    client.put(f"/api/v1/characters/{ready_character_id}/location", json={"space_id": sid})
    assert client.delete(f"/api/v1/living/spaces/{sid}").status_code == 204
    assert client.get(f"/api/v1/living/spaces/{sid}").status_code == 404
    assert client.get(f"/api/v1/characters/{ready_character_id}/location").json()["space_id"] is None


def test_action_idempotent_and_conflict(client, ready_character_id):
    sid = _private(client, ready_character_id).json()["id"]
    rid = str(uuid4())
    command = {"action": "place", "kind": "tree", "x": 0.2, "y": 0.3}
    first = client.post(f"/api/v1/living/spaces/{sid}/actions",
                        json={"request_id": rid, "expected_revision": 0, "command": command})
    assert first.status_code == 200
    replay = client.post(f"/api/v1/living/spaces/{sid}/actions",
                         json={"request_id": rid, "expected_revision": 0, "command": command})
    assert replay.json() == first.json()
    conflict = client.post(f"/api/v1/living/spaces/{sid}/actions",
                           json={"request_id": str(uuid4()), "expected_revision": 0, "command": command})
    assert conflict.status_code == 409


@pytest.mark.parametrize("operation", ["read", "action", "members", "add_member", "remove_member", "delete", "location", "private"])
def test_other_account_cannot_read_or_mutate_living_resources(client, ready_character_id, operation):
    from fastapi.testclient import TestClient
    from app.core.database import SessionLocal
    from app.models.models import User
    from app.services.auth import create_session
    sid = client.post("/api/v1/living/spaces", json={"scene_type": "home", "mode": "shared"}).json()["id"]
    with SessionLocal() as db:
        user = User(id=str(uuid4()), phone="13900000008")
        db.add(user); db.commit()
        token = create_session(db, user)
    other = TestClient(client.app, headers={"Authorization": f"Bearer {token}"})
    root = f"/api/v1/living/spaces/{sid}"
    if operation == "read": result = other.get(root)
    elif operation == "action": result = other.post(root + "/actions", json={"request_id": str(uuid4()), "expected_revision": 0, "command": {"action": "place", "kind": "tree", "x": .5, "y": .5}})
    elif operation == "members": result = other.get(root + "/members")
    elif operation == "add_member": result = other.post(root + "/members", json={"companion_id": str(ready_character_id)})
    elif operation == "remove_member": result = other.delete(root + f"/members/{ready_character_id}")
    elif operation == "delete": result = other.delete(root)
    elif operation == "location": result = other.put(f"/api/v1/characters/{ready_character_id}/location", json={"space_id": sid})
    else: result = _private(other, ready_character_id)
    assert result.status_code == 404
    assert "error" in result.json()
    assert other.get("/api/v1/living/spaces").json() == []
    owner_snapshot = client.get(root).json()
    assert owner_snapshot["revision"] == 0
    assert owner_snapshot["items"] == []


def test_oasis_layout_turn_activity_receipts(client, ready_character_id):
    space = _private(client, ready_character_id, 'desert').json()
    base = f"/api/v1/living/spaces/{space['id']}"
    payload = {'request_id': str(uuid4()), 'expected_revision': 0,
               'command': {'action': 'layout', 'template': 'water'}}
    result = client.post(base + '/actions', json=payload)
    assert result.status_code == 200
    assert len(result.json()['items']) == 10
    assert client.post(base + '/actions', json=payload).json() == result.json()
    activity = client.get(base + '/activity').json()['events']
    assert len(activity) == 1 and activity[0]['action'] == 'layout'
    assert activity[0]['target_item_id'] is None
    target = result.json()['items'][0]['id']
    turned = client.post(base + '/actions', json={
        'request_id': str(uuid4()), 'expected_revision': 1,
        'command': {'action': 'turn', 'item_id': target}})
    assert turned.status_code == 200 and turned.json()['items'][0]['flipped']
    activity = client.get(base + '/activity').json()['events']
    assert activity[0]['action'] == 'turn' and activity[0]['target_kind'] == 'palm'
    assert activity[0]['target_item_id'] == target
