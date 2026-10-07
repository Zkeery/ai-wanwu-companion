"""Durable local motion delivery; never creates or calls a model provider."""
import asyncio
import json
import logging
import shutil
import time
from pathlib import Path
from uuid import uuid4

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.models import Character, CharacterActivityMotionAsset, MotionCleanupTask, MotionPreparationTask
from app.services.motion_assets import MotionAssetError, validate_motion_pack
from app.services.motion_bindings import MotionBindingError, owned_character, pack_directory, read_binding, source_digest

ACTIVITIES = ("rest", "walk", "observe")


def enqueue_preparation(db: Session, ch: Character) -> None:
    """Caller owns the generation transaction. No disk work on the SSE path."""
    if ch.status != "ready" or not ch.owner_id or not ch.image_path:
        return
    for activity in ACTIVITIES:
        if db.get(MotionPreparationTask, (ch.id, activity)) is None:
            db.add(MotionPreparationTask(character_id=ch.id, activity=activity,
                                         owner_id=ch.owner_id, source_image_path=ch.image_path))


def _manifest(directory: Path, digest: str, activity: str) -> dict:
    try:
        data = validate_motion_pack(directory, digest)
        if data.get("activity") != activity:
            raise MotionBindingError("motion_activity_mismatch", 422)
        return data
    except (OSError, MotionAssetError):
        raise MotionBindingError() from None


def submit_prepared_pack(db: Session, cid: int, owner: str, directory: Path,
                         activity: str, *, apply=False) -> dict:
    """Single-activity compatibility entry point."""
    return submit_prepared_packs(db, cid, owner, {activity: directory}, apply=apply)["activities"][0]


def submit_prepared_packs(db: Session, cid: int, owner: str, directories: dict[str, Path],
                          *, apply=False) -> dict:
    """Validate the entire batch before publishing any queued inputs."""
    if not directories or any(activity not in ACTIVITIES for activity in directories):
        raise MotionBindingError("invalid_activity", 422)
    ch = owned_character(db, cid, owner)
    digest, original_path = source_digest(ch), ch.image_path
    manifests = {activity: _manifest(Path(directory), digest, activity)
                 for activity, directory in directories.items()}
    targets, retained, results = {}, set(), []
    committed = False
    try:
        if apply:
            # Copy before locking SQLite; all copied identities are checked again.
            for activity, directory in directories.items():
                manifest = manifests[activity]
                target = pack_directory(uuid4().hex)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.mkdir()
                targets[activity] = target
                files = ([manifest["video_file"]] if "video_file" in manifest
                         else [manifest["sprite_file"], manifest["background_file"]])
                for name in ["manifest.json", *files]:
                    shutil.copyfile(Path(directory) / name, target / name)
                if _manifest(target, digest, activity) != manifest:
                    raise MotionBindingError()
            db.rollback()
            db.execute(text("BEGIN IMMEDIATE"))
            ch = owned_character(db, cid, owner)
            if ch.image_path != original_path or source_digest(ch) != digest:
                raise MotionBindingError("motion_source_changed")
        # Check every existing slot before changing any of the jobs.
        pending = []
        for activity, manifest in manifests.items():
            existing = db.get(CharacterActivityMotionAsset, (cid, activity))
            job = db.get(MotionPreparationTask, (cid, activity))
            if existing:
                _, previous = read_binding(ch, existing)
                if previous != manifest:
                    raise MotionBindingError("motion_exists")
                state = "ready"
            else:
                if job and (job.owner_id != owner or job.source_image_path != original_path):
                    raise MotionBindingError("motion_source_changed")
                if job and job.input_pack_id and job.state != "failed":
                    if _manifest(pack_directory(job.input_pack_id), digest, activity) != manifest:
                        raise MotionBindingError("motion_exists")
                    state = "queued"
                else:
                    state = "queued" if apply else "validated"
                    pending.append(activity)
            results.append({"activity": activity, "state": state, "written": False})
        if apply and pending:
            enqueue_preparation(db, ch)
            db.flush()
            for activity in pending:
                job = db.get(MotionPreparationTask, (cid, activity))
                target = targets[activity]
                job.input_pack_id, job.source_sha256 = target.name, digest
                job.state, job.attempts, job.retry_at, job.error_code = "queued", 0, 0, None
                db.add(MotionCleanupTask(pack_id=target.name))
                retained.add(activity)
            db.commit()
            committed = True
            for result in results:
                result["written"] = result["activity"] in retained
        elif apply:
            db.rollback()
        return {"character_id": cid, "written": committed, "activities": results}
    except Exception as exc:
        db.rollback()
        if isinstance(exc, MotionBindingError):
            raise
        raise MotionBindingError() from None
    finally:
        for activity, target in targets.items():
            if not committed or activity not in retained:
                shutil.rmtree(target, ignore_errors=True)


def process_one(db: Session, *, now: int | None = None) -> bool:
    """SQLite serializes claiming, binding and completion in one transaction."""
    now = int(time.time()) if now is None else now
    db.rollback()
    db.execute(text("BEGIN IMMEDIATE"))
    try:
        job = (db.query(MotionPreparationTask).filter(
            MotionPreparationTask.state == "queued", MotionPreparationTask.retry_at <= now)
            .order_by(MotionPreparationTask.retry_at, MotionPreparationTask.created_at,
                      MotionPreparationTask.character_id, MotionPreparationTask.activity).first())
        if job is None:
            db.rollback()
            return False
        job.attempts += 1
        try:
            ch = owned_character(db, job.character_id, job.owner_id)
            if ch.image_path != job.source_image_path or source_digest(ch) != job.source_sha256:
                raise MotionBindingError("motion_source_changed")
            manifest = _manifest(pack_directory(job.input_pack_id or ""), job.source_sha256, job.activity)
            existing = db.get(CharacterActivityMotionAsset, (ch.id, job.activity))
            if existing:
                _, previous = read_binding(ch, existing)
                if previous != manifest:
                    raise MotionBindingError("motion_exists")
            else:
                db.add(CharacterActivityMotionAsset(
                    character_id=ch.id, activity=job.activity, pack_id=job.input_pack_id,
                    source_image_path=ch.image_path, source_sha256=job.source_sha256,
                    manifest_json=json.dumps(manifest, sort_keys=True)))
            job.state, job.error_code = "ready", None
        except (MotionBindingError, OSError) as exc:
            code = exc.code if isinstance(exc, MotionBindingError) else "motion_unavailable"
            terminal = code in {"character_not_found", "motion_source_changed", "motion_exists"}
            job.state = "failed" if terminal or job.attempts >= 3 else "queued"
            job.error_code, job.retry_at = code, now + (5 if job.attempts == 1 else 30)
        db.commit()
        return True
    except BaseException:
        db.rollback()
        raise


def preparation_status(db: Session, cid: int, owner: str) -> dict:
    ch = owned_character(db, cid, owner)
    result = []
    for activity in ACTIVITIES:
        job = db.get(MotionPreparationTask, (cid, activity))
        state, error, attempts = "not_requested", None, 0
        if job:
            state, error, attempts = job.state, job.error_code, job.attempts
            if job.owner_id != owner or job.source_image_path != ch.image_path:
                state, error = "failed", "motion_source_changed"
        binding = db.get(CharacterActivityMotionAsset, (cid, activity))
        if binding:
            try:
                read_binding(ch, binding)
                state, error = "ready", None
            except MotionBindingError:
                state, error = "failed", "motion_unavailable"
        elif state == "ready":
            state, error = "failed", "motion_unavailable"
        result.append({"activity": activity, "state": state, "attempts": attempts, "error_code": error})
    return {"character_id": cid, "activities": result}


def process_batch() -> None:
    with SessionLocal() as db:
        for _ in range(3):
            if not process_one(db):
                break


async def consume(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            await asyncio.to_thread(process_batch)
        except Exception:
            logging.getLogger(__name__).warning("motion_preparation_unavailable")
        try:
            await asyncio.wait_for(stop.wait(), timeout=2)
        except asyncio.TimeoutError:
            pass
