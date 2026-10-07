"""An isolated backup must restore into a fresh directory without touching the source."""
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/check_full_flow_recovery.py'
sys.path.insert(0, str(SCRIPT.parent))
spec = importlib.util.spec_from_file_location('check_full_flow_recovery', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


@pytest.fixture
def snapshot(tmp_path, monkeypatch):
    project = tmp_path / 'project'
    runtime = project / '.runtime'
    source = runtime / 'preview'
    backup = runtime / 'snapshot'
    source.mkdir(parents=True)
    backup.mkdir()
    with sqlite3.connect(backup / 'preview.db') as db:
        db.execute('CREATE TABLE companions (id INTEGER PRIMARY KEY, name TEXT)')
        db.execute('INSERT INTO companions VALUES (1, ?)', ('小杯',))
    (backup / 'uploads').mkdir()
    (backup / 'uploads' / 'image.png').write_bytes(b'fixture image')
    manifest = {'tables': module.facts(backup / 'preview.db'), 'files': module.files(backup / 'uploads')}
    (backup / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
    monkeypatch.setattr(module, 'PROJECT', project)
    monkeypatch.setattr(module, 'STATE', source)
    monkeypatch.setattr(module, 'DESTINATION', backup)
    return runtime, backup, manifest


def test_restore_to_new_runtime_directory(snapshot):
    runtime, backup, manifest = snapshot
    target = runtime / 'restored'
    result = module.restore_test(target)
    assert result == {'restored': True, 'table_count': 1, 'file_count': 1}
    assert module.facts(target / 'preview.db') == manifest['tables']
    assert module.files(target / 'uploads') == manifest['files']
    assert module.facts(backup / 'preview.db') == manifest['tables']


def test_tampered_snapshot_cannot_create_restoration(snapshot):
    runtime, backup, _ = snapshot
    (backup / 'uploads' / 'image.png').write_bytes(b'changed')
    with pytest.raises(ValueError, match='manifest'):
        module.restore_test(runtime / 'restored')
    assert not (runtime / 'restored').exists()


def test_existing_or_outside_target_is_rejected(snapshot):
    runtime, backup, _ = snapshot
    existing = runtime / 'existing'
    existing.mkdir()
    with pytest.raises(FileExistsError):
        module.restore_test(existing)
    with pytest.raises(ValueError, match='runtime'):
        module.restore_test(runtime.parent / 'outside')
    with pytest.raises(ValueError):
        module.restore_test(backup)


def test_current_database_name_capture_restore_and_private_files(snapshot):
    runtime, original, _ = snapshot
    source = runtime / 'current'
    source.mkdir()
    import shutil
    shutil.copy2(original / 'preview.db', source / 'check.db')
    shutil.copytree(original / 'uploads', source / 'uploads')
    (source / '.env').write_text('SECRET=never-copy-me')
    destination = runtime / 'current-backup'
    options = dict(source=source, snapshot=destination, database_name='check.db')
    assert module.capture(**options)['backup_verified']
    assert set(p.name for p in destination.iterdir()) == {'check.db', 'uploads', 'manifest.json'}
    target = runtime / 'current-restored'
    assert module.restore_test(target, **options) == {'restored': True, 'table_count': 1, 'file_count': 1}
    assert module.snapshot_facts(source, 'check.db') == module.snapshot_facts(target, 'check.db')
    assert destination.stat().st_mode & 0o777 == 0o700
    for root in (destination, target):
        for file in root.rglob('*'):
            assert file.stat().st_mode & 0o777 == (0o700 if file.is_dir() else 0o600)
    with pytest.raises(FileExistsError):
        module.capture(**options)


@pytest.mark.parametrize('database_name', ['../secret.db', '/tmp/secret.db', 'a\\b.db', '.', ''])
def test_database_name_cannot_escape(snapshot, database_name):
    runtime, source, _ = snapshot
    destination = runtime / 'new'
    with pytest.raises(ValueError, match='filename'):
        module.capture(source=source, snapshot=destination, database_name=database_name)
    assert not destination.exists()


def test_source_change_does_not_publish_a_valid_manifest(snapshot, monkeypatch):
    runtime, source, _ = snapshot
    original_copy = module.copy_uploads
    def change_after_copy(uploads, target):
        original_copy(uploads, target)
        (uploads / 'image.png').write_bytes(b'new upload')
    monkeypatch.setattr(module, 'copy_uploads', change_after_copy)
    destination = runtime / 'changed'
    with pytest.raises(ValueError, match='changed'):
        module.capture(source=source, snapshot=destination)
    assert not (destination / 'manifest.json').exists()
    with pytest.raises(FileNotFoundError):
        module.restore_test(runtime / 'invalid-restore', source=source, snapshot=destination)
    assert not (runtime / 'invalid-restore').exists()


def test_symlinks_and_overlap_are_rejected_before_copy(snapshot):
    runtime, source, _ = snapshot
    with pytest.raises(ValueError, match='overlap'):
        module.capture(source=source, snapshot=source / 'nested')
    alias = runtime / 'alias'
    alias.symlink_to(source, target_is_directory=True)
    with pytest.raises(ValueError, match='Symlink'):
        module.capture(source=alias, snapshot=runtime / 'via-alias')
    (source / 'uploads' / 'link.png').symlink_to(source / 'preview.db')
    with pytest.raises(ValueError, match='unsafe'):
        module.capture(source=source, snapshot=runtime / 'unsafe')
    assert not (runtime / 'unsafe').exists()


def test_modified_database_cannot_restore(snapshot):
    runtime, backup, _ = snapshot
    with sqlite3.connect(backup / 'preview.db') as db:
        db.execute('INSERT INTO companions VALUES (2, ?)', ('changed',))
    with pytest.raises(ValueError, match='manifest'):
        module.restore_test(runtime / 'changed-db')
    assert not (runtime / 'changed-db').exists()


@pytest.fixture
def complete_runtime(snapshot):
    import shutil
    runtime, original, _ = snapshot
    source = runtime / 'complete-source'
    source.mkdir()
    shutil.copy2(original / 'preview.db', source / 'check.db')
    shutil.copytree(original / 'uploads', source / 'uploads')
    (source / 'ledger' / 'requests').mkdir(parents=True)
    (source / 'ledger' / 'requests' / 'receipt.json').write_text('{"dispatched":true,"state":"unknown"}')
    (source / 'job.json').write_text('{"state":"waiting_for_review"}')
    (source / 'backend-process.json').write_text('{"pid":12345}')
    (source / '.env').write_text('SECRET=excluded')
    (source / 'backend.log').write_text('private log excluded')
    return dict(source=source, snapshot=runtime / 'complete-backup', database_name='check.db',
                include_runtime_state=True)


def test_complete_runtime_restores_receipts_states_and_private_modes(complete_runtime):
    options = complete_runtime
    result = module.capture(**options)
    assert result == dict(backup_verified=True, table_count=1, file_count=1, ledger_file_count=1, state_file_count=2)
    target = options['source'].parent / 'complete-restored'
    # V2 auto-detection works even without repeating the capture flag.
    assert module.restore_test(target, **{k: v for k, v in options.items() if k != 'include_runtime_state'})['restored']
    assert module.snapshot_facts(target, 'check.db', True) == module.snapshot_facts(options['source'], 'check.db', True)
    assert module.verify(**options)['ledger_files'] == 1
    for root in (options['snapshot'], target):
        assert not (root / '.env').exists() and not (root / 'backend.log').exists()
        assert root.stat().st_mode & 0o777 == 0o700
        for item in root.rglob('*'):
            assert item.stat().st_mode & 0o777 == (0o700 if item.is_dir() else 0o600)
    with pytest.raises(FileExistsError):
        module.restore_test(target, **options)


@pytest.mark.parametrize('change', ['ledger_modify', 'ledger_delete', 'ledger_add', 'state_modify', 'state_delete', 'state_add'])
def test_runtime_snapshot_tampering_rejected_before_restore(complete_runtime, change):
    options = complete_runtime
    module.capture(**options)
    root = options['snapshot']
    if change.startswith('ledger'):
        item = root / 'ledger' / 'requests' / ('extra.json' if change.endswith('add') else 'receipt.json')
    else:
        item = root / ('extra.json' if change.endswith('add') else 'job.json')
    if change.endswith('delete'):
        item.unlink()
    else:
        item.write_text('changed')
    target = root.parent / 'tampered-restored'
    with pytest.raises(ValueError, match='manifest'):
        module.restore_test(target, **options)
    with pytest.raises(ValueError, match='manifest'):
        module.verify(**options)
    assert not target.exists()


@pytest.mark.parametrize('relative', ['ledger', 'job.json', 'ledger/requests/receipt.json'])
def test_runtime_symlinks_rejected_before_capture(complete_runtime, relative):
    import shutil
    options = complete_runtime
    item = options['source'] / relative
    if item.is_dir():
        shutil.rmtree(item)
    else:
        item.unlink()
    item.symlink_to(options['source'] / 'check.db')
    with pytest.raises(ValueError, match='[Uu]nsafe'):
        module.capture(**options)
    assert not options['snapshot'].exists()


def test_runtime_change_during_capture_never_publishes_manifest(complete_runtime, monkeypatch):
    options = complete_runtime
    copy = module.copy_runtime_state
    def mutate(source, target, manifest):
        copy(source, target, manifest)
        (source / 'job.json').write_text('{"state":"done"}')
    monkeypatch.setattr(module, 'copy_runtime_state', mutate)
    with pytest.raises(ValueError, match='changed'):
        module.capture(**options)
    assert not (options['snapshot'] / 'manifest.json').exists()


def test_runtime_manifest_cannot_inject_path_or_claim_wrong_database(complete_runtime):
    options = complete_runtime
    module.capture(**options)
    path = options['snapshot'] / 'manifest.json'
    original = json.loads(path.read_text())
    bad = json.loads(path.read_text())
    bad['runtime_state']['state_files']['../../escape.json'] = 'x'
    path.write_text(json.dumps(bad))
    target = options['source'].parent / 'bad-manifest'
    with pytest.raises(ValueError, match='manifest'):
        module.restore_test(target, **options)
    original['database_name'] = 'other.db'
    path.write_text(json.dumps(original))
    with pytest.raises(ValueError, match='database name'):
        module.restore_test(target, **options)
    assert not target.exists()


def test_old_snapshot_cannot_be_claimed_as_complete_runtime(snapshot):
    runtime, _, _ = snapshot
    with pytest.raises(ValueError, match='does not include runtime state'):
        module.restore_test(runtime / 'not-complete', include_runtime_state=True)


def test_runtime_without_ledger_preserves_absence(complete_runtime):
    import shutil
    options = complete_runtime
    shutil.rmtree(options['source'] / 'ledger')
    assert module.capture(**options)['ledger_file_count'] == 0
    target = options['source'].parent / 'no-ledger-restored'
    module.restore_test(target, **options)
    assert not (target / 'ledger').exists()


def test_source_state_change_is_detected_by_verify(complete_runtime):
    options = complete_runtime
    module.capture(**options)
    (options['source'] / 'job.json').write_text('new state')
    with pytest.raises(ValueError, match='changed'):
        module.verify(**options)


def test_runtime_cli_independent_processes_and_redacted_failures(tmp_path):
    import subprocess
    from uuid import uuid4
    import shutil
    project = SCRIPT.parents[2]
    root = project / '.runtime' / ('recovery-test-' + uuid4().hex)
    source, backup, target = root / 'source', root / 'snapshot', root / 'restored'
    source.mkdir(parents=True)
    try:
        with sqlite3.connect(source / 'check.db') as db:
            db.execute('CREATE TABLE receipts (id INTEGER PRIMARY KEY, state TEXT)')
            db.execute("INSERT INTO receipts VALUES (1, 'unknown')")
        (source / 'uploads').mkdir()
        (source / 'ledger').mkdir()
        (source / 'ledger' / 'receipt.json').write_text('{"used":true}')
        (source / 'job.json').write_text('{"state":"waiting"}')
        args = ['--source', str(source), '--snapshot', str(backup), '--database-name', 'check.db', '--include-runtime-state']
        for mode, extra, flag in [('capture', [], 'backup_verified'), ('verify', [], 'restart_verified'),
                                 ('restore-test', ['--restore-to', str(target)], 'restored')]:
            result = subprocess.run([sys.executable, str(SCRIPT), mode, *args, *extra], capture_output=True, text=True)
            assert result.returncode == 0 and json.loads(result.stdout)[flag]
            assert not result.stderr
        assert module.snapshot_facts(source, 'check.db', True) == module.snapshot_facts(target, 'check.db', True)
        (backup / 'ledger' / 'receipt.json').write_text('private-error-content')
        result = subprocess.run([sys.executable, str(SCRIPT), 'verify', *args], capture_output=True, text=True)
        assert result.returncode == 1 and json.loads(result.stdout)['error']['code'] == 'recovery_check_failed'
        assert 'private-error-content' not in result.stdout and str(root) not in result.stdout and not result.stderr
    finally:
        shutil.rmtree(root)
