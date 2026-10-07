"""角色生成（SSE）与收藏增删查测试。"""
from __future__ import annotations


def _upload(client, png_header):
    res = client.post(
        "/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}
    )
    assert res.status_code == 201
    return res.json()["objects"][0]["id"]


def test_create_character_full_flow(client, png_header, parse_sse):
    obj_id = _upload(client, png_header)
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    assert res.status_code == 200

    events = parse_sse(res.text)
    done = [d for e, d in events if e == "done"]
    assert len(done) == 1
    char = done[0]
    assert char["name"] == "杯子小伴"
    assert char["status"] == "ready"
    assert char["persona"]
    assert char["opening_line"]
    assert char["image_path"].endswith(".svg")


def test_list_get_delete_flow(client, png_header, parse_sse):
    obj_id = _upload(client, png_header)
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    char = [d for e, d in parse_sse(res.text) if e == "done"][0]
    cid = char["id"]

    # 收藏列表
    res = client.get("/api/v1/characters")
    assert res.status_code == 200
    assert cid in [c["id"] for c in res.json()]

    # 详情
    res = client.get(f"/api/v1/characters/{cid}")
    assert res.status_code == 200
    assert res.json()["name"] == "杯子小伴"

    # 删除
    res = client.delete(f"/api/v1/characters/{cid}")
    assert res.status_code == 204
    res = client.get("/api/v1/characters")
    assert cid not in [c["id"] for c in res.json()]


def test_duplicate_generation_returns_409(client, png_header):
    obj_id = _upload(client, png_header)
    client.post("/api/v1/characters", json={"object_id": obj_id})
    res = client.post("/api/v1/characters", json={"object_id": obj_id})
    assert res.status_code == 409
    assert res.json()["error"]["code"] == "already_exists"


def test_object_not_found_returns_404(client):
    res = client.post("/api/v1/characters", json={"object_id": 9999})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "object_not_found"
