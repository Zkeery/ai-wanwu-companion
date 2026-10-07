import hashlib
import json
from datetime import date
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from scripts import run_manan_motion as batch
from tests.test_manan_motion_batch import ledger  # noqa: F401


@pytest.fixture
def stopped(ledger, monkeypatch):
    from app.core import database
    from app.models.models import Base, MotionGenerationRequest, MotionGenerationActivityRequest
    from app.services import motion_generation as generation
    from scripts import check_full_flow_recovery as recovery
    root, _, _ = ledger
    monkeypatch.setattr(recovery, 'PROJECT', root.parent.parent)
    data = root.parent / 'data'
    source = data / 'uploads/source.png'
    source.parent.mkdir(parents=True)
    source.write_bytes(b'synthetic-adopted-source')
    evidence = root.parent / 'evidence'
    evidence.mkdir()
    auth = dict(authorization_ref=batch.REF, continuation_ref=batch.CONTINUATION_REF,
        user_reply='好，那就用Chrome ，继续吧', confirmed_on=date.today().isoformat(),
        character_id=9, source_sha256=batch.prepared.IMAGE_SHA256, max_total_provider_requests=3,
        total_budget_usd='0.30', automatic_retries=0, original_budget_ledger_must_be_retained=True,
        original_failure_evidence_must_be_retained=True, motion_adoption_authorized=False)
    (evidence / '人工续跑确认.json').write_text(json.dumps(auth))
    engine = create_engine('sqlite:///' + str(data / 'check.db'))
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, autoflush=False)
    with factory() as db:
        for activity in batch.ACTIVITIES:
            ref = batch.REF + ':' + activity
            model = MotionGenerationRequest if activity == 'walk' else MotionGenerationActivityRequest
            db.add(model(id=activity + '-synthetic', character_id=9, owner_id='synthetic-owner',
                source_image_path='source.png', source_sha256=batch.prepared.IMAGE_SHA256,
                prompt_sha256=hashlib.sha256(activity.encode()).hexdigest(), approval_ref=ref,
                approval_sha256=hashlib.sha256(ref.encode()).hexdigest(),
                state='unknown' if activity == 'rest' else 'blocked',
                error_code='candidate_unavailable' if activity == 'rest' else 'batch_stopped',
                **({'activity': activity} if activity != 'walk' else {})))
        db.commit()
    job = hashlib.sha256((batch.REF + ':rest').encode()).hexdigest()
    directory = data / 'ledger/jobs' / job
    directory.mkdir(parents=True)
    (directory / 'source.image').write_bytes(source.read_bytes())
    record = data / 'ledger' / f'approval-{job}.json'
    record.write_text(json.dumps(dict(job_id=job, character_id=9, owner_id='synthetic-owner',
        activity='rest', source_sha256=batch.prepared.IMAGE_SHA256, state='unknown',
        error_code='candidate_unavailable', generation_requests=1)))
    batch.save(root / 'run-state.json', dict(status='paused_failure', error_type='ValueError'))
    monkeypatch.setattr(batch, 'DATA', data)
    monkeypatch.setattr(batch, 'EVIDENCE', evidence)
    monkeypatch.setattr(batch.prepared, 'approved_source', lambda: ('synthetic-owner', source))
    monkeypatch.setattr(database, 'SessionLocal', factory)
    monkeypatch.setattr(batch, 'context', lambda: (SimpleNamespace(), generation))
    yield root, data, evidence, record, factory, generation
    engine.dispose()


def test_manual_recovery_keeps_failure_and_budget_then_cannot_repeat(stopped):
    root, data, _, record, factory, gen = stopped
    old_record = record.read_bytes()
    old_budget = (root / 'guard.db').read_bytes()
    result = batch.resume()
    assert result['status'] == 'queued' and result['requests'] == 0
    assert (root / 'guard.db').read_bytes() == old_budget
    assert record.read_bytes() == old_record
    marker = json.loads((root / 'manual-resume.json').read_text())
    assert marker['original_run_state']['status'] == 'paused_failure'
    assert (root / 'before-manual-resume/manifest.json').is_file()
    with factory() as db:
        for activity in batch.ACTIVITIES:
            row = gen._by_id(db, activity + '-synthetic')
            assert row.state == 'queued' and row.error_code is None
            assert row.approval_ref == batch.CONTINUATION_REF + ':' + activity
    state = json.loads((root / 'run-state.json').read_text())
    item = json.loads((root / 'state.json').read_text())['activities'][0]
    assert batch.current_request(gen, 'synthetic-owner', item, state)['state'] == 'queued'
    with pytest.raises(ValueError):
        batch.resume()
    assert record.read_bytes() == old_record


@pytest.mark.parametrize('extra', [dict(provider_task_id='task-may-have-billed'),
    dict(usage={}), dict(candidate_sha256='0' * 64), dict(error_code='provider_call_unknown')])
def test_possible_upstream_attempt_cannot_resume(stopped, extra):
    root, _, _, record, factory, gen = stopped
    value = json.loads(record.read_text()); value.update(extra)
    record.write_text(json.dumps(value))
    with pytest.raises(ValueError):
        batch.resume()
    assert not (root / 'manual-resume.json').exists()
    with factory() as db:
        assert gen._by_id(db, 'rest-synthetic').state == 'unknown'
    assert batch.status()['requests'] == 0


def test_reserved_provider_attempt_cannot_resume(stopped):
    root, *_ = stopped
    batch.claim('rest')
    with pytest.raises(ValueError):
        batch.resume()
    assert batch.status()['requests'] == 1
    assert not (root / 'manual-resume.json').exists()


def test_missing_manual_confirmation_cannot_change_business_state(stopped):
    root, _, evidence, _, factory, gen = stopped
    (evidence / '人工续跑确认.json').unlink()
    with pytest.raises(FileNotFoundError):
        batch.resume()
    with factory() as db:
        assert gen._by_id(db, 'rest-synthetic').state == 'unknown'
    assert not (root / 'manual-resume.json').exists()
