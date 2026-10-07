import json
import pytest
from concurrent.futures import ThreadPoolExecutor
from app.core.database import SessionLocal
from app.models.models import SceneState, SceneProposal, Message
from app.services.chat import detect_scene_action, build_messages
from app.services import scene as service

CASES = [
    ("plant_flower", "flower", "种一簇花吧"),
    ("grow_mushroom", "mushroom", "添一丛蘑菇"),
    ("add_pond", "pond", "加个水池"),
    ("place_bench", "bench", "放张长椅"),
    ("light_campfire", "campfire", "点亮营火"),
    ("release_fireflies", "fireflies", "迎来萤火虫"),
]


def save_trees(cid, count, previous):
    with SessionLocal() as db:
        state = service.default_elements()
        state["tree"] = count
        before = {**state, "tree": previous}
        db.add(SceneState(character_id=cid, state_json=service.serialize(state, [before])))
        message = Message(character_id=cid, role="assistant", content="种树提议")
        db.add(message)
        db.flush()
        db.add(SceneProposal(id="tree-proposal", character_id=cid, message_id=message.id, action="plant_tree"))
        db.commit()


@pytest.mark.parametrize("concurrent", [False, True])
def test_tree_cap_preserves_last_effective_undo(client, ready_character_id, concurrent):
    save_trees(ready_character_id, 6, 5)
    base = f"/api/v1/characters/{ready_character_id}/scene"
    def plant(_):
        return client.post(base + "/actions/plant_tree")
    if concurrent:
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(plant, range(2)))
    else:
        results = [plant(0), plant(1)]
    assert all(r.status_code == 200 and r.json()["elements"]["tree"] == 7 for r in results)
    assert client.get(base).json()["elements"]["tree"] == 7
    assert client.post(base + "/undo").json()["elements"]["tree"] == 6
    assert client.post(base + "/undo").status_code == 409


@pytest.mark.parametrize("count,previous", [(7, 6), (9, 8)])
def test_tree_noop_preserves_state_proposal_and_legacy_undo(client, ready_character_id, count, previous):
    save_trees(ready_character_id, count, previous)
    base = f"/api/v1/characters/{ready_character_id}/scene"
    with SessionLocal() as db:
        saved = db.query(SceneState).one()
        before = (saved.state_json, saved.updated_at)
    assert client.get(base).json()["elements"]["tree"] == count
    result = client.post(base + "/actions/plant_tree").json()
    assert result["elements"]["tree"] == count
    assert "上限" in result["feedback"] or "已保存" in result["feedback"]
    assert result["proposal"]["id"] == "tree-proposal"
    with SessionLocal() as db:
        saved = db.query(SceneState).one()
        assert (saved.state_json, saved.updated_at) == before
    confirmed = client.post(base + "/proposals/tree-proposal/confirm").json()
    assert confirmed["elements"]["tree"] == count and confirmed["proposal"] is None
    assert client.post(base + "/proposals/tree-proposal/confirm").status_code == 409
    assert client.post(base + "/undo").json()["elements"]["tree"] == previous


def test_non_tree_action_does_not_clip_legacy_count(client, ready_character_id):
    save_trees(ready_character_id, 9, 8)
    base = f"/api/v1/characters/{ready_character_id}/scene"
    assert client.post(base + "/actions/plant_flower").json()["elements"]["tree"] == 9
    assert client.post(base + "/undo").json()["elements"]["tree"] == 9


def create(client, png_header, parse_sse):
    photo = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()
    result = client.post("/api/v1/characters", json={"object_id": photo["objects"][0]["id"]})
    return next(data["id"] for event, data in parse_sse(result.text) if event == "done")


@pytest.mark.parametrize("action,key,text", CASES)
def test_new_object_persists_and_undo_restores(client, png_header, parse_sse, action, key, text):
    cid = create(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    before = client.post(base + "/actions/plant_tree").json()["elements"]
    added = client.post(base + "/actions/" + action)
    assert added.status_code == 200
    assert added.json()["elements"][key] == 1
    assert added.json()["elements"]["tree"] == 1
    assert client.get(base).json()["elements"] == added.json()["elements"]
    assert client.post(base + "/undo").json()["elements"] == before
    assert detect_scene_action(text) == action
    assert detect_scene_action("不要" + text) is None
    assert detect_scene_action(text + "，再种棵树") is None


@pytest.mark.parametrize("action,key,text", CASES)
def test_new_proposal_waits_for_confirmation(client, png_header, parse_sse, action, key, text):
    cid = create(client, png_header, parse_sse)
    response = client.post(f"/api/v1/characters/{cid}/chat", json={"message": text})
    assert "no-transform" in response.headers["cache-control"]
    done = next(data for event, data in parse_sse(response.text) if event == "done")
    token = done["proposal"]["id"]
    base = f"/api/v1/characters/{cid}/scene"
    assert client.get(base).json()["elements"][key] == 0
    assert client.post(base + f"/proposals/{token}/confirm").json()["elements"][key] == 1
    assert client.post(base + f"/proposals/{token}/confirm").status_code == 409
    assert client.post(base + "/undo").json()["elements"][key] == 0


def test_old_saved_garden_and_undo_are_normalized_without_losing_existing_values():
    raw = json.dumps({"elements": {"rain": 1, "tree": 9, "cloud": 1, "sound": 0},
                      "history": [{"rain": 0, "tree": 8, "cloud": 0, "sound": 1}]})
    elements, history = service.deserialize(raw)
    assert elements["tree"] == 9 and elements["sound"] == 0
    assert history[0]["tree"] == 8
    for key in ("flower", "mushroom", "pond", "bench", "campfire", "fireflies"):
        assert elements[key] == history[0][key] == 0


def test_repeated_decoration_does_not_destroy_undo(client, png_header, parse_sse):
    cid = create(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}/scene"
    client.post(base + "/actions/add_pond")
    client.post(base + "/actions/add_pond")
    assert client.post(base + "/undo").json()["elements"]["pond"] == 0


def test_new_plants_are_bounded():
    state = service.default_elements()
    for _ in range(20):
        state = service.apply_action(state, "plant_flower")
        state = service.apply_action(state, "grow_mushroom")
    assert state["flower"] == 6 and state["mushroom"] == 4


def test_confirming_existing_decoration_preserves_previous_undo(client, png_header, parse_sse):
    cid = create(client, png_header, parse_sse)
    base = f"/api/v1/characters/{cid}"
    client.post(base + "/scene/actions/add_pond")
    response = client.post(base + "/chat", json={"message": "加个水池"})
    done = next(data for event, data in parse_sse(response.text) if event == "done")
    token = done["proposal"]["id"]
    confirmed = client.post(base + f"/scene/proposals/{token}/confirm").json()
    assert confirmed["proposal"] is None
    assert confirmed["elements"]["pond"] == 1
    assert client.post(base + "/scene/undo").json()["elements"]["pond"] == 0


def test_chat_context_includes_actual_decorations():
    from app.models.models import Character
    messages = build_messages(Character(name="小杯", persona="温柔"), [], [], "花园有什么？",
                              {"flower": 3, "mushroom": 2, "pond": 1, "bench": 1, "campfire": 0, "fireflies": 1})
    assert all(text in messages[0]["content"] for text in ["花丛=3", "蘑菇丛=2", "水池=有", "长椅=有", "营火=无", "萤火虫=有"])
