"""Capture and restore project-local runtime data; never overwrite a target."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import time

if __package__:
    from .c13_life_preview import database_facts
else:
    from c13_life_preview import database_facts

PROJECT = Path(__file__).resolve().parents[2]
STATE = PROJECT / '.runtime' / 'v12-c13-preview'
DESTINATION = PROJECT / '.runtime' / 'full-flow-recovery'


def files(root):
    if not root.is_dir() or root.is_symlink() or any(p.is_symlink() for p in root.rglob('*')):
        raise ValueError('Missing or unsafe uploads')
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob('*') if p.is_file()}


def facts(path):
    if not path.is_file() or path.is_symlink():
        raise ValueError('Missing or unsafe database')
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Database integrity check failed')
        return database_facts(db)


def runtime_path(path: Path) -> Path:
    runtime = (PROJECT / '.runtime').resolve()
    absolute = path.absolute()
    resolved = path.resolve()
    if resolved == runtime or not resolved.is_relative_to(runtime):
        raise ValueError('Data directory must be under this project runtime')
    if any(p.is_symlink() for p in (absolute, *absolute.parents)):
        raise ValueError('Symlink data directories are not supported')
    return resolved


def locations(source=None, snapshot=None, database_name='preview.db'):
    if (not database_name or database_name in ('.', '..')
            or Path(database_name).name != database_name or '\\' in database_name):
        raise ValueError('Database name must be a single filename')
    source, snapshot = runtime_path(source or STATE), runtime_path(snapshot or DESTINATION)
    if source.is_relative_to(snapshot) or snapshot.is_relative_to(source):
        raise ValueError('Source and snapshot must not overlap')
    return source, snapshot


def state_files(directory, database_name):
    result = {}
    for item in sorted(directory.glob('*.json')):
        if item.name in ('manifest.json', database_name):
            continue
        if item.is_symlink() or not item.is_file():
            raise ValueError('Unsafe runtime state file')
        result[item.name] = hashlib.sha256(item.read_bytes()).hexdigest()
    return result


def snapshot_facts(directory, database_name, include_runtime_state=False):
    result = {'tables': facts(directory / database_name), 'files': files(directory / 'uploads')}
    if include_runtime_state:
        ledger = directory / 'ledger'
        result.update(schema_version=2, database_name=database_name,
                      runtime_state={'ledger': files(ledger) if ledger.exists() or ledger.is_symlink() else None,
                                     'state_files': state_files(directory, database_name)})
    return result


def copy_runtime_state(source, target, manifest):
    state = manifest.get('runtime_state')
    if state is None:
        return
    if state['ledger'] is not None:
        copy_uploads(source / 'ledger', target / 'ledger')
    for name in state['state_files']:
        item = source / name
        if item.is_symlink() or not item.is_file():
            raise ValueError('Unsafe runtime state file')
        shutil.copyfile(item, target / name)
        (target / name).chmod(0o600)


def load_snapshot(snapshot, database_name, require_runtime_state=False):
    if (snapshot / 'manifest.json').is_symlink():
        raise ValueError('Unsafe snapshot manifest')
    manifest = json.loads((snapshot / 'manifest.json').read_text(encoding='utf-8'))
    if not isinstance(manifest, dict) or not isinstance(manifest.get('tables'), dict) or not isinstance(manifest.get('files'), dict):
        raise ValueError('Invalid snapshot manifest')
    extended = 'schema_version' in manifest or 'runtime_state' in manifest
    if extended and (type(manifest.get('schema_version')) is not int or manifest['schema_version'] != 2
                     or manifest.get('database_name') != database_name):
        raise ValueError('Unsupported snapshot manifest or database name')
    if require_runtime_state and not extended:
        raise ValueError('Snapshot does not include runtime state')
    if snapshot_facts(snapshot, database_name, extended) != manifest:
        raise ValueError('Snapshot does not match its manifest')
    return manifest, extended


def summary(manifest):
    result = {'table_count': len(manifest['tables']), 'file_count': len(manifest['files'])}
    if 'runtime_state' in manifest:
        result.update(ledger_file_count=len(manifest['runtime_state']['ledger'] or {}),
                      state_file_count=len(manifest['runtime_state']['state_files']))
    return result


def copy_database(source, target):
    deadline = time.monotonic() + 30
    def progress(*_):
        if time.monotonic() > deadline:
            raise ValueError('Database backup timed out')
    with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as db, sqlite3.connect(target) as copy:
        db.backup(copy, pages=256, progress=progress, sleep=.05)
    target.chmod(0o600)


def copy_uploads(source, target):
    shutil.copytree(source, target)
    target.chmod(0o700)
    for item in target.rglob('*'):
        item.chmod(0o700 if item.is_dir() else 0o600)


def capture(*, source=None, snapshot=None, database_name='preview.db', include_runtime_state=False) -> dict:
    source, snapshot = locations(source, snapshot, database_name)
    if snapshot.exists():
        raise FileExistsError('Snapshot already exists')
    if include_runtime_state and ((source / 'manifest.json').exists() or (source / 'manifest.json').is_symlink()
                                  or database_name in ('manifest.json', 'ledger', 'uploads')):
        raise ValueError('Runtime source uses a reserved snapshot name')
    before = snapshot_facts(source, database_name, include_runtime_state)
    snapshot.mkdir(parents=True, mode=0o700, exist_ok=False)
    copy_database(source / database_name, snapshot / database_name)
    copy_uploads(source / 'uploads', snapshot / 'uploads')
    copy_runtime_state(source, snapshot, before)
    actual = snapshot_facts(snapshot, database_name, include_runtime_state)
    if before != actual or before != snapshot_facts(source, database_name, include_runtime_state):
        raise ValueError('Source changed during capture; snapshot is incomplete')
    manifest = snapshot / 'manifest.json'
    manifest.touch(mode=0o600, exist_ok=False)
    manifest.write_text(json.dumps(before, indent=2), encoding='utf-8')
    return {'backup_verified': True, **summary(before)}


def restore_test(target: Path, *, source=None, snapshot=None, database_name='preview.db', include_runtime_state=False) -> dict:
    """Restore the isolated snapshot into a new runtime directory and verify it."""
    source, snapshot = locations(source, snapshot, database_name)
    target = runtime_path(target)
    if any(target.is_relative_to(p) or p.is_relative_to(target) for p in (source, snapshot)):
        raise ValueError('Restore target cannot overlap source or snapshot')
    if target.exists():
        raise FileExistsError('Restore target already exists')
    if not snapshot.is_dir():
        raise FileNotFoundError('Isolated snapshot is missing')
    manifest, extended = load_snapshot(snapshot, database_name, include_runtime_state)
    uploads = snapshot / 'uploads'

    target.mkdir(parents=True, mode=0o700, exist_ok=False)
    copy_database(snapshot / database_name, target / database_name)
    copy_uploads(uploads, target / 'uploads')
    copy_runtime_state(snapshot, target, manifest)
    actual = snapshot_facts(target, database_name, extended)
    if actual != manifest or snapshot_facts(snapshot, database_name, extended) != manifest:
        raise ValueError('Restored data differs from snapshot')
    return {'restored': True, **summary(actual)}


def verify(*, source=None, snapshot=None, database_name='preview.db', include_runtime_state=False):
    source, snapshot = locations(source, snapshot, database_name)
    before, extended = load_snapshot(snapshot, database_name, include_runtime_state)
    after = snapshot_facts(source, database_name, extended)
    if before != after:
        raise ValueError('Records changed across restart')
    result = {'restart_verified': True, 'tables': len(after['tables']), 'files': len(after['files'])}
    if extended:
        result.update(ledger_files=len(after['runtime_state']['ledger'] or {}),
                      state_files=len(after['runtime_state']['state_files']))
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['capture', 'verify', 'restore-test'])
    parser.add_argument('--restore-to', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--snapshot', type=Path)
    parser.add_argument('--database-name', default='preview.db')
    parser.add_argument('--include-runtime-state', action='store_true',
                        help='Include ledger and root JSON state; required when restoring/verifying a complete runtime backup')
    args = parser.parse_args()
    options = dict(source=args.source, snapshot=args.snapshot, database_name=args.database_name,
                   include_runtime_state=args.include_runtime_state)
    if args.mode == 'restore-test':
        if args.restore_to is None:
            parser.error('restore-test requires --restore-to')
        print(json.dumps(restore_test(args.restore_to, **options)))
        return
    if args.restore_to is not None:
        parser.error('--restore-to is only for restore-test')
    if args.mode == 'capture':
        print(json.dumps(capture(**options)))
    else:
        print(json.dumps(verify(**options)))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, sqlite3.Error):
        print(json.dumps({'error': {'code': 'recovery_check_failed',
                                   'message': '备份或恢复未通过；源数据未覆盖，请检查目录与一致性。'}}, ensure_ascii=False))
        raise SystemExit(1) from None
