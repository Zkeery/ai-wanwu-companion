"""Synthetic snapshots only: never read production data or model credentials."""
import fcntl
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('ecs_backup_once', SCRIPTS / 'ecs_backup_once.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
ENGINE = SCRIPTS / 'ecs_verified_snapshot.py'
SHA = hashlib.sha256(ENGINE.read_bytes()).hexdigest()


@pytest.fixture
def root(tmp_path):
    root = tmp_path / 'ecs-fixture'
    for rel in ['data/private-invites', 'runtime/motion-video-batch-20261016',
                'runtime/paid-flow-acceptance-20261016', 'runtime/c155-aihubmix-walk',
                'app/backend/app', 'app/backend/scripts', 'app/frontend', 'backups']:
        (root / rel).mkdir(parents=True, mode=0o700)
    for rel in ['data/app.db', 'data/daily-model-requests.db',
                'runtime/motion-video-batch-20261016/ledger.db',
                'runtime/paid-flow-acceptance-20261016/ledger.db',
                'runtime/c155-aihubmix-walk/ledger.db']:
        with sqlite3.connect(root / rel) as db:
            db.execute('create table state (used integer, available integer, enabled integer)')
            db.execute('insert into state values (19, 0, 0)')
    (root / 'data/private-invites/fixture.json').write_text('{"code":"synthetic-invite"}')
    (root / 'app/backend/.env').write_text('TEST_SECRET=must-not-be-in-backup')
    (root / 'app/backend/app/main.py').write_text('# fixture only')
    (root / 'app/frontend/index.txt').write_text('fixture frontend')
    return root


def test_real_capture_restore_preserves_all_five_databases_and_excludes_env(root):
    result = backup.run(root, ENGINE, SHA)
    assert result['state'] == 'verified' and result['databases'] == 5
    target = root / 'backups/scheduled' / result['run_id']
    restored = target / 'restore-check'
    assert not (restored / 'app/backend/.env').exists()
    assert json.loads((restored / 'data/private-invites/fixture.json').read_text())['code'] == 'synthetic-invite'
    for rel in ['data/app.db', 'data/daily-model-requests.db',
                'runtime/motion-video-batch-20261016/ledger.db',
                'runtime/paid-flow-acceptance-20261016/ledger.db',
                'runtime/c155-aihubmix-walk/ledger.db']:
        with sqlite3.connect(restored / rel) as db:
            assert db.execute('select * from state').fetchall() == [(19, 0, 0)]
    assert (target / 'snapshot.tar').stat().st_mode & 0o777 == 0o600
    assert (target / 'scheduled-result.json').stat().st_mode & 0o777 == 0o600
    assert result['automatic_retries'] == 0 and result['offsite_copy'] is False


def test_second_run_keeps_previous_archive(root):
    first = backup.run(root, ENGINE, SHA)
    archive = root / 'backups/scheduled' / first['run_id'] / 'snapshot.tar'
    before = archive.read_bytes()
    second = backup.run(root, ENGINE, SHA)
    assert first['run_id'] != second['run_id'] and second['state'] == 'verified'
    assert archive.read_bytes() == before


def test_checksum_rejection_does_not_create_scheduled_directory(root):
    with pytest.raises(ValueError, match='engine_checksum'):
        backup.run(root, ENGINE, '0' * 64)
    assert not (root / 'backups/scheduled').exists()


def test_capacity_stops_without_deletion(root):
    first = backup.run(root, ENGINE, SHA, max_snapshots=1)
    second = backup.run(root, ENGINE, SHA, max_snapshots=1)
    assert second == {'state': 'blocked', 'reason': 'retention_review_required'}
    assert (root / 'backups/scheduled' / first['run_id'] / 'snapshot.tar').exists()


def test_failure_is_preserved_and_blocks_next_run(root):
    (root / 'data/unsupported-link').symlink_to(root / 'app/backend/app/main.py')
    first = backup.run(root, ENGINE, SHA)
    marker = root / 'backups/scheduled/review-required.json'
    evidence = marker.read_bytes()
    assert first['state'] == 'failed' and first['evidence_preserved']
    second = backup.run(root, ENGINE, SHA)
    assert second['reason'] == 'previous_failure_requires_review'
    assert marker.read_bytes() == evidence


def test_restore_failure_does_not_claim_verified(root, monkeypatch):
    engine = backup.load_engine(ENGINE, SHA)

    def fail(*args):
        raise ValueError('synthetic_restore_failure')

    engine.restore = fail
    monkeypatch.setattr(backup, 'load_engine', lambda *args: engine)
    result = backup.run(root, ENGINE, SHA)
    assert result['state'] == 'failed'
    assert (root / 'backups/scheduled' / result['run_id'] / 'snapshot.tar').exists()


def test_lock_blocks_overlapping_capture(root):
    scheduled = root / 'backups/scheduled'
    scheduled.mkdir(mode=0o700)
    with (scheduled / '.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert backup.run(root, ENGINE, SHA)['reason'] == 'backup_already_running'
    assert not list(scheduled.glob('run-*'))


def test_backup_symlink_is_rejected(root, tmp_path):
    (root / 'backups').rmdir()
    (root / 'backups').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError, match='unsafe_backup_directory'):
        backup.run(root, ENGINE, SHA)
