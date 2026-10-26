"""Content-free, monotonic generation metrics with an optional append-only sink."""
import json
import logging
import os
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from threading import RLock
from time import perf_counter
from uuid import UUID

_operation_id: ContextVar[str | None] = ContextVar("generation_operation_id", default=None)
_sink = None
_sink_lock = RLock()


def configure_timing_log(filename: str = "") -> bool:
    """Explicit startup option; never depends on uvicorn's INFO configuration."""
    global _sink
    with _sink_lock:
        close_timing_log()
        if not filename:
            return False
        try:
            path = Path(filename).expanduser().resolve()
            path.parent.mkdir(parents=True, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            os.close(fd)
            path.chmod(0o600)
            _sink = logging.FileHandler(path, mode="a", encoding="utf-8")
            _sink.setFormatter(logging.Formatter("%(message)s"))
            return True
        except OSError:
            logging.getLogger(__name__).warning("generation_timing_file_unavailable")
            return False


def close_timing_log() -> None:
    global _sink
    with _sink_lock:
        if _sink is not None:
            _sink.close()
            _sink = None


def diagnostic_operation_id(trace: str | None, fallback: str) -> str:
    # Client input is only an anonymous correlation label, never authorization.
    try:
        if isinstance(trace, str) and len(trace) == 36:
            return "trace:" + str(UUID(trace))
    except (ValueError, AttributeError):
        pass
    return fallback


def current_operation_id() -> str | None:
    return _operation_id.get()


def record_timing(stage: str, operation_id: str, started: float, outcome: str) -> None:
    payload = json.dumps({"stage": stage, "operation_id": operation_id,
                          "elapsed_ms": round((perf_counter() - started) * 1000, 3), "outcome": outcome})
    logging.getLogger("uvicorn.error").info("generation_timing %s", payload)
    with _sink_lock:
        if _sink is not None:
            _sink.handle(logging.LogRecord("generation_timing", logging.INFO, "", 0, payload, (), None))


@contextmanager
def timing_span(stage: str, operation_id: str):
    started = perf_counter()
    outcome = "failed"
    token = _operation_id.set(operation_id)
    try:
        yield
        outcome = "succeeded"
    finally:
        try:
            record_timing(stage, operation_id, started, outcome)
        finally:
            _operation_id.reset(token)


def timed_call(stage, operation_id, function, *args, **kwargs):
    with timing_span(stage, operation_id):
        return function(*args, **kwargs)


def http_trace(stage: str, operation_id: str):
    """httpcore trace callback. Discard info (headers, URLs and errors) entirely.

    response_headers is the wait until headers complete, including provider and
    network time; it cannot isolate provider queue/compute or exact first byte.
    A reused connection has no connect_tcp/start_tls event, not a zero-time one.
    """
    names = {"connect_tcp": "connect_tcp", "start_tls": "tls",
             "send_request_headers": "request_headers", "send_request_body": "request_body",
             "receive_response_headers": "response_headers", "receive_response_body": "response_body"}
    starts = {}

    def trace(event, info):
        parts = event.rsplit(".", 2)
        if len(parts) != 3 or parts[1] not in names:
            return
        _, name, status = parts
        if status == "started":
            starts[name] = perf_counter()
        elif status in ("complete", "failed"):
            started = starts.pop(name, None)
            if started is not None:
                record_timing(stage + "." + names[name], operation_id, started,
                              "succeeded" if status == "complete" else "failed")
    return trace
