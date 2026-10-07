"""Synthetic local resources. These checks do not certify motion quality."""
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

import pytest

from app.core.database import SessionLocal
from app.models.models import Character, CharacterActivityMotionAsset, MotionPreparationTask, User
from app.services.motion_bindings import MotionBindingError, pack_directory
from app.services.motion_cleanup import cleanup_pending_motion
from app.services.motion_preparation import enqueue_preparation, process_one, submit_prepared_pack
from tests.auth_helpers import TEST_USER_ID
from tests.test_characters_api import _upload
from tests.test_multi_activity_motion import classified
from tests.test_private_motion import pack  # noqa: F401


def queue(pack, tmp_path, activity="rest"):
    cid, directory, _ = pack
    source = classified(directory, tmp_path / activity, activity)
    with SessionLocal() as db:
        result = submit_prepared_pack(db, cid, TEST_USER_ID, source, activity, apply=True)
        job = db.get(MotionPreparationTask, (cid, activity))
        return source, job.input_pack_id, result


def test_generation_enqueues_atomically_without_media_work(client, png_header, parse_sse):
    oid = _upload(client, png_header)
    with patch("app.services.motion_preparation.source_digest", side_effect=AssertionError("SSE must not hash media")):
        response = client.post("/api/v1/characters", json={"object_id": oid})
    done = [d for e, d in parse_sse(response.text) if e == "done"][0]
    status = client.get(f"/api/v1/characters/{done['id']}/motion-preparation").json()
    assert {j["activity"] for j in status["activities"]} == {"rest", "walk", "observe"}
    assert all(j["state"] == "waiting_source" and j["attempts"] == 0 for j in status["activities"])
    with SessionLocal() as db:
        enqueue_preparation(db, db.get(Character, done["id"]))
        db.commit()
        assert db.query(MotionPreparationTask).count() == 3
        assert not process_one(db)


def test_enqueue_failure_rolls_back_generation_and_jobs(client, png_header, parse_sse):
    oid = _upload(client, png_header)
    def fail(db, ch):
        enqueue_preparation(db, ch)
        db.flush()
        raise RuntimeError("synthetic persistence failure")
    with patch("app.services.motion_preparation.enqueue_preparation", side_effect=fail):
        response = client.post("/api/v1/characters", json={"object_id": oid})
    assert parse_sse(response.text)[-1][0] == "error"
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 0
        assert db.query(Character).one().status == "failed"


def test_dryrun_and_wrong_activity_do_not_create_jobs(pack, tmp_path):
    source = classified(pack[1], tmp_path / "rest", "rest")
    with SessionLocal() as db:
        assert not submit_prepared_pack(db, pack[0], TEST_USER_ID, source, "rest")["written"]
        with pytest.raises(MotionBindingError):
            submit_prepared_pack(db, pack[0], TEST_USER_ID, source, "walk", apply=True)
        assert db.query(MotionPreparationTask).count() == 0


def test_three_slots_automatically_bind_and_deliver(client, pack, tmp_path):
    for activity in ("rest", "walk", "observe"):
        source, pack_id, result = queue(pack, tmp_path, activity)
        assert result["state"] == "queued"
        with SessionLocal() as db:
            assert cleanup_pending_motion(db, apply=True)["removed"] == 0
            assert not submit_prepared_pack(db, pack[0], TEST_USER_ID, source, activity, apply=True)["written"]
            assert process_one(db)
            assert not process_one(db)
            assert not submit_prepared_pack(db, pack[0], TEST_USER_ID, source, activity, apply=True)["written"]
            assert db.get(CharacterActivityMotionAsset, (pack[0], activity)).pack_id == pack_id
        data = client.get(f"/api/v1/characters/{pack[0]}/motion?activity={activity}").json()
        assert data["pack_id"] == pack_id
        assert client.get(data["sprite_url"]).status_code == 200
    status = client.get(f"/api/v1/characters/{pack[0]}/motion-preparation").json()
    assert all(j["state"] == "ready" and j["attempts"] == 1 for j in status["activities"])


def test_failed_commit_recovers_in_new_process(pack, tmp_path):
    _, pack_id, _ = queue(pack, tmp_path)
    with SessionLocal() as db:
        with patch.object(db, "commit", side_effect=RuntimeError("simulated crash")):
            with pytest.raises(RuntimeError):
                process_one(db)
        assert db.get(CharacterActivityMotionAsset, (pack[0], "rest")) is None
        assert db.get(MotionPreparationTask, (pack[0], "rest")).state == "queued"
    code = "from app.core.database import SessionLocal\nfrom app.services.motion_preparation import process_one\nwith SessionLocal() as db:\n assert process_one(db)\n assert not process_one(db)\n"
    result = subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=20)
    assert result.returncode == 0, result.stderr.decode()
    with SessionLocal() as db:
        assert db.get(CharacterActivityMotionAsset, (pack[0], "rest")).pack_id == pack_id
        assert db.get(MotionPreparationTask, (pack[0], "rest")).attempts == 1


def test_concurrent_workers_bind_once(pack, tmp_path):
    queue(pack, tmp_path)
    def run():
        with SessionLocal() as db:
            return process_one(db)
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(lambda _: run(), range(2))) == [False, True]
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == 1
        assert db.get(MotionPreparationTask, (pack[0], "rest")).attempts == 1


@pytest.mark.parametrize("change", ["source", "owner", "image_path"])
def test_stale_identity_never_binds(pack, tmp_path, change):
    queue(pack, tmp_path)
    with SessionLocal() as db:
        ch = db.get(Character, pack[0])
        if change == "source":
            pack[2].write_bytes(b"changed")
        elif change == "owner":
            db.add(User(id="other-motion-owner", phone="13987654321")); db.flush()
            ch.owner_id = "other-motion-owner"
        else:
            ch.image_path = "replacement.png"
        db.commit()
        assert process_one(db)
        assert db.get(MotionPreparationTask, (pack[0], "rest")).state == "failed"
        assert db.get(CharacterActivityMotionAsset, (pack[0], "rest")) is None


def test_corrupt_input_has_bounded_retries_and_explicit_replacement(pack, tmp_path):
    source, pack_id, _ = queue(pack, tmp_path)
    (pack_directory(pack_id) / "sprite.png").write_bytes(b"invalid")
    with SessionLocal() as db:
        assert process_one(db, now=100)
        assert not process_one(db, now=104)
        assert process_one(db, now=105)
        assert not process_one(db, now=134)
        assert process_one(db, now=135)
        assert not process_one(db, now=1000)
        job = db.get(MotionPreparationTask, (pack[0], "rest"))
        assert job.state == "failed" and job.attempts == 3
        assert submit_prepared_pack(db, pack[0], TEST_USER_ID, source, "rest", apply=True)["written"]
        assert cleanup_pending_motion(db, limit=1, apply=True)["removed"] == 1
        assert not pack_directory(pack_id).exists()
        assert process_one(db)


def test_status_is_private_readonly_and_rechecks_bound_media(client, anon, pack, tmp_path):
    url = f"/api/v1/characters/{pack[0]}/motion-preparation"
    assert anon.get(url).status_code == 401
    response = client.get(url)
    assert response.headers["cache-control"] == "private, no-store"
    assert all(j["state"] == "not_requested" for j in response.json()["activities"])
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 0
    _, pack_id, _ = queue(pack, tmp_path)
    with SessionLocal() as db:
        process_one(db)
    assert "ready" in client.get(url).text
    (pack_directory(pack_id) / "sprite.png").write_bytes(b"invalid")
    response = client.get(url)
    assert response.json()["activities"][0]["state"] == "failed"
    assert pack_id not in response.text and TEST_USER_ID not in response.text
    assert "source_image_path" not in response.text
    with SessionLocal() as db:
        db.add(User(id="other-motion-owner", phone="13987654321")); db.flush()
        db.get(Character, pack[0]).owner_id = "other-motion-owner"; db.commit()
    assert client.get(url).status_code == 404


@pytest.mark.parametrize("bound", [False, True])
def test_deletion_recovers_queued_and_bound_media(client, pack, tmp_path, bound):
    _, pack_id, _ = queue(pack, tmp_path)
    if bound:
        with SessionLocal() as db:
            process_one(db)
    with patch("app.services.motion_cleanup.shutil.rmtree", side_effect=OSError()):
        assert client.delete(f"/api/v1/characters/{pack[0]}").status_code == 204
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 0
        assert cleanup_pending_motion(db, apply=True)["removed"] == 1
    assert not pack_directory(pack_id).exists()


def test_existing_valid_pack_cannot_be_replaced(pack, tmp_path):
    source, _, _ = queue(pack, tmp_path)
    manifest_path = source / "manifest.json"
    data = json.loads(manifest_path.read_text()); data["fps"] = 10
    manifest_path.write_text(json.dumps(data))
    with SessionLocal() as db, pytest.raises(MotionBindingError, match="动作素材"):
        submit_prepared_pack(db, pack[0], TEST_USER_ID, source, "rest", apply=True)


def test_service_lifespan_consumes_pending_pack(pack, tmp_path):
    from fastapi.testclient import TestClient
    from app.main import app
    from tests.auth_helpers import TEST_TOKEN
    _, pack_id, _ = queue(pack, tmp_path)
    with TestClient(app, headers={"Authorization": f"Bearer {TEST_TOKEN}"}) as live:
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            data = live.get(f"/api/v1/characters/{pack[0]}/motion?activity=rest").json()
            if data["state"] == "ready":
                break
            time.sleep(.02)
        assert data["pack_id"] == pack_id
        assert live.get(data["sprite_url"]).status_code == 200
    with SessionLocal() as db:
        assert db.get(MotionPreparationTask, (pack[0], "rest")).state == "ready"


def test_copy_failure_and_source_race_leave_no_pending_pack(pack, tmp_path):
    import shutil
    source = classified(pack[1], tmp_path / "rest", "rest")
    with SessionLocal() as db:
        with patch("app.services.motion_preparation.shutil.copyfile", side_effect=OSError()):
            with pytest.raises(MotionBindingError):
                submit_prepared_pack(db, pack[0], TEST_USER_ID, source, "rest", apply=True)
        assert db.query(MotionPreparationTask).count() == 0
        copy = shutil.copyfile
        def copy_and_change(a, b):
            result = copy(a, b)
            pack[2].write_bytes(b"source replaced while copying")
            return result
        with patch("app.services.motion_preparation.shutil.copyfile", side_effect=copy_and_change):
            with pytest.raises(MotionBindingError):
                submit_prepared_pack(db, pack[0], TEST_USER_ID, source, "rest", apply=True)
        assert db.query(MotionPreparationTask).count() == 0


def test_cleanup_limit_does_not_starve_deleted_packs(client, pack, tmp_path):
    _, live_id, _ = queue(pack, tmp_path, "rest")
    _, deleted_id, _ = queue(pack, tmp_path, "walk")
    with SessionLocal() as db:
        db.delete(db.get(MotionPreparationTask, (pack[0], "walk")))
        db.commit()
        assert cleanup_pending_motion(db, limit=1, apply=True)["removed"] == 1
    assert pack_directory(live_id).exists()
    assert not pack_directory(deleted_id).exists()
