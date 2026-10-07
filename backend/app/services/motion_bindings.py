"""Owner-bound immutable motion packs. No provider calls."""
import hashlib
import json
import re
import shutil
from pathlib import Path
from uuid import uuid4

from sqlalchemy import inspect
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.models import Character, CharacterMotionAsset, CharacterActivityMotionAsset
from app.services.motion_assets import MotionAssetError, validate_motion_pack


class MotionBindingError(ValueError):
    def __init__(self, code="motion_unavailable", status=409):
        self.code, self.status = code, status
        super().__init__("动作素材暂不可用，静态形象仍保留")


def owned_character(db: Session, character_id: int, owner_id: str) -> Character:
    ch = db.get(Character, character_id)
    if ch is None or ch.owner_id != owner_id:
        raise MotionBindingError("character_not_found", 404)
    if ch.status != "ready":
        raise MotionBindingError()
    return ch


def source_digest(ch: Character) -> str:
    from app.api.wall import image_file
    path = image_file(ch)
    if path is None or path.stat().st_size > 20 * 1024 * 1024:
        raise MotionBindingError()
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pack_directory(pack_id: str) -> Path:
    root = Path(get_settings().upload_dir).resolve() / "motion-packs"
    if not re.fullmatch(r"[a-f0-9]{32}", pack_id) or root.is_symlink():
        raise MotionBindingError()
    directory = root / pack_id
    if directory.is_symlink():
        raise MotionBindingError()
    return directory


def read_binding(ch: Character, binding: CharacterMotionAsset | CharacterActivityMotionAsset) -> tuple[Path, dict]:
    try:
        if binding.source_image_path != ch.image_path or source_digest(ch) != binding.source_sha256:
            raise MotionBindingError()
        directory = pack_directory(binding.pack_id)
        manifest = validate_motion_pack(directory, binding.source_sha256)
        if manifest != json.loads(binding.manifest_json):
            raise MotionBindingError()
        if isinstance(binding, CharacterActivityMotionAsset) and manifest.get("activity") != binding.activity:
            raise MotionBindingError()
        return directory, manifest
    except (OSError, ValueError, TypeError) as exc:
        if isinstance(exc, MotionBindingError):
            raise
        raise MotionBindingError() from None


def import_motion_pack(db: Session, character_id: int, owner_id: str, directory: Path, *, apply=False) -> dict:
    ch = owned_character(db, character_id, owner_id)
    try:
        digest = source_digest(ch)
        manifest = validate_motion_pack(directory, digest)
    except (OSError, MotionAssetError):
        raise MotionBindingError() from None
    existing = (db.get(CharacterMotionAsset, character_id)
                if inspect(db.get_bind()).has_table(CharacterMotionAsset.__tablename__) else None)
    if existing:
        _, previous = read_binding(ch, existing)
        if previous != manifest:
            raise MotionBindingError("motion_exists", 409)
        return {"state": "ready", "pack_id": existing.pack_id, "written": False}
    if not apply:
        return {"state": "validated", "character_id": character_id, "written": False}
    target = pack_directory(uuid4().hex)
    created = False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.mkdir()
        created = True
        filenames = (("manifest.json", manifest["video_file"]) if "video_file" in manifest
                     else ("manifest.json", manifest["sprite_file"], manifest["background_file"]))
        for filename in filenames:
            shutil.copyfile(directory / filename, target / filename)
        if validate_motion_pack(target, digest) != manifest:
            raise MotionBindingError()
        # Recheck after copying; never bind resources to a concurrently changed image.
        db.refresh(ch)
        if ch.owner_id != owner_id or ch.status != "ready" or source_digest(ch) != digest:
            raise MotionBindingError()
        db.add(CharacterMotionAsset(character_id=ch.id, pack_id=target.name,
                                   source_image_path=ch.image_path, source_sha256=digest,
                                   manifest_json=json.dumps(manifest, sort_keys=True)))
        db.commit()
        return {"state": "ready", "pack_id": target.name, "written": True}
    except Exception:
        db.rollback()
        if created:
            shutil.rmtree(target)
        raise MotionBindingError() from None


def import_activity_motion_pack(db: Session, character_id: int, owner_id: str,
                                directory: Path, activity: str, *, apply=False) -> dict:
    ch = owned_character(db, character_id, owner_id)
    if activity not in ("rest", "walk", "observe"):
        raise MotionBindingError("invalid_activity", 422)
    try:
        digest = source_digest(ch)
        manifest = validate_motion_pack(directory, digest)
        if manifest.get("activity") != activity:
            raise MotionBindingError("motion_activity_mismatch", 422)
    except (OSError, MotionAssetError):
        raise MotionBindingError() from None
    existing = (db.get(CharacterActivityMotionAsset, (character_id, activity))
                if inspect(db.get_bind()).has_table(CharacterActivityMotionAsset.__tablename__) else None)
    if existing:
        _, previous = read_binding(ch, existing)
        if previous != manifest:
            raise MotionBindingError("motion_exists", 409)
        return {"state": "ready", "activity": activity, "pack_id": existing.pack_id, "written": False}
    if not apply:
        return {"state": "validated", "activity": activity, "character_id": character_id, "written": False}
    target = pack_directory(uuid4().hex)
    created = False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.mkdir()
        created = True
        filenames = (("manifest.json", manifest["video_file"]) if "video_file" in manifest
                     else ("manifest.json", manifest["sprite_file"], manifest["background_file"]))
        for filename in filenames:
            shutil.copyfile(directory / filename, target / filename)
        if validate_motion_pack(target, digest) != manifest:
            raise MotionBindingError()
        db.refresh(ch)
        if ch.owner_id != owner_id or ch.status != "ready" or source_digest(ch) != digest:
            raise MotionBindingError()
        db.add(CharacterActivityMotionAsset(character_id=ch.id, activity=activity, pack_id=target.name,
                                            source_image_path=ch.image_path, source_sha256=digest,
                                            manifest_json=json.dumps(manifest, sort_keys=True)))
        db.commit()
        return {"state": "ready", "activity": activity, "pack_id": target.name, "written": True}
    except Exception:
        db.rollback()
        if created:
            shutil.rmtree(target)
        raise MotionBindingError() from None
