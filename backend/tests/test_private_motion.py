"""Synthetic packs only; no real user writes or model calls."""
import hashlib
import json
import shutil
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterMotionAsset, MotionCleanupTask, User
from app.services.motion_bindings import MotionBindingError, import_motion_pack
from tests.auth_helpers import TEST_USER_ID

FIXTURE = Path(__file__).resolve().parents[2] / "frontend/public/motion-preview-assets"


@pytest.fixture
def pack(ready_character_id, tmp_path):
    directory = tmp_path / "pack"
    shutil.copytree(FIXTURE, directory)
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    source = root / "motion-test-static.png"
    shutil.copyfile(FIXTURE / "static.png", source)
    with SessionLocal() as db:
        ch = db.get(Character, ready_character_id)
        ch.image_path = source.name
        db.commit()
    return ready_character_id, directory, source


def bind(pack):
    cid, directory, _ = pack
    with SessionLocal() as db:
        return import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)


def test_dry_run_does_not_write(pack):
    cid, directory, _ = pack
    with SessionLocal() as db:
        result = import_motion_pack(db, cid, TEST_USER_ID, directory)
        assert result["written"] is False
        assert db.get(CharacterMotionAsset, cid) is None


def test_delivery_and_idempotent_import(client, pack):
    result = bind(pack)
    cid, directory, _ = pack
    with SessionLocal() as db:
        again = import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)
        assert again["pack_id"] == result["pack_id"] and not again["written"]
    base = f"/api/v1/characters/{cid}/motion"
    response = client.get(base)
    assert response.status_code == 200
    data = response.json()
    assert data["state"] == "ready" and "file" not in json.dumps(data)
    assert str(get_settings().upload_dir) not in response.text
    for kind in ("sprite", "background"):
        image = client.get(data[kind + "_url"])
        assert image.status_code == 200
        assert image.headers["content-type"] == "image/png"
        assert image.headers["cache-control"] == "private, no-store"
        assert image.headers["vary"] == "Authorization"
        assert hashlib.sha256(image.content).hexdigest() == data[kind + "_sha256"]
    assert client.get(base + "/" + "f" * 32 + "/sprite").status_code == 404
    assert client.get(base + "/" + result["pack_id"] + "/manifest.json").status_code == 422


@pytest.mark.parametrize("owner", [None, "motion-other-owner"])
def test_missing_anonymous_and_other_owner(client, anon, pack, owner):
    cid, _, _ = pack
    base = f"/api/v1/characters/{cid}/motion"
    assert client.get(base).json() == {"state": "missing"}
    result = bind(pack)
    urls = [base, base + "/" + result["pack_id"] + "/sprite"]
    for url in urls:
        assert anon.get(url).status_code == 401
    with SessionLocal() as db:
        if owner:
            db.add(User(id=owner, phone="13900998877"))
            db.flush()
        db.get(Character, cid).owner_id = owner
        db.commit()
    for url in urls:
        res = client.get(url)
        assert res.status_code == 404 and res.json()["error"]["code"] == "character_not_found"
    with SessionLocal() as db, pytest.raises(MotionBindingError):
        import_motion_pack(db, cid, TEST_USER_ID, pack[1], apply=True)


@pytest.mark.parametrize("change", ["source", "sprite", "manifest", "symlink", "directory-link"])
def test_changed_resource_stays_private(client, pack, change, tmp_path):
    result = bind(pack)
    cid, _, source = pack
    target = Path(get_settings().upload_dir) / "motion-packs" / result["pack_id"]
    if change == "source":
        source.write_bytes(b"changed")
    elif change == "sprite":
        (target / "sprite.png").write_bytes(b"invalid")
    elif change == "manifest":
        (target / "manifest.json").write_text("{}")
    elif change == "symlink":
        (target / "sprite.png").unlink()
        (target / "sprite.png").symlink_to(FIXTURE / "sprite.png")
    else:
        moved = tmp_path / "moved"
        target.rename(moved)
        target.symlink_to(moved, target_is_directory=True)
    for url in [f"/api/v1/characters/{cid}/motion", f"/api/v1/characters/{cid}/motion/{result['pack_id']}/sprite"]:
        res = client.get(url)
        assert res.status_code == 409 and res.json()["error"]["code"] == "motion_unavailable"
        assert str(target) not in res.text


def test_import_conflict_keeps_old_binding(pack):
    original = bind(pack)
    cid, directory, _ = pack
    path = directory / "manifest.json"
    data = json.loads(path.read_text())
    data["fps"] = 10
    path.write_text(json.dumps(data))
    with SessionLocal() as db, pytest.raises(MotionBindingError) as error:
        import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)
    assert error.value.code == "motion_exists"
    with SessionLocal() as db:
        assert db.get(CharacterMotionAsset, cid).pack_id == original["pack_id"]


@pytest.mark.parametrize("failure", ["copy", "commit"])
def test_failed_import_cleans_only_new_directory(pack, failure):
    cid, directory, source = pack
    root = Path(get_settings().upload_dir) / "motion-packs"
    before = set(root.iterdir()) if root.exists() else set()
    target = "app.services.motion_bindings.shutil.copyfile" if failure == "copy" else "sqlalchemy.orm.Session.commit"
    with SessionLocal() as db, patch(target, side_effect=OSError()), pytest.raises(MotionBindingError):
        import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)
    with SessionLocal() as db:
        assert db.get(CharacterMotionAsset, cid) is None
    assert set(root.iterdir()) == before
    assert source.is_file()


def test_deleted_character_invalidates_pack(client, pack):
    result = bind(pack)
    cid = pack[0]
    with SessionLocal() as db:
        db.delete(db.get(Character, cid))
        db.commit()
        assert db.get(CharacterMotionAsset, cid) is None
    assert client.get(f"/api/v1/characters/{cid}/motion/{result['pack_id']}/sprite").status_code == 404


def test_binding_survives_another_process(pack):
    import subprocess
    import sys
    result = bind(pack)
    cid = pack[0]
    code = f"""
from app.core.database import SessionLocal
from app.models.models import Character, CharacterMotionAsset
from app.services.motion_bindings import read_binding
with SessionLocal() as db:
    ch, binding = db.get(Character, {cid}), db.get(CharacterMotionAsset, {cid})
    directory, data = read_binding(ch, binding)
    assert binding.pack_id == {result['pack_id']!r}
    assert (directory / data['sprite_file']).is_file()
print('restored')
"""
    restored = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=10)
    assert restored.returncode == 0 and restored.stdout.strip() == "restored"


def test_delete_api_cleans_only_deleted_pack(client, pack):
    result = bind(pack)
    cid, directory, source = pack
    with SessionLocal() as db:
        original = db.get(Character, cid)
        other = Character(object_id=original.object_id, owner_id=TEST_USER_ID, image_path=source.name,
                          name="保留伙伴", persona="合成测试", opening_line="", status="ready")
        db.add(other)
        db.commit()
        other_id = other.id
        second = import_motion_pack(db, other_id, TEST_USER_ID, directory, apply=True)
    root = Path(get_settings().upload_dir) / "motion-packs"
    assert client.delete(f"/api/v1/characters/{cid}").status_code == 204
    assert not (root / result["pack_id"]).exists()
    assert (root / second["pack_id"]).is_dir() and source.is_file()
    assert client.get(f"/api/v1/characters/{other_id}/motion").json()["state"] == "ready"
    with SessionLocal() as db:
        assert db.get(MotionCleanupTask, result["pack_id"]) is None


def test_failed_physical_delete_is_persisted_and_retried_in_another_process(client, pack):
    import subprocess
    import sys
    result = bind(pack)
    cid = pack[0]
    root = Path(get_settings().upload_dir) / "motion-packs" / result["pack_id"]
    with patch("app.services.motion_cleanup.shutil.rmtree", side_effect=OSError()):
        assert client.delete(f"/api/v1/characters/{cid}").status_code == 204
    with SessionLocal() as db:
        assert db.get(Character, cid) is None
        assert db.get(MotionCleanupTask, result["pack_id"]) is not None
    assert root.exists()
    assert client.get(f"/api/v1/characters/{cid}/motion").status_code == 404
    script = Path(__file__).resolve().parents[1] / "scripts/cleanup_motion_packs.py"
    dry = subprocess.run([sys.executable, str(script)], capture_output=True, text=True, timeout=10)
    assert dry.returncode == 0 and json.loads(dry.stdout)["removed"] == 0 and root.exists()
    applied = subprocess.run([sys.executable, str(script), "--apply"], capture_output=True, text=True, timeout=10)
    assert applied.returncode == 0 and json.loads(applied.stdout)["removed"] == 1
    assert not root.exists()
    with SessionLocal() as db:
        assert db.get(MotionCleanupTask, result["pack_id"]) is None


def test_database_delete_failure_does_not_remove_resources(client, pack):
    result = bind(pack)
    from sqlalchemy.exc import SQLAlchemyError
    root = Path(get_settings().upload_dir) / "motion-packs" / result["pack_id"]
    with patch("sqlalchemy.orm.Session.commit", side_effect=SQLAlchemyError()):
        with pytest.raises(SQLAlchemyError):
            client.delete(f"/api/v1/characters/{pack[0]}")
    assert root.is_dir()
    with SessionLocal() as db:
        assert db.get(Character, pack[0]) is not None
        assert db.get(MotionCleanupTask, result["pack_id"]) is None


def test_cleanup_does_not_follow_links_or_delete_live_bindings(pack, tmp_path):
    from app.services.motion_cleanup import cleanup_pending_motion
    result = bind(pack)
    linked_id = "a" * 32
    target = tmp_path / "keep"
    target.mkdir()
    (target / "keep.txt").write_text("保留")
    root = Path(get_settings().upload_dir) / "motion-packs"
    (root / linked_id).symlink_to(target, target_is_directory=True)
    with SessionLocal() as db:
        db.add_all([MotionCleanupTask(pack_id=result["pack_id"]), MotionCleanupTask(pack_id=linked_id)])
        db.commit()
        assert cleanup_pending_motion(db, apply=True)["removed"] == 0
        assert db.query(MotionCleanupTask).count() == 2
    assert (target / "keep.txt").is_file() and (root / result["pack_id"]).is_dir()
