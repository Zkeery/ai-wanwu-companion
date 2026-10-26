"""Persist each outbound model attempt before sending it; never refund unknown usage."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
import time
from typing import Callable
from urllib.parse import urlsplit
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx

DAILY_LIMIT_MESSAGE = '今天的 AI 调用次数已用完，明天再来吧。已有伙伴和聊天记录仍可查看。'
_trial_dispatch_quota = ContextVar('trial_dispatch_quota', default=None)


@contextmanager
def trial_dispatch_counts_once(quota):
    """Internal scope: only a TrialTransport-backed adapter may own counting."""
    token = _trial_dispatch_quota.set(quota)
    try:
        yield
    finally:
        _trial_dispatch_quota.reset(token)


class DailyQuotaExceeded(RuntimeError):
    pass


class DailyModelQuota:
    def __init__(self, path: Path, limit: int, *, clock: Callable[[], float] = time.time):
        if type(limit) is not int or not 1 <= limit <= 1000:
            raise ValueError('Daily model request limit must be between 1 and 1000')
        self.path, self.limit, self.clock = Path(path), limit, clock
        if not self.path.parent.is_dir() or self.path.is_symlink():
            raise ValueError('Quota directory must exist and the database must not be a symlink')
        with self.connection() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute('''CREATE TABLE IF NOT EXISTS model_attempts (
                id TEXT PRIMARY KEY, day TEXT NOT NULL, started_at REAL NOT NULL,
                outcome TEXT NOT NULL, http_status INTEGER, finished_at REAL)''')
            db.execute('CREATE INDEX IF NOT EXISTS model_attempt_day ON model_attempts(day)')

    def connection(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.execute('PRAGMA synchronous=FULL')
        return db

    def day(self) -> str:
        return datetime.fromtimestamp(self.clock(), timezone.utc).astimezone(ZoneInfo('Asia/Shanghai')).date().isoformat()

    def status(self) -> dict:
        day = self.day()
        with self.connection() as db:
            used = db.execute('SELECT count(*) FROM model_attempts WHERE day=?', (day,)).fetchone()[0]
        return {'day': day, 'timezone': 'Asia/Shanghai', 'limit': self.limit,
                'used': used, 'remaining': max(0, self.limit - used)}

    def reserve(self) -> str:
        day, attempt = self.day(), uuid4().hex
        with self.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            used = db.execute('SELECT count(*) FROM model_attempts WHERE day=?', (day,)).fetchone()[0]
            if used >= self.limit:
                raise DailyQuotaExceeded(DAILY_LIMIT_MESSAGE)
            db.execute('INSERT INTO model_attempts(id,day,started_at,outcome) VALUES (?,?,?,?)',
                       (attempt, day, self.clock(), 'in_flight'))
        return attempt

    def finish(self, attempt: str, status: int | None) -> None:
        with self.connection() as db:
            db.execute('UPDATE model_attempts SET outcome=?,http_status=?,finished_at=? WHERE id=?',
                       ('response_received' if status is not None else 'unknown_or_error',
                        status, self.clock(), attempt))


def install_httpx_quota(quota: DailyModelQuota, endpoints: list[str]):
    """Cover normal requests, streamed requests, pooled clients and async clients."""
    origins = set()
    for endpoint in endpoints:
        if not endpoint:
            continue
        url = urlsplit(endpoint)
        if url.scheme not in ('http', 'https') or not url.hostname or url.username or url.password:
            raise ValueError('Invalid model endpoint')
        origins.add((url.scheme, url.hostname.lower(), url.port or (443 if url.scheme == 'https' else 80), url.path.rstrip('/')))
    if not origins:
        raise ValueError('At least one configured model endpoint is required')

    def billable(request: httpx.Request) -> bool:
        if request.method != 'POST':
            return False
        url = request.url
        origin = (url.scheme, url.host.lower(), url.port or (443 if url.scheme == 'https' else 80))
        return any(origin == item[:3] and (url.path == item[3] or url.path.startswith(item[3] + '/'))
                   for item in origins)

    sync_send, async_send = httpx.Client.send, httpx.AsyncClient.send

    def send(client, request, *args, **kwargs):
        if not billable(request) or _trial_dispatch_quota.get() is quota:
            return sync_send(client, request, *args, **kwargs)
        attempt = quota.reserve()
        try:
            response = sync_send(client, request, *args, **kwargs)
        except Exception:
            quota.finish(attempt, None)
            raise
        quota.finish(attempt, response.status_code)
        return response

    async def send_async(client, request, *args, **kwargs):
        if not billable(request) or _trial_dispatch_quota.get() is quota:
            return await async_send(client, request, *args, **kwargs)
        attempt = quota.reserve()
        try:
            response = await async_send(client, request, *args, **kwargs)
        except Exception:
            quota.finish(attempt, None)
            raise
        quota.finish(attempt, response.status_code)
        return response

    httpx.Client.send, httpx.AsyncClient.send = send, send_async

    def restore():
        httpx.Client.send, httpx.AsyncClient.send = sync_send, async_send

    return restore
