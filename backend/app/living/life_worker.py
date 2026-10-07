"""Serial consumer of persisted, explicitly confirmed life execution requests."""
import asyncio
import logging
from collections.abc import Awaitable, Callable

from app.living.life_runtime import LifeRuntime
from app.living.rules import LivingError

logger = logging.getLogger(__name__)


async def consume_once(runtime: LifeRuntime, execute: Callable[[str, str, str], Awaitable[None]]):
    runtime.schedule_automatic()
    for spec in runtime.dispatched_tasks():
        owner, sid, tid = spec.owner_id, spec.space_id, spec.basis.plan_id
        try:
            await execute(owner, sid, tid)
        except asyncio.CancelledError:
            raise
        except Exception:
            # Do not log provider bodies, identities, credentials or raw exceptions.
            logger.warning('life_dispatch_execution_unavailable')
            try:
                task = runtime.claim(owner, sid, tid)
                if task.result is None:
                    runtime.fail_task(owner, sid, tid, task.token)
            except LivingError:
                # Another worker's live lease, pause, deletion, or unavailable storage.
                logger.warning('life_dispatch_recovery_deferred')


async def consume(runtime: LifeRuntime, execute: Callable[[str, str, str], Awaitable[None]]):
    while True:
        try:
            await consume_once(runtime, execute)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning('life_dispatch_scan_unavailable')
        await asyncio.sleep(2)
