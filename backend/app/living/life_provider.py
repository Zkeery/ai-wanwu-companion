"""Fixed MaaS planning adapter for the separately authorized read-only pilot.

Deliberately exposes plan(), not C1.4's complete(): real results must not enter
the offline execution worker or be labelled offline_fixture.
"""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

import httpx

from app.living.life_planner import Prompt, parse_candidate
from app.living.rules import LivingError

MODEL = 'qwen3.8-flash'
BASE_URL = 'https://maas-api.antdigital.com/v1'
CATALOG_URL = 'https://maas.antdigital.com/api/v1/model-service/public/page-list'
INPUT_LIMIT = 1_000_000
OUTPUT_LIMIT = 128_000
REQUEST_OUTPUT = 512  # Requested, NOT assumed to be an enforced billing cap.
RESERVE_MICRO = 1_145_600
MAX_RESPONSE = 65_536


def error(code='provider_error'):
    return LivingError(code, '规划服务未返回可核对的完整结果，本轮停止')


def verify_catalog(payload: dict) -> dict:
    """Require current released catalog pricing no higher than our reservation."""
    try:
        if payload.get('success') is not True:
            raise ValueError()
        matches = [m for m in payload['data']['items'] if m['name'] == MODEL]
        if len(matches) != 1:
            raise ValueError()
        model = matches[0]
        if model['status'] != 'RELEASED' or model['offShelfFlag'] != 0 or model.get('offShelfDate'):
            raise ValueError()
        for key, cap in [('contextLength', INPUT_LIMIT), ('maxCompletionTokens', OUTPUT_LIMIT)]:
            value = model[key]
            if type(value) not in (str, int) or not str(value).isdigit() or not 0 < int(value) <= cap:
                raise ValueError()
        tiers = model['priceInfo']['prices']
        if not tiers:
            raise ValueError()
        for tier in tiers:
            if tier['priceCurrency'] != 'CNY':
                raise ValueError()
            for direction, cap in [('INPUT', Decimal('.8')), ('OUTPUT', Decimal('2.7'))]:
                prices = [p for p in tier['price'] if p['priceCode'] == direction]
                if len(prices) != 1 or prices[0]['unitCode'] != 'M_TOKENS':
                    raise ValueError()
                amount = Decimal(prices[0]['priceValue'])
                if not amount.is_finite() or not 0 <= amount <= cap:
                    raise ValueError()
        return {'model': MODEL, 'updated_at': model['updatedTime'], 'reserve_micro': RESERVE_MICRO}
    except (KeyError, TypeError, ValueError, InvalidOperation, OverflowError):
        raise error('pricing_unverified') from None


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def _constant(_):
    raise ValueError()


@dataclass(frozen=True)
class Reply:
    candidate: dict
    content: str
    model: str
    usage: dict | None
    estimated_micro: int | None


def decode_reply(body: bytes) -> Reply:
    try:
        if len(body) > MAX_RESPONSE:
            raise ValueError()
        data = json.loads(body, object_pairs_hook=_pairs, parse_constant=_constant)
        if data['model'] != MODEL or len(data['choices']) != 1:
            raise ValueError()
        choice = data['choices'][0]
        message = choice['message']
        if choice['finish_reason'] != 'stop' or message['role'] != 'assistant':
            raise ValueError()
        if message.get('tool_calls') or message.get('function_call') or message.get('refusal'):
            raise ValueError()
        content = message['content']
        candidate = parse_candidate(content)
        usage = data.get('usage')
        estimate = None
        if usage is not None:
            values = [usage[k] for k in ('prompt_tokens', 'completion_tokens', 'total_tokens')]
            if any(type(v) is not int or v < 0 for v in values):
                raise ValueError()
            prompt, output, total = values
            if prompt > INPUT_LIMIT or output > OUTPUT_LIMIT or total != prompt + output:
                raise ValueError()
            usage = dict(zip(('prompt_tokens', 'completion_tokens', 'total_tokens'), values))
            estimate = (prompt * 8 + output * 27 + 9) // 10
        return Reply(candidate, content, data['model'], usage, estimate)
    except (ValueError, TypeError, KeyError, IndexError, RecursionError, LivingError):
        raise error('invalid_response') from None


class MaaSPlannerAdapter:
    read_timeout = 12
    request_deadline = 15
    request_options: dict = {}

    def __init__(self, api_key: str, *, transport: httpx.AsyncBaseTransport | None = None):
        if not isinstance(api_key, str) or not api_key.strip():
            raise error('configuration_error')
        self._key = api_key
        self._transport = transport

    async def plan(self, prompt: Prompt) -> Reply:
        return await self._complete(prompt, decode_reply)

    async def _complete(self, prompt: Prompt, decode):
        if not isinstance(prompt, Prompt) or any(not isinstance(s, str) or not s.strip() or len(s.encode('utf8')) > 16384 for s in (prompt.system, prompt.user)):
            raise error('invalid_request')
        async def request():
            async with httpx.AsyncClient(transport=self._transport, timeout=httpx.Timeout(self.read_timeout, connect=5),
                                         follow_redirects=False, trust_env=False) as client:
                async with client.stream('POST', BASE_URL + '/chat/completions',
                    headers={'Authorization': 'Bearer ' + self._key},
                    json={**self.request_options, 'model': MODEL, 'stream': False, 'max_tokens': REQUEST_OUTPUT,
                          'messages': [{'role': 'system', 'content': prompt.system},
                                       {'role': 'user', 'content': prompt.user}]}) as response:
                    if response.status_code != 200:
                        raise error(f'provider_http_{response.status_code}')
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_RESPONSE:
                            raise error('invalid_response')
                    return decode(bytes(body))
        try:
            return await asyncio.wait_for(request(), timeout=self.request_deadline)
        except LivingError:
            raise
        except httpx.ConnectTimeout:
            raise error('provider_connect_timeout') from None
        except httpx.ReadTimeout:
            raise error('provider_read_timeout') from None
        except httpx.WriteTimeout:
            raise error('provider_write_timeout') from None
        except httpx.PoolTimeout:
            raise error('provider_pool_timeout') from None
        except httpx.ConnectError:
            raise error('provider_connect_error') from None
        except httpx.HTTPError:
            raise error('provider_transport_error') from None
        except TimeoutError:
            raise error('provider_deadline') from None
        except (ValueError, TypeError):
            raise error('invalid_response') from None


class MaaSLifePlannerAdapter(MaaSPlannerAdapter):
    """Bounded background life planning; no retry or extra output allowance."""
    read_timeout = 30
    request_deadline = 40
    request_options = {'enable_thinking': False}
