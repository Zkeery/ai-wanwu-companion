"""Durable life execution kernel, available only through controlled preview.

Explicit initialization only. This module makes no provider calls or scene movement.
Real-provider mode uses a fresh, marked database and separate provenance.
"""
from __future__ import annotations

import hashlib
import json
import logging
from contextlib import contextmanager
from typing import Literal
from uuid import uuid4

from pydantic import Field, ValidationError, field_validator, model_validator
from sqlalchemy import Column, ForeignKey, Integer, MetaData, String, Table, Text, insert, select, text, update
from sqlalchemy.exc import SQLAlchemyError

from app.living import life_planning as planning
from app.living.rules import Identifier, LivingError
from app.living.store import LivingStore, _identity, _require_complete_saved_model, _uuid, spaces
from app.models.models import Character

metadata = MetaData()
mode_metadata = MetaData()
mode_marker = Table('life_runtime_mode', mode_metadata,
    Column('name', String, primary_key=True), Column('origin', String, nullable=False))
Origin = Literal['offline_fixture', 'real_provider']
permissions = Table('life_runtime_permissions', metadata,
    Column('space_id', String, ForeignKey(spaces.c.id), primary_key=True),
    Column('payload', Text, nullable=False))
settings_receipts = Table('life_runtime_setting_receipts', metadata,
    Column('space_id', String, ForeignKey(spaces.c.id), primary_key=True),
    Column('request_id', String, primary_key=True), Column('digest', String, nullable=False),
    Column('payload', Text, nullable=False))
tasks = Table('life_runtime_tasks', metadata,
    Column('id', String, primary_key=True), Column('space_id', String, ForeignKey(spaces.c.id), nullable=False),
    Column('created_at', Integer, nullable=False), Column('source', String, nullable=False),
    Column('day', String, nullable=False), Column('state', String, nullable=False),
    Column('token', String), Column('lease_until', Integer, nullable=False),
    Column('spec', Text, nullable=False), Column('result', Text))
events = Table('life_runtime_events', metadata,
    Column('task_id', String, ForeignKey(tasks.c.id), primary_key=True),
    Column('space_id', String, ForeignKey(spaces.c.id), nullable=False),
    Column('payload', Text, nullable=False))
dispatches = Table('life_runtime_dispatches', metadata,
    Column('task_id', String, ForeignKey(tasks.c.id), primary_key=True),
    Column('space_id', String, ForeignKey(spaces.c.id), nullable=False),
    Column('requested_at', Integer, nullable=False))
automatic = Table('life_runtime_automatic', metadata,
    Column('space_id', String, ForeignKey(spaces.c.id), primary_key=True),
    Column('enabled', Integer, nullable=False), Column('next_at', Integer, nullable=False),
    Column('payload', Text, nullable=False))
viewers = Table('life_runtime_viewers', metadata,
    Column('lease_id', String, primary_key=True),
    Column('space_id', String, ForeignKey(spaces.c.id), nullable=False),
    Column('automatic_revision', Integer, nullable=False),
    Column('expires_at', Integer, nullable=False), Column('closed', Integer, nullable=False))
automatic_tasks = Table('life_runtime_automatic_tasks', metadata,
    Column('task_id', String, ForeignKey(tasks.c.id), primary_key=True))
limits = Table('life_runtime_limits', metadata,
    Column('scope', String, primary_key=True), Column('payload', Text, nullable=False))
budget_changes = Table('life_runtime_budget_changes', metadata,
    Column('request_id', String, primary_key=True),
    Column('authorization_ref', String, nullable=False, unique=True),
    Column('digest', String, nullable=False), Column('result', Text, nullable=False))
calls = Table('life_runtime_calls', metadata,
    Column('id', String, primary_key=True), Column('task_id', String, ForeignKey(tasks.c.id), nullable=False),
    Column('space_id', String, ForeignKey(spaces.c.id), nullable=False),
    Column('payload', Text, nullable=False))

ActiveState = Literal['queued', 'running', 'done', 'cancelled', 'failed']
LEASE_SECONDS = 60
MAX_MONEY = 10**12  # integer micro-yuan; bounded well below SQLite integer overflow


class TaskSpec(planning.FrozenModel):
    schema_version: Literal[1] = 1
    origin: Origin = 'offline_fixture'
    owner_id: planning.Identity
    space_id: Identifier
    companion_id: planning.Identity
    source: Literal['viewing', 'offline']
    day: str = Field(pattern=r'^\d{4}-\d{2}-\d{2}$')
    basis: planning.PlanBasis


class StepEvent(planning.FrozenModel):
    schema_version: Literal[1] = 1
    origin: Origin = 'offline_fixture'
    effect: Literal['activity_state_changed'] = 'activity_state_changed'
    task_id: Identifier
    space_id: Identifier
    companion_id: planning.Identity
    location_epoch: planning.Revision
    activity: planning.Activity
    target_id: Identifier | None
    created_at: planning.Timestamp
    reason: str | None = Field(default=None, min_length=1, max_length=120)

    @field_validator('reason')
    @classmethod
    def plain_reason(cls, value):
        if value is not None and (not value.strip() or any(ord(c) < 32 for c in value)):
            raise ValueError('reason must be a short plain line')
        return value


STEP_ERROR_PATTERN = (r'^(invalid_action|invalid_request|conflict|not_found|worker_error|budget_exhausted|'
                      r'configuration_error|pricing_unverified|invalid_response|provider_error|'
                      r'provider_(http_[1-5][0-9]{2}|connect_timeout|read_timeout|write_timeout|pool_timeout|'
                      r'connect_error|transport_error|deadline))$')


class StepResult(planning.FrozenModel):
    task_id: Identifier
    state: Literal['done', 'cancelled', 'failed']
    candidate_digest: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')
    event: StepEvent | None = None
    error_code: str | None = Field(default=None, pattern=STEP_ERROR_PATTERN)

    @model_validator(mode='after')
    def consistent(self):
        if (self.state == 'done') != (self.event is not None) or (self.state == 'done') != (self.error_code is None):
            raise ValueError('invalid step result')
        if self.event and (self.event.task_id != self.task_id or self.candidate_digest is None):
            raise ValueError('invalid event identity')
        return self


class Task(planning.FrozenModel):
    spec: TaskSpec
    state: ActiveState
    token: Identifier | None
    lease_until: planning.Timestamp
    result: StepResult | None

    @model_validator(mode='after')
    def consistent(self):
        if (self.state == 'running') != (self.token is not None and self.lease_until > 0):
            raise ValueError('invalid lease')
        if self.state != 'running' and (self.token is not None or self.lease_until != 0):
            raise ValueError('unexpected lease')
        if (self.state in ('done', 'cancelled', 'failed')) != (self.result is not None):
            raise ValueError('invalid result state')
        if self.result and (self.result.task_id != self.spec.basis.plan_id or self.result.state != self.state):
            raise ValueError('result identity mismatch')
        if self.result and self.result.event and (
                self.result.event.space_id != self.spec.space_id or
                self.result.event.companion_id != self.spec.companion_id or
                self.result.event.origin != self.spec.origin):
            raise ValueError('event scope mismatch')
        return self


class Limit(planning.FrozenModel):
    origin: Origin = 'offline_fixture'
    scope: str
    cap: int = Field(ge=0, le=MAX_MONEY)
    authorization_ref: str = Field(min_length=1, max_length=120)


class Call(planning.FrozenModel):
    origin: Origin = 'offline_fixture'
    id: Identifier
    task_id: Identifier
    space_id: Identifier
    max_cost: int = Field(gt=0, le=MAX_MONEY)
    actual_cost: int | None = Field(default=None, ge=0, le=MAX_MONEY)
    outcome: Literal['reserved', 'unknown', 'succeeded', 'failed'] = 'reserved'

    @model_validator(mode='after')
    def consistent(self):
        if (self.outcome in ('succeeded', 'failed')) != (self.actual_cost is not None):
            raise ValueError('invalid accounting state')
        if self.actual_cost is not None and self.actual_cost > self.max_cost:
            raise ValueError('actual charge exceeds reservation')
        return self


class Ticket(planning.FrozenModel):
    call: Call
    dispatch_allowed: bool


class Budget(planning.FrozenModel):
    origin: Origin = 'offline_fixture'
    space_id: Identifier
    cap: int = Field(ge=0, le=MAX_MONEY)
    committed: int = Field(ge=0)


class PublicPermission(planning.FrozenModel):
    enabled: bool
    activities: tuple[planning.Activity, ...]
    revision: planning.Revision


class PublicTask(planning.FrozenModel):
    id: Identifier
    state: ActiveState
    created_at: planning.Timestamp
    retry_at: planning.Timestamp
    activity: planning.Activity | None
    target_id: Identifier | None
    error_code: str | None
    dispatch_requested: bool = False
    reason: str | None = Field(default=None, min_length=1, max_length=120)


class AutomaticPolicy(planning.FrozenModel):
    origin: Origin = 'offline_fixture'
    owner_id: planning.Identity
    companion_id: planning.Identity
    space_id: Identifier
    enabled: bool
    revision: int = Field(gt=0)
    next_at: planning.Timestamp
    request_id: Identifier | None
    request_digest: str | None


class AutomaticStatus(planning.FrozenModel):
    enabled: bool = False
    revision: planning.Revision = 0
    next_at: planning.Timestamp = 0
    today_count: int = Field(ge=0, le=2, default=0)
    daily_limit: Literal[2] = 2
    viewing_until: planning.Timestamp = 0
    budget_available: bool | None = None


class ViewingLease(planning.FrozenModel):
    lease_id: Identifier
    expires_at: planning.Timestamp


class CurrentActivity(planning.FrozenModel):
    task_id: Identifier
    activity: planning.Activity
    target_id: Identifier | None
    started_at: planning.Timestamp
    expires_at: planning.Timestamp
    source: Literal['viewing', 'offline']


class RuntimeSnapshot(planning.FrozenModel):
    origin: Origin = 'offline_fixture'
    space_id: Identifier
    companion_id: planning.Identity
    permission: PublicPermission
    present: bool
    observed_at: planning.Timestamp
    next_allowed_at: planning.Timestamp
    tasks: tuple[PublicTask, ...] = Field(max_length=20)
    automatic: AutomaticStatus | None = None
    current_activity: CurrentActivity | None = None


class RuntimeHistory(planning.FrozenModel):
    origin: Origin
    space_id: Identifier
    companion_id: planning.Identity
    observed_at: planning.Timestamp
    tasks: tuple[PublicTask, ...] = Field(max_length=20)
    next_before: str | None = None


def _history_cursor(value):
    if not isinstance(value, str) or len(value) > 60:
        raise LivingError('invalid_request', '活动记录页码不正确')
    parts = value.split(':')
    try:
        if len(parts) != 2 or str(int(parts[0])) != parts[0] or not 0 <= int(parts[0]) <= 253402300799:
            raise ValueError()
        return int(parts[0]), _uuid(parts[1])
    except (ValueError, TypeError):
        raise LivingError('invalid_request', '活动记录页码不正确') from None


def _saved(model, payload):
    try:
        if model in (StepEvent, StepResult):
            record = json.loads(payload)
            # Older completed tasks had no explanation field. Only this known
            # additive field is migrated at read time; all other fields remain strict.
            if isinstance(record, dict):
                event = record if model is StepEvent else record.get('event')
                if isinstance(event, dict):
                    event.setdefault('reason', None)
            value = model.model_validate(record)
        else:
            value = model.model_validate_json(payload)
        _require_complete_saved_model(value)
        return value
    except (ValidationError, ValueError, TypeError):
        raise LivingError('corrupt_state', '生活任务存档无法读取，请保留数据') from None


def _hash(payload):
    try:
        raw = json.dumps(payload, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        return hashlib.sha256(raw.encode()).hexdigest()
    except (TypeError, ValueError):
        raise LivingError('invalid_request', '请求结构不正确') from None


class LifeRuntime:
    def __init__(self, engine, clock, *, origin: Origin = 'offline_fixture'):
        if engine.dialect.name != 'sqlite':
            raise ValueError('C1.2 supports SQLite only')
        if origin not in ('offline_fixture', 'real_provider'):
            raise ValueError('Invalid life runtime origin')
        self.engine, self.clock = engine, clock
        self.origin = origin
        self.store = LivingStore(engine, clock=clock)

    def _now(self):
        now = self.clock()
        planning._local_time(now)
        return now

    def initialize(self):
        """Initialize preview tables; real mode rejects old data and records its origin."""
        try:
            with self.engine.connect() as conn:
                has_marker = conn.execute(text("SELECT 1 FROM sqlite_master WHERE type='table' AND name='life_runtime_mode'")).first() is not None
                if has_marker:
                    existing = conn.execute(text("SELECT origin FROM life_runtime_mode WHERE name='runtime'")).scalar_one_or_none()
                    if existing != self.origin:
                        raise LivingError('conflict', '生活运行库模式与当前服务不一致')
                elif self.origin == 'real_provider':
                    for table in metadata.tables.values():
                        exists = conn.execute(text("SELECT 1 FROM sqlite_master WHERE type='table' AND name=:name"),
                                              {'name': table.name}).first()
                        if exists and conn.execute(text('SELECT 1 FROM "' + table.name + '" LIMIT 1')).first():
                            raise LivingError('conflict', '已有离线生活记录，真实试用须使用全新隔离库')
            metadata.create_all(self.engine)
            if self.origin == 'real_provider' and not has_marker:
                mode_metadata.create_all(self.engine)
                with self.engine.begin() as conn:
                    conn.execute(insert(mode_marker).values(name='runtime', origin=self.origin))
        except SQLAlchemyError:
            raise LivingError('storage_unavailable', '生活任务存储暂时无法初始化') from None

    @contextmanager
    def _connection(self, write=False):
        try:
            with self.engine.connect() as conn:
                if write:
                    conn.execute(text('BEGIN IMMEDIATE'))
                try:
                    yield conn
                    if write:
                        conn.commit()
                except Exception:
                    conn.rollback()
                    raise
        except SQLAlchemyError:
            raise LivingError('storage_unavailable', '生活任务暂时无法保存或读取') from None

    def _scope(self, conn, owner, sid):
        _identity(owner)
        _uuid(sid)
        row = self.store._row(conn, owner, sid)
        if row['mode'] != 'private':
            raise LivingError('invalid_action', '本轮仅支持私人空间')
        cid = conn.execute(select(Character.id).where(Character.id == row['companion_id'],
                                                      Character.owner_id == owner)).scalar_one_or_none()
        if cid is None:
            raise LivingError('not_found', '伙伴不存在或无权访问')
        return str(cid)

    def _permission(self, conn, owner, sid, cid):
        payload = conn.execute(select(permissions.c.payload).where(permissions.c.space_id == sid)).scalar_one_or_none()
        if payload is None:
            return None
        value = _saved(planning.Permission, payload)
        if (value.owner_id, value.space_id, value.companion_id) != (owner, sid, cid):
            raise LivingError('corrupt_state', '生活授权归属不一致')
        return value

    def read_permission(self, owner, sid):
        with self._connection() as conn:
            return self._permission(conn, owner, sid, self._scope(conn, owner, sid))

    def save_permission(self, owner, sid, request_id, expected_revision, enabled, activities):
        _uuid(request_id)
        if type(expected_revision) is not int or expected_revision < 0:
            raise LivingError('invalid_request', '授权版本不正确')
        with self._connection(True) as conn:
            cid = self._scope(conn, owner, sid)
            try:
                desired = planning.Permission(owner_id=owner, space_id=sid, companion_id=cid,
                    revision=expected_revision + 1, enabled=enabled, activities=activities)
                if desired.enabled and not desired.activities:
                    raise ValueError()
            except (ValidationError, ValueError):
                raise LivingError('invalid_request', '请选择有效的活动授权') from None
            digest = _hash({'revision': expected_revision, 'settings': desired.model_dump(mode='json')})
            receipt = conn.execute(select(settings_receipts).where(settings_receipts.c.space_id == sid,
                                  settings_receipts.c.request_id == request_id)).mappings().first()
            if receipt:
                if receipt['digest'] != digest:
                    raise LivingError('conflict', '同一请求不能用于不同授权')
                value = _saved(planning.Permission, receipt['payload'])
                if value != desired:
                    raise LivingError('corrupt_state', '授权回执不一致')
                return value
            current = self._permission(conn, owner, sid, cid)
            if (current.revision if current else 0) != expected_revision:
                raise LivingError('conflict', '授权已更新，请刷新')
            if current:
                conn.execute(update(permissions).where(permissions.c.space_id == sid).values(payload=desired.model_dump_json()))
            else:
                conn.execute(insert(permissions).values(space_id=sid, payload=desired.model_dump_json()))
            auto = self._automatic(conn, owner, sid, cid)
            if auto and auto.enabled:
                self._write_automatic(conn, auto.model_copy(update={'enabled': False, 'next_at': 0,
                    'revision': auto.revision + 1, 'request_id': None, 'request_digest': None}))
            for row in conn.execute(select(tasks).where(tasks.c.space_id == sid,
                                     tasks.c.state.in_(['queued', 'running']))).mappings().all():
                task = self._decode_task(row, owner, sid, cid)
                self._finish(conn, task, 'cancelled', error_code='conflict')
            conn.execute(insert(settings_receipts).values(space_id=sid, request_id=request_id,
                         digest=digest, payload=desired.model_dump_json()))
            return desired

    def _decode_task(self, row, owner, sid, cid):
        spec = _saved(TaskSpec, row['spec'])
        result = _saved(StepResult, row['result']) if row['result'] is not None else None
        try:
            task = Task(spec=spec, state=row['state'], token=row['token'], lease_until=row['lease_until'], result=result)
            if spec.origin != self.origin:
                raise ValueError()
            if (row['id'], row['space_id'], row['created_at'], row['source'], row['day']) != (
                    spec.basis.plan_id, spec.space_id, spec.basis.observed_at, spec.source, spec.day):
                raise ValueError()
            if spec.basis.request_id != spec.basis.plan_id or (spec.owner_id, spec.space_id, spec.companion_id) != (owner, sid, cid):
                raise ValueError()
            if planning._local_time(spec.basis.observed_at).date().isoformat() != spec.day:
                raise ValueError()
            return task
        except (ValidationError, ValueError, LivingError):
            raise LivingError('corrupt_state', '生活任务身份或状态不一致') from None

    def _task(self, conn, owner, sid, tid, cid):
        _uuid(tid)
        row = conn.execute(select(tasks).where(tasks.c.id == tid, tasks.c.space_id == sid)).mappings().first()
        if row is None:
            raise LivingError('not_found', '生活任务不存在或无权访问')
        task = self._decode_task(row, owner, sid, cid)
        if task.state == 'done':
            event_row = conn.execute(select(events).where(events.c.task_id == tid)).mappings().first()
            if (event_row is None or event_row['space_id'] != sid or
                    _saved(StepEvent, event_row['payload']) != task.result.event):
                raise LivingError('corrupt_state', '执行回执缺少一致的活动事件')
        return task

    def read_task(self, owner, sid, tid):
        with self._connection() as conn:
            return self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))

    def pending_tasks(self, owner, sid):
        """Discover durable work after a process restart; never starts it by reading."""
        with self._connection() as conn:
            cid = self._scope(conn, owner, sid)
            history = [self._decode_task(row, owner, sid, cid) for row in conn.execute(
                select(tasks).where(tasks.c.space_id == sid).order_by(tasks.c.created_at)).mappings()]
            return [task for task in history if task.state in ('queued', 'running')]

    def request_dispatch(self, owner, sid, tid):
        """Persist the owner's execution request; never call a provider here."""
        with self._connection(True) as conn:
            task = self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            if task.result is not None:
                return
            existing = conn.execute(select(dispatches.c.space_id).where(dispatches.c.task_id == tid)).scalar_one_or_none()
            if existing is not None:
                if existing != sid:
                    raise LivingError('corrupt_state', '派发记录归属不一致')
                return
            try:
                self._fresh(conn, task, self._now())
            except LivingError as exc:
                if exc.code not in ('conflict', 'invalid_action', 'not_found'):
                    raise
                self._finish(conn, task, 'cancelled', error_code=exc.code)
                return
            conn.execute(insert(dispatches).values(task_id=tid, space_id=sid, requested_at=self._now()))

    def dispatched_tasks(self):
        """Only confirmed work is discoverable; scheduling alone is not consent."""
        with self._connection() as conn:
            now = self._now()
            rows = conn.execute(select(tasks).join(dispatches, dispatches.c.task_id == tasks.c.id).where(
                dispatches.c.space_id == tasks.c.space_id,
                (tasks.c.state == 'queued') | ((tasks.c.state == 'running') & (tasks.c.lease_until <= now))
            ).order_by(dispatches.c.requested_at, tasks.c.id).limit(20)).mappings().all()
            result = []
            for row in rows:
                spec = _saved(TaskSpec, row['spec'])
                result.append(self._decode_task(row, spec.owner_id, row['space_id'], spec.companion_id).spec)
            return result

    def schedule(self, owner, sid, request_id, source='viewing'):
        _uuid(request_id)
        if source not in ('viewing', 'offline'):
            raise LivingError('invalid_request', '任务来源不正确')
        with self._connection(True) as conn:
            return self._schedule(conn, owner, sid, request_id, source)

    def _schedule(self, conn, owner, sid, request_id, source):
        cid = self._scope(conn, owner, sid)
        existing = conn.execute(select(tasks).where(tasks.c.id == request_id)).mappings().first()
        if existing:
            if existing['space_id'] != sid:
                raise LivingError('conflict', '任务请求标识已使用')
            task = self._task(conn, owner, sid, request_id, cid)
            if task.spec.source != source:
                raise LivingError('conflict', '同一请求不能更改任务来源')
            return task
        now = self._now()
        facts = planning.read_facts(conn, owner, sid, now)
        permission = self._permission(conn, owner, sid, cid)
        basis = planning.make_basis(facts, permission, plan_id=request_id, request_id=request_id)
        day = planning._local_time(now).date().isoformat()
        history = [self._decode_task(row, owner, sid, cid) for row in conn.execute(
            select(tasks).where(tasks.c.space_id == sid)).mappings()]
        if history:
            last = max(history, key=lambda task: task.spec.basis.observed_at)
            if now < last.spec.basis.observed_at + 600:
                raise LivingError('conflict', '规划间隔不足10分钟')
        if any(task.state in ('queued', 'running') for task in history):
            raise LivingError('conflict', '已有待处理生活任务，请先恢复或结束')
        if source == 'offline' and sum(task.spec.source == 'offline' and task.spec.day == day
                                       for task in history) >= 2:
            raise LivingError('conflict', '今日离线任务次数已用完')
        spec = TaskSpec(origin=self.origin, owner_id=owner, space_id=sid, companion_id=cid,
                        source=source, day=day, basis=basis)
        conn.execute(insert(tasks).values(id=request_id, space_id=sid, created_at=now, source=source,
                     day=day, state='queued', token=None, lease_until=0, spec=spec.model_dump_json(), result=None))
        return self._task(conn, owner, sid, request_id, cid)

    def _automatic(self, conn, owner, sid, cid):
        row = conn.execute(select(automatic).where(automatic.c.space_id == sid)).mappings().first()
        if row is None:
            return None
        value = _saved(AutomaticPolicy, row['payload'])
        if (value.origin != self.origin
                or (value.owner_id, value.space_id, value.companion_id) != (owner, sid, cid)
                or row['enabled'] != int(value.enabled) or row['next_at'] != value.next_at
                or (not value.enabled and value.next_at != 0)):
            raise LivingError('corrupt_state', '自动体验设置不一致')
        return value

    def _write_automatic(self, conn, value):
        values = dict(enabled=int(value.enabled), next_at=value.next_at, payload=value.model_dump_json())
        if conn.execute(select(automatic.c.space_id).where(automatic.c.space_id == value.space_id)).first():
            conn.execute(update(automatic).where(automatic.c.space_id == value.space_id).values(**values))
        else:
            conn.execute(insert(automatic).values(space_id=value.space_id, **values))

    def _automatic_budget_available(self, conn, sid):
        if self.origin != 'real_provider':
            return None
        from app.living.life_provider import RESERVE_MICRO
        return all(self._scope_cost(conn, scope) + RESERVE_MICRO <= self._limit(conn, scope)
                   for scope in ('project', 'space:' + sid))

    def _automatic_status(self, conn, owner, sid, cid, now):
        value = self._automatic(conn, owner, sid, cid)
        day = planning._local_time(now).date().isoformat()
        count = len(conn.execute(select(tasks.c.id).where(tasks.c.space_id == sid,
            tasks.c.source == 'offline', tasks.c.day == day)).all())
        if count > 2:
            raise LivingError('corrupt_state', '自动体验次数不一致')
        return AutomaticStatus(enabled=value.enabled if value else False,
            revision=value.revision if value else 0, next_at=value.next_at if value else 0, today_count=count,
            viewing_until=self._viewing_until(conn, value, now),
            budget_available=self._automatic_budget_available(conn, sid))

    def _viewing_until(self, conn, policy, now):
        if not policy or not policy.enabled:
            return 0
        expirations = conn.execute(select(viewers.c.expires_at).where(
            viewers.c.space_id == policy.space_id, viewers.c.automatic_revision == policy.revision,
            viewers.c.closed == 0, viewers.c.expires_at > now)).scalars().all()
        if any(type(value) is not int or value > now + 75 for value in expirations):
            raise LivingError('corrupt_state', '观看状态无法核对')
        return max(expirations, default=0)

    def save_viewing(self, owner, sid, lease_id, expected_revision, enabled):
        _uuid(lease_id)
        if type(expected_revision) is not int or expected_revision < 0 or type(enabled) is not bool:
            raise LivingError('invalid_request', '观看设置不正确')
        with self._connection(True) as conn:
            cid = self._scope(conn, owner, sid)
            row = conn.execute(select(viewers).where(viewers.c.lease_id == lease_id)).mappings().first()
            if row and (row['space_id'] != sid or row['automatic_revision'] != expected_revision):
                raise LivingError('conflict', '观看请求已失效，请重新开启')
            now = self._now()
            if enabled:
                policy = self._automatic(conn, owner, sid, cid)
                if not policy or not policy.enabled or policy.revision != expected_revision or (row and row['closed']):
                    raise LivingError('conflict', '自动体验已变化，请重新开启观看')
                planning.make_basis(planning.read_facts(conn, owner, sid, now),
                    self._permission(conn, owner, sid, cid), plan_id=lease_id, request_id=lease_id)
                if self._automatic_budget_available(conn, sid) is False:
                    raise LivingError('budget_exhausted', '已授权预算不足，观看模式未开启或续期')
                # Wake a daily-capped space without bypassing the common task interval.
                last = conn.execute(select(tasks.c.created_at).where(tasks.c.space_id == sid)
                    .order_by(tasks.c.created_at.desc()).limit(1)).scalar_one_or_none()
                due = max(now, last + 600 if last is not None else now)
                if policy.next_at > due:
                    self._write_automatic(conn, policy.model_copy(update={'next_at': due}))
            values = dict(space_id=sid, automatic_revision=expected_revision,
                expires_at=now + 75 if enabled else 0, closed=int(not enabled))
            if row:
                conn.execute(update(viewers).where(viewers.c.lease_id == lease_id).values(**values))
            else:
                conn.execute(insert(viewers).values(lease_id=lease_id, **values))
            return ViewingLease(lease_id=lease_id, expires_at=values['expires_at'])

    def save_automatic(self, owner, sid, request_id, expected_revision, enabled):
        _uuid(request_id)
        if type(expected_revision) is not int or expected_revision < 0 or type(enabled) is not bool:
            raise LivingError('invalid_request', '自动体验设置不正确')
        with self._connection(True) as conn:
            cid = self._scope(conn, owner, sid)
            value = self._automatic(conn, owner, sid, cid)
            digest = _hash({'revision': expected_revision, 'enabled': enabled})
            if value and value.request_id == request_id:
                if value.request_digest != digest:
                    raise LivingError('conflict', '同一请求不能修改自动体验设置')
                return
            if (value.revision if value else 0) != expected_revision:
                raise LivingError('conflict', '自动体验已更新，请刷新')
            now = self._now()
            if enabled:
                planning.make_basis(planning.read_facts(conn, owner, sid, now),
                    self._permission(conn, owner, sid, cid), plan_id=request_id, request_id=request_id)
                if self._automatic_budget_available(conn, sid) is False:
                    raise LivingError('budget_exhausted', '已授权预算不足，无法开启自动安排')
            else:
                for row in conn.execute(select(tasks).where(tasks.c.space_id == sid,
                        ((tasks.c.source == 'offline') | tasks.c.id.in_(select(automatic_tasks.c.task_id))),
                        tasks.c.state.in_(['queued', 'running']))).mappings():
                    self._finish(conn, self._decode_task(row, owner, sid, cid), 'cancelled', error_code='conflict')
            self._write_automatic(conn, AutomaticPolicy(origin=self.origin, owner_id=owner, companion_id=cid, space_id=sid,
                enabled=enabled, revision=expected_revision + 1, next_at=now if enabled else 0,
                request_id=request_id, request_digest=digest))

    def schedule_automatic(self):
        """Opt-in only. Enqueue and dispatch atomically; never backfill missed days."""
        now = self._now()
        with self._connection() as conn:
            due = conn.execute(select(automatic.c.space_id).where(automatic.c.enabled == 1,
                automatic.c.next_at <= now).order_by(automatic.c.next_at, automatic.c.space_id).limit(20)).scalars().all()
        for sid in due:
            try:
                with self._connection(True) as conn:
                    row = conn.execute(select(automatic).where(automatic.c.space_id == sid)).mappings().first()
                    if not row or not row['enabled'] or row['next_at'] > now:
                        continue
                    policy = _saved(AutomaticPolicy, row['payload'])
                    cid = self._scope(conn, policy.owner_id, sid)
                    value = self._automatic(conn, policy.owner_id, sid, cid)
                    status = self._automatic_status(conn, policy.owner_id, sid, cid, now)
                    next_at = now + 60
                    viewing = status.viewing_until > now
                    if not viewing and status.today_count >= 2:
                        local = planning._local_time(now)
                        next_at = now + 86400 - (local.hour * 3600 + local.minute * 60 + local.second)
                    elif status.budget_available is not False:
                        tid = str(uuid4())
                        try:
                            self._schedule(conn, policy.owner_id, sid, tid, 'viewing' if viewing else 'offline')
                        except LivingError as exc:
                            if exc.code not in ('conflict', 'invalid_action', 'not_found'):
                                raise
                        else:
                            conn.execute(insert(dispatches).values(task_id=tid, space_id=sid, requested_at=now))
                            conn.execute(insert(automatic_tasks).values(task_id=tid))
                            next_at = now + 600
                    self._write_automatic(conn, value.model_copy(update={'next_at': next_at}))
            except LivingError:
                logging.getLogger(__name__).warning('life_automatic_scan_unavailable')

    def _fresh(self, conn, task, now):
        spec = task.spec
        facts = planning.read_facts(conn, spec.owner_id, spec.space_id, now)
        permission = self._permission(conn, spec.owner_id, spec.space_id, spec.companion_id)
        planning.check_basis(spec.basis, facts, permission)
        return facts, permission

    def planning_inputs(self, owner, sid, tid, token):
        """Read one current, authorized planning snapshot without exposing a writer."""
        with self._connection() as conn:
            conn.execute(text('BEGIN'))
            task = self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            now = self._now()
            self._lease(task, token, now)
            return self._fresh(conn, task, now)

    def _finish(self, conn, task, state, *, error_code=None, digest=None, event=None):
        result = StepResult(task_id=task.spec.basis.plan_id, state=state,
                            candidate_digest=digest, event=event, error_code=error_code)
        conn.execute(update(tasks).where(tasks.c.id == result.task_id).values(
            state=state, token=None, lease_until=0, result=result.model_dump_json()))
        return Task(spec=task.spec, state=state, token=None, lease_until=0, result=result)

    def claim(self, owner, sid, tid):
        with self._connection(True) as conn:
            task = self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            if task.result:
                return task
            now = self._now()
            if task.state == 'running' and now < task.lease_until:
                raise LivingError('conflict', '任务正在执行')
            try:
                self._fresh(conn, task, now)
            except LivingError as exc:
                if exc.code not in ('conflict', 'invalid_action', 'not_found'):
                    raise
                return self._finish(conn, task, 'cancelled', error_code=exc.code)
            token = str(uuid4())
            conn.execute(update(tasks).where(tasks.c.id == tid).values(
                state='running', token=token, lease_until=now + LEASE_SECONDS))
            return Task(spec=task.spec, state='running', token=token, lease_until=now + LEASE_SECONDS, result=None)

    def _lease(self, task, token, now):
        _uuid(token)
        if task.state != 'running' or token != task.token or now >= task.lease_until or now < task.lease_until - LEASE_SECONDS:
            raise LivingError('conflict', '任务租约已失效，请重新领取')

    def execute_step(self, owner, sid, tid, token, candidate):
        digest = _hash(candidate)
        with self._connection(True) as conn:
            task = self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            if task.result:
                if task.result.candidate_digest and task.result.candidate_digest != digest:
                    raise LivingError('conflict', '已结束任务不能更换结果')
                return task
            now = self._now()
            self._lease(task, token, now)
            try:
                facts, permission = self._fresh(conn, task, now)
            except LivingError as exc:
                if exc.code not in ('conflict', 'invalid_action', 'not_found'):
                    raise
                return self._finish(conn, task, 'cancelled', error_code=exc.code, digest=digest)
            try:
                review = planning.review_candidate(candidate, basis=task.spec.basis, facts=facts, permission=permission)
            except LivingError as exc:
                if exc.code not in ('invalid_request', 'invalid_action', 'conflict'):
                    raise
                return self._finish(conn, task, 'failed', error_code=exc.code, digest=digest)
            event = StepEvent(origin=self.origin, task_id=tid, space_id=sid, companion_id=facts.companion_id,
                              location_epoch=facts.location_epoch, activity=review.candidate.activity,
                              target_id=review.candidate.target_id, created_at=now,
                              reason=review.candidate.reason)
            conn.execute(insert(events).values(task_id=tid, space_id=sid, payload=event.model_dump_json()))
            return self._finish(conn, task, 'done', digest=digest, event=event)

    def fail_task(self, owner, sid, tid, token, error_code='worker_error'):
        with self._connection(True) as conn:
            task = self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            if task.result:
                return task
            self._lease(task, token, self._now())
            return self._finish(conn, task, 'failed', error_code=error_code)

    def _public_tasks(self, conn, owner, sid, cid, rows):
        values = [self._decode_task(row, owner, sid, cid) for row in rows]
        event_rows = {row['task_id']: row for row in conn.execute(select(events).where(
            events.c.task_id.in_([row['id'] for row in rows]))).mappings()} if rows else {}
        requested = set(conn.execute(select(dispatches.c.task_id).where(dispatches.c.space_id == sid, dispatches.c.task_id.in_([row['id'] for row in rows]))).scalars()) if rows else set()
        public = []
        for task in values:
            event = task.result.event if task.result else None
            saved = event_rows.get(task.spec.basis.plan_id)
            if event is not None:
                if saved is None or saved['space_id'] != sid or _saved(StepEvent, saved['payload']) != event:
                    raise LivingError('corrupt_state', '执行回执缺少一致的活动事件')
            elif saved is not None:
                raise LivingError('corrupt_state', '未完成任务包含异常事件')
            public.append(PublicTask(id=task.spec.basis.plan_id, state=task.state,
                created_at=task.spec.basis.observed_at, retry_at=task.lease_until,
                activity=event.activity if event else None, target_id=event.target_id if event else None,
                error_code=task.result.error_code if task.result else None,
                dispatch_requested=task.spec.basis.plan_id in requested,
                reason=event.reason if event else None))
        return tuple(public)

    def history(self, owner, sid, before=None):
        with self._connection() as conn:
            conn.execute(text('BEGIN'))
            cid = self._scope(conn, owner, sid)
            query = select(tasks).where(tasks.c.space_id == sid)
            if before is not None:
                stamp, tid = _history_cursor(before)
                query = query.where((tasks.c.created_at < stamp) | ((tasks.c.created_at == stamp) & (tasks.c.id < tid)))
            rows = conn.execute(query.order_by(tasks.c.created_at.desc(), tasks.c.id.desc()).limit(21)).mappings().all()
            page = rows[:20]
            public = self._public_tasks(conn, owner, sid, cid, page)
            cursor = f"{page[-1]['created_at']}:{page[-1]['id']}" if len(rows) > 20 else None
            return RuntimeHistory(origin=self.origin, space_id=sid, companion_id=cid,
                                  observed_at=self._now(), tasks=public, next_before=cursor)

    def _current_activity(self, conn, owner, sid, cid, facts, permission, rows, now):
        if (not rows or not permission or not permission.enabled or facts.current_space_id != sid
                or facts.companion_status != 'ready'):
            return None
        task = self._task(conn, owner, sid, rows[0]['id'], cid)
        event = task.result.event if task.result else None
        if (not event or task.state != 'done' or task.spec.basis.permission_revision != permission.revision
                or event.location_epoch != facts.location_epoch or not event.created_at <= now < event.created_at + 600
                or event.activity not in permission.activities):
            return None
        hour = planning._local_time(now).hour
        if (hour >= 22 or hour < 7) and event.activity != 'rest':
            return None
        if event.activity == 'observe' and not any(item.id == event.target_id for item in facts.items):
            return None
        return CurrentActivity(task_id=event.task_id, activity=event.activity, target_id=event.target_id,
            started_at=event.created_at, expires_at=event.created_at + 600, source=task.spec.source)

    def snapshot(self, owner, sid):
        """One SQLite read snapshot, with no worker token or internal plan data."""
        with self._connection() as conn:
            conn.execute(text('BEGIN'))
            now = self._now()
            cid = self._scope(conn, owner, sid)
            facts = planning.read_facts(conn, owner, sid, now)
            permission = self._permission(conn, owner, sid, cid)
            rows = conn.execute(select(tasks).where(tasks.c.space_id == sid)
                .order_by(tasks.c.created_at.desc(), tasks.c.id.desc()).limit(20)).mappings().all()
            public = self._public_tasks(conn, owner, sid, cid, rows)
            return RuntimeSnapshot(origin=self.origin, space_id=sid, companion_id=cid, present=facts.current_space_id == sid,
                permission=PublicPermission(enabled=permission.enabled if permission else False,
                    activities=permission.activities if permission else (), revision=permission.revision if permission else 0),
                observed_at=now, next_allowed_at=max(now, rows[0]['created_at'] + 600) if rows else now,
                tasks=tuple(public), automatic=self._automatic_status(conn, owner, sid, cid, now),
                current_activity=self._current_activity(conn, owner, sid, cid, facts, permission, rows, now))

    def run_fixture(self, owner, sid, tid):
        """Explicit preview action; candidate is chosen here, never by the browser."""
        if self.origin != 'offline_fixture':
            raise LivingError('invalid_action', '真实活动不能使用离线预设结果')
        task = self.claim(owner, sid, tid)
        if task.result is not None:
            return
        try:
            with self._connection() as conn:
                facts, permission = self._fresh(conn, task, self._now())
        except LivingError as exc:
            if exc.code not in ('invalid_action', 'conflict', 'not_found'):
                raise
            self.execute_step(owner, sid, tid, task.token, {'activity': 'rest', 'reason': '离线预设活动'})
            return
        hour = planning._local_time(facts.observed_at).hour
        candidate = None
        if hour >= 22 or hour < 7:
            if 'rest' in permission.activities:
                candidate = {'activity': 'rest', 'reason': '夜间安静休息的离线体验'}
        elif 'observe' in permission.activities and facts.items:
            candidate = {'activity': 'observe', 'target_id': facts.items[0].id, 'reason': '观察现有物件的离线体验'}
        else:
            for activity in ('walk', 'rest'):
                if activity in permission.activities:
                    candidate = {'activity': activity, 'reason': '根据已允许活动安排的离线体验'}
                    break
        if candidate is None:
            self.fail_task(owner, sid, tid, task.token, error_code='invalid_action')
        else:
            self.execute_step(owner, sid, tid, task.token, candidate)

    def read_events(self, owner, sid):
        with self._connection() as conn:
            cid = self._scope(conn, owner, sid)
            result = []
            for row in conn.execute(select(events).where(events.c.space_id == sid)).mappings():
                value = _saved(StepEvent, row['payload'])
                if (value.task_id, value.space_id, value.companion_id, value.origin) != (row['task_id'], sid, cid, self.origin):
                    raise LivingError('corrupt_state', '生活事件身份不一致')
                task = self._task(conn, owner, sid, value.task_id, cid)
                if task.result is None or task.result.event != value:
                    raise LivingError('corrupt_state', '生活事件与执行回执不一致')
                result.append(value)
            return sorted(result, key=lambda value: (value.created_at, value.task_id), reverse=True)

    def _call(self, row):
        value = _saved(Call, row['payload'])
        if (value.id, value.task_id, value.space_id, value.origin) != (
                row['id'], row['task_id'], row['space_id'], self.origin):
            raise LivingError('corrupt_state', '调用账目身份不一致')
        return value

    def _scope_cost(self, conn, scope):
        query = select(calls)
        if scope != 'project':
            query = query.where(calls.c.space_id == scope.removeprefix('space:'))
        records = [self._call(row) for row in conn.execute(query).mappings()]
        return sum(c.actual_cost if c.actual_cost is not None else c.max_cost for c in records)

    def _limit(self, conn, scope):
        row = conn.execute(select(limits).where(limits.c.scope == scope)).mappings().first()
        if row is None:
            return 0
        value = _saved(Limit, row['payload'])
        if value.scope != scope or value.origin != self.origin:
            raise LivingError('corrupt_state', '额度归属不一致')
        return value.cap

    def set_limit(self, scope, cap, authorization_ref):
        """Trusted isolated test/admin entry; never callable by models or browsers."""
        if not isinstance(scope, str) or (scope != 'project' and not scope.startswith('space:')):
            raise LivingError('invalid_request', '额度范围不正确')
        if scope != 'project':
            _uuid(scope.removeprefix('space:'))
        try:
            value = Limit(origin=self.origin, scope=scope, cap=cap, authorization_ref=authorization_ref)
            if not authorization_ref.strip():
                raise ValueError()
        except (ValueError, ValidationError):
            raise LivingError('invalid_request', '额度及授权记录不正确') from None
        with self._connection(True) as conn:
            if scope != 'project' and conn.execute(select(spaces.c.id).where(
                    spaces.c.id == scope.removeprefix('space:'))).first() is None:
                raise LivingError('not_found', '空间不存在')
            if cap < self._scope_cost(conn, scope):
                raise LivingError('conflict', '额度不能低于已用及待确认费用')
            if conn.execute(select(limits.c.scope).where(limits.c.scope == scope)).first():
                conn.execute(update(limits).where(limits.c.scope == scope).values(payload=value.model_dump_json()))
            else:
                conn.execute(insert(limits).values(scope=scope, payload=value.model_dump_json()))
            return value

    def reserve_call(self, owner, sid, tid, token, call_id, max_cost):
        _uuid(call_id)
        try:
            desired = Call(origin=self.origin, id=call_id, task_id=tid, space_id=sid, max_cost=max_cost)
        except ValidationError:
            raise LivingError('invalid_request', '调用费用上限不正确') from None
        with self._connection(True) as conn:
            task = self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            now = self._now()
            self._lease(task, token, now)
            self._fresh(conn, task, now)
            row = conn.execute(select(calls).where(calls.c.id == call_id)).mappings().first()
            if row:
                value = self._call(row)
                if (value.task_id, value.space_id, value.max_cost) != (tid, sid, max_cost):
                    raise LivingError('conflict', '同一调用标识不能更改用途或上限')
                return Ticket(call=value, dispatch_allowed=False)
            if len(conn.execute(select(calls.c.id).where(calls.c.task_id == tid).limit(2)).all()) >= 2:
                raise LivingError('invalid_action', '本轮模型请求次数已用完')
            for scope in ('project', 'space:' + sid):
                if self._scope_cost(conn, scope) + max_cost > self._limit(conn, scope):
                    raise LivingError('budget_exhausted' if self.origin == 'real_provider' else 'invalid_action',
                                      '自主生活预算不足')
            conn.execute(insert(calls).values(id=call_id, task_id=tid, space_id=sid, payload=desired.model_dump_json()))
            return Ticket(call=desired, dispatch_allowed=True)

    def settle_call(self, owner, sid, tid, call_id, actual_cost, outcome):
        _uuid(call_id)
        with self._connection(True) as conn:
            self._task(conn, owner, sid, tid, self._scope(conn, owner, sid))
            row = conn.execute(select(calls).where(calls.c.id == call_id, calls.c.task_id == tid,
                                                  calls.c.space_id == sid)).mappings().first()
            if row is None:
                raise LivingError('not_found', '调用账目不存在或无权访问')
            current = self._call(row)
            try:
                if outcome not in ('unknown', 'succeeded', 'failed'):
                    raise ValueError()
                desired = Call(**{**current.model_dump(), 'actual_cost': actual_cost, 'outcome': outcome})
            except (ValidationError, ValueError):
                raise LivingError('invalid_request', '实际费用或结算状态不正确') from None
            if current.actual_cost is not None and current != desired:
                raise LivingError('conflict', '已结算调用不能更改账目')
            conn.execute(update(calls).where(calls.c.id == call_id).values(payload=desired.model_dump_json()))
            return desired

    def read_budget(self, owner, sid):
        with self._connection() as conn:
            self._scope(conn, owner, sid)
            # Project-wide figures are intentionally not exposed through this owner view.
            scope = 'space:' + sid
            return Budget(origin=self.origin, space_id=sid, cap=self._limit(conn, scope), committed=self._scope_cost(conn, scope))
