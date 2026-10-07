"""Five initial credits; reserve and settle in the caller's character transaction."""
from uuid import uuid4

from sqlalchemy import select, update
from sqlalchemy.dialects.sqlite import insert

from app.core.config import get_settings
from app.core.errors import api_error
from app.models.models import Character, GenerationCharge, GenerationCredits


def balance(db, owner_id):
    db.execute(insert(GenerationCredits).values(owner_id=owner_id, available=5).on_conflict_do_nothing())
    return db.scalar(select(GenerationCredits.available).where(GenerationCredits.owner_id == owner_id))


def reserve(db, owner_id, character_id):
    if not get_settings().generation_quota_enabled:
        return None
    balance(db, owner_id)
    changed = db.execute(update(GenerationCredits).where(
        GenerationCredits.owner_id == owner_id, GenerationCredits.available > 0,
    ).values(available=GenerationCredits.available - 1))
    if changed.rowcount != 1:
        raise api_error(409, "credits_exhausted", "本次内测的生成额度已用完，已有伙伴仍可继续陪伴你")
    charge = GenerationCharge(id=str(uuid4()), owner_id=owner_id, character_id=character_id, status="reserved")
    db.add(charge)
    db.flush()
    return charge.id


def active(db, character_id):
    return db.scalar(select(GenerationCharge.id).where(
        GenerationCharge.character_id == character_id, GenerationCharge.status == "reserved"))


def is_reserved(db, charge_id, character_id):
    return charge_id is None or db.scalar(select(GenerationCharge.id).where(
        GenerationCharge.id == charge_id, GenerationCharge.character_id == character_id,
        GenerationCharge.status == "reserved")) is not None


def settle(db, charge_id, *, success):
    if charge_id is None:
        return
    owner = db.execute(update(GenerationCharge).where(
        GenerationCharge.id == charge_id, GenerationCharge.status == "reserved",
    ).values(status="spent" if success else "refunded").returning(GenerationCharge.owner_id)).scalar_one_or_none()
    if owner is not None and not success:
        db.execute(update(GenerationCredits).where(GenerationCredits.owner_id == owner).values(
            available=GenerationCredits.available + 1))


def refund_character(db, character_id):
    for charge_id in db.scalars(select(GenerationCharge.id).where(
            GenerationCharge.character_id == character_id, GenerationCharge.status == "reserved")).all():
        settle(db, charge_id, success=False)


def recover(db):
    for charge in db.scalars(select(GenerationCharge).where(GenerationCharge.status == "reserved")).all():
        character = db.get(Character, charge.character_id) if charge.character_id else None
        settle(db, charge.id, success=character is not None and character.status == "ready")
