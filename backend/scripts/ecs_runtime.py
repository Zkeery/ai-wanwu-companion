"""Fail-closed ECS startup and quiesced complete-data backup/restore.

Never provisions resources, sends requests, starts services or imports the app.
"""
from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
import subprocess
from typing import Mapping

from scripts.check_full_flow_recovery import (
    copy_database, copy_runtime_state, copy_uploads, load_snapshot,
    snapshot_facts, summary,
)

DATA_ROOT = Path('/srv/ai-companion/data')
BACKEND_UNIT = 'ai-companion-backend.service'
MARKER = '.ai-companion-volume'


def safe_path(path: Path) -> Path:
    absolute = path.absolute()
    if any(p.is_symlink() for p in (absolute, *absolute.parents)):
        raise ValueError('unsafe_path')
    return absolute.resolve()


def mounted_volume(root: Path, volume_id: str) -> Path:
    root = safe_path(root)
    if (not volume_id or not root.is_dir() or not os.path.ismount(root)
            or not (root / MARKER).is_file() or (root / MARKER).is_symlink()
            or (root / MARKER).read_text(encoding='utf8').strip() != volume_id):
        raise ValueError('data_volume_unavailable')
    return root


def check_environment(kind: str, env: Mapping[str, str], root: Path = DATA_ROOT) -> dict:
    root = mounted_volume(root, env.get('DATA_VOLUME_ID', ''))
    for directory in ('uploads', 'ledger'):
        item = safe_path(root / directory)
        if not item.is_dir():
            raise ValueError('data_directories_missing')
    if kind == 'backend':
        if (env.get('APP_ENV') != 'production'
                or env.get('DATABASE_URL') != f'sqlite:///{root / "app.db"}'
                or env.get('UPLOAD_DIR') != str(root / 'uploads')
                or env.get('WALK_WORKFLOW_ROOT') != str(root / 'ledger')):
            raise ValueError('persistent_paths_required')
        safe_path(root / 'app.db')
        # Settings checks production SMS, model bounds, transport and dev access.
        # Explicitly supplied inputs prevent a local .env from filling omissions.
        from app.core.config import Settings
        values = {name: env[name.upper()] for name in Settings.model_fields if name.upper() in env}
        Settings(_env_file=None, **values)
    elif kind == 'frontend':
        if (env.get('BACKEND_URL') != 'http://127.0.0.1:8020'
                or env.get('HOSTNAME') != '127.0.0.1' or env.get('PORT') != '3020'
                or env.get('NODE_ENV') != 'production'
                or env.get('NEXT_PUBLIC_DEV_SMS_CODE', '').strip()
                or any(env.get(k, '').lower() not in ('', 'false', '0') for k in
                       ('NEXT_PUBLIC_OFFLINE_PREVIEW', 'NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW'))
                or any(value.strip() and re.search(r'SECRET|TOKEN|PASSWORD|(?:API|ACCESS|PRIVATE)_?KEY', name)
                       for name, value in env.items() if name.startswith('NEXT_PUBLIC_'))):
            raise ValueError('frontend_production_inputs_required')
    else:
        raise ValueError('invalid_service')
    return {'startup_inputs_verified': True, 'service': kind,
            'network_requests': 0, 'volume_mounted': True,
            'release_acceptance': 'pending'}


def ensure_backend_stopped() -> None:
    result = subprocess.run(
        ['systemctl', 'show', BACKEND_UNIT, '--property=LoadState,ActiveState,SubState'],
        capture_output=True, text=True, timeout=10, check=False,
    )
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if result.returncode or fields != {'LoadState': 'loaded', 'ActiveState': 'inactive', 'SubState': 'dead'}:
        raise ValueError('backend_must_be_stopped')


def separate_paths(source: Path, target: Path) -> tuple[Path, Path]:
    source, target = safe_path(source), safe_path(target)
    if (source.is_relative_to(target) or target.is_relative_to(source)
            or target.exists() or not target.parent.is_dir()):
        raise ValueError('new_separate_target_required')
    return source, target


def capture_data(source: Path, target: Path) -> dict:
    """Internal operation; CLI first checks the mount and stopped service."""
    source, target = separate_paths(source, target)
    before = snapshot_facts(source, 'app.db', True)
    target.mkdir(mode=0o700)
    copy_database(source / 'app.db', target / 'app.db')
    copy_uploads(source / 'uploads', target / 'uploads')
    copy_runtime_state(source, target, before)
    if (snapshot_facts(target, 'app.db', True) != before
            or snapshot_facts(source, 'app.db', True) != before):
        raise ValueError('incomplete_backup')
    manifest = target / 'manifest.json'
    with manifest.open('x', encoding='utf8') as out:
        os.chmod(manifest, 0o600)
        json.dump(before, out, indent=2)
    return {'backup_verified': True, **summary(before), 'offsite_backup': 'pending'}


def restore_data(snapshot: Path, target: Path) -> dict:
    """Never overwrites a running data root or restores the volume marker."""
    snapshot, target = separate_paths(snapshot, target)
    manifest, _ = load_snapshot(snapshot, 'app.db', True)
    target.mkdir(mode=0o700)
    copy_database(snapshot / 'app.db', target / 'app.db')
    copy_uploads(snapshot / 'uploads', target / 'uploads')
    copy_runtime_state(snapshot, target, manifest)
    if (snapshot_facts(target, 'app.db', True) != manifest
            or snapshot_facts(snapshot, 'app.db', True) != manifest):
        raise ValueError('restore_mismatch')
    return {'restored_verified': True, **summary(manifest), 'production_activation': 'pending'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='mode', required=True)
    check = sub.add_parser('check')
    check.add_argument('service', choices=('backend', 'frontend'))
    backup = sub.add_parser('backup')
    backup.add_argument('--target', required=True, type=Path)
    restore = sub.add_parser('restore')
    restore.add_argument('--snapshot', required=True, type=Path)
    restore.add_argument('--target', required=True, type=Path)
    for child in (backup, restore):
        child.add_argument('--confirm-quiesced', action='store_true', required=True)
    args = parser.parse_args()
    try:
        if args.mode == 'check':
            result = check_environment(args.service, os.environ)
        else:
            root = mounted_volume(DATA_ROOT, os.environ.get('DATA_VOLUME_ID', ''))
            ensure_backend_stopped()
            # Restore only inside the checked data volume, into a new subdirectory.
            # Activating it is a separate reviewed action with another verified backup.
            if args.mode == 'restore':
                if not safe_path(args.target).is_relative_to(root) or safe_path(args.snapshot).is_relative_to(root):
                    raise ValueError('restore_location_invalid')
                result = restore_data(args.snapshot, args.target)
            else:
                result = capture_data(root, args.target)
        print(json.dumps(result))
        return 0
    except Exception:
        # SDK/config/filesystem errors may contain credential values or private paths.
        print(json.dumps({'error': {'code': 'ecs_runtime_check_failed',
                                   'message': '启动或数据操作未通过；检查挂盘、生产配置、停服状态和完整性。'}}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
