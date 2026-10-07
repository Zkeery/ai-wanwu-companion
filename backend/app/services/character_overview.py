"""Read-only homepage facts. Never initialize scenes or infer character activity."""
from __future__ import annotations

import logging
import json
from datetime import datetime, timezone

from sqlalchemy import String, and_, cast, exists, func, or_, select
from sqlalchemy.orm import Session

from app.living.store import spaces
from app.living.activity import event_text, recent_for_spaces
from app.models.models import Character, LivingMembership, Message
from app.schemas.schemas import CharacterOut, CharacterOverview, LifeActivitySummary, ResidenceOverview

logger = logging.getLogger(__name__)


def character_overviews(db: Session, owner_id: str, include_life_activity: bool = False) -> list[CharacterOverview]:
    owned_ready = (Character.owner_id == owner_id, Character.status == "ready")
    from app.living.gatherings import visits, groups
    joined = db.execute(select(Character, groups.c.id.label('gather_id'), groups.c.state_json.label('gather_state'))
        .outerjoin(visits, and_(visits.c.character_id == Character.id, visits.c.owner_id == owner_id,
                               visits.c.group_id == Character.current_space_id))
        .outerjoin(groups, groups.c.id == visits.c.group_id).where(*owned_ready).order_by(
        Character.created_at.desc(), Character.id.desc()
    )).all()
    characters = [row[0] for row in joined]
    if not characters:
        return []

    # Owner match is necessary but not sufficient: a stale pointer to another
    # character's private home or a shared space without membership is invalid.
    member = exists(select(LivingMembership.space_id).where(
        LivingMembership.space_id == spaces.c.id,
        LivingMembership.companion_id == cast(Character.id, String),
    )).correlate(Character, spaces)
    valid_residence = or_(
        and_(spaces.c.mode == "private",
             spaces.c.companion_id == cast(Character.id, String)),
        and_(spaces.c.mode == "shared", member),
    )
    rows = db.execute(select(
        Character.id, spaces.c.id.label("space_id"),
        spaces.c.scene_type, spaces.c.mode,
    ).join(spaces, spaces.c.id == Character.current_space_id).where(
        *owned_ready, spaces.c.owner_id == owner_id, valid_residence,
    )).all()
    residences = {
        row.id: ResidenceOverview(space_id=row.space_id,
                                 scene_type=row.scene_type, mode=row.mode)
        for row in rows
    }
    from app.schemas.schemas import GatheringOverview
    gathering_by_character = {}
    for row in joined:
        if not row.gather_state:
            continue
        group = json.loads(row.gather_state)
        if not group['closed'] and owner_id in group['members']:
            gathering_by_character[row[0].id] = GatheringOverview(id=row.gather_id, title=group['title'])

    recent = dict(db.execute(select(
        Message.character_id, func.max(Message.created_at)
    ).join(Character, Character.id == Message.character_id).where(
        *owned_ready
    ).group_by(Message.character_id)).all())

    invalid_count = sum(bool(ch.current_space_id) and ch.id not in residences and ch.id not in gathering_by_character
                        for ch in characters)
    if invalid_count:
        # No account IDs, message content, private names or space IDs in logs.
        logger.warning("overview_invalid_residence count=%s", invalid_count)

    activity = recent_for_spaces(db, [r.space_id for r in residences.values()
                                      if r.mode == 'private']) if include_life_activity else {}

    result = []
    for ch in characters:
        last = recent.get(ch.id)
        # Existing DateTime columns store UTC without tzinfo. The new contract
        # carries an explicit timezone; old CharacterOut stays unchanged.
        if last is not None and last.tzinfo is None:
            last = last.replace(tzinfo=timezone.utc)
        result.append(CharacterOverview(
            character=CharacterOut.model_validate(ch),
            residence=residences.get(ch.id), last_interaction_at=last,
            gathering=gathering_by_character.get(ch.id),
            recent_activity=[LifeActivitySummary(
                revision=item.revision, occurred_at=datetime.fromtimestamp(item.created_at, timezone.utc),
                source=item.source, text=event_text(item),
            ) for item in activity.get(residences[ch.id].space_id, [])] if ch.id in residences else [],
        ))
    return result
