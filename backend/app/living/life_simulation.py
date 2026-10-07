"""Deterministic test-only life rehearsal. Never calls providers or changes a scene."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table, Text, insert, select, update

from app.living.rules import LivingError
from app.living.store import LivingStore, spaces
from app.living import seasons
from app.models.models import Character

metadata = MetaData()
preferences = Table('life_sim_settings', metadata,
    Column('space_id', String, ForeignKey(spaces.c.id, ondelete='CASCADE'), primary_key=True),
    Column('settings_json', Text, nullable=False), Column('revision', Integer, nullable=False))
events = Table('life_sim_events', metadata,
    Column('space_id', String, ForeignKey(spaces.c.id, ondelete='CASCADE'), primary_key=True),
    Column('request_id', String, primary_key=True), Column('created_at', Integer, nullable=False),
    Column('source', String, nullable=False), Column('day', String, nullable=False),
    Column('event_json', Text, nullable=False))
receipts = Table('life_sim_receipts', metadata,
    Column('space_id', String, ForeignKey(spaces.c.id, ondelete='CASCADE'), primary_key=True),
    Column('request_id', String, primary_key=True), Column('digest', String, nullable=False),
    Column('result_json', Text, nullable=False))
TZ = ZoneInfo('Asia/Shanghai')
Activity = Literal['rest', 'walk', 'observe']


class Settings(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    enabled: bool
    activities: list[Activity] = Field(max_length=3)

    @field_validator('activities')
    @classmethod
    def unique(cls, value):
        if len(set(value)) != len(value):
            raise ValueError('duplicate activities')
        return sorted(value)

    @model_validator(mode='after')
    def enabled_has_scope(self):
        if self.enabled and not self.activities:
            raise ValueError('select activities first')
        return self


class Plan(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    activity: Activity
    target_id: str | None = None


class Event(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    id: str
    mode: Literal['simulation']
    companion_id: str
    activity: Activity
    target_id: str | None
    target_kind: Literal['tree', 'bench', 'shade', 'cushion', 'flower', 'mushroom', 'pond', 'campfire', 'fireflies'] | None
    season: Literal['spring', 'summer', 'autumn', 'winter'] | None
    scene_revision: int = Field(ge=0)
    created_at: int = Field(ge=0)
    source: Literal['viewing', 'offline']
    reason: str

    @model_validator(mode='after')
    def target_matches(self):
        valid = (self.target_id is not None and self.target_kind is not None) if self.activity == 'observe' else (self.target_id is None and self.target_kind is None)
        if not valid:
            raise ValueError('invalid target')
        return self


class Snapshot(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    mode: Literal['simulation']
    settings: Settings
    revision: int = Field(ge=0)
    present: bool
    observed_at: int = Field(ge=0)
    next_allowed_at: int = Field(ge=0)
    events: list[Event] = Field(max_length=20)
    outcome: Literal['read', 'saved', 'executed', 'paused', 'away', 'cooldown', 'offline_limit', 'no_allowed_activity']


def owned(conn, owner, sid):
    row = LivingStore._row(conn, owner, sid)
    if row['mode'] != 'private':
        raise LivingError('invalid_action', '本轮模拟仅支持私人空间')
    ch = conn.execute(select(Character.__table__).where(
        Character.id == row['companion_id'], Character.owner_id == owner)).mappings().first()
    if ch is None:
        raise LivingError('not_found', '伙伴不存在或无权访问')
    return row, ch


def config(conn, sid):
    row = conn.execute(select(preferences).where(preferences.c.space_id == sid)).mappings().first()
    if row is None:
        return Settings(enabled=False, activities=[]), 0
    try:
        s = Settings.model_validate_json(row['settings_json'])
        if type(row['revision']) is not int or row['revision'] < 1:
            raise ValueError()
        return s, row['revision']
    except ValueError:
        raise LivingError('corrupt_state', '生活模拟设置无法读取，请保留数据') from None


def read(conn, owner, sid, now):
    row, ch = owned(conn, owner, sid)
    settings, revision = config(conn, sid)
    saved = conn.execute(select(events).where(events.c.space_id == sid).order_by(
        events.c.created_at.desc(), events.c.request_id).limit(20)).mappings().all()
    try:
        history = [Event.model_validate_json(e['event_json']).model_dump() for e in saved]
    except (ValueError, KeyError, TypeError):
        raise LivingError('corrupt_state', '生活模拟记录无法读取，请保留数据') from None
    last_at = saved[0]['created_at'] if saved else None
    return {'mode': 'simulation', 'settings': settings.model_dump(), 'revision': revision,
            'present': ch['current_space_id'] == sid, 'observed_at': now,
            'next_allowed_at': last_at + 600 if last_at is not None else now,
            'events': history, 'outcome': 'read'}


def digest(payload):
    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()


def replay(conn, sid, rid, signature):
    row = conn.execute(select(receipts).where(receipts.c.space_id == sid,
                                            receipts.c.request_id == rid)).mappings().first()
    if row is None:
        return None
    if row['digest'] != signature:
        raise LivingError('conflict', '相同请求标识不能用于不同的操作')
    try:
        return Snapshot.model_validate_json(row['result_json']).model_dump()
    except (ValueError, KeyError, TypeError):
        raise LivingError('corrupt_state', '模拟回执无法读取，请保留数据') from None


def finish(conn, owner, sid, rid, signature, now, outcome):
    result = {**read(conn, owner, sid, now), 'outcome': outcome}
    conn.execute(insert(receipts).values(space_id=sid, request_id=rid, digest=signature,
                                        result_json=json.dumps(result, ensure_ascii=False)))
    return result


def save(conn, owner, sid, rid, revision, settings, now):
    owned(conn, owner, sid)
    signature = digest({'operation': 'settings', 'revision': revision, **settings.model_dump()})
    previous = replay(conn, sid, rid, signature)
    if previous is not None:
        return previous
    current, saved_revision = config(conn, sid)
    if revision != saved_revision:
        raise LivingError('conflict', '生活设置已变化，请先刷新记录')
    if settings != current:
        values = {'settings_json': settings.model_dump_json(), 'revision': revision + 1}
        if revision:
            conn.execute(update(preferences).where(preferences.c.space_id == sid).values(**values))
        else:
            conn.execute(insert(preferences).values(space_id=sid, **values))
    return finish(conn, owner, sid, rid, signature, now, 'saved')


def choose_plan(settings, state, now):
    hour = datetime.fromtimestamp(now, TZ).hour
    if hour >= 22 or hour < 7:
        return Plan(activity='rest') if 'rest' in settings.activities else None
    visible = sorted((i for i in state.items.values() if not i.stored), key=lambda i: i.id)
    if 'observe' in settings.activities and visible:
        return Plan(activity='observe', target_id=visible[0].id)
    return next((Plan(activity=a) for a in ('walk', 'rest') if a in settings.activities), None)


def validate_plan(plan, settings, state):
    if plan.activity not in settings.activities:
        raise LivingError('invalid_action', '活动尚未获得允许')
    if plan.activity == 'observe':
        item = state.items.get(plan.target_id)
        if item is None or item.stored:
            raise LivingError('invalid_action', '观察目标当前不可用')
    elif plan.target_id is not None:
        raise LivingError('invalid_action', '该活动不接受物件目标')


def step(conn, owner, sid, rid, source, now):
    row, ch = owned(conn, owner, sid)
    signature = digest({'operation': 'step', 'source': source})
    previous = replay(conn, sid, rid, signature)
    if previous is not None:
        return previous
    settings, _ = config(conn, sid)
    outcome = None
    if not settings.enabled:
        outcome = 'paused'
    elif ch['current_space_id'] != sid:
        outcome = 'away'
    last = conn.execute(select(events.c.created_at).where(events.c.space_id == sid)
                        .order_by(events.c.created_at.desc()).limit(1)).scalar_one_or_none()
    day = datetime.fromtimestamp(now, TZ).date().isoformat()
    if outcome is None and last is not None and now < last + 600:
        outcome = 'cooldown'
    if outcome is None and source == 'offline':
        count = len(conn.execute(select(events.c.request_id).where(events.c.space_id == sid,
                    events.c.source == 'offline', events.c.day == day).limit(2)).all())
        if count >= 2:
            outcome = 'offline_limit'
    if outcome:
        return finish(conn, owner, sid, rid, signature, now, outcome)
    state = LivingStore._state(row)
    plan = choose_plan(settings, state, now)
    if plan is None:
        return finish(conn, owner, sid, rid, signature, now, 'no_allowed_activity')
    validate_plan(plan, settings, state)
    season = seasons.read(conn, owner, sid, now)['current_season']
    target = state.items[plan.target_id] if plan.target_id else None
    event = {'id': rid, 'mode': 'simulation', 'companion_id': str(ch['id']),
             'activity': plan.activity, 'target_id': plan.target_id,
             'target_kind': target.kind if target else None, 'season': season,
             'scene_revision': row['revision'], 'created_at': now, 'source': source,
             'reason': '夜间安静休息' if datetime.fromtimestamp(now, TZ).hour not in range(7, 22)
                       else '依据已允许的活动与当前场景物件模拟'}
    conn.execute(insert(events).values(space_id=sid, request_id=rid, created_at=now,
                 source=source, day=day, event_json=json.dumps(event, ensure_ascii=False)))
    return finish(conn, owner, sid, rid, signature, now, 'executed')
