import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterMotionAsset, User
from app.services.motion_assets import MotionAssetError, validate_motion_pack
from app.services.motion_bindings import import_motion_pack
from scripts.build_video_motion import build
from tests.auth_helpers import TEST_USER_ID
from tests.test_private_motion import pack  # noqa: F401


@pytest.fixture
def video_pack(pack, tmp_path):
    cid, _, source = pack
    clip = tmp_path / "input.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=96x96:r=24",
                    "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], check=True, timeout=15)
    output = tmp_path / "video-pack"
    assert build(source, clip, output)["written"] is False and not output.exists()
    build(source, clip, output, write=True)
    return cid, output, source


def test_private_delivery_restart_and_delete(client, anon, video_pack):
    cid, directory, _ = video_pack
    with SessionLocal() as db:
        result = import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)
        assert not import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)["written"]
    base = f"/api/v1/characters/{cid}/motion"
    data = client.get(base).json()
    assert data["kind"] == "video" and data["duration_ms"] == 4000
    response = client.get(data["video_url"])
    assert response.status_code == 200 and response.headers["content-type"] == "video/mp4"
    assert response.headers["cache-control"] == "private, no-store"
    assert hashlib.sha256(response.content).hexdigest() == data["video_sha256"]
    assert anon.get(data["video_url"]).status_code == 401
    assert client.get(data["video_url"].replace('/video', '/sprite')).status_code == 404
    code = f"""from app.core.database import SessionLocal
from app.models.models import Character, CharacterMotionAsset
from app.services.motion_bindings import read_binding
with SessionLocal() as db:
    _, data = read_binding(db.get(Character,{cid}),db.get(CharacterMotionAsset,{cid}))
    assert data['video_file']=='motion.mp4'
"""
    assert subprocess.run([sys.executable, "-c", code], capture_output=True, timeout=10).returncode == 0
    assert client.delete(f"/api/v1/characters/{cid}").status_code == 204
    assert not (Path(get_settings().upload_dir) / "motion-packs" / result["pack_id"]).exists()
    assert client.get(data["video_url"]).status_code == 404


def test_video_is_not_readable_after_owner_changes(client, video_pack):
    cid, directory, _ = video_pack
    with SessionLocal() as db:
        import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)
    data = client.get(f"/api/v1/characters/{cid}/motion").json()
    with SessionLocal() as db:
        db.add(User(id="video-other", phone="13900887766")); db.flush()
        db.get(Character, cid).owner_id = "video-other"; db.commit()
    assert client.get(data["video_url"]).status_code == 404


@pytest.mark.parametrize("change", ["hash", "source", "path", "dimensions", "duration", "bool", "symlink", "fake", "extra"])
def test_invalid_video_pack_rejected(video_pack, change, tmp_path):
    _, directory, source = video_pack
    manifest = directory / "manifest.json"
    data = json.loads(manifest.read_text())
    if change == "hash": data["video_sha256"] = "0" * 64
    elif change == "source": data["source_sha256"] = "0" * 64
    elif change == "path": data["video_file"] = "../input.mp4"
    elif change == "dimensions": data["width"] = 100
    elif change == "duration": data["duration_ms"] = 6000
    elif change == "bool": data["fps"] = True
    elif change == "extra": data["other"] = "field"
    elif change == "symlink":
        other = tmp_path / "other.mp4"; shutil.copyfile(directory / "motion.mp4", other)
        (directory / "motion.mp4").unlink(); (directory / "motion.mp4").symlink_to(other)
    else:
        (directory / "motion.mp4").write_bytes(b"not a video")
        data["video_sha256"] = hashlib.sha256(b"not a video").hexdigest()
    manifest.write_text(json.dumps(data))
    with pytest.raises(MotionAssetError): validate_motion_pack(directory, hashlib.sha256(source.read_bytes()).hexdigest())


def test_probe_timeout_fails_closed(video_pack):
    _, directory, source = video_pack
    with patch('app.services.motion_video.subprocess.run', side_effect=subprocess.TimeoutExpired('ffprobe', 5)):
        with pytest.raises(MotionAssetError): validate_motion_pack(directory, hashlib.sha256(source.read_bytes()).hexdigest())


def test_audio_is_removed_without_modifying_source(video_pack, tmp_path):
    _, _, source = video_pack
    original = Path(__file__).resolve().parents[2] / 'docs/PRD/版本/V1.2/验收证据/阶段1/R1.6表情与转圈小样/apple-doubao-mini.mp4'
    before = hashlib.sha256(original.read_bytes()).hexdigest()
    from app.services.motion_video import probe_video
    with pytest.raises(ValueError): probe_video(original)
    output = tmp_path / 'silent'
    build(source, original, output, write=True)
    assert probe_video(output / 'motion.mp4')['width'] == 960
    assert hashlib.sha256(original.read_bytes()).hexdigest() == before
    with pytest.raises(ValueError): build(source, original, output, write=True)


def test_invalid_activity_does_not_create_video_pack(video_pack, tmp_path):
    _, directory, source = video_pack
    output = tmp_path / 'invalid-activity'
    with pytest.raises(ValueError):
        build(source, directory / 'motion.mp4', output, activity='dance', write=True)
    assert not output.exists()
    assert 'activity' not in json.loads((directory / 'manifest.json').read_text())
