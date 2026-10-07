"""Local operator budget plans and atomic receipts. No HTTP or provider access."""
from __future__ import annotations

import hashlib
import json
import re
from typing import Literal

from pydantic import Field, ValidationError
from sqlalchemy import insert, inspect, select, update

from app.living.life_planning import FrozenModel
from app.living.life_runtime import LifeRuntime, Limit, MAX_MONEY, budget_changes, limits, mode_marker
from app.living.rules import LivingError
from app.living.store import _uuid


class Summary(FrozenModel):
    project_cap: int = Field(ge=0, le=MAX_MONEY)
    space_cap: int = Field(ge=0, le=MAX_MONEY)
    project_committed: int = Field(ge=0)
    space_committed: int = Field(ge=0)


class Plan(FrozenModel):
    action: Literal['set', 'freeze-space']
    space_id: str
    expected_state: str = Field(pattern=r'^[0-9a-f]{64}$')
    before: Summary
    after: Summary


def _digest(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def _require_real(runtime, conn):
    if runtime.origin != 'real_provider' or not inspect(conn).has_table(mode_marker.name):
        raise LivingError('invalid_action', '额度维护只支持已标记的真实运行库')
    origin = conn.execute(select(mode_marker.c.origin).where(mode_marker.c.name == 'runtime')).scalar_one_or_none()
    if origin != 'real_provider':
        raise LivingError('invalid_action', '额度维护只支持已标记的真实运行库')


def _plan(runtime, conn, owner, sid, action, project_cap, space_cap):
    _require_real(runtime, conn)
    runtime._scope(conn, owner, sid)
    before = Summary(project_cap=runtime._limit(conn, 'project'),
                     space_cap=runtime._limit(conn, 'space:' + sid),
                     project_committed=runtime._scope_cost(conn, 'project'),
                     space_committed=runtime._scope_cost(conn, 'space:' + sid))
    raw_limits = [list(row) for row in conn.execute(select(limits.c.scope, limits.c.payload).where(
        limits.c.scope.in_(('project', 'space:' + sid))).order_by(limits.c.scope))]
    if action == 'freeze-space':
        if project_cap is not None or space_cap is not None:
            raise LivingError('invalid_request', '关闭剩余额度不能同时指定新上限')
        project_cap, space_cap = before.project_cap, before.space_committed
    elif action != 'set':
        raise LivingError('invalid_request', '额度操作不正确')
    try:
        after = Summary(**{**before.model_dump(), 'project_cap': project_cap, 'space_cap': space_cap})
    except ValidationError:
        raise LivingError('invalid_request', '额度必须是范围内的非负金额') from None
    if after.project_cap < after.space_cap:
        raise LivingError('invalid_request', '空间累计上限不能高于项目累计上限')
    if after.project_cap < before.project_committed or after.space_cap < before.space_committed:
        raise LivingError('conflict', '额度不能低于已用及待确认费用')
    return Plan(action=action, space_id=sid,
                expected_state=_digest([owner, sid, raw_limits, before.model_dump(), action, after.model_dump()]),
                before=before, after=after)


def preview(runtime: LifeRuntime, owner: str, sid: str, action='set', project_cap=None, space_cap=None) -> Plan:
    # One SQLite read transaction provides a consistent proposal without a write lock.
    with runtime._connection() as conn:
        conn.exec_driver_sql('BEGIN')
        return _plan(runtime, conn, owner, sid, action, project_cap, space_cap)


def apply(runtime: LifeRuntime, owner: str, sid: str, *, request_id: str, authorization_ref: str,
          expected_state: str, action='set', project_cap=None, space_cap=None) -> tuple[Plan, bool]:
    _uuid(request_id)
    if (not isinstance(authorization_ref, str) or not re.fullmatch(r'[A-Za-z0-9_.:/-]{8,120}', authorization_ref)
            or not isinstance(expected_state, str) or not re.fullmatch(r'[0-9a-f]{64}', expected_state)):
        raise LivingError('invalid_request', '需提供本次授权编号与只读方案的状态摘要')
    digest = _digest([owner, sid, action, project_cap, space_cap, expected_state, authorization_ref])
    with runtime._connection(True) as conn:
        _require_real(runtime, conn)
        runtime._scope(conn, owner, sid)
        if not inspect(conn).has_table(budget_changes.name):
            raise LivingError('invalid_action', '运行库尚未更新，请先备份并更新服务后再保存额度')
        receipt = conn.execute(select(budget_changes).where(budget_changes.c.request_id == request_id)).mappings().first()
        if receipt:
            if receipt['digest'] != digest:
                raise LivingError('conflict', '同一请求不能改变额度方案或授权记录')
            try:
                return Plan.model_validate_json(receipt['result']), True
            except ValidationError:
                raise LivingError('corrupt_state', '额度变更回执无法核对') from None
        if conn.execute(select(budget_changes.c.request_id).where(
                budget_changes.c.authorization_ref == authorization_ref)).first():
            raise LivingError('conflict', '该授权记录已使用，请勿用新请求重复授权')
        plan = _plan(runtime, conn, owner, sid, action, project_cap, space_cap)
        if plan.expected_state != expected_state:
            raise LivingError('conflict', '预算或调用记录已变化，请重新核对方案')
        # The two caps and their receipt either all commit or all roll back.
        changes = [('space:' + sid, plan.after.space_cap)]
        if action == 'set':
            changes.insert(0, ('project', plan.after.project_cap))
        for scope, cap in changes:
            value = Limit(origin=runtime.origin, scope=scope, cap=cap, authorization_ref=authorization_ref)
            if conn.execute(select(limits.c.scope).where(limits.c.scope == scope)).first():
                conn.execute(update(limits).where(limits.c.scope == scope).values(payload=value.model_dump_json()))
            else:
                conn.execute(insert(limits).values(scope=scope, payload=value.model_dump_json()))
        conn.execute(insert(budget_changes).values(request_id=request_id, authorization_ref=authorization_ref,
                     digest=digest, result=plan.model_dump_json()))
        return plan, False
