"""Stop the paid website batch on actual API/SSE business failure."""
import json
import re


def protect(response, budget, before_requests):
    source=response.body_iterator
    event_stream=response.headers.get('content-type','').startswith('text/event-stream')

    async def body():
        tail=b''
        collected=bytearray()
        async for chunk in source:
            raw=chunk.encode() if isinstance(chunk,str) else chunk
            if event_stream:
                combined=tail+raw
                if re.search(rb'(?:^|\r?\n)event:[ \t]*error\r?\n',combined):
                    budget.stop('business_failure')
                tail=combined[-128:]
            elif len(collected)+len(raw)<=65536:
                collected.extend(raw)
            yield chunk
        if not event_stream and collected:
            try:
                value=json.loads(collected)
            except (ValueError,TypeError):
                value=None
            if isinstance(value,dict) and (isinstance(value.get('error'),dict) or value.get('status')=='failed'):
                if budget.status()['requests']>before_requests:
                    budget.stop('business_failure')
        if response.status_code>=400 and budget.status()['requests']>before_requests:
            budget.stop('business_failure')

    response.body_iterator=body()
    return response
