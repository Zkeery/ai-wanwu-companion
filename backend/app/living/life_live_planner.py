"""One explicitly requested real planning step in an isolated preview database.

The budget starts at zero. A retained reservation is never silently retried.
"""
from __future__ import annotations

import asyncio
import re
from dataclasses import replace
from typing import Awaitable, Callable

import httpx

from app.living.life_planner import call_id_for, make_prompt
from app.living.life_provider import CATALOG_URL, RESERVE_MICRO, MaaSPlannerAdapter, verify_catalog
from app.living.life_runtime import LifeRuntime, STEP_ERROR_PATTERN
from app.living.rules import LivingError


async def check_current_catalog() -> dict:
    try:
        async with httpx.AsyncClient(timeout=12, trust_env=False, follow_redirects=False) as client:
            response = await client.get(CATALOG_URL)
            response.raise_for_status()
            return verify_catalog(response.json())
    except (httpx.HTTPError, ValueError, TypeError):
        raise LivingError('pricing_unverified', '当前模型价格未核对，本轮没有调用模型') from None


def _fail(runtime: LifeRuntime, owner: str, sid: str, task, code: str = 'worker_error'):
    tid = task.spec.basis.plan_id
    try:
        return runtime.fail_task(owner, sid, tid, task.token, error_code=code)
    except LivingError as exc:
        if exc.code != 'conflict':
            raise
        return runtime.read_task(owner, sid, tid)


def safe_failure_code(exc):
    """Keep allowlisted codes, never exception messages or provider bodies."""
    if isinstance(exc, LivingError) and isinstance(exc.code, str) and re.fullmatch(STEP_ERROR_PATTERN, exc.code):
        return exc.code
    if isinstance(exc, TimeoutError):
        return 'provider_deadline'
    return 'worker_error'


async def run_real_planner(runtime: LifeRuntime, owner: str, sid: str, tid: str,
                           client_factory: Callable[[], MaaSPlannerAdapter],
                           catalog_check: Callable[[], Awaitable[dict]] = check_current_catalog):
    if runtime.origin != 'real_provider':
        raise LivingError('invalid_action', '真实规划不能写入离线体验库')
    task = runtime.claim(owner, sid, tid)
    if task.result is not None:
        return task
    try:
        facts, permission = runtime.planning_inputs(owner, sid, tid, task.token)
        prompt = replace(make_prompt(facts, permission), origin='real_provider')
        call_id = call_id_for(tid)
        ticket = runtime.reserve_call(owner, sid, tid, task.token, call_id, RESERVE_MICRO)
    except LivingError as exc:
        if exc.code not in ('invalid_action', 'invalid_request', 'conflict', 'not_found', 'budget_exhausted'):
            raise
        return _fail(runtime, owner, sid, task, exc.code)
    if not ticket.dispatch_allowed:
        return _fail(runtime, owner, sid, task)

    try:
        await catalog_check()
        runtime.planning_inputs(owner, sid, tid, task.token)
        client = client_factory()
    except asyncio.CancelledError:
        runtime.settle_call(owner, sid, tid, call_id, 0, 'failed')
        _fail(runtime, owner, sid, task)
        raise
    except Exception as exc:
        runtime.settle_call(owner, sid, tid, call_id, 0, 'failed')
        return _fail(runtime, owner, sid, task, safe_failure_code(exc))

    try:
        reply = await client.plan(prompt)
    except asyncio.CancelledError:
        runtime.settle_call(owner, sid, tid, call_id, None, 'unknown')
        _fail(runtime, owner, sid, task)
        raise
    except Exception as exc:
        runtime.settle_call(owner, sid, tid, call_id, None, 'unknown')
        return _fail(runtime, owner, sid, task, safe_failure_code(exc))

    # Usage is an estimate, not the supplier bill. Retain the full reservation.
    runtime.settle_call(owner, sid, tid, call_id, None, 'unknown')
    try:
        return runtime.execute_step(owner, sid, tid, task.token, reply.candidate)
    except LivingError as exc:
        if exc.code != 'conflict':
            raise
        return runtime.read_task(owner, sid, tid)
