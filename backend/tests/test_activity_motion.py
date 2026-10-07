import json
import pytest
from app.core.database import SessionLocal
from app.models.models import CharacterMotionAsset, Character, User
from app.services.motion_assets import MotionAssetError, validate_motion_pack
from app.services.motion_bindings import import_motion_pack
from tests.auth_helpers import TEST_USER_ID
from tests.test_private_motion import pack, bind  # noqa: F401
from tests.test_video_motion import video_pack  # noqa: F401

@pytest.mark.parametrize("fixture_name", ["pack", "video_pack"])
@pytest.mark.parametrize("activity", ["rest", "walk", "observe"])
def test_classified_delivery_is_read_only_and_owner_bound(client, anon, request, fixture_name, activity):
    cid, directory, source = request.getfixturevalue(fixture_name)
    manifest = directory / "manifest.json"
    data = json.loads(manifest.read_text())
    data["activity"] = activity
    manifest.write_text(json.dumps(data))
    with SessionLocal() as db:
        import_motion_pack(db, cid, TEST_USER_ID, directory, apply=True)
        before = db.get(CharacterMotionAsset, cid).manifest_json
    base = f"/api/v1/characters/{cid}/motion"
    matching = client.get(base, params={"activity": activity})
    assert matching.status_code == 200 and matching.json()["activity"] == activity
    assert matching.headers["cache-control"] == "private, no-store"
    assert client.get(base).json()["activity"] == activity
    for other in {"rest", "walk", "observe"} - {activity}:
        assert client.get(base, params={"activity": other}).json() == {"state": "missing"}
    assert client.get(base, params={"activity": "dance"}).status_code == 422
    assert anon.get(base, params={"activity": activity}).status_code == 401
    with SessionLocal() as db:
        assert db.get(CharacterMotionAsset, cid).manifest_json == before
        db.add(User(id="activity-motion-other", phone="13900119988")); db.flush()
        db.get(Character, cid).owner_id = "activity-motion-other"; db.commit()
    assert client.get(base, params={"activity": activity}).status_code == 404

def test_legacy_pack_is_never_used_for_current_activity(client, pack):
    cid, _, _ = pack
    bind(pack)
    base = f"/api/v1/characters/{cid}/motion"
    assert client.get(base).json()["state"] == "ready"
    for activity in ("rest", "walk", "observe"):
        assert client.get(base, params={"activity": activity}).json() == {"state": "missing"}

@pytest.mark.parametrize("fixture_name", ["pack", "video_pack"])
@pytest.mark.parametrize("value", ["dance", None, [], True])
def test_invalid_classification_rejected(request, fixture_name, value):
    _, directory, _ = request.getfixturevalue(fixture_name)
    manifest = directory / "manifest.json"
    data = json.loads(manifest.read_text())
    data["activity"] = value
    manifest.write_text(json.dumps(data))
    with pytest.raises(MotionAssetError):
        validate_motion_pack(directory, data["source_sha256"])
