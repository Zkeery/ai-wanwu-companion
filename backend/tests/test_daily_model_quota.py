import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import httpx
import pytest
from fastapi import HTTPException
from types import SimpleNamespace

from app.services.daily_model_quota import DailyModelQuota, DailyQuotaExceeded, install_httpx_quota


def test_api_exposes_daily_exhaustion_as_429_without_disabling_saved_data(tmp_path):
    from app.api.model_availability import model_availability, require_model_available
    quota = DailyModelQuota(tmp_path / 'quota.db', 1)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(daily_model_quota=quota)))
    assert model_availability(request)['model_available'] is True
    quota.reserve()
    assert model_availability(request)['model_available'] is False
    with pytest.raises(HTTPException) as caught:
        require_model_available(request, _user=None)
    assert caught.value.status_code == 429
    assert caught.value.detail['error']['code'] == 'daily_model_limit'


def test_parallel_attempts_never_exceed_daily_limit_and_restart_does_not_reset(tmp_path):
    path = tmp_path / 'quota.db'
    quota = DailyModelQuota(path, 5)

    def attempt(_):
        try:
            return quota.reserve()
        except DailyQuotaExceeded:
            return None

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(attempt, range(30)))
    assert len([x for x in results if x]) == 5
    assert quota.status()['used'] == 5
    restarted = DailyModelQuota(path, 5)
    assert restarted.status()['remaining'] == 0
    with pytest.raises(DailyQuotaExceeded):
        restarted.reserve()


def test_reset_is_at_shanghai_midnight_and_old_attempts_remain(tmp_path):
    now = [datetime(2026, 10, 15, 15, 59, 59, tzinfo=timezone.utc).timestamp()]
    quota = DailyModelQuota(tmp_path / 'quota.db', 1, clock=lambda: now[0])
    quota.reserve()
    assert quota.status()['day'] == '2026-10-15'
    now[0] += 1
    assert quota.status()['day'] == '2026-10-16'
    assert quota.status()['remaining'] == 1
    quota.reserve()
    with quota.connection() as db:
        assert db.execute('SELECT count(*) FROM model_attempts').fetchone()[0] == 2


def test_sync_stream_and_unknown_result_both_consume_one_attempt(tmp_path):
    quota = DailyModelQuota(tmp_path / 'quota.db', 2)
    sent = []

    def transport(request):
        sent.append(request.url.path)
        if request.url.path.endswith('/unknown'):
            raise httpx.ReadTimeout('unknown result')
        return httpx.Response(200, text='data: done\n\n')

    restore = install_httpx_quota(quota, ['https://model.example/v1'])
    try:
        with httpx.Client(transport=httpx.MockTransport(transport)) as client:
            client.get('https://model.example/v1/models')
            client.post('https://other.example/v1/unrelated')
            assert quota.status()['used'] == 0
            with client.stream('POST', 'https://model.example/v1/chat/completions') as response:
                assert response.read().startswith(b'data:')
            with pytest.raises(httpx.ReadTimeout):
                client.post('https://model.example/v1/unknown')
            with pytest.raises(DailyQuotaExceeded):
                client.post('https://model.example/v1/images/generations')
        assert sent.count('/v1/chat/completions') == 1
        assert '/v1/images/generations' not in sent
        assert DailyModelQuota(tmp_path / 'quota.db', 2).status()['used'] == 2
    finally:
        restore()


def test_async_client_is_also_counted_without_retries(tmp_path):
    quota = DailyModelQuota(tmp_path / 'quota.db', 1)
    sent = []

    async def transport(request):
        sent.append(request.url.path)
        return httpx.Response(200, json={'ok': True})

    restore = install_httpx_quota(quota, ['https://model.example/v1'])
    try:
        async def run():
            async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
                async with client.stream('POST', 'https://model.example/v1/images/generations') as response:
                    assert await response.aread() == b'{"ok":true}'
                with pytest.raises(DailyQuotaExceeded):
                    await client.post('https://model.example/v1/chat/completions')
        asyncio.run(run())
        assert sent == ['/v1/images/generations']
        assert quota.status()['remaining'] == 0
    finally:
        restore()
