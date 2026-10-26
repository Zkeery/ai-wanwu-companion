"""Hyper3D courtyard models are generated once and never retried after failure."""
from pathlib import Path

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterCourtyardMesh
from app.services import courtyard_mesh


class _Response:
    def __init__(self, status_code, payload=None, content=b""):
        self.status_code = status_code
        self._payload = payload or {}
        self.content = content

    def json(self):
        return self._payload


class _Client:
    calls = []

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def post(self, url, headers=None, json=None):
        self.calls.append(("post", url))
        assert "Authorization" not in str(json)
        return _Response(403, {"error": {"code": "AccessDenied", "message": "hidden"}})

    def get(self, url, headers=None, timeout=None):
        self.calls.append(("get", url))
        return _Response(500, {})


def _prepare(character_id):
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    image = root / "characters" / "cup.png"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    with SessionLocal() as db:
        character = db.get(Character, character_id)
        character.image_path = "characters/cup.png"
        courtyard_mesh.enqueue(db, character)
        courtyard_mesh.enqueue(db, character)
        db.commit()
        assert db.query(CharacterCourtyardMesh).count() == 1


def test_a_failed_model_is_recorded_and_not_submitted_again(ready_character_id, monkeypatch):
    _Client.calls = []
    _prepare(ready_character_id)
    monkeypatch.setattr(courtyard_mesh.httpx, "Client", _Client)
    monkeypatch.setattr(courtyard_mesh, "get_settings", lambda: type("S", (), {
        "ark_api_key": "unit-test-key", "ark_base_url": "https://ark.example",
        "upload_dir": get_settings().upload_dir,
    })())
    assert courtyard_mesh.run_once() is True
    with SessionLocal() as db:
        row = db.get(CharacterCourtyardMesh, ready_character_id)
        assert row.status == "failed" and row.http_status == 403 and row.error_code == "AccessDenied"
        assert row.duration_ms is not None and row.duration_ms >= 0 and row.task_id is None
    assert courtyard_mesh.run_once() is False
    assert len(_Client.calls) == 1


def test_guest_companion_cap_still_limits_new_models():
    from app.core.config import get_settings as settings
    assert settings().guest_companions_per_user == 2
