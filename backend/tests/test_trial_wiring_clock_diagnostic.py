"""Deterministic reproduction of the old synthetic scene/voice clock mismatch."""
from uuid import uuid4

from app.core.database import SessionLocal, engine
from app.living.rules import LivingError
from app.living.store import LivingStore
from app.models.models import Character
from app.services import scene_bridge
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_trial_wiring import build
from tests.test_voice import wav


def test_old_frozen_voice_clock_precedes_new_scene_before_any_mock_post(tmp_path, ready_character_id, monkeypatch):
    service, gate, now, calls, _, _ = build(tmp_path, ready_character_id)
    frozen = int(now[0])
    scene = LivingStore(engine, clock=lambda: frozen + 2).create_space(
        UID, str(uuid4()), 'home', 'private', str(ready_character_id))
    with SessionLocal() as db:
        db.get(Character, ready_character_id).current_space_id = scene['id']
        db.commit()
    now[0] = frozen + 0.25
    errors = []
    original_snapshot = scene_bridge.snapshot

    def capture_fixed_code(*args, **kwargs):
        try:
            return original_snapshot(*args, **kwargs)
        except LivingError as error:
            errors.append(error.code)
            raise

    monkeypatch.setattr(scene_bridge, 'snapshot', capture_fixed_code)
    result = service.send(UID, ready_character_id, str(uuid4()), 'synthetic clock diagnostic', wav(), offline=False)
    assert errors == ['conflict']
    assert result['state'] == 'failed' and result['error'] == 'reply_unavailable'
    assert calls == []
    assert gate.summary()['attempts'] == 0 and gate.summary()['state'] == 'stopped'
    assert gate.daily.status()['used'] == 0
