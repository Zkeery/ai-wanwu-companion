"""Transactional atlas delivery; synthetic inputs do not certify animation quality."""
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from app.core.config import get_settings
from app.core.database import SessionLocal, engine
from app.models.models import Character, CharacterActivityMotionAsset, MotionCleanupTask, MotionPreparationTask, User
from app.services.character_motion_atlas import prepare_character_atlas
from app.services.motion_atlas import ACTIVITIES, build_motion_atlas
from app.services.motion_bindings import MotionBindingError
from app.services.motion_preparation import process_one, submit_prepared_pack, submit_prepared_packs
from tests.auth_helpers import TEST_USER_ID
from tests.test_motion_atlas import inputs  # noqa: F401


@pytest.fixture
def delivery(inputs, ready_character_id):
    source, atlas, output = inputs
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    original = root / "batch-atlas-source.png"
    shutil.copyfile(source, original)
    with SessionLocal() as db:
        db.get(Character, ready_character_id).image_path = original.name
        db.commit()
    build_motion_atlas(original, atlas, output, write=True)
    return ready_character_id, original, atlas, {a: output / a for a in ACTIVITIES}


def disk_state():
    root = Path(get_settings().upload_dir)
    return {str(f.relative_to(root)): hashlib.sha256(f.read_bytes()).hexdigest()
            for f in root.rglob("*") if f.is_file()}


def apply_atlas(db, delivery):
    cid, _, atlas, _ = delivery
    return prepare_character_atlas(db, cid, TEST_USER_ID, atlas, apply=True,
                                  reviewed_sha256=hashlib.sha256(atlas.read_bytes()).hexdigest())


def test_dryrun_and_missing_review_do_not_write(delivery):
    cid, _, atlas, _ = delivery
    before = disk_state()
    with SessionLocal() as db:
        result = prepare_character_atlas(db, cid, TEST_USER_ID, atlas)
        assert not result["written"] and not result["queue_checked"]
        for digest in (None, "0" * 64):
            with pytest.raises(MotionBindingError) as error:
                prepare_character_atlas(db, cid, TEST_USER_ID, atlas, apply=True, reviewed_sha256=digest)
            assert error.value.code == "motion_review_required"
        assert db.query(MotionPreparationTask).count() == 0
        assert db.query(MotionCleanupTask).count() == 0
    assert disk_state() == before


def test_atlas_restarts_consumes_and_delivers_privately(delivery, client, anon):
    cid, _, _, _ = delivery
    with SessionLocal() as db:
        result = apply_atlas(db, delivery)
        assert result["written"] and len(result["activities"]) == 3
        assert all(r["state"] == "queued" for r in result["activities"])
        assert not apply_atlas(db, delivery)["written"]
    before = disk_state()
    code = "from app.core.database import SessionLocal\nfrom app.services.motion_preparation import process_one\nwith SessionLocal() as db:\n assert all(process_one(db) for _ in range(3))\n assert not process_one(db)\n"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr.decode()
    with SessionLocal() as db:
        assert all(r["state"] == "ready" for r in apply_atlas(db, delivery)["activities"])
        assert db.query(CharacterActivityMotionAsset).count() == 3
        assert db.query(MotionCleanupTask).count() == 3
    assert disk_state() == before
    for activity in ACTIVITIES:
        url = f"/api/v1/characters/{cid}/motion?activity={activity}"
        data = client.get(url).json()
        assert data["state"] == "ready" and data["activity"] == activity
        assert client.get(data["sprite_url"]).status_code == 200
        assert anon.get(data["sprite_url"]).status_code == 401


@pytest.mark.parametrize("failure", ["invalid_third", "copy_third", "commit", "source", "owner"])
def test_batch_failure_has_no_partial_tasks_or_files(delivery, failure):
    cid, original, _, directories = delivery
    before = disk_state()
    copy = shutil.copyfile
    changed = False
    def copy_or_fail(a, b):
        nonlocal changed
        if Path(a).parent.name == "observe":
            if failure == "copy_third":
                raise OSError("synthetic copy failure")
            if failure == "source":
                original.write_bytes(b"changed")
            if failure == "owner" and not changed:
                with SessionLocal() as other:
                    other.add(User(id="atlas-other", phone="13800009991"))
                    other.flush()
                    other.get(Character, cid).owner_id = "atlas-other"
                    other.commit()
                changed = True
        return copy(a, b)
    if failure == "invalid_third":
        (directories["observe"] / "sprite.png").write_bytes(b"invalid")
    with SessionLocal() as db:
        with patch("app.services.motion_preparation.shutil.copyfile", side_effect=copy_or_fail):
            with patch.object(db, "commit", side_effect=RuntimeError("synthetic commit failure")) if failure == "commit" else patch.object(db, "commit", wraps=db.commit):
                with pytest.raises(MotionBindingError) as error:
                    submit_prepared_packs(db, cid, TEST_USER_ID, directories, apply=True)
                if failure in ("source", "owner"):
                    assert error.value.code == ("motion_source_changed" if failure == "source" else "character_not_found")
        assert db.query(MotionPreparationTask).count() == 0
        assert db.query(MotionCleanupTask).count() == 0
        assert db.query(CharacterActivityMotionAsset).count() == 0
    after = disk_state()
    if failure == "source":
        before.pop(original.name); after.pop(original.name)
    assert after == before


@pytest.mark.parametrize("bound", [False, True])
def test_conflicting_last_slot_rolls_back_other_two(delivery, bound):
    cid, _, _, directories = delivery
    with SessionLocal() as db:
        submit_prepared_pack(db, cid, TEST_USER_ID, directories["observe"], "observe", apply=True)
        if bound:
            assert process_one(db)
        before = disk_state()
        manifest = directories["observe"] / "manifest.json"
        data = json.loads(manifest.read_text()); data["fps"] = 10
        manifest.write_text(json.dumps(data))
        with pytest.raises(MotionBindingError) as error:
            submit_prepared_packs(db, cid, TEST_USER_ID, directories, apply=True)
        assert error.value.code == "motion_exists"
        assert all(j.input_pack_id is None for j in db.query(MotionPreparationTask)
                   if j.activity in ("rest", "walk"))
        assert db.query(MotionCleanupTask).count() == 1
    assert disk_state() == before


def test_concurrent_submissions_keep_one_set(delivery):
    cid, _, _, directories = delivery
    def submit(_):
        with SessionLocal() as db:
            return submit_prepared_packs(db, cid, TEST_USER_ID, directories, apply=True)["written"]
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(submit, range(2))) == [False, True]
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 3
        assert db.query(MotionCleanupTask).count() == 3


@pytest.mark.parametrize("which", ["atlas", "source"])
def test_input_changed_after_review_is_discarded(delivery, which):
    from app.services.character_motion_atlas import build_motion_atlas as build
    cid, original, atlas, _ = delivery
    before = disk_state()
    def changed(*args, **kwargs):
        if kwargs.get("write"):
            target = atlas if which == "atlas" else original
            with Image.open(target) as image:
                altered = image.copy()
            altered.putpixel((150, 150), (180, 80, 80, 220) if altered.mode == "RGBA" else (180, 80, 80))
            altered.save(target)
        return build(*args, **kwargs)
    with SessionLocal() as db, patch("app.services.character_motion_atlas.build_motion_atlas", side_effect=changed):
        with pytest.raises(MotionBindingError):
            apply_atlas(db, delivery)
        assert db.query(MotionPreparationTask).count() == 0
    after = disk_state()
    if which == "source":
        before.pop(original.name); after.pop(original.name)
    assert after == before
    assert not list(original.parent.glob(".atlas-delivery-*"))


def test_recorded_real_atlas_cli_restart_and_backup_restore(ready_character_id, tmp_path, client, record_property):
    """Actual C1.45 pixels, isolated owner/data. No new image/model request."""
    project = Path(__file__).resolve().parents[2]
    evidence = project / "docs/PRD/版本/V1.2/验收证据"
    atlas = evidence / "阶段3/C1.45三活动姿态总图/apple-atlas-v2.png"
    root = Path(get_settings().upload_dir)
    root.mkdir(parents=True, exist_ok=True)
    source = root / "recorded-atlas-source.jpg"
    shutil.copyfile(evidence / "阶段7/R7.14古灵精怪免费体验/apple-9b.jpg", source)
    with SessionLocal() as db:
        db.get(Character, ready_character_id).image_path = source.name
        db.commit()
    args = [sys.executable, "-m", "scripts.prepare_character_atlas", "--character-id",
            str(ready_character_id), "--owner-id", TEST_USER_ID, "--atlas", str(atlas)]
    def run(command, env=None):
        result = subprocess.run(command, capture_output=True, timeout=20, env=env)
        assert result.returncode == 0, result.stderr.decode()
        return json.loads(result.stdout)
    before = disk_state()
    probe = run(args)
    assert not probe["written"] and disk_state() == before
    applied = run(args + ["--apply", "--reviewed-sha256", probe["atlas_sha256"]])
    assert applied["written"] and len(applied["activities"]) == 3
    backup = tmp_path / "queued-backup.db"
    with sqlite3.connect(engine.url.database) as live, sqlite3.connect(backup) as restored:
        live.backup(restored)
    code = "from app.core.database import SessionLocal\nfrom app.services.motion_preparation import process_one,preparation_status\nimport json\nwith SessionLocal() as db:\n assert all(process_one(db) for _ in range(3))\n assert not process_one(db)\n print(json.dumps(preparation_status(db," + str(ready_character_id) + "," + repr(TEST_USER_ID) + ")))\n"
    original_result = run([sys.executable, "-c", code])
    restored_result = run([sys.executable, "-c", code], env={**os.environ, "DATABASE_URL": f"sqlite:///{backup}"})
    assert original_result == restored_result
    assert all(row["state"] == "ready" for row in original_result["activities"])
    assert not run(args + ["--apply", "--reviewed-sha256", probe["atlas_sha256"]])["written"]
    assets = []
    for activity in ACTIVITIES:
        data = client.get(f"/api/v1/characters/{ready_character_id}/motion?activity={activity}").json()
        sprite = client.get(data["sprite_url"])
        # C1.51 deliberately fixes the walk order. Rest/observe retain their original bytes.
        version = "C1.51透明能力与步态编排" if activity == "walk" else "C1.45三活动姿态总图"
        expected = evidence / f"阶段3/{version}/packs/{activity}/sprite.png"
        assert sprite.status_code == 200 and sprite.content == expected.read_bytes()
        assets.append({"activity": activity, "http_status": sprite.status_code,
                       "sprite_sha256": hashlib.sha256(sprite.content).hexdigest()})
    record_property("atlas_delivery_receipt", json.dumps({
        "source": "C1.45 archived real atlas; isolated synthetic owner and database",
        "atlas_sha256": probe["atlas_sha256"], "dry_run_written": probe["written"],
        "initial_submission": applied, "after_restart": original_result,
        "backup_restore_equal": original_result == restored_result,
        "duplicate_submission_written": False, "assets": assets,
        "new_model_calls": 0,
    }))
