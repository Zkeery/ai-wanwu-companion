"""Local scheduled verified backups and journal alarms; never sends cloud I/O."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
import fcntl
import http.client
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
from uuid import uuid4

from scripts import ecs_runtime as runtime
from scripts.ecs_cloud_backup import pack, unpack, digest
from scripts.check_full_flow_recovery import load_snapshot

BACKUPS = Path('/srv/ai-companion/backups')
MONITOR = Path('/srv/ai-companion/monitor')
GIB = 1024 ** 3
DEFAULT_QUOTA = 5 * GIB
MIN_FREE = 2 * GIB
MAX_RUNS = 1000


def private_directory(path: Path) -> Path:
    path = runtime.safe_path(path)
    if not path.is_dir() or path.stat().st_mode & 0o077:
        raise ValueError('private_directory_required')
    return path


def save_json(path: Path, value: dict) -> None:
    path = runtime.safe_path(path)
    temporary = path.with_name(path.name + '.' + uuid4().hex + '.tmp')
    with temporary.open('x', encoding='utf8') as out:
        os.chmod(temporary, 0o600)
        json.dump(value, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def exclusive(root: Path, name: str):
    path = runtime.safe_path(root / name)
    with path.open('a') as lock:
        os.chmod(path, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('maintenance_already_running') from None
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def runs(root: Path) -> list[dict]:
    result = []
    entries = list(root.glob('run-*.json'))
    if len(entries) > MAX_RUNS:
        raise ValueError('run_limit_reached')
    for path in entries:
        path = runtime.safe_path(path)
        if path.stat().st_size > 8192:
            raise ValueError('invalid_run_record')
        item = json.loads(path.read_text(encoding='utf8'))
        if (not isinstance(item, dict) or item.get('state') not in ('running', 'verified', 'failed')
                or type(item.get('started_at')) is not int
                or not isinstance(item.get('run_id'), str)
                or len(item['run_id']) != 32
                or any(c not in '0123456789abcdef' for c in item['run_id'])
                or path.name != 'run-' + item['run_id'] + '.json'):
            raise ValueError('invalid_run_record')
        if item['state'] == 'verified' and (
                type(item.get('finished_at')) is not int or item['finished_at'] < item['started_at']):
            raise ValueError('invalid_run_record')
        result.append(item)
    return result


def total_bytes(root: Path) -> int:
    result = 0
    for item in root.rglob('*'):
        if item.is_symlink():
            raise ValueError('unsafe_backup_files')
        if item.is_file():
            result += item.stat().st_size
        elif not item.is_dir():
            raise ValueError('unsafe_backup_files')
    return result


def sync_tree(root: Path) -> None:
    entries = list(root.rglob('*'))
    for item in entries:
        item = runtime.safe_path(item)
        if item.is_file():
            with item.open('rb') as data:
                os.fsync(data.fileno())
    directories = sorted((item for item in entries if item.is_dir()),
                         key=lambda item: len(item.parts), reverse=True)
    for directory in [*directories, root]:
        descriptor = os.open(runtime.safe_path(directory), os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)


def backup_once(source: Path, root: Path, *, now: int | None = None,
                quota: int = DEFAULT_QUOTA) -> dict:
    source, root = runtime.safe_path(source), private_directory(root)
    if (source.is_relative_to(root) or root.is_relative_to(source)
            or type(quota) is not int or not GIB <= quota <= 10 * GIB):
        raise ValueError('backup_location_or_quota_invalid')
    now = int(time.time()) if now is None else now
    with exclusive(root, '.backup.lock'):
        records = runs(root)
        if any(item['state'] == 'running' for item in records):
            raise ValueError('unfinished_backup_requires_resolution')
        if len(records) >= MAX_RUNS:
            raise ValueError('run_limit_reached')
        record = {'run_id': uuid4().hex, 'state': 'running', 'started_at': now,
                  'cloud_requests': 0, 'automatic_retries': 0}
        record_path = root / ('run-' + record['run_id'] + '.json')
        # Intent precedes every snapshot/archive write. Interrupted runs block replay.
        save_json(record_path, record)
        try:
            source_bytes = total_bytes(source)
            file_count = sum(item.is_file() for item in source.rglob('*'))
            # Snapshot, tar and temporary restore coexist; allow tar/manifest overhead.
            needed = 3 * source_bytes + 4096 * file_count + 2 * 1024 ** 2
            if (needed > quota or total_bytes(root) + needed > quota
                    or shutil.disk_usage(root).free < needed + MIN_FREE):
                raise ValueError('backup_capacity_exhausted')
            destination = root / record['run_id']
            destination.mkdir(mode=0o700)
            result = runtime.capture_data(source, destination / 'snapshot')
            archive = pack(destination / 'snapshot', destination / 'snapshot.tar')
            # Archive must itself restore and match the complete manifest.
            restored = destination / 'restore-check'
            unpack(destination / 'snapshot.tar', archive['archive_sha256'], restored)
            load_snapshot(restored, 'app.db', True)
            shutil.rmtree(restored)
            sync_tree(destination)
            record.update(state='verified', finished_at=max(now, int(time.time())),
                          archive_sha256=archive['archive_sha256'],
                          counts={k: result[k] for k in (
                              'table_count', 'file_count', 'ledger_file_count', 'state_file_count')})
        except Exception:
            # Never put exceptions, paths, user data or credential values in alarms.
            record.update(state='failed', finished_at=max(now, int(time.time())),
                          error_code='scheduled_backup_failed')
        save_json(record_path, record)
        return record


def resolve_run(root: Path, run_id: str) -> dict:
    root = private_directory(root)
    if len(run_id) != 32 or any(c not in '0123456789abcdef' for c in run_id):
        raise ValueError('invalid_run_id')
    with exclusive(root, '.backup.lock'):
        record = next((r for r in runs(root) if r['run_id'] == run_id), None)
        if record is None or record['state'] != 'running':
            raise ValueError('unfinished_run_required')
        directory = runtime.safe_path(root / run_id)
        try:
            load_snapshot(directory / 'snapshot', 'app.db', True)
            checksum = digest(runtime.safe_path(directory / 'snapshot.tar'))
            check = directory / ('resolution-' + uuid4().hex)
            unpack(directory / 'snapshot.tar', checksum, check)
            load_snapshot(check, 'app.db', True)
            shutil.rmtree(check)
            sync_tree(directory)
            record.update(state='verified', archive_sha256=checksum)
        except Exception:
            record.update(state='failed', error_code='interrupted_backup_not_verified')
        record['finished_at'] = max(record['started_at'], int(time.time()))
        save_json(root / ('run-' + run_id + '.json'), record)
        return record


def service_ready(unit: str) -> bool:
    try:
        result = subprocess.run(
            ['systemctl', 'show', unit, '--property=LoadState,ActiveState,SubState'],
            capture_output=True, text=True, timeout=5, check=False)
        fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        return result.returncode == 0 and fields == {
            'LoadState': 'loaded', 'ActiveState': 'active', 'SubState': 'running'}
    except Exception:
        return False


def loopback_ready(port: int) -> bool:
    # Fixed destinations; no authentication, redirects, model, or business mutation.
    if port not in (8020, 3020):
        return False
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
    try:
        connection.request('GET', '/openapi.json' if port == 8020 else '/')
        response = connection.getresponse()
        if response.status != 200:
            return False
        body = response.read(1024 ** 2 + 1)
        if len(body) > 1024 ** 2:
            return False
        if port == 8020:
            value = json.loads(body)
            return isinstance(value, dict) and value.get('info', {}).get('title') == 'AI万物伙伴'
        return b'<html' in body.lower()
    except Exception:
        return False
    finally:
        connection.close()


def monitor_once(source: Path, root: Path, output: Path, volume_id: str, *,
                 now: int | None = None) -> dict:
    output = private_directory(output)
    now = int(time.time()) if now is None else now
    with exclusive(output, '.monitor.lock'):
        alarms = []
        try:
            runtime.mounted_volume(source, volume_id)
        except Exception:
            alarms.append('data_volume_unavailable')
        for name, port in (('backend', 8020), ('frontend', 3020)):
            if not service_ready('ai-companion-' + name + '.service') or not loopback_ready(port):
                alarms.append(name + '_unavailable')
        last = None
        try:
            root = private_directory(root)
            records = runs(root)
            if any(r['state'] == 'running' and now - r['started_at'] > 180 for r in records):
                alarms.append('backup_interrupted')
            completed = [r for r in records if r['state'] == 'verified']
            last = max((r['finished_at'] for r in completed), default=None)
            if last is None or now - last > 26 * 3600:
                alarms.append('backup_overdue')
            if last is not None and last > now + 60:
                alarms.append('backup_clock_invalid')
            latest = max(records, key=lambda r: (r['started_at'], r.get('finished_at', 0),
                                                r['state'] == 'failed'), default=None)
            if latest and latest['state'] == 'failed':
                alarms.append('latest_backup_failed')
            if shutil.disk_usage(root).free < MIN_FREE:
                alarms.append('backup_disk_low')
        except Exception:
            alarms.append('backup_records_unavailable')
        result = {'checked_at': now, 'status': 'alert' if alarms else 'ok',
                  'alarms': alarms, 'last_backup_at': last,
                  'external_notifications': 0, 'model_requests': 0, 'cloud_requests': 0}
        save_json(output / 'status.json', result)
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('backup', 'monitor', 'resolve'))
    parser.add_argument('--run-id')
    args = parser.parse_args()
    try:
        if os.environ.get('LOCAL_MAINTENANCE_ENABLED') != 'true':
            raise ValueError('maintenance_not_enabled')
        if args.mode == 'monitor':
            result = monitor_once(runtime.DATA_ROOT, BACKUPS, MONITOR,
                                  os.environ.get('DATA_VOLUME_ID', ''))
        else:
            root = runtime.mounted_volume(runtime.DATA_ROOT, os.environ.get('DATA_VOLUME_ID', ''))
            if args.mode == 'resolve':
                if not args.run_id:
                    raise ValueError('run_id_required')
                result = resolve_run(BACKUPS, args.run_id)
            else:
                result = backup_once(root, BACKUPS,
                                     quota=int(os.environ.get('LOCAL_BACKUP_QUOTA_BYTES', str(DEFAULT_QUOTA))))
        # Journal only gets fixed codes and aggregate state, not private run manifests.
        safe = {k: result[k] for k in ('state', 'status', 'alarms') if k in result}
        safe.update(model_requests=0, cloud_requests=0, external_notifications=0)
        print(json.dumps(safe, ensure_ascii=False))
        return 0 if result.get('state') == 'verified' or result.get('status') == 'ok' else 1
    except Exception:
        print(json.dumps({'error': {'code': 'local_maintenance_failed',
                                   'message': '本地维护未通过，请检查挂盘、私有目录、备份记录和空间。'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
