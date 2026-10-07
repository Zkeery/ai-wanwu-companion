"""Local package/start/recovery rehearsal. No cloud deployment or real providers."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid
import zipfile

PROJECT = Path(__file__).resolve().parents[2]
WORK = PROJECT / '.runtime' / 'r812-release-rehearsal'
BACKEND_PORT, FRONTEND_PORT = 8056, 3056
DENIED_DIRS = {'.git', '.venv', '.runtime', '.vefaas', '__pycache__', '.pytest_cache',
               'node_modules', '.next', 'data', 'uploads', 'logs'}


def private_json(file: Path, value: dict) -> None:
    with file.open('w', encoding='utf-8') as output:
        os.chmod(file, 0o600)
        json.dump(value, output, ensure_ascii=False, indent=2)


def denied(name: str) -> bool:
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts or '\\' in name:
        return True
    for part in path.parts:
        if part in DENIED_DIRS or part.startswith('.next-'):
            return True
        if part.startswith('.env') and part not in ('.env.example', '.env.blueprint.example'):
            return True
    return bool(re.search(r'\.(?:db|sqlite3?)(?:-(?:wal|shm|journal))?$|\.pyc$|\.DS_Store$', name))


def source_files(base: Path) -> list[str]:
    result = subprocess.run(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
                            cwd=base, capture_output=True, check=True)
    return sorted({name for name in result.stdout.decode().split('\0')
                   if name and not denied(name) and (base / name).is_file()})


def zip_files(base: Path, names: list[str], output: Path, *, source: bool = True) -> None:
    if output.exists():
        raise ValueError('archive_exists')
    with zipfile.ZipFile(output, 'x', compression=zipfile.ZIP_DEFLATED) as archive:
        os.chmod(output, 0o600)
        for name in sorted(names):
            path = base / name
            if (PurePosixPath(name).is_absolute() or '..' in PurePosixPath(name).parts
                    or '\\' in name or not path.resolve().is_relative_to(base.resolve())
                    or path.is_symlink() or (source and denied(name))):
                raise ValueError('unsafe_archive_source')
            archive.write(path, name)


def unpack(archive_path: Path, target: Path) -> None:
    if target.exists():
        raise ValueError('restore_target_exists')
    with zipfile.ZipFile(archive_path) as archive:
        for item in archive.infolist():
            path = PurePosixPath(item.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in item.filename
                    or (item.external_attr >> 16) & 0o170000 == 0o120000):
                raise ValueError('unsafe_archive_member')
        target.mkdir(mode=0o700)
        archive.extractall(target)


def child_env(**changes: str) -> dict[str, str]:
    env = {key: os.environ[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG') if key in os.environ}
    env.update(NEXT_TELEMETRY_DISABLED='1', NODE_ENV='production',
               NEXT_PUBLIC_DEV_SMS_CODE='', NEXT_PUBLIC_OFFLINE_PREVIEW='false',
               NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW='false', NEXT_PUBLIC_LIFE_RUNTIME_ENABLED='false',
               BACKEND_URL=f'http://127.0.0.1:{BACKEND_PORT}',
               NO_UPDATE_NOTIFIER='1', NO_COLOR='1')
    env.update(changes)
    return env


def backend_env(state: Path) -> dict[str, str]:
    return child_env(APP_ENV='production', DATABASE_URL='sqlite:///' + str(state / 'check.db'),
                     UPLOAD_DIR=str(state / 'uploads'), MODEL_API_KEY='synthetic-offline-model-key',
                     MODEL_BASE_URL='https://example.invalid/v1', IMAGE_BASE_URL='',
                     DEV_AUTH_TOKEN='', DEV_SMS_FIXED_CODE='', LEGACY_CLAIM_USER_ID='',
                     SMS_PROVIDER='volcengine', SMS_LIVE_ENABLED='true', SMS_DAILY_LIMIT='1',
                     SMS_ACCESS_KEY_ID='synthetic-offline-ak', SMS_SECRET_ACCESS_KEY='synthetic-offline-sk',
                     SMS_ACCOUNT='synthetic-offline-account', SMS_SIGN='synthetic-offline-sign',
                     SMS_TEMPLATE_ID='synthetic-offline-template', GENERATION_QUOTA_ENABLED='true',
                     LIFE_SIMULATION_ENABLED='false', LIFE_RUNTIME_PREVIEW_ENABLED='false',
                     LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false', LIFE_RUNTIME_ENABLED='false',
                     GATHERING_DIALOGUE_ENABLED='false', GATHERING_DIALOGUE_AUTOMATIC_ENABLED='false',
                     COMPETITION_AI_ENABLED='false', MOTION_GENERATION_ENABLED='false',
                     VOICE_LIVE_REPLY_ENABLED='false', MODEL_MAX_RETRIES='0')


def block_external_network() -> None:
    original_connect, original_resolve = socket.socket.connect, socket.getaddrinfo

    def connect(sock, address):
        if not isinstance(address, tuple) or address[0] not in ('127.0.0.1', '::1'):
            raise RuntimeError('rehearsal_external_network_blocked')
        return original_connect(sock, address)

    def resolve(host, *args, **kwargs):
        if host not in ('127.0.0.1', '::1', 'localhost', None):
            raise RuntimeError('rehearsal_external_network_blocked')
        return original_resolve(host, *args, **kwargs)

    socket.socket.connect = connect
    socket.getaddrinfo = resolve


def seed() -> dict:
    from app.core.database import SessionLocal
    from app.models.models import User, Session, Photo, Object, Character
    token = secrets.token_urlsafe(32)
    owner, other = str(uuid.uuid4()), str(uuid.uuid4())
    with SessionLocal() as db:
        db.add_all([User(id=owner, phone='13800001212'), User(id=other, phone='13800001213')])
        db.flush()
        db.add(Session(token_hash=hashlib.sha256(token.encode()).hexdigest(), user_id=owner,
                       expires_at=datetime.utcnow() + timedelta(hours=2)))
        photo = Photo(owner_id=owner, filename='synthetic-recovery-marker.txt', status='done')
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label='合成恢复样本')
        db.add(obj)
        db.flush()
        character = Character(object_id=obj.id, owner_id=owner, name='离线恢复样本',
                              persona='仅用于本地恢复演练', opening_line='本地样本', status='ready')
        db.add(character)
        other_token = secrets.token_urlsafe(32)
        db.add(Session(token_hash=hashlib.sha256(other_token.encode()).hexdigest(), user_id=other,
                       expires_at=datetime.utcnow() + timedelta(hours=2)))
        db.commit()
        receipt = dict(token=token, other_token=other_token, owner=owner, character=character.id)
    state = Path(os.environ['UPLOAD_DIR'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker = state / 'synthetic-recovery-marker.txt'
    marker.write_text('synthetic-r812-recovery-marker', encoding='utf-8')
    os.chmod(marker, 0o600)
    return receipt


def serve(backend: Path, state: Path) -> None:
    block_external_network()
    sys.path.insert(0, str(backend))
    from app.main import app
    session_file = WORK / 'session.json'
    if not session_file.exists():
        private_json(session_file, seed())
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=BACKEND_PORT, access_log=False, log_level='warning')


def request(port: int, path: str, token: str = '', payload: dict | None = None) -> tuple[int, bytes]:
    headers = {'Authorization': 'Bearer ' + token} if token else {}
    if payload is not None:
        headers['Content-Type'] = 'application/json'
    req = Request(f'http://127.0.0.1:{port}{path}',
                  data=json.dumps(payload).encode() if payload is not None else None, headers=headers)
    try:
        with urlopen(req, timeout=5) as response:
            return response.status, response.read(2_000_000)
    except HTTPError as error:
        return error.code, error.read(2_000_000)


def wait_ready(process: subprocess.Popen, port: int, path: str) -> None:
    end = time.monotonic() + 30
    while time.monotonic() < end:
        if process.poll() is not None:
            raise ValueError('rehearsal_process_failed')
        try:
            request(port, path)
            return
        except (URLError, TimeoutError):
            time.sleep(.2)
    raise ValueError('rehearsal_start_timeout')


def stop(process: subprocess.Popen | None) -> None:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)


def prepare() -> dict:
    WORK.mkdir(mode=0o700)  # Exclusive: never overwrite an earlier rehearsal.
    for service in ('backend', 'frontend'):
        source = PROJECT / service
        names = source_files(source)
        zip_files(source, names, WORK / (service + '-source.zip'))
        unpack(WORK / (service + '-source.zip'), WORK / (service + '-source'))
    # Clone only this project's dependencies, not private project configuration.
    subprocess.run(['cp', '-cR', str(PROJECT / 'frontend/node_modules'),
                    str(WORK / 'frontend-source/node_modules')], check=True, capture_output=True)
    unchanged_files = ['backend/.env', 'frontend/next-env.d.ts', 'frontend/tsconfig.json',
                       '.runtime/c160-review/backend-process.json']
    baseline = {file: hashlib.sha256((PROJECT / file).read_bytes()).hexdigest()
                for file in unchanged_files if (PROJECT / file).exists()}
    receipt = dict(phase='prepared', backend_port=BACKEND_PORT, frontend_port=FRONTEND_PORT,
                   original_file_hashes=baseline)
    private_json(WORK / 'receipt.json', receipt)
    return receipt


def build() -> dict:
    receipt = json.loads((WORK / 'receipt.json').read_text())
    if receipt['phase'] != 'prepared':
        raise ValueError('unexpected_rehearsal_phase')
    source = WORK / 'frontend-source'
    log = WORK / 'frontend-build.log'
    with log.open('wb') as output:
        os.chmod(log, 0o600)
        for command in (['npm', 'run', 'build'], ['npm', 'run', 'typecheck'],
                        ['npm', 'run', 'lint', '--', '--max-warnings', '0']):
            result = subprocess.run(command, cwd=source, env=child_env(),
                                    stdout=output, stderr=subprocess.STDOUT, timeout=240)
            if result.returncode:
                raise ValueError('frontend_build_or_checks_failed')
    standalone = source / '.next/standalone'
    shutil.copytree(source / 'public', standalone / 'public', dirs_exist_ok=True)
    shutil.copytree(source / '.next/static', standalone / '.next/static', dirs_exist_ok=True)
    names = [str(file.relative_to(standalone)) for file in standalone.rglob('*') if file.is_file()]
    zip_files(standalone, names, WORK / 'frontend-standalone-local.zip', source=False)
    unpack(WORK / 'frontend-standalone-local.zip', WORK / 'frontend-server')
    receipt.update(phase='built', front_local_platform=sys.platform,
                   frontend_build=True, frontend_typecheck=True, frontend_lint=True)
    private_json(WORK / 'receipt.json', receipt)
    return receipt


def exercise() -> dict:
    receipt = json.loads((WORK / 'receipt.json').read_text())
    if receipt['phase'] != 'built':
        raise ValueError('unexpected_rehearsal_phase')
    for port in (BACKEND_PORT, FRONTEND_PORT):
        with socket.socket() as probe:
            # An exited Linux server may leave TIME_WAIT sockets. Match the
            # production servers' reuse setting; active listeners still conflict.
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            probe.bind(('127.0.0.1', port))
    backend = WORK / 'backend-source'
    state = WORK / 'backend-state'
    state.mkdir(mode=0o700)
    processes: list[subprocess.Popen] = []
    checks: dict[str, bool] = {}

    def launch_backend(store: Path) -> subprocess.Popen:
        log = (WORK / 'backend-start.log').open('ab')
        os.chmod(WORK / 'backend-start.log', 0o600)
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '_serve',
                                    '--backend', str(backend), '--state', str(store)],
                                   cwd=backend, env=backend_env(store), stdout=log, stderr=log)
        log.close()
        processes.append(process)
        wait_ready(process, BACKEND_PORT, '/api/v1/auth/me')
        return process

    try:
        first = launch_backend(state)
        sessions = json.loads((WORK / 'session.json').read_text())
        token, other = sessions['token'], sessions['other_token']
        checks['anonymous_rejected'] = request(BACKEND_PORT, '/api/v1/auth/me')[0] == 401
        checks['development_token_rejected'] = request(BACKEND_PORT, '/api/v1/auth/me', 'synthetic-dev-token')[0] == 401
        status, _ = request(BACKEND_PORT, '/api/v1/auth/login', payload={'phone': '13800001212', 'code': '000000'})
        checks['unissued_code_rejected'] = status in (400, 401, 429)

        def owned(port: int, auth: str) -> list:
            status, body = request(port, '/api/v1/characters', auth)
            if status != 200:
                raise ValueError('character_read_failed')
            return json.loads(body)

        initial = owned(BACKEND_PORT, token)
        checks['owner_data_visible'] = any(c['id'] == sessions['character'] for c in initial)
        checks['other_account_isolated'] = owned(BACKEND_PORT, other) == []
        log = (WORK / 'frontend-start.log').open('wb')
        os.chmod(WORK / 'frontend-start.log', 0o600)
        frontend = subprocess.Popen(['node', 'server.js'], cwd=WORK / 'frontend-server',
                                    env=child_env(PORT=str(FRONTEND_PORT), HOSTNAME='127.0.0.1'),
                                    stdout=log, stderr=log)
        log.close()
        processes.append(frontend)
        wait_ready(frontend, FRONTEND_PORT, '/')
        status, body = request(FRONTEND_PORT, '/')
        checks['standalone_homepage'] = status == 200 and b'<html' in body
        assets = re.findall(rb'(?:src|href)="([^"?]+/_next/static/[^"?]+|/_next/static/[^"?]+)', body)
        checks['standalone_static_assets'] = bool(assets) and all(request(FRONTEND_PORT, a.decode())[0] == 200 for a in assets)
        checks['same_origin_owner_proxy'] = any(c['id'] == sessions['character'] for c in owned(FRONTEND_PORT, token))
        checks['same_origin_anonymous_rejected'] = request(FRONTEND_PORT, '/api/v1/auth/me')[0] == 401
        stop(first)
        second = launch_backend(state)
        checks['restart_data_recovered'] = any(c['id'] == sessions['character'] for c in owned(BACKEND_PORT, token))
        stop(second)
        sys.path.insert(0, str(PROJECT / 'backend/scripts'))
        import check_full_flow_recovery as recovery
        snapshot = WORK / 'snapshot'
        captured = recovery.capture(source=state, snapshot=snapshot, database_name='check.db')
        recovery.verify(source=state, snapshot=snapshot, database_name='check.db')
        restored = WORK / 'restored-state'
        restored_result = recovery.restore_test(restored, source=state, snapshot=snapshot, database_name='check.db')
        checks['new_directory_restore_verified'] = bool(captured) and bool(restored_result)
        recovered = launch_backend(restored)
        checks['restored_process_data_recovered'] = any(c['id'] == sessions['character'] for c in owned(BACKEND_PORT, token))
        checks['restored_upload_recovered'] = (restored / 'uploads/synthetic-recovery-marker.txt').read_text() == 'synthetic-r812-recovery-marker'
        stop(recovered)
        if not all(checks.values()):
            raise ValueError('rehearsal_checks_failed')
        receipt.update(phase='exercised', checks=checks, backup=captured, restore=restored_result,
                       real_sms_sends=0, model_calls=0, cloud_deployments=0)
        private_json(WORK / 'receipt.json', receipt)
        return receipt
    finally:
        for process in reversed(processes):
            stop(process)


def verify_artifacts() -> dict:
    receipt = json.loads((WORK / 'receipt.json').read_text())
    if receipt['phase'] != 'exercised':
        raise ValueError('unexpected_rehearsal_phase')
    from dotenv import dotenv_values
    needles = set()
    for name in ('.env', 'backend/.env', 'frontend/.env.local'):
        file = PROJECT / name
        if file.exists():
            for key, value in dotenv_values(file, interpolate=False).items():
                if value and len(value) >= 8 and re.search(r'KEY|SECRET|TOKEN|PASSWORD', key):
                    needles.add(value.encode())
    artifacts = []
    for name in ('backend-source.zip', 'frontend-source.zip', 'frontend-standalone-local.zip'):
        file = WORK / name
        with zipfile.ZipFile(file) as archive:
            names = archive.namelist()
            if name != 'frontend-standalone-local.zip' and any(denied(member) for member in names):
                raise ValueError('private_archive_member')
            if any(any(part.startswith('.env') and part not in ('.env.example', '.env.blueprint.example')
                       for part in PurePosixPath(member).parts) for member in names):
                raise ValueError('private_environment_in_archive')
            if any(any(needle in archive.read(member) for needle in needles) for member in names):
                raise ValueError('credential_in_archive')
            required = {'backend-source.zip': ['app/main.py', 'app/core/config.py', 'requirements.txt',
                                              'requirements-sms.txt', 'requirements-voice.txt'],
                        'frontend-source.zip': ['package.json', 'package-lock.json', 'next.config.ts'],
                        'frontend-standalone-local.zip': ['server.js', '.next/BUILD_ID']}[name]
            if not all(member in names for member in required):
                raise ValueError('required_archive_member_missing')
            artifacts.append(dict(name=name, bytes=file.stat().st_size, members=len(names),
                                  sha256=hashlib.sha256(file.read_bytes()).hexdigest(), credential_matches=0))
    unchanged = all((PROJECT / file).exists() and hashlib.sha256((PROJECT / file).read_bytes()).hexdigest() == digest
                    for file, digest in receipt['original_file_hashes'].items())
    if not unchanged:
        raise ValueError('original_configuration_changed')
    manifest = dict(artifacts=artifacts, original_configuration_unchanged=True,
                    ready_for_cloud_release=False, official_cli_offline_packaging=False,
                    linux_runtime_acceptance='pending', real_sms_acceptance='deferred')
    private_json(WORK / 'artifact-manifest.json', manifest)
    receipt.update(phase='verified', artifact_manifest=manifest)
    private_json(WORK / 'receipt.json', receipt)
    return receipt


def cleanup() -> dict:
    receipt = json.loads((WORK / 'receipt.json').read_text())
    if receipt['phase'] != 'verified':
        raise ValueError('unexpected_rehearsal_phase')
    for name in ('backend-source', 'frontend-source', 'frontend-server', 'backend-state',
                 'restored-state', 'snapshot'):
        directory = WORK / name
        if directory.is_symlink() or not directory.resolve().is_relative_to(WORK.resolve()):
            raise ValueError('invalid_cleanup_scope')
        if directory.exists():
            shutil.rmtree(directory)
    for name in ('session.json', 'backend-start.log', 'frontend-start.log', 'frontend-build.log'):
        (WORK / name).unlink(missing_ok=True)
    receipt.update(phase='finished', temporary_sessions_deleted=True, temporary_workspaces_deleted=True)
    private_json(WORK / 'receipt.json', receipt)
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser(description='仅本项目的本地包启动恢复演练，不发布')
    parser.add_argument('phase', choices=['prepare', 'build', 'exercise', 'verify', 'cleanup', 'status', '_serve'])
    parser.add_argument('--backend', type=Path)
    parser.add_argument('--state', type=Path)
    args = parser.parse_args()
    try:
        if args.phase == '_serve':
            if args.backend != WORK / 'backend-source' or args.state not in (WORK / 'backend-state', WORK / 'restored-state'):
                raise ValueError('invalid_rehearsal_scope')
            serve(args.backend, args.state)
            return 0
        result = {'prepare': prepare, 'build': build, 'exercise': exercise,
                  'verify': verify_artifacts, 'cleanup': cleanup}.get(args.phase)
        report = result() if result else json.loads((WORK / 'receipt.json').read_text())
        print(json.dumps(report, ensure_ascii=False))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'release_rehearsal_failed',
                                   'message': '本地演练未通过，固定工作目录内检查；详情不回显'}}, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
