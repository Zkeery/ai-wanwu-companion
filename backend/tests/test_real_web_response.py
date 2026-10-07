import asyncio
import json

import pytest
from starlette.responses import StreamingResponse

from scripts.real_web_budget import Budget, REF
from scripts.real_web_response import protect


@pytest.mark.parametrize('chunks,paused',[
    ([b'event: er',b'ror\ndata: {"code":"failed"}\n\n'],True),
    ([b'event: delta\ndata: {"text":"event: error"}\n\n',b'event: done\ndata: {}\n\n'],False)])
def test_sse_protocol_error_stops_but_reply_text_does_not(tmp_path,chunks,paused):
    ledger=Budget(tmp_path,'https://example.test/v1')
    (tmp_path/'authorization.json').write_text(json.dumps(dict(authorization_ref=REF,budget_cny=5,
        requests_max=12,automatic_retries=0,confirmed=True,user_reply='synthetic',
        target_root=str(tmp_path.resolve()),endpoint=ledger.endpoint)))
    call=ledger.claim('qwen3.8-flash');ledger.settle(call,'succeeded',200)
    async def stream():
        for chunk in chunks:yield chunk
    response=protect(StreamingResponse(stream(),media_type='text/event-stream'),ledger,0)
    async def consume():return b''.join([chunk async for chunk in response.body_iterator])
    assert asyncio.run(consume())==b''.join(chunks)
    assert ledger.status()['paused'] is paused


def test_json_business_failure_after_known_paid_reply_is_retained(tmp_path):
    ledger=Budget(tmp_path,'https://example.test/v1')
    (tmp_path/'authorization.json').write_text(json.dumps(dict(authorization_ref=REF,budget_cny=5,
        requests_max=12,automatic_retries=0,confirmed=True,user_reply='synthetic',
        target_root=str(tmp_path.resolve()),endpoint=ledger.endpoint)))
    call=ledger.claim('qwen3.8-flash');ledger.settle(call,'succeeded',200)
    async def stream():yield b'{"status":"failed"}'
    response=protect(StreamingResponse(stream(),media_type='application/json'),ledger,0)
    async def consume():return [chunk async for chunk in response.body_iterator]
    asyncio.run(consume())
    assert Budget(tmp_path,ledger.endpoint).status()['paused']
    assert ledger.status()['requests']==1 and ledger.status()['reserved_cny']==1.1456
