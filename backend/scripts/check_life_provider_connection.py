"""Free, unauthenticated connectivity diagnosis; never calls a generation API."""
import asyncio
import json
import os
import time

import httpx

URL = 'https://maas-api.antdigital.com/v1/models'


async def probe(trust_env):
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(trust_env=trust_env, timeout=httpx.Timeout(5), follow_redirects=False) as client:
            async with client.stream('GET', URL) as response:
                return {'trust_env': trust_env, 'http_status': response.status_code,
                        'elapsed_ms': round((time.monotonic() - start) * 1000)}
    except httpx.HTTPError as exc:
        return {'trust_env': trust_env, 'error_type': type(exc).__name__,
                'elapsed_ms': round((time.monotonic() - start) * 1000)}


async def main():
    result = {'probe': 'unauthenticated GET /v1/models; no generation',
              'proxy_environment_present': any(os.environ.get(k) for k in
                  ('HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy')),
              'results': [await probe(False), await probe(True)]}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
