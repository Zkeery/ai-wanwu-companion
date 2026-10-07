"""Bounded stage metrics; never log prompts, photos, user text, URLs or errors."""
import json
import logging
from contextvars import ContextVar
from time import perf_counter


_operation_id: ContextVar[str | None] = ContextVar("generation_operation_id", default=None)


def current_operation_id() -> str | None:
    return _operation_id.get()


def record_timing(stage: str, operation_id: str, started: float, outcome: str) -> None:
    logging.getLogger("uvicorn.error").info("generation_timing %s", json.dumps({
        "stage": stage, "operation_id": operation_id,
        "elapsed_ms": round((perf_counter() - started) * 1000), "outcome": outcome,
    }))


def timed_call(stage, operation_id, function, *args, **kwargs):
    started = perf_counter()
    outcome = "failed"
    token = _operation_id.set(operation_id)
    try:
        value = function(*args, **kwargs)
        outcome = "succeeded"
        return value
    finally:
        try:
            record_timing(stage, operation_id, started, outcome)
        finally:
            _operation_id.reset(token)
