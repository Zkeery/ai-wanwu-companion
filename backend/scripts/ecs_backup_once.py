"""Verified ECS backup, fail closed; installing a timer is a separate operation."""
from __future__ import annotations

import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import uuid


def write_private(path: Path, value: dict) -> None:
    with path.open('x', encoding='utf-8') as output:
        path.chmod(0o600)
        json.dump(value, output, ensure_ascii=False, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())


def load_engine(path: Path, expected_sha: str):
    if path.is_symlink() or not path.is_file():
        raise ValueError('unsafe_engine')
    if hashlib.sha256(path.read_bytes()).hexdigest() != expected_sha:
        raise ValueError('engine_checksum')
    spec = importlib.util.spec_from_file_location('verified_ecs_snapshot', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(root: Path, engine_path: Path, expected_sha: str, *, max_snapshots: int = 7) -> dict:
    if root.is_symlink() or not root.is_dir() or not 1 <= max_snapshots <= 31:
        raise ValueError('invalid_backup_configuration')
    root = root.resolve()
    # Check the frozen implementation before writing any backup state.
    engine = load_engine(engine_path, expected_sha)
    for directory in [root / 'backups', root / 'backups/scheduled']:
        if directory.is_symlink():
            raise ValueError('unsafe_backup_directory')
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.stat().st_mode & 0o077:
            raise ValueError('backup_directory_not_private')
    backups = root / 'backups/scheduled'
    descriptor = os.open(backups / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'state': 'blocked', 'reason': 'backup_already_running'}
        if (backups / 'review-required.json').exists():
            return {'state': 'blocked', 'reason': 'previous_failure_requires_review'}
        existing = list(backups.glob('run-*'))
        if len(existing) >= max_snapshots:
            return {'state': 'blocked', 'reason': 'retention_review_required'}
        target = backups / ('run-' + uuid.uuid4().hex)
        try:
            captured = engine.capture(root, target)
            if captured.get('state') != 'verified':
                raise ValueError('capture_not_verified')
            restored = engine.restore(target / 'snapshot.tar', target / 'restore-check',
                                      captured['archive_sha256'])
            if restored.get('state') != 'restored_verified':
                raise ValueError('restore_not_verified')
            result = {'state': 'verified', 'run_id': target.name,
                      'engine_sha256': expected_sha,
                      'archive_sha256': captured['archive_sha256'],
                      'entries': captured['entries'], 'databases': captured['databases'],
                      'restore_verified': True, 'network_requests': 0,
                      'automatic_retries': 0, 'production_overwritten': False,
                      'offsite_copy': False}
            write_private(target / 'scheduled-result.json', result)
            return result
        except Exception as error:
            result = {'state': 'failed', 'run_id': target.name,
                      'error_type': type(error).__name__,
                      'automatic_retries': 0, 'evidence_preserved': True}
            write_private(backups / 'review-required.json', result)
            return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--engine-sha256', required=True)
    parser.add_argument('--max-snapshots', type=int, default=7)
    args = parser.parse_args()
    try:
        result = run(args.root, args.engine, args.engine_sha256,
                     max_snapshots=args.max_snapshots)
    except Exception as error:
        result = {'state': 'blocked', 'reason': type(error).__name__}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['state'] == 'verified' else 2


if __name__ == '__main__':
    raise SystemExit(main())
