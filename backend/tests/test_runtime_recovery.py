"""真实故障回归：路径、同名图片、重启与识别异常。"""
from fastapi.testclient import TestClient

from app.core.config import BASE_DIR, Settings
from app.core.database import SessionLocal
from app.main import app
from app.models.models import Character
from app.services.model_client import ModelClient
from app.services.parsers import ParseError
from tests.auth_helpers import TEST_TOKEN, TEST_USER_ID


def test_data_paths_do_not_change_with_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None, database_url="sqlite:///./data/app.db", upload_dir="./data/uploads")
    assert settings.upload_dir == str(BASE_DIR / "data/uploads")
    assert settings.database_url == "sqlite:///" + str(BASE_DIR / "data/app.db")
    assert Settings(_env_file=None, database_url="sqlite:///:memory:").database_url == "sqlite:///:memory:"


def test_same_name_characters_keep_separate_images(client, png_header, parse_sse):
    characters = []
    for _ in range(2):
        photo = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()
        response = client.post("/api/v1/characters", json={"object_id": photo["objects"][0]["id"]})
        characters.append(next(data for event, data in parse_sse(response.text) if event == "done"))
    first, second = characters
    assert first["name"] == second["name"]
    assert first["image_path"] != second["image_path"]
    assert client.delete(f'/api/v1/characters/{first["id"]}').status_code == 204
    assert client.get('/uploads/' + second["image_path"]).status_code == 200


def test_legacy_shared_image_kept_until_last_character_deleted(client, png_header, parse_sse):
    photo = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()
    response = client.post("/api/v1/characters", json={"object_id": photo["objects"][0]["id"]})
    first = next(data for event, data in parse_sse(response.text) if event == "done")
    with SessionLocal() as session:
        second = Character(object_id=photo["objects"][1]["id"], owner_id=TEST_USER_ID,
                           name="同名", persona="p", opening_line="hi",
                           image_path=first["image_path"], status="ready")
        session.add(second)
        session.commit()
        second_id = second.id
    client.delete(f'/api/v1/characters/{first["id"]}')
    assert client.get('/uploads/' + first["image_path"]).status_code == 200
    client.delete(f'/api/v1/characters/{second_id}')
    assert client.get('/uploads/' + first["image_path"]).status_code == 404


def test_restart_recovers_interrupted_generation_and_allows_retry(client, png_header, parse_sse):
    photo = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()
    obj_id = photo["objects"][0]["id"]
    with SessionLocal() as session:
        interrupted = Character(object_id=obj_id, owner_id=TEST_USER_ID, name="",
                                 persona="", opening_line="", status="generating")
        session.add(interrupted)
        session.commit()
        cid = interrupted.id
    with TestClient(app, headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as restarted:
        assert restarted.get(f'/api/v1/characters/{cid}').json()["status"] == "failed"
        response = restarted.post("/api/v1/characters", json={"object_id": obj_id})
        assert any(event == "done" for event, _ in parse_sse(response.text))


def test_malformed_vision_output_is_retryable_error(client, png_header, monkeypatch):
    def malformed(*args):
        raise ParseError("bad JSON")
    monkeypatch.setattr(ModelClient, "recognize", malformed)
    response = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")})
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "recognize_failed"


def test_generated_name_cannot_escape_upload_directory(tmp_path, monkeypatch):
    from app.services import model_client
    settings = Settings(_env_file=None, model_api_key="", upload_dir=str(tmp_path))
    monkeypatch.setattr(model_client, "get_settings", lambda: settings)
    result = ModelClient().generate_image("杯子", '../../<script>bad</script>')
    path = tmp_path / result
    assert path.resolve().is_relative_to(tmp_path / "characters")
    assert '<script>' not in path.read_text()


def test_slow_recognition_does_not_block_collection(png_header, monkeypatch):
    import asyncio
    import threading
    import httpx
    from app.services.parsers import RecognizedObject

    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    def slow_recognize(*args):
        started.set()
        release.wait(timeout=2)
        finished.set()
        return [RecognizedObject(label="杯子")]

    monkeypatch.setattr(ModelClient, "recognize", slow_recognize)

    async def scenario():
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test",
                                     headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as client:
            upload = asyncio.create_task(client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}))
            try:
                assert await asyncio.to_thread(started.wait, 1)
                collection = await asyncio.wait_for(client.get("/api/v1/characters"), timeout=1)
                assert collection.status_code == 200
                assert not finished.is_set(), "识别阻塞了应用事件循环"
            finally:
                release.set()
                await upload

    asyncio.run(scenario())
