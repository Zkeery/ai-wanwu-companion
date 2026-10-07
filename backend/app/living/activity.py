"""Persisted facts from explicit private-space actions; never AI narration."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from sqlalchemy import Column, ForeignKey, Integer, String, Table, Text, UniqueConstraint, func, insert, select

from app.living.rules import ItemKind, LivingError
from app.living.store import LivingStore, metadata

events = Table(
    'living_activity_events', metadata,
    Column('space_id', String(36), ForeignKey('living_spaces.id', ondelete='CASCADE'), primary_key=True),
    Column('revision', Integer, primary_key=True),
    Column('request_id', String(36), nullable=False),
    Column('event_json', Text, nullable=False),
    UniqueConstraint('space_id', 'request_id'),
)


class ActivityEvent(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    revision: int = Field(gt=0)
    request_id: str
    created_at: int = Field(ge=0, le=253402300799)
    source: Literal['user']
    action: Literal['place', 'move', 'care', 'store', 'restore', 'atmosphere', 'undo', 'turn', 'layout']
    target_kind: ItemKind | None
    target_item_id: str | None = None
    weather: Literal['rain', 'clear', 'quiet'] | None

    @model_validator(mode='after')
    def consistent(self):
        from app.living.store import _uuid
        _uuid(self.request_id)
        if (self.action == 'atmosphere') != (self.weather is not None):
            raise ValueError('weather mismatch')
        if (self.action not in ('atmosphere', 'undo', 'layout')) != (self.target_kind is not None):
            raise ValueError('target mismatch')
        if self.target_item_id is not None:
            _uuid(self.target_item_id)
            if self.target_kind is None:
                raise ValueError('item identity without target')
        return self


def record(conn, row, command, result, request_id):
    kind = command.get('kind') if command['action'] == 'place' else None
    item_id = None
    if command['action'] == 'place':
        previous_ids = LivingStore._state(row).items.keys()
        added = [item for item in result['items'] if item['id'] not in previous_ids]
        if len(added) != 1 or added[0]['kind'] != kind:
            raise LivingError('corrupt_state', '新物件无法核对，请保留数据并联系维护人员')
        item_id = added[0]['id']
    if command['action'] in ('move', 'care', 'store', 'restore', 'turn'):
        item_id = command['item_id']
        kind = LivingStore._state(row).items[item_id].kind
        targets = [item for item in result['items'] if item['id'] == item_id]
        if len(targets) != 1 or targets[0]['kind'] != kind:
            raise LivingError('corrupt_state', '原物件无法核对，请保留数据并联系维护人员')
    event = ActivityEvent(revision=result['revision'], request_id=request_id,
                          created_at=result['observed_at'], source='user',
                          action=command['action'], target_kind=kind, target_item_id=item_id,
                          weather=command.get('weather'))
    conn.execute(insert(events).values(space_id=row['id'], revision=event.revision,
                                      request_id=request_id, event_json=event.model_dump_json()))


CATEGORY_ACTIONS = {
    'care': ('care',),
    'layout': ('place', 'move', 'store', 'restore', 'undo', 'turn', 'layout'),
    'atmosphere': ('atmosphere',),
}


def read(conn, owner_id, space_id, before_revision=None, category='all'):
    row = LivingStore._row(conn, owner_id, space_id)
    if row['mode'] != 'private':
        raise LivingError('invalid_action', '当前生活记录仅适用于私人空间')
    query = select(events).where(events.c.space_id == space_id)
    if category != 'all':
        if category not in CATEGORY_ACTIONS:
            raise LivingError('invalid_request', '请选择有效的生活记录分类')
        query = query.where(func.json_extract(events.c.event_json, '$.action').in_(CATEGORY_ACTIONS[category]))
    if before_revision is not None:
        query = query.where(events.c.revision < before_revision)
    rows = conn.execute(query.order_by(events.c.revision.desc()).limit(21)).mappings().all()
    result = [validated_event(saved).model_dump() for saved in rows[:20]]
    return {'space_id': space_id, 'category': category, 'events': result,
            'next_before_revision': result[-1]['revision'] if len(rows) > 20 else None}


def validated_event(saved):
    try:
        item = ActivityEvent.model_validate_json(saved['event_json'])
        if item.revision != saved['revision'] or item.request_id != saved['request_id']:
            raise ValueError('event identity mismatch')
        return item
    except (ValidationError, ValueError, TypeError, LivingError):
        raise LivingError('corrupt_state', '生活记录无法读取，请保留数据并联系维护人员') from None


def recent_for_spaces(conn, owned_private_space_ids):
    """Caller supplies only verified current private residences; one read query."""
    if not owned_private_space_ids:
        return {}
    ranked = select(events, func.row_number().over(
        partition_by=events.c.space_id, order_by=events.c.revision.desc()
    ).label('position')).where(events.c.space_id.in_(owned_private_space_ids)).subquery()
    rows = conn.execute(select(ranked).where(ranked.c.position <= 3).order_by(
        ranked.c.space_id, ranked.c.revision.desc()
    )).mappings()
    result = {}
    for saved in rows:
        result.setdefault(saved['space_id'], []).append(validated_event(saved))
    return result


def event_text(item: ActivityEvent) -> str:
    """Only fixed labels from a validated event, never a model or user narrative."""
    if item.action == 'atmosphere':
        return {'rain': '开启了小雨', 'clear': '让庭院放晴', 'quiet': '让庭院安静下来'}[item.weather]
    actions = {'turn': '转向了', 'layout': '换了一套绿洲布置', 'place': '放置了', 'move': '移动了', 'care': '照料了',
               'store': '收纳了', 'restore': '摆出了', 'undo': '撤销了上一步布置'}
    kinds = {'palm': '棕榈树', 'cactus': '仙人掌', 'rock': '石头', 'tea_table': '茶桌', 'tent': '帐篷', 'string_lights': '串灯', 'sign': '路牌', 'flowerpot': '花盆', 'tree': '小树', 'bench': '长椅', 'shade': '遮阴处', 'cushion': '坐垫',
             'flower': '花丛', 'mushroom': '蘑菇', 'pond': '水池',
             'campfire': '营火', 'fireflies': '萤火虫'}
    return actions[item.action] + (kinds[item.target_kind] if item.target_kind else '')
