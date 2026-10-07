from datetime import date
import hashlib
import json
import sqlite3
from types import SimpleNamespace

import pytest

from scripts import run_manan_motion as batch


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    root = tmp_path / '.runtime/batch'
    root.mkdir(parents=True)
    synthetic_source = tmp_path / 'synthetic.png'
    synthetic_source.write_bytes(b'synthetic-adopted-source')
    monkeypatch.setattr(batch.prepared, 'IMAGE_SHA256', batch.digest(synthetic_source))
    auth = tmp_path / 'authorization.json'
    source_review = tmp_path / 'adopted.json'
    source_review.write_text('{"status":"accepted"}')
    auth.write_text(json.dumps(dict(authorization_ref=batch.REF, character_id=9,
        source_sha256=batch.prepared.IMAGE_SHA256, activities=list(batch.ACTIVITIES), requests_max=3,
        budget_usd='0.30', reservation_per_request_usd='0.10', automatic_retries=0, fallback_models=0,
        model_allowlist=[batch.MODEL], user_reply='确认！', motion_adoption_authorized=False)))
    plan = dict(source_sha256=batch.prepared.IMAGE_SHA256, max_requests=3,
        source_review_sha256=batch.digest(source_review),
        activities=[dict(activity=a, request_id=a + '-synthetic',
                         prompt_sha256=hashlib.sha256(a.encode()).hexdigest()) for a in batch.ACTIVITIES])
    (root / 'state.json').write_text(json.dumps(plan))
    quota = tmp_path / 'quota.json'
    secret = 'synthetic-project-key-not-real'
    quota.write_text(json.dumps(dict(status='opened_for_approved_batch', authorization_ref=batch.REF,
        verified_on=date.today().isoformat(), price_verified_on=date.today().isoformat(),
        remaining_usd_approved='0.30', unlimited=False, model_allowlist=[batch.MODEL], fallback_models=0,
        platform_key_display_sha256=hashlib.sha256((secret[:7] + '****' + secret[-4:]).encode()).hexdigest())))
    monkeypatch.setattr(batch, 'ROOT', root)
    monkeypatch.setattr(batch, 'AUTH', auth)
    monkeypatch.setattr(batch, 'QUOTA', quota)
    monkeypatch.setattr(batch.prepared, 'REVIEW', source_review)
    monkeypatch.setattr(batch.prepared, 'approved_source', lambda: ('synthetic-owner', tmp_path / 'synthetic.png'))
    monkeypatch.setattr(batch, 'key', lambda: secret)
    assert batch.initialize()['requests'] == 0
    return root, auth, quota


def test_three_calls_reserve_exact_cap_and_refuse_fourth(ledger):
    for activity in batch.ACTIVITIES:
        batch.claim(activity)
        batch.settle(activity, 'succeeded', {'synthetic': True})
    state = batch.status()
    assert state['requests'] == state['succeeded'] == 3
    assert state['reserved_usd'] == '0.3'
    with pytest.raises(ValueError):
        batch.claim('rest')
    assert batch.status()['requests'] == 3


def test_unknown_blocks_remaining_even_after_process_reopen(ledger):
    batch.claim('rest')
    # No settlement: represents an interrupted process/unknown upstream outcome.
    with pytest.raises(ValueError):
        batch.claim('walk')
    assert batch.status()['unknown'] == 1
    assert batch.status()['reserved_usd'] == '0.1'


@pytest.mark.parametrize('activity', ['walk', 'observe', 'invalid'])
def test_wrong_order_never_reserves(ledger, activity):
    with pytest.raises(ValueError):
        batch.claim(activity)
    assert batch.status()['requests'] == 0


@pytest.mark.parametrize('field,value', [
    ('budget_usd', '0.31'), ('requests_max', 4), ('automatic_retries', 1),
    ('source_sha256', '0' * 64), ('motion_adoption_authorized', True),
])
def test_changed_authorization_blocks_existing_ledger(ledger, field, value):
    root, auth, _ = ledger
    changed = json.loads(auth.read_text())
    changed[field] = value
    auth.write_text(json.dumps(changed))
    with pytest.raises(ValueError):
        batch.claim('rest')
    with sqlite3.connect(root / 'guard.db') as db:
        assert db.execute('SELECT COUNT(*) FROM calls').fetchone()[0] == 0


@pytest.mark.parametrize('field,value', [
    ('verified_on', '2020-01-01'), ('price_verified_on', '2020-01-01'),
    ('unlimited', True), ('remaining_usd_approved', '0.08'),
    ('model_allowlist', ['another-model']), ('fallback_models', 1),
    ('platform_key_display_sha256', '0' * 64),
])
def test_unverified_quota_or_key_blocks_before_reservation(ledger, field, value):
    _, _, quota = ledger
    changed = json.loads(quota.read_text())
    changed[field] = value
    quota.write_text(json.dumps(changed))
    with pytest.raises(ValueError):
        batch.claim('rest')
    assert batch.status()['requests'] == 0


def test_plan_changes_block_existing_ledger(ledger):
    root, _, _ = ledger
    changed = json.loads((root / 'state.json').read_text())
    changed['activities'][0]['request_id'] = 'changed'
    (root / 'state.json').write_text(json.dumps(changed))
    with pytest.raises(ValueError):
        batch.claim('rest')


def test_missing_ledger_cannot_be_reinitialized(ledger):
    root, _, _ = ledger
    (root / 'guard.db').unlink()
    with pytest.raises(FileExistsError):
        batch.initialize()
    with pytest.raises(ValueError):
        batch.status()


@pytest.mark.parametrize('failure_at', [None, 'rest', 'walk', 'observe'])
def test_executor_serial_dispatch_and_unknown_stop(ledger, monkeypatch, failure_at):
    from app.services import motion_walk_aihubmix as upstream
    root, _, quota = ledger
    batch.save(root / 'run-state.json', dict(status='queued', quota_sha256=batch.digest(quota)))
    settings = SimpleNamespace(motion_generation_enabled=False)
    states = {a: 'queued' for a in batch.ACTIVITIES}
    sent, exports = [], []

    def generate(source, supplied_key, *, activity, on_task, **kwargs):
        assert settings.motion_generation_enabled
        sent.append(activity)
        on_task('synthetic-' + activity)
        if activity == failure_at:
            raise TimeoutError('synthetic unknown upstream outcome')
        return b'synthetic-candidate', {}

    def process_one(*, request_id, provider):
        activity = request_id.removesuffix('-synthetic')
        try:
            provider(root / 'synthetic.png', batch.key(),
                     expected_sha256=batch.prepared.IMAGE_SHA256,
                     **({'activity': activity} if activity != 'walk' else {}))
            states[activity] = 'needs_review'
        except Exception:
            states[activity] = 'unknown'

    generation = SimpleNamespace(process_one=process_one,
        status=lambda cid, owner, *, activity: dict(request_id=activity + '-synthetic', state=states[activity]))
    monkeypatch.setattr(batch, 'context', lambda: (settings, generation))
    monkeypatch.setattr(upstream, 'preflight', lambda *args, **kwargs: None)
    monkeypatch.setattr(upstream, 'generate', generate)
    monkeypatch.setattr(batch, 'export', lambda: exports.append(True))
    result = batch.run()
    count = 3 if failure_at is None else batch.ACTIVITIES.index(failure_at) + 1
    assert sent == list(batch.ACTIVITIES[:count])
    assert result['requests'] == count
    assert result['unknown'] == (failure_at is not None)
    assert result['status'] == ('needs_review' if failure_at is None else 'paused_failure')
    assert result['actual_bill_verified'] is False
    assert settings.motion_generation_enabled is False
    assert exports == [True]
    # Reopening the executor cannot retry either successful or unknown calls.
    with pytest.raises(ValueError):
        batch.run()
    assert len(sent) == count


def test_missing_platform_proof_prevents_dispatch(ledger, monkeypatch):
    root, _, quota = ledger
    batch.save(root / 'run-state.json', dict(status='queued', quota_sha256=batch.digest(quota)))
    quota.unlink()
    reached = []
    monkeypatch.setattr(batch, 'context', lambda: reached.append(True))
    with pytest.raises(FileNotFoundError):
        batch.run()
    assert reached == []
    assert batch.status()['requests'] == 0
