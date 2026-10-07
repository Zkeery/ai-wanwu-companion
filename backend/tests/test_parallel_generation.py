"""Concurrency/failure invariants: real API, event barriers, no paid requests."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event

import httpx
import pytest

from app.core.config import get_settings
from app.services.model_client import ModelClient, ModelError
from app.services.parsers import Persona


@pytest.fixture(autouse=True)
def legacy_split_mode(monkeypatch):
    # Keep every existing split-path invariant covered for the rollback mode.
    monkeypatch.setattr(get_settings(), "character_bundle_enabled", False)


def object_id(client, png_header):
    return client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()["objects"][0]["id"]


def test_opening_and_image_overlap_after_persona_and_publish_together(client, png_header, monkeypatch, parse_sse):
    oid = object_id(client, png_header)
    opening_entered, image_entered = Event(), Event()
    release_opening, release_image = Event(), Event()
    calls = []
    real_image = ModelClient.generate_image

    def persona(self, label):
        calls.append(("persona", label))
        return Persona("小杯", "温柔")

    def opening(self, p):
        assert calls[0] == ("persona", "纠正后的杯子")
        assert p == Persona("小杯", "温柔")
        calls.append(("opening", p.name))
        opening_entered.set()
        assert release_opening.wait(5)
        return "你好，我是小杯。"

    def image(self, label, name, **appearance):
        assert calls[0] == ("persona", "纠正后的杯子")
        calls.append(("image", name))
        image_entered.set()
        assert release_image.wait(5)
        return real_image(self, label, name, **appearance)

    monkeypatch.setattr(ModelClient, "generate_persona", persona)
    monkeypatch.setattr(ModelClient, "generate_opening", opening)
    monkeypatch.setattr(ModelClient, "generate_image", image)
    with ThreadPoolExecutor() as pool:
        request = pool.submit(client.post, "/api/v1/characters", json={"object_id": oid, "label": "纠正后的杯子"})
        try:
            assert opening_entered.wait(5) and image_entered.wait(5)
            assert client.get(f"/api/v1/characters/by-object/{oid}").json()["status"] == "generating"
            assert client.post("/api/v1/characters", json={"object_id": oid}).status_code == 409
            release_opening.set()
            assert client.get("/api/v1/characters").json() == []
            release_image.set()
            events = parse_sse(request.result(timeout=5).text)
        finally:
            release_opening.set()
            release_image.set()
    assert len(calls) == 3
    assert [data["stage"] for event, data in events if event == "chunk"] == ["正在根据确认的特征完善角色构思…", "正在准备开场白和角色图…"]
    result = next(data for event, data in events if event == "done")
    assert result["name"] == "小杯" and result["opening_line"] == "你好，我是小杯。"
    assert result["status"] == "ready"
    assert (Path(get_settings().upload_dir) / result["image_path"]).is_file()


def test_persona_failure_starts_no_independent_branch(client, png_header, monkeypatch, parse_sse):
    oid = object_id(client, png_header)
    def fail(*args):
        raise ModelError("persona failure")
    def forbidden(*args):
        pytest.fail("Downstream generation must not run after persona failure")
    monkeypatch.setattr(ModelClient, "generate_persona", fail)
    monkeypatch.setattr(ModelClient, "generate_opening", forbidden)
    monkeypatch.setattr(ModelClient, "generate_image", forbidden)
    events = parse_sse(client.post("/api/v1/characters", json={"object_id": oid}).text)
    assert events[-1][0] == "error"
    assert client.get(f"/api/v1/characters/by-object/{oid}").json()["status"] == "failed"


@pytest.mark.parametrize("failure", [ModelError("bad opening"), httpx.ReadTimeout("timeout")])
def test_opening_failure_waits_for_and_cleans_late_image(client, png_header, monkeypatch, parse_sse, failure):
    oid = object_id(client, png_header)
    image_started, opening_failed, release_image = Event(), Event(), Event()
    paths = []
    real_image = ModelClient.generate_image
    def image(self, label, name, **appearance):
        image_started.set()
        assert release_image.wait(5)
        paths.append(real_image(self, label, name, **appearance))
        return paths[-1]
    def opening(*args):
        assert image_started.wait(5)
        opening_failed.set()
        raise failure
    monkeypatch.setattr(ModelClient, "generate_image", image)
    with monkeypatch.context() as patch:
        patch.setattr(ModelClient, "generate_opening", opening)
        with ThreadPoolExecutor() as pool:
            request = pool.submit(client.post, "/api/v1/characters", json={"object_id": oid})
            try:
                assert opening_failed.wait(5)
                assert not request.done()
            finally:
                release_image.set()
            events = parse_sse(request.result(timeout=5).text)
    assert events[-1][0] == "error" and all(e != "done" for e, _ in events)
    assert len(paths) == 1 and not (Path(get_settings().upload_dir) / paths[0]).exists()
    saved = client.get(f"/api/v1/characters/by-object/{oid}").json()
    assert saved["status"] == "failed" and saved["image_path"] is None
    retry = parse_sse(client.post("/api/v1/characters", json={"object_id": oid}).text)
    ready = next(d for e, d in retry if e == "done")
    assert ready["id"] == saved["id"] and ready["status"] == "ready"


def test_image_failure_never_publishes_partial_character(client, png_header, monkeypatch, parse_sse):
    oid = object_id(client, png_header)
    calls = []
    def image(*args, **kwargs):
        calls.append(1)
        raise ModelError("image failure")
    monkeypatch.setattr(ModelClient, "generate_image", image)
    events = parse_sse(client.post("/api/v1/characters", json={"object_id": oid}).text)
    assert events[-1][0] == "error" and calls == [1]
    saved = client.get(f"/api/v1/characters/by-object/{oid}").json()
    assert saved["status"] == "failed" and saved["name"] == "" and saved["image_path"] is None
    assert client.get("/api/v1/characters").json() == []


def test_delete_during_parallel_generation_cleans_image_without_resurrection(client, png_header, monkeypatch, parse_sse):
    oid = object_id(client, png_header)
    entered, release = Event(), Event()
    paths = []
    original = ModelClient.generate_image
    def image(self, label, name, **appearance):
        entered.set()
        assert release.wait(5)
        paths.append(original(self, label, name, **appearance))
        return paths[-1]
    monkeypatch.setattr(ModelClient, "generate_image", image)
    with ThreadPoolExecutor() as pool:
        request = pool.submit(client.post, "/api/v1/characters", json={"object_id": oid})
        try:
            assert entered.wait(5)
            current = client.get(f"/api/v1/characters/by-object/{oid}").json()
            assert client.delete(f"/api/v1/characters/{current['id']}").status_code == 204
        finally:
            release.set()
        events = parse_sse(request.result(timeout=5).text)
    assert events[-1][0] == "error"
    assert client.get(f"/api/v1/characters/by-object/{oid}").json() is None
    assert len(paths) == 1 and not (Path(get_settings().upload_dir) / paths[0]).exists()


def test_split_calls_keep_the_existing_prompt_and_generation_parameters(monkeypatch):
    from app.core.config import Settings
    from app.services import model_client, prompts
    settings = Settings(_env_file=None, model_api_key="fake", chat_model="unchanged", character_bundle_enabled=False)
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    payloads = []
    def capture(self, payload, settings):
        payloads.append(payload)
        return '{"name":"小杯","persona":"温柔"}' if len(payloads) == 1 else "你好，我是小杯。"
    monkeypatch.setattr(ModelClient, "_post_chat_completions", capture)
    client = ModelClient()
    persona = client.generate_persona("杯子")
    assert client.generate_opening(persona) == "你好，我是小杯。"
    assert [p["messages"][0]["content"] for p in payloads] == [prompts.PERSONA_PROMPT.format(label="杯子"), prompts.OPENING_PROMPT.format(name="小杯", persona="温柔")]
    assert all(p["temperature"] == 0.7 and p["model"] == "unchanged" for p in payloads)
