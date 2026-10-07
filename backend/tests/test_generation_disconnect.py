"""Exercise a real TCP/SSE disconnect, not TestClient's buffered transport."""
from pathlib import Path
import socket
from threading import Event, Thread
from time import monotonic, sleep

import httpx
import pytest
import uvicorn

from app.core.config import get_settings
from app.services.model_client import ModelClient
from tests.auth_helpers import TEST_TOKEN, TEST_USER_ID


def test_failure_stream_cleanup_cannot_fail_a_new_retry(client, png_header, monkeypatch):
    from app.api.characters import create_character
    from app.core.database import SessionLocal
    from app.models.models import Character, User
    from app.schemas.schemas import CharacterCreate
    from app.services.model_client import ModelError

    oid = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()["objects"][0]["id"]
    def fail(self, label):
        raise ModelError("failure")
    monkeypatch.setattr(ModelClient, "generate_persona", fail)
    with SessionLocal() as db:
        user = db.get(User, TEST_USER_ID)
        response = create_character(CharacterCreate(object_id=oid), user, db)
    stream = response.generation_iterator
    assert "event: started" in next(stream)
    assert "event: chunk" in next(stream)
    assert "event: error" in next(stream)
    # A new HTTP request may reserve a retry immediately after receiving error,
    # before the old response's finally runs.
    with SessionLocal() as db:
        user = db.get(User, TEST_USER_ID)
        retry = create_character(CharacterCreate(object_id=oid), user, db)
    response.finish()
    with SessionLocal() as db:
        assert db.get(Character, response.character_id).status == "generating"
    retry.finish()
    with SessionLocal() as db:
        assert db.get(Character, response.character_id).status == "failed"


def test_disconnect_before_first_event_releases_reservation(client, png_header):
    import anyio
    from app.api.characters import create_character
    from app.core.database import SessionLocal
    from app.models.models import User
    from app.schemas.schemas import CharacterCreate
    oid = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()["objects"][0]["id"]
    with SessionLocal() as db:
        user = db.get(User, TEST_USER_ID)
        response = create_character(CharacterCreate(object_id=oid), user, db)
    async def receive():
        return {"type": "http.disconnect"}
    async def send(message):
        raise OSError("connection already closed")
    async def run():
        with pytest.raises(Exception):
            await response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send)
    anyio.run(run)
    assert client.get(f"/api/v1/characters/by-object/{oid}").json()["status"] == "failed"


@pytest.mark.parametrize("disconnect_at", ["persona", "parallel"])
def test_tcp_disconnect_leaves_recoverable_state_and_no_orphan(png_header, monkeypatch, disconnect_at):
    from app.main import app
    started, release = Event(), Event()
    original_persona = ModelClient.generate_persona
    original_image = ModelClient.generate_image
    image_paths = []

    def persona(self, label):
        if disconnect_at == "persona":
            started.set()
            assert release.wait(5)
        return original_persona(self, label)

    def image(self, label, name, **appearance):
        if disconnect_at == "parallel":
            started.set()
            assert release.wait(5)
        image_paths.append(original_image(self, label, name, **appearance))
        return image_paths[-1]

    monkeypatch.setattr(ModelClient, "generate_persona", persona)
    monkeypatch.setattr(ModelClient, "generate_image", image)
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level="critical", lifespan="on"))
    thread = Thread(target=server.run, kwargs={"sockets": [sock]}, daemon=True)
    thread.start()
    try:
        deadline = monotonic() + 5
        while not server.started and monotonic() < deadline:
            sleep(0.01)
        assert server.started
        with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5,
                          headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as client:
            photo = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()
            oid = photo["objects"][0]["id"]
            with client.stream("POST", "/api/v1/characters", json={"object_id": oid}) as response:
                assert response.status_code == 200
                assert "no-transform" in response.headers["cache-control"]
                lines = response.iter_lines()
                for line in lines:
                    if line == "event: started":
                        break
                else:
                    pytest.fail("stream ended before started event")
                assert started.wait(5)
                current = client.get(f"/api/v1/characters/by-object/{oid}").json()
                assert current["status"] == "generating"
            # Closing the streamed response closes its TCP connection while the
            # selected model branch is still in progress.
            release.set()
            deadline = monotonic() + 5
            while monotonic() < deadline:
                current = client.get(f"/api/v1/characters/by-object/{oid}").json()
                if current["status"] != "generating":
                    break
                sleep(0.02)
            assert current["status"] in ("ready", "failed")
            root = Path(get_settings().upload_dir)
            for path in image_paths:
                assert (root / path).exists() == (current["status"] == "ready" and current["image_path"] == path)
            if current["status"] == "failed":
                retry = client.post("/api/v1/characters", json={"object_id": oid})
                assert "event: done" in retry.text
            else:
                assert client.post("/api/v1/characters", json={"object_id": oid}).status_code == 409
    finally:
        release.set()
        server.should_exit = True
        thread.join(5)
        sock.close()
    assert not thread.is_alive()
