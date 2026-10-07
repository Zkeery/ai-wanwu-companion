"""Read-only C1 planning boundary. No execution, persisted consent or model calls.

Permission and PlanBasis are trusted server inputs, never model/browser inputs.
The future executor must re-read them in its transaction and check its own budget,
rate limits, lease and receipt. A Review is not an execution authorization.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.living import seasons
from app.living.rules import Identifier, LivingError
from app.living.competitions import character_competing
from app.living.store import LivingStore, _identity, _uuid

Activity = Literal['rest', 'walk', 'observe']
Identity = Annotated[str, Field(min_length=1, max_length=128)]
Timestamp = Annotated[int, Field(ge=0, le=253402300799)]
Revision = Annotated[int, Field(ge=0)]
MAX_PLAN_AGE = 600
TZ = ZoneInfo('Asia/Shanghai')


class FrozenModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)


class VisibleItem(FrozenModel):
    id: Identifier
    kind: Literal['tree', 'bench', 'shade', 'cushion', 'flower', 'mushroom',
                  'pond', 'campfire', 'fireflies']
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class Facts(FrozenModel):
    owner_id: Identity
    space_id: Identifier
    companion_id: Identity
    scene_type: Literal['home', 'desert', 'forest']
    scene_revision: Revision
    companion_status: Literal['ready', 'generating', 'failed']
    current_space_id: Identifier | None
    location_epoch: Revision
    items: tuple[VisibleItem, ...]
    rain: bool
    sound: bool
    season: Literal['spring', 'summer', 'autumn', 'winter'] | None
    season_revision: Revision
    observed_at: Timestamp


class Permission(FrozenModel):
    """Future durable-consent adapter contract; never infer from simulation."""
    owner_id: Identity
    space_id: Identifier
    companion_id: Identity
    revision: int = Field(gt=0)
    enabled: bool
    activities: tuple[Activity, ...] = Field(max_length=3)

    @field_validator('activities')
    @classmethod
    def unique_activities(cls, value):
        if len(set(value)) != len(value):
            raise ValueError('duplicate activities')
        return tuple(sorted(value))


class Candidate(FrozenModel):
    activity: Activity
    target_id: Identifier | None = None
    reason: str = Field(min_length=1, max_length=120)

    @field_validator('reason')
    @classmethod
    def readable_reason(cls, value):
        if not value.strip() or any(ord(c) < 32 for c in value):
            raise ValueError('reason must be a short plain line')
        return value.strip()


class PlanBasis(FrozenModel):
    plan_id: Identifier
    request_id: Identifier
    facts_digest: str = Field(pattern=r'^[0-9a-f]{64}$')
    permission_digest: str = Field(pattern=r'^[0-9a-f]{64}$')
    permission_revision: int = Field(gt=0)
    observed_at: Timestamp


class Review(FrozenModel):
    mode: Literal['validation_only'] = 'validation_only'
    candidate: Candidate
    basis: PlanBasis
    checked_at: Timestamp


def _local_time(now):
    if type(now) is not int or not 0 <= now <= 253402300799:
        raise LivingError('invalid_request', '服务端时间不正确')
    try:
        return datetime.fromtimestamp(now, TZ)
    except (ValueError, OverflowError, OSError):
        raise LivingError('invalid_request', '服务端时间不正确') from None


def read_facts(conn, owner_id: str, space_id: str, now: int) -> Facts:
    """Select only current facts. Caller owns the connection and transaction."""
    from app.models.models import Character

    _identity(owner_id)
    _uuid(space_id)
    _local_time(now)
    try:
        row = LivingStore._row(conn, owner_id, space_id)
        if row['mode'] != 'private':
            raise LivingError('invalid_action', '本轮计划仅支持私人空间')
        ch = conn.execute(select(Character.id, Character.status,
                                 Character.current_space_id, Character.location_epoch).where(
            Character.id == row['companion_id'], Character.owner_id == owner_id
        )).mappings().first()
        if ch is None:
            raise LivingError('not_found', '伙伴不存在或无权访问')
        if character_competing(conn, ch['id']):
            raise LivingError('invalid_action', '伙伴正在比赛，请结束或退出比赛后再安排生活')
        state = LivingStore._state(row)
        if now < state.last_write_at:
            raise LivingError('conflict', '服务端时间早于已保存状态')
        season = seasons.read(conn, owner_id, space_id, now)
        return Facts(
            owner_id=owner_id, space_id=space_id, companion_id=str(ch['id']),
            scene_type=row['scene_type'], scene_revision=row['revision'],
            companion_status=ch['status'], current_space_id=ch['current_space_id'],
            location_epoch=ch['location_epoch'], observed_at=now,
            items=tuple(VisibleItem(id=i.id, kind=i.kind, x=i.x, y=i.y)
                        for i in sorted(state.items.values(), key=lambda x: x.id) if not i.stored),
            rain=state.atmosphere.rain, sound=state.atmosphere.sound,
            season=season['current_season'], season_revision=season['revision'],
        )
    except SQLAlchemyError:
        raise LivingError('storage_unavailable', '生活事实暂时无法读取') from None
    except (ValidationError, ValueError, TypeError, KeyError):
        raise LivingError('corrupt_state', '生活事实无法读取，请保留数据') from None


def _digest(value: BaseModel, *, exclude=None) -> str:
    encoded = json.dumps(value.model_dump(mode='json', exclude=exclude),
                         sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _require_permission(facts: Facts, permission: Permission | None):
    if permission is None:
        raise LivingError('invalid_action', '自主生活尚未获得允许')
    if any(getattr(facts, key) != getattr(permission, key)
           for key in ('owner_id', 'space_id', 'companion_id')):
        raise LivingError('invalid_action', '授权不属于当前伙伴和空间')
    if not permission.enabled:
        raise LivingError('invalid_action', '自主生活已暂停')
    if facts.companion_status != 'ready':
        raise LivingError('invalid_action', '伙伴尚未准备好')
    if facts.current_space_id != facts.space_id:
        raise LivingError('invalid_action', '伙伴当前不在此空间')


def make_basis(facts: Facts, permission: Permission | None, *,
               plan_id: str, request_id: str) -> PlanBasis:
    """Bind a future candidate to server facts before asking a model."""
    _require_permission(facts, permission)
    return PlanBasis(plan_id=_uuid(plan_id), request_id=_uuid(request_id),
                     facts_digest=_digest(facts, exclude={'observed_at'}),
                     permission_digest=_digest(permission),
                     permission_revision=permission.revision, observed_at=facts.observed_at)


def check_basis(basis: PlanBasis, facts: Facts, permission: Permission | None) -> None:
    """Recheck a server-owned plan binding, including before a future model call."""
    _require_permission(facts, permission)
    age = facts.observed_at - basis.observed_at
    if not 0 <= age < MAX_PLAN_AGE:
        raise LivingError('conflict', '计划已过期或时间发生变化，请重新规划')
    if (basis.facts_digest != _digest(facts, exclude={'observed_at'}) or
            basis.permission_revision != permission.revision or
            basis.permission_digest != _digest(permission)):
        raise LivingError('conflict', '场景、伙伴或授权已变化，请重新规划')


def review_candidate(payload: dict, *, basis: PlanBasis, facts: Facts,
                     permission: Permission | None) -> Review:
    """Validate against freshly read facts; never execute or store the candidate."""
    check_basis(basis, facts, permission)
    try:
        candidate = Candidate.model_validate(payload)
    except ValidationError:
        raise LivingError('invalid_request', '候选计划结构不正确') from None
    if candidate.activity not in permission.activities:
        raise LivingError('invalid_action', '该活动尚未获得允许')
    hour = _local_time(facts.observed_at).hour
    if (hour >= 22 or hour < 7) and candidate.activity != 'rest':
        raise LivingError('invalid_action', '夜间只允许安静休息')
    if candidate.activity == 'observe':
        if candidate.target_id not in {item.id for item in facts.items}:
            raise LivingError('invalid_action', '观察目标当前不可用')
    elif candidate.target_id is not None:
        raise LivingError('invalid_action', '该活动不接受物件目标')
    return Review(candidate=candidate, basis=basis, checked_at=facts.observed_at)
