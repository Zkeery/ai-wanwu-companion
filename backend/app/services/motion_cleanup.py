"""Persist deletion intent, then remove only unbound private motion directories."""
import logging
import shutil

from sqlalchemy import inspect
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.models.models import CharacterMotionAsset, CharacterActivityMotionAsset, MotionCleanupTask, MotionPreparationTask
from app.services.motion_bindings import MotionBindingError, pack_directory


def cleanup_pending_motion(db: Session, *, limit=50, apply=False) -> dict:
    has_activity_bindings = inspect(db.get_bind()).has_table(CharacterActivityMotionAsset.__tablename__)
    has_preparation = inspect(db.get_bind()).has_table(MotionPreparationTask.__tablename__)
    # Filter references before LIMIT so live packs cannot starve deleted packs.
    pending = db.query(MotionCleanupTask).filter(~db.query(CharacterMotionAsset)
        .filter(CharacterMotionAsset.pack_id == MotionCleanupTask.pack_id).exists())
    if has_activity_bindings:
        pending = pending.filter(~db.query(CharacterActivityMotionAsset)
            .filter(CharacterActivityMotionAsset.pack_id == MotionCleanupTask.pack_id).exists())
    if has_preparation:
        pending = pending.filter(~db.query(MotionPreparationTask)
            .filter(MotionPreparationTask.input_pack_id == MotionCleanupTask.pack_id).exists())
    tasks = pending.order_by(MotionCleanupTask.created_at).limit(limit).all()
    complete = 0
    for task in tasks:
        pack_id = task.pack_id
        if not apply:
            continue
        try:
            # An intact live binding always takes priority over any queued task.
            if (db.query(CharacterMotionAsset).filter_by(pack_id=pack_id).first()
                    or (has_preparation and db.query(MotionPreparationTask)
                        .filter_by(input_pack_id=pack_id).first())
                    or (has_activity_bindings and db.query(CharacterActivityMotionAsset)
                        .filter_by(pack_id=pack_id).first())):
                continue
            directory = pack_directory(pack_id)
            if directory.exists():
                shutil.rmtree(directory)
            db.delete(task)
            db.commit()
            complete += 1
        except (OSError, MotionBindingError, SQLAlchemyError):
            db.rollback()
            logging.getLogger(__name__).warning("motion_cleanup_pending")
    return {"inspected": len(tasks), "removed": complete, "apply": apply}
