"""Synthetic provider tests. No request here certifies model quality or billing."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from io import BytesIO
import json
from pathlib import Path
import subprocess
import sys
import threading
from unittest.mock import Mock

from PIL import Image, ImageDraw
import pytest

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterActivityMotionAsset, MotionPreparationTask, User
from app.services import character_walk_workflow as flow
from app.services.motion_atlas_provider import AtlasProviderError
from app.services.motion_bindings import MotionBindingError
from app.services.motion_preparation import process_one
from tests.auth_helpers import TEST_USER_ID


@pytest.fixture
def case(tmp_path, ready_character_id, monkeypatch):
    source = Path(get_settings().upload_dir) / 'workflow-source.png'
    source.parent.mkdir(parents=True, exist_ok=True)
    Image.new('RGB', (512, 512), 'salmon').save(source)
    with SessionLocal() as db:
        db.get(Character, ready_character_id).image_path = source.name
        db.commit()
    image = Image.new('RGBA', (1024, 1024))
    draw = ImageDraw.Draw(image)
    for y in (0, 512):
        for x in (0, 512):
            draw.ellipse((x+150, y+145, x+362, y+370), fill='salmon')
    encoded = BytesIO(); image.save(encoded, format='PNG'); raw = encoded.getvalue()
    def provider(path, key, *, expected_sha256, on_task):
        assert key == 'fake-test-key'
        assert flow._digest(path.read_bytes()) == expected_sha256
        on_task('t_test')
        return raw, {'input_tokens': 2, 'output_tokens': 3, 'secret': 'must-not-persist'}
    mock = Mock(side_effect=provider)
    key = Mock(return_value={'AIHUBMIX_API_KEY': 'fake-test-key'})
    monkeypatch.setattr(flow, 'dotenv_values', key)
    return {'cid': ready_character_id, 'source': source, 'raw': raw, 'root': tmp_path/'ledger',
            'provider': mock, 'key': key, 'digest': flow._digest(source.read_bytes())}


def create(case, **overrides):
    args = dict(expected_source_sha256=case['digest'], approval_ref='new-single-approval',
                price_verified_on=date.today().isoformat(), accept_metered_cost=True,
                root=case['root'], provider=case['provider'])
    args.update(overrides)
    return flow.generate_candidate(case['cid'], TEST_USER_ID, **args)


def accept(case, result, **overrides):
    args = dict(decision='accept', candidate_sha256=result['candidate_sha256'],
                review_ref='human-review-one', root=case['root'])
    args.update(overrides)
    return flow.review(result['job_id'], case['cid'], TEST_USER_ID, **args)


def record(case, result):
    return json.loads((case['root']/f"approval-{result['job_id']}.json").read_text())


def test_plan_has_no_key_disk_or_provider_side_effects(case):
    result = flow.plan(case['cid'], TEST_USER_ID)
    assert result['state'] == 'dry-run' and result['source_sha256'] == case['digest']
    assert not case['root'].exists()
    case['key'].assert_not_called(); case['provider'].assert_not_called()


@pytest.mark.parametrize('override', [dict(approval_ref=''), dict(price_verified_on='2000-01-01'),
    dict(accept_metered_cost=False), dict(expected_source_sha256='0'*64)])
def test_invalid_authorization_cannot_make_request(case, override):
    with pytest.raises(AtlasProviderError):
        create(case, **override)
    case['provider'].assert_not_called()
    assert not case['root'].exists()


def test_generate_requires_review_then_queues_only_walk_and_survives_restart(case):
    result = create(case)
    assert result['state'] == 'needs_review' and result['generation_requests'] == 1
    saved = record(case, result)
    assert saved['provider_task_id'] == 't_test'
    assert saved['usage'] == {'input_tokens': 2, 'output_tokens': 3}
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == db.query(MotionPreparationTask).count() == 0
    assert accept(case, result)['state'] == 'queued'
    code = "from app.core.database import SessionLocal\nfrom app.services.motion_preparation import process_one\nwith SessionLocal() as db:\n assert process_one(db)\n"
    restarted = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=20)
    assert restarted.returncode == 0, restarted.stderr.decode()
    assert flow.status(result['job_id'], case['cid'], TEST_USER_ID, root=case['root'])['state'] == 'ready'
    assert accept(case, result)['state'] == 'ready'
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == 1
        assert db.get(MotionPreparationTask, (case['cid'], 'rest')).state == 'waiting_source'
        assert db.get(MotionPreparationTask, (case['cid'], 'observe')).state == 'waiting_source'
        assert db.get(MotionPreparationTask, (case['cid'], 'walk')).attempts == 1
    case['provider'].assert_called_once()
    assert all(path.stat().st_mode & 0o077 == 0 for path in (case['root']/'jobs'/result['job_id']).iterdir())


def test_previous_approval_namespace_cannot_be_reused(case):
    case['root'].mkdir()
    path = case['root']/f"approval-{flow._digest(b'new-single-approval')}.json"
    path.write_text('{"state":"attempted"}')
    with pytest.raises(AtlasProviderError, match='approval_already_used'):
        create(case)
    case['provider'].assert_not_called()


def test_unknown_call_never_retries_and_error_text_is_not_saved(case):
    case['provider'].side_effect = RuntimeError('sensitive-provider-text')
    with pytest.raises(AtlasProviderError, match='candidate_unavailable'):
        create(case)
    with pytest.raises(AtlasProviderError, match='approval_already_used'):
        create(case)
    raw = next(case['root'].glob('approval-*.json')).read_text()
    assert 'sensitive-provider-text' not in raw
    saved = json.loads(raw)
    assert saved['state'] == 'unknown' and saved['generation_requests'] == 1
    with pytest.raises(AtlasProviderError):
        flow.recover_local(saved['job_id'], case['cid'], TEST_USER_ID, root=case['root'])
    case['provider'].assert_called_once()


def test_hard_interruption_keeps_attempted_and_does_not_resend(case):
    case['provider'].side_effect = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        create(case)
    assert json.loads(next(case['root'].glob('approval-*.json')).read_text())['state'] == 'attempted'
    with pytest.raises(AtlasProviderError, match='approval_already_used'):
        create(case)
    case['provider'].assert_called_once()


def test_recovers_only_existing_digest_matched_candidate_without_network(case, monkeypatch):
    finish = flow._finish_candidate
    monkeypatch.setattr(flow, '_finish_candidate', Mock(side_effect=OSError('disk transient')))
    with pytest.raises(AtlasProviderError):
        create(case)
    job = flow._digest(b'new-single-approval')
    monkeypatch.setattr(flow, '_finish_candidate', finish)
    result = flow.recover_local(job, case['cid'], TEST_USER_ID, root=case['root'])
    assert result['state'] == 'needs_review'
    case['provider'].assert_called_once()


@pytest.mark.parametrize('tamper', ['source', 'candidate', 'snapshot', 'owner'])
def test_review_rejects_changed_identity_or_bytes(case, tamper):
    result = create(case)
    if tamper == 'source':
        Image.new('RGB', (512, 512), 'blue').save(case['source'])
    elif tamper == 'candidate':
        Path(result['candidate']).write_bytes(b'changed')
    elif tamper == 'snapshot':
        Image.new('RGB', (512, 512), 'blue').save(Path(result['candidate']).with_name('source.image'), format='PNG')
    else:
        with SessionLocal() as db:
            db.add(User(id='someone-else', phone='13900000759'))
            db.flush()
            db.get(Character, case['cid']).owner_id = 'someone-else'
            db.commit()
    with pytest.raises((AtlasProviderError, MotionBindingError)):
        accept(case, result)
    with SessionLocal() as db:
        assert db.query(CharacterActivityMotionAsset).count() == db.query(MotionPreparationTask).count() == 0


def test_wrong_review_digest_and_explicit_rejection_never_enqueue(case):
    result = create(case)
    with pytest.raises(AtlasProviderError, match='candidate_changed'):
        accept(case, result, candidate_sha256='0'*64)
    assert accept(case, result, decision='reject')['state'] == 'rejected'
    assert accept(case, result, decision='reject')['state'] == 'rejected'
    with pytest.raises(AtlasProviderError, match='review_conflict'):
        accept(case, result)
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 0


def test_queue_commit_then_receipt_failure_is_idempotent_on_resume(case, monkeypatch):
    result = create(case)
    save = flow._save
    def fail_queue_receipt(root, value, **kwargs):
        if value['state'] == 'queued':
            raise OSError('receipt interrupted after db commit')
        save(root, value, **kwargs)
    monkeypatch.setattr(flow, '_save', fail_queue_receipt)
    with pytest.raises(OSError):
        accept(case, result)
    assert record(case, result)['state'] == 'reviewed'
    monkeypatch.setattr(flow, '_save', save)
    assert accept(case, result)['state'] == 'queued'
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).filter_by(activity='walk').count() == 1
        assert process_one(db)
    assert accept(case, result)['state'] == 'ready'
    case['provider'].assert_called_once()


def test_concurrent_same_approval_calls_provider_once(case):
    entered, release = threading.Event(), threading.Event()
    original = case['provider'].side_effect
    def slow(*args, **kwargs):
        entered.set(); assert release.wait(5)
        return original(*args, **kwargs)
    case['provider'].side_effect = slow
    with ThreadPoolExecutor(2) as pool:
        first = pool.submit(create, case)
        assert entered.wait(5)
        try:
            with pytest.raises(AtlasProviderError, match='approval_already_used'):
                create(case)
        finally:
            release.set()
        assert first.result()['state'] == 'needs_review'
    case['provider'].assert_called_once()


def test_review_lock_rejects_concurrent_writer(case):
    result = create(case)
    with flow._lock(case['root'], result['job_id']):
        with pytest.raises(AtlasProviderError, match='job_busy'):
            accept(case, result)
    assert record(case, result)['state'] == 'needs_review'


def test_import_receipt_preserves_provenance_and_needs_separate_review(case, tmp_path):
    candidate = tmp_path/'candidate.png'; candidate.write_bytes(case['raw'])
    receipt = tmp_path/'receipt.json'
    receipt.write_text(json.dumps({'provider': 'aihubmix', 'model': flow.MODEL, 'provider_task_id': 't_archived',
        'source_sha256': case['digest'], 'state': 'needs_review', 'image_sha256': flow._digest(case['raw'])}))
    result = flow.import_candidate(case['cid'], TEST_USER_ID, receipt, candidate, root=case['root'])
    assert result['state'] == 'needs_review' and result['origin'] == 'archived_receipt'
    assert result['generation_requests'] == 0
    assert flow.import_candidate(case['cid'], TEST_USER_ID, receipt, candidate, root=case['root']) == result
    assert accept(case, result)['state'] == 'queued'
    case['key'].assert_not_called(); case['provider'].assert_not_called()
    receipt.write_text(receipt.read_text().replace(case['digest'], '0'*64))
    with pytest.raises(AtlasProviderError, match='receipt_invalid'):
        flow.import_candidate(case['cid'], TEST_USER_ID, receipt, candidate, root=case['root'])


def test_foreign_owner_and_unsafe_job_path_are_not_readable(case):
    result = create(case)
    with pytest.raises(MotionBindingError):
        flow.status(result['job_id'], case['cid'], 'foreign', root=case['root'])
    with pytest.raises(AtlasProviderError, match='job_invalid'):
        flow.status('../elsewhere', case['cid'], TEST_USER_ID, root=case['root'])


def test_source_changed_during_generation_keeps_candidate_but_blocks_delivery(case):
    provider = case['provider'].side_effect
    def change(*args, **kwargs):
        output = provider(*args, **kwargs)
        Image.new('RGB', (512, 512), 'blue').save(case['source'])
        return output
    case['provider'].side_effect = change
    with pytest.raises(AtlasProviderError, match='source_changed'):
        create(case)
    saved = json.loads(next(case['root'].glob('approval-*.json')).read_text())
    assert saved['state'] == 'unknown' and saved['candidate_sha256'] == flow._digest(case['raw'])
    assert (case['root']/'jobs'/saved['job_id']/'candidate.png').is_file()
    with pytest.raises(AtlasProviderError, match='source_changed'):
        flow.recover_local(saved['job_id'], case['cid'], TEST_USER_ID, root=case['root'])


def test_nontransparent_candidate_is_not_human_reviewable(case):
    image = BytesIO(); Image.new('RGB', (1024, 1024), 'white').save(image, format='PNG')
    case['provider'].side_effect = lambda *args, **kwargs: (image.getvalue(), {})
    result = create(case)
    assert result['state'] == 'rejected'
    with pytest.raises(AtlasProviderError, match='candidate_not_reviewable'):
        accept(case, result)
    with SessionLocal() as db:
        assert db.query(MotionPreparationTask).count() == 0


def test_task_receipt_survives_provider_download_error_without_raw_error_code(case):
    def fail(*args, on_task, **kwargs):
        on_task('t_saved_before_download')
        raise AtlasProviderError('private value with spaces and /paths')
    case['provider'].side_effect = fail
    with pytest.raises(AtlasProviderError, match='candidate_unavailable'):
        create(case)
    saved = json.loads(next(case['root'].glob('approval-*.json')).read_text())
    assert saved['provider_task_id'] == 't_saved_before_download'
    assert saved['state'] == 'unknown'
    assert 'private value' not in json.dumps(saved)
