"""R6.2 permission boundaries; synthetic data only, no network models."""
from datetime import datetime, timedelta
from pathlib import Path
import os
import subprocess
import sys
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.core.config import Settings, get_settings
from app.core.database import SessionLocal
from app.core.security import hash_token
from app.models.models import Character, Photo, Session, User
from tests.auth_helpers import TEST_USER_ID


@pytest.fixture
def private_image(ready_character_id, png_header):
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    name = f"private-{uuid4()}.png"
    (root / name).write_bytes(png_header)
    with SessionLocal() as db:
        ch = db.get(Character, ready_character_id)
        ch.image_path = name
        ch.theme_id = "fruit"
        db.commit()
    return ready_character_id, name


def other_account():
    uid, token = str(uuid4()), str(uuid4())
    with SessionLocal() as db:
        db.add(User(id=uid, phone="13900000066"))
        db.flush()
        db.add(Session(token_hash=hash_token(token), user_id=uid,
                       expires_at=datetime.now() + timedelta(days=1)))
        db.commit()
    return uid, {"Authorization": f"Bearer {token}"}


def test_anonymous_known_image_path_is_private(anon, private_image):
    assert anon.get("/uploads/" + private_image[1]).status_code == 401


def test_default_claim_refuses_without_changing_legacy_data(client, monkeypatch):
    # Default must be off, even with valid user login.
    if hasattr(get_settings(), "legacy_claim_user_id"):
        monkeypatch.setattr(get_settings(), "legacy_claim_user_id", "")
    with SessionLocal() as db:
        photo = Photo(filename="synthetic.png", status="done")
        db.add(photo)
        db.commit()
        pid = photo.id
    assert client.post("/api/v1/auth/claim").status_code == 403
    with SessionLocal() as db:
        assert db.get(Photo, pid).owner_id is None


def test_owner_only_and_no_cache(client, private_image, png_header):
    url = "/uploads/" + private_image[1]
    _, headers = other_account()
    response = client.get(url)
    assert response.status_code == 200 and response.content == png_header
    assert "no-store" in response.headers["cache-control"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "sandbox" in response.headers["content-security-policy"]
    response = client.get(url, headers=headers)
    assert response.status_code == 404
    assert "no-store" in response.headers["cache-control"]


def test_publishing_never_opens_raw_path_and_withdraw_revokes_public(client, anon, private_image):
    cid, name = private_image
    published = client.put(f"/api/v1/wall/characters/{cid}", json={"author_name": "果友"})
    assert published.status_code == 200
    pid = published.json()["publication_id"]
    public = f"/api/v1/themes/fruit/works/{pid}/image"
    assert anon.get(public).status_code == 200
    assert anon.get("/uploads/" + name).status_code == 401
    assert client.delete(f"/api/v1/wall/characters/{cid}").status_code == 204
    assert anon.get(public).status_code == 404
    assert client.get("/uploads/" + name).status_code == 200
    assert client.delete(f"/api/v1/characters/{cid}").status_code == 204
    assert client.get("/uploads/" + name).status_code == 404


def test_owned_reference_required_even_when_file_exists(client, png_header):
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    (root / "unreferenced.png").write_bytes(png_header)
    assert client.get("/uploads/unreferenced.png").status_code == 404


def test_symlink_outside_uploads_is_rejected(client, private_image, tmp_path, png_header):
    _, name = private_image
    image = Path(get_settings().upload_dir) / name
    image.unlink()
    secret = tmp_path / "outside.png"
    secret.write_bytes(png_header)
    image.symlink_to(secret)
    assert client.get("/uploads/" + name).status_code == 404


@pytest.mark.parametrize("path", ["%2e%2e/secret.png", "a%5csecret.png", "%2Fetc/secret.png", "a//b.png"])
def test_invalid_paths_are_rejected(client, path):
    assert client.get("/uploads/" + path).status_code == 404


def test_shared_old_image_requires_each_owners_reference(client, private_image):
    cid, name = private_image
    uid, headers = other_account()
    with SessionLocal() as db:
        db.get(Character, cid).owner_id = uid
        db.commit()
    assert client.get("/uploads/" + name).status_code == 404
    assert client.get("/uploads/" + name, headers=headers).status_code == 200


def test_claim_only_explicit_development_owner(client, monkeypatch):
    monkeypatch.setattr(get_settings(), "legacy_claim_user_id", TEST_USER_ID)
    _, headers = other_account()
    assert client.post("/api/v1/auth/claim", headers=headers).status_code == 403
    assert client.post("/api/v1/auth/claim").status_code == 200
    monkeypatch.setattr(get_settings(), "app_env", "production")
    assert client.post("/api/v1/auth/claim").status_code == 403


def test_production_guard_redacts_and_blocks_development_settings():
    marker = "private-value-never-echo"
    with pytest.raises(ValidationError) as error:
        Settings(_env_file=None, app_env="production", dev_auth_token=marker,
                 dev_sms_fixed_code=marker, legacy_claim_user_id=marker, model_api_key="")
    assert marker not in str(error.value)
    assert "production_configuration_blocked" in str(error.value)


def test_production_cannot_pretend_mock_sms_is_real():
    with pytest.raises(ValidationError, match="mock_sms"):
        Settings(_env_file=None, app_env="production", dev_auth_token="", dev_sms_fixed_code="",
                 legacy_claim_user_id="", model_api_key="configured", model_base_url="https://example.invalid")


def test_unknown_environment_is_rejected():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="prod-typo")


def test_production_rejection_happens_before_app_creates_data(tmp_path):
    data = tmp_path / "must-not-exist"
    result = subprocess.run([sys.executable, "-c", "import app.main"],
                            cwd=Path(__file__).resolve().parents[1],
                            env={**os.environ, "APP_ENV": "production", "MODEL_API_KEY": "",
                                 "DATABASE_URL": f"sqlite:///{data / 'app.db'}", "UPLOAD_DIR": str(data / "uploads")},
                            text=True, capture_output=True, timeout=15)
    assert result.returncode != 0
    assert "production_configuration_blocked" in result.stderr
    assert not data.exists()
