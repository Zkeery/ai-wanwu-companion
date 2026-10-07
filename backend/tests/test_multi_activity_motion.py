"""Synthetic binding tests; content quality of animations is not asserted."""
import json
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterActivityMotionAsset, CharacterMotionAsset, MotionCleanupTask, User
from app.services.motion_bindings import MotionBindingError, import_activity_motion_pack, import_motion_pack
from scripts.build_video_motion import build as build_video_motion
from tests.auth_helpers import TEST_USER_ID
from tests.test_private_motion import pack  # noqa: F401
from tests.test_video_motion import video_pack  # noqa: F401


def classified(source: Path, target: Path, activity: str) -> Path:
    shutil.copytree(source, target)
    manifest = target / "manifest.json"
    data = json.loads(manifest.read_text())
    data["activity"] = activity
    manifest.write_text(json.dumps(data))
    return target


def add(cid: int, directory: Path, activity: str, apply=True):
    with SessionLocal() as db:
        return import_activity_motion_pack(db, cid, TEST_USER_ID, directory, activity, apply=apply)


def test_three_activity_slots_and_generic_survive_independently(client, pack, video_pack, tmp_path):
    cid, original, _ = pack
    assert video_pack[0] == cid
    rest = classified(original, tmp_path / "rest", "rest")
    default = add(cid, rest, "rest", apply=False)
    assert default == {"state": "validated", "activity": "rest", "character_id": cid, "written": False}
    with SessionLocal() as db:
        legacy = import_motion_pack(db, cid, TEST_USER_ID, original, apply=True)
    walk = tmp_path / "walk"
    assert not build_video_motion(video_pack[2], video_pack[1] / "motion.mp4", walk,
                                  activity="walk")["written"]
    assert not walk.exists()
    build_video_motion(video_pack[2], video_pack[1] / "motion.mp4", walk,
                       activity="walk", write=True)
    paths = {"rest": rest, "walk": walk,
             "observe": classified(original, tmp_path / "observe", "observe")}
    ids = {name: add(cid, path, name)["pack_id"] for name, path in paths.items()}
    assert len(set(ids.values())) == 3
    assert add(cid, paths["rest"], "rest")["written"] is False
    base = f"/api/v1/characters/{cid}/motion"
    assert client.get(base).json()["pack_id"] == legacy["pack_id"]
    for activity, pack_id in ids.items():
        data = client.get(base, params={"activity": activity}).json()
        assert data["state"] == "ready" and data["activity"] == activity
        assert data["slot"] == "activity" and data["pack_id"] == pack_id
        kind = "video" if activity == "walk" else "sprite"
        response = client.get(data[kind + "_url"])
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert f"/activity/{activity}/{pack_id}/" in data[kind + "_url"]
        wrong = "rest" if activity != "rest" else "walk"
        assert client.get(data[kind + "_url"].replace(f"/activity/{activity}/", f"/activity/{wrong}/")).status_code == 404
    with SessionLocal() as db:
        assert db.get(CharacterMotionAsset, cid).pack_id == legacy["pack_id"]
        assert db.query(CharacterActivityMotionAsset).filter_by(character_id=cid).count() == 3


def test_conflict_mismatch_and_copy_failure_keep_other_slots(client, pack, tmp_path):
    cid, original, _ = pack
    rest = classified(original, tmp_path / "rest", "rest")
    walk = classified(original, tmp_path / "walk", "walk")
    first = add(cid, rest, "rest")
    assert add(cid, walk, "walk", apply=False)["state"] == "validated"
    with pytest.raises(MotionBindingError) as mismatch:
        add(cid, walk, "observe")
    assert mismatch.value.code == "motion_activity_mismatch"
    changed = classified(original, tmp_path / "changed", "rest")
    data = json.loads((changed / "manifest.json").read_text())
    data["fps"] = 10
    (changed / "manifest.json").write_text(json.dumps(data))
    with pytest.raises(MotionBindingError) as conflict:
        add(cid, changed, "rest")
    assert conflict.value.code == "motion_exists"
    with patch("app.services.motion_bindings.shutil.copyfile", side_effect=OSError()):
        with pytest.raises(MotionBindingError):
            add(cid, walk, "walk")
    with SessionLocal() as db:
        assert db.get(CharacterActivityMotionAsset, (cid, "rest")).pack_id == first["pack_id"]
        assert db.get(CharacterActivityMotionAsset, (cid, "walk")) is None
    assert client.get(f"/api/v1/characters/{cid}/motion?activity=rest").json()["state"] == "ready"
    assert client.get(f"/api/v1/characters/{cid}/motion?activity=walk").json() == {"state": "missing"}


def test_ownership_source_change_and_failed_media(client, anon, pack, tmp_path):
    cid, original, source = pack
    rest = classified(original, tmp_path / "rest", "rest")
    result = add(cid, rest, "rest")
    base = f"/api/v1/characters/{cid}/motion"
    url = client.get(base, params={"activity": "rest"}).json()["sprite_url"]
    assert anon.get(base, params={"activity": "rest"}).status_code == 401
    assert anon.get(url).status_code == 401
    with SessionLocal() as db:
        db.add(User(id="motion-slot-other", phone="13900112233")); db.flush()
        db.get(Character, cid).owner_id = "motion-slot-other"; db.commit()
    assert client.get(base, params={"activity": "rest"}).status_code == 404
    assert client.get(url).status_code == 404
    with SessionLocal() as db:
        db.get(Character, cid).owner_id = TEST_USER_ID; db.commit()
    directory = Path(get_settings().upload_dir) / "motion-packs" / result["pack_id"]
    (directory / "sprite.png").write_bytes(b"corrupt")
    assert client.get(base, params={"activity": "rest"}).status_code == 409
    assert client.get(url).status_code == 409
    shutil.copyfile(original / "sprite.png", directory / "sprite.png")
    source.write_bytes(b"changed")
    assert client.get(base, params={"activity": "rest"}).status_code == 409


def test_delete_records_all_slots_and_recovers_physical_cleanup(client, pack, tmp_path):
    cid, original, _ = pack
    paths = [classified(original, tmp_path / name, name) for name in ("rest", "walk", "observe")]
    ids = [add(cid, path, name)["pack_id"] for path, name in zip(paths, ("rest", "walk", "observe"))]
    with patch("app.services.motion_cleanup.shutil.rmtree", side_effect=OSError()):
        assert client.delete(f"/api/v1/characters/{cid}").status_code == 204
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).filter_by(character_id=cid).count() == 0
        assert {task.pack_id for task in db.query(MotionCleanupTask)} == set(ids)
    code = """from app.core.database import SessionLocal
from app.services.motion_cleanup import cleanup_pending_motion
with SessionLocal() as db:
    assert cleanup_pending_motion(db,apply=True)['removed']==3
"""
    assert subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=10).returncode == 0
    with SessionLocal() as db:
        assert db.query(MotionCleanupTask).count() == 0
    for pack_id in ids:
        assert not (Path(get_settings().upload_dir) / "motion-packs" / pack_id).exists()


def test_existing_live_binding_protects_queued_deletion(client, pack, tmp_path):
    from app.services.motion_cleanup import cleanup_pending_motion
    cid, original, _ = pack
    rest = classified(original, tmp_path / "rest", "rest")
    pack_id = add(cid, rest, "rest")["pack_id"]
    with SessionLocal() as db:
        db.add(MotionCleanupTask(pack_id=pack_id)); db.commit()
        assert cleanup_pending_motion(db, apply=True)["removed"] == 0
        assert db.get(MotionCleanupTask, pack_id) is not None
    assert client.get(f"/api/v1/characters/{cid}/motion?activity=rest").json()["state"] == "ready"
