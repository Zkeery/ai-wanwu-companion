"""Deliver an explicitly reviewed local atlas, without a model provider call."""
import tempfile
from pathlib import Path

from sqlalchemy.orm import Session

from app.api.wall import image_file
from app.core.config import get_settings
from app.services.motion_atlas import ACTIVITIES, build_motion_atlas
from app.services.motion_bindings import MotionBindingError, owned_character
from app.services.motion_preparation import submit_prepared_packs


def prepare_character_atlas(db: Session, cid: int, owner: str, atlas: Path, *,
                            apply=False, reviewed_sha256: str | None = None) -> dict:
    ch = owned_character(db, cid, owner)
    source = image_file(ch)
    if source is None:
        raise MotionBindingError()
    # Dry-run only validates geometry and reports the digest to be reviewed.
    # Queue conflict checks happen in the single transaction during apply.
    probe = build_motion_atlas(source, atlas, Path(get_settings().upload_dir) / ".atlas-dry-run")
    if not apply:
        return {**probe, "character_id": cid, "queue_checked": False}
    if reviewed_sha256 != probe["atlas_sha256"]:
        raise MotionBindingError("motion_review_required", 422)
    root = Path(get_settings().upload_dir)
    with tempfile.TemporaryDirectory(prefix=".atlas-delivery-", dir=root) as temporary:
        directory = Path(temporary) / "packs"
        built = build_motion_atlas(source, atlas, directory, write=True)
        if (built["atlas_sha256"] != reviewed_sha256
                or built["source_sha256"] != probe["source_sha256"]):
            raise MotionBindingError("motion_source_changed")
        result = submit_prepared_packs(db, cid, owner,
            {activity: directory / activity for activity in ACTIVITIES}, apply=True)
    return {**result, "atlas_sha256": reviewed_sha256, "source_sha256": built["source_sha256"]}
