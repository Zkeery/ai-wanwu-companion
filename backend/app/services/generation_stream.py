"""Close synchronous generation explicitly when an SSE connection ends."""
from inspect import GEN_CREATED, getgeneratorstate

import anyio
from starlette.responses import StreamingResponse

from app.core.database import SessionLocal
from app.models.models import Character
from app.services import generation_quota as quota


class GenerationStreamResponse(StreamingResponse):
    def __init__(self, iterator, character_id: int, charge_id=None):
        self.generation_iterator = iterator
        self.character_id = character_id
        self.charge_id = charge_id
        super().__init__(iterator, media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
        })

    def finish(self):
        # StreamingResponse waits for its non-abandoned thread before returning.
        # Explicit close runs the generator's finally without depending on GC.
        never_started = getgeneratorstate(self.generation_iterator) == GEN_CREATED
        try:
            self.generation_iterator.close()
        finally:
            # close() does not enter a generator that has never been started.
            if never_started:
                with SessionLocal() as db:
                    character = db.get(Character, self.character_id)
                    if character is not None and character.status == "generating" and quota.is_reserved(db, self.charge_id, self.character_id):
                        character.status = "failed"
                    quota.settle(db, self.charge_id, success=False)
                    db.commit()

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await anyio.to_thread.run_sync(self.finish)
