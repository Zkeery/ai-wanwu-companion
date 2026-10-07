"""Project-local Linux acceptance; never loads user credentials or deploys to cloud."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
from urllib.request import urlopen
import zipfile

PROJECT = Path(__file__).resolve().parents[2]
WORK = PROJECT / '.runtime/r813-linux'
# This project path leaves exactly enough room for Lima's socket suffix. Temporary
# Lima directories at its root are ignored and removed after the isolated run.
LIMA_HOME = PROJECT
INSTANCE = 'l'
GUEST = '/home/lima/ai-companions-r813'
ASSETS = [
    ('lima-2.2.0-Darwin-arm64.tar.gz',
     'https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-2.2.0-Darwin-arm64.tar.gz',
     'bbdef91774885a0d05f7b048c4eb89ae2bcf3a0c252ae7ca7934e63df76d93c3'),
    ('lima-additional-guestagents-2.2.0-Darwin-arm64.tar.gz',
     'https://github.com/lima-vm/lima/releases/download/v2.2.0/lima-additional-guestagents-2.2.0-Darwin-arm64.tar.gz',
     '3aff4453eb3c359eb4f3b458056db24f2c5c15019232531292f49e04050554ed'),
    ('ubuntu-arm64.img',
     'https://cloud-images.ubuntu.com/releases/noble/release-20260705/ubuntu-24.04-server-cloudimg-arm64.img',
     '7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc'),
    ('node-v24.21.0-linux-arm64.tar.xz',
     'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz',
     '6ad1325edbdb5649c379b75a237147a666c95d4f9ae8d340fef2d1575d289ad2'),
]


def save(file: Path, value: dict) -> None:
    file.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    file.chmod(0o600)


def download(name: str, url: str, digest: str) -> Path:
    target = WORK / name
    if not target.exists():
        partial = target.with_suffix(target.suffix + '.part')
        with urlopen(url, timeout=60) as response, partial.open('wb') as output:
            partial.chmod(0o600)
            shutil.copyfileobj(response, output, length=1024 * 1024)
        partial.replace(target)
    hasher = hashlib.sha256()
    with target.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            hasher.update(block)
    if hasher.hexdigest() != digest:
        raise ValueError('download_digest_mismatch:' + name)
    print('verified_download=' + name, flush=True)
    return target


def install() -> None:
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise ValueError('requires_apple_silicon_host')
    WORK.mkdir(mode=0o700, exist_ok=True)
    LIMA_HOME.mkdir(mode=0o700, exist_ok=True)
    tools = WORK / 'tools'
    tools.mkdir(mode=0o700, exist_ok=True)
    baseline = WORK / 'host-baseline.json'
    if not baseline.exists():
        names = ['backend/.env', 'frontend/next-env.d.ts', 'frontend/tsconfig.json',
                 '.runtime/c160-review/backend-process.json']
        save(baseline, {n: hashlib.sha256((PROJECT / n).read_bytes()).hexdigest()
                        for n in names if (PROJECT / n).exists()})
    for name, url, digest in ASSETS:
        file = download(name, url, digest)
        if name.endswith('.tar.gz'):
            with tarfile.open(file) as archive:
                archive.extractall(tools, filter='data')
    config = WORK / 'linux.yaml'
    # Local, hash-checked image avoids Lima's global host download cache.
    config.write_text('vmType: vz\narch: aarch64\ncpus: 4\nmemory: 4GiB\ndisk: 20GiB\n'
                      'images:\n- location: ' + json.dumps(str(WORK / 'ubuntu-arm64.img')) + '\n'
                      '  arch: aarch64\n  digest: sha256:' + ASSETS[2][2] + '\n'
                      'mounts: []\ncontainerd:\n  system: false\n  user: false\n'
                      'portForwards:\n- guestPortRange: [1, 65535]\n  ignore: true\n', encoding='utf-8')
    config.chmod(0o600)
    save(WORK / 'setup.json', dict(lima='2.2.0', ubuntu='24.04', architecture='aarch64',
                                 cpu=4, memory_gib=4, disk_gib=20, mounts=[], assets=ASSETS))


def env() -> dict[str, str]:
    result = {k: os.environ[k] for k in ('HOME', 'PATH', 'TMPDIR', 'LANG') if k in os.environ}
    result.update(LIMA_HOME=str(LIMA_HOME), LIMA_WORKDIR='/',
                  XDG_CACHE_HOME=str(WORK / 'host-cache'), NO_COLOR='1')
    return result


def lima(*args: str, timeout: int = 600) -> bytes:
    result = subprocess.run([str(WORK / 'tools/bin/limactl'), *args], env=env(),
                            cwd=PROJECT, capture_output=True, timeout=timeout)
    with (WORK / 'operations.log').open('ab') as log:
        log.write(result.stdout + result.stderr)
    (WORK / 'operations.log').chmod(0o600)
    if result.returncode:
        raise ValueError('lima_command_failed:' + args[0])
    return result.stdout


def start() -> None:
    lima('start', '--name=' + INSTANCE, '--tty=false', str(WORK / 'linux.yaml'), timeout=600)
    print('linux_vm_started', flush=True)


def transfer() -> None:
    home = lima('shell', INSTANCE, 'sh', '-c', 'printf %s "$HOME"').decode().strip()
    guest = home + '/ai-companions-r813'
    save(WORK / 'guest.json', dict(root=guest))
    lima('shell', INSTANCE, 'mkdir', '-m', '700', guest)
    from rehearse_release import source_files, zip_files
    for service in ('backend', 'frontend'):
        file = WORK / (service + '-source.zip')
        zip_files(PROJECT / service, source_files(PROJECT / service), file)
        lima('copy', str(file), INSTANCE + ':' + guest + '/' + file.name)
    lima('copy', str(WORK / ASSETS[3][0]), INSTANCE + ':' + guest + '/' + ASSETS[3][0])
    print('credential_free_sources_transferred', flush=True)


def guest_root() -> str:
    return json.loads((WORK / 'guest.json').read_text())['root']


def guest_prepare() -> None:
    root = guest_root()
    # Fixed commands run only inside the isolated VM. No host directories are mounted.
    script = '''set -eu
cd "$1"
sudo apt-get update
sudo apt-get install -y python3.12-venv python3-pip unzip
python3 -m zipfile -e backend-source.zip backend
python3 -m zipfile -e frontend-source.zip frontend
tar -xJf node-v24.21.0-linux-arm64.tar.xz
export PATH="$PWD/node-v24.21.0-linux-arm64/bin:$PATH"
python3 -m venv backend/.venv
backend/.venv/bin/pip install --no-cache-dir -r backend/requirements.txt -r backend/requirements-sms.txt
cd frontend
npm ci --no-audit --no-fund
cd ..
backend/.venv/bin/python backend/scripts/linux_rehearsal.py guest
'''
    lima('shell', INSTANCE, 'sh', '-c', script, 'r813', root, timeout=1500)
    print('linux_install_build_and_acceptance_passed', flush=True)


def guest() -> None:
    if sys.platform != 'linux' or platform.machine() != 'aarch64':
        raise ValueError('requires_linux_arm64_guest')
    import rehearse_release as rehearsal
    if rehearsal.WORK.exists():
        receipt = json.loads((rehearsal.WORK / 'receipt.json').read_text())
        if receipt['phase'] != 'prepared':
            raise ValueError('cannot_replace_built_or_exercised_guest')
        shutil.rmtree(rehearsal.WORK)  # Failed pre-build copy only; no live service.
    rehearsal.WORK.mkdir(mode=0o700, parents=True)
    for service in ('backend', 'frontend'):
        shutil.copyfile(PROJECT / (service + '-source.zip'), rehearsal.WORK / (service + '-source.zip'))
        # Dependencies were freshly installed on Linux, never copied from macOS.
        shutil.copytree(PROJECT / service, rehearsal.WORK / (service + '-source'), symlinks=True)
    rehearsal.private_json(rehearsal.WORK / 'receipt.json', dict(phase='prepared',
                            backend_port=rehearsal.BACKEND_PORT, frontend_port=rehearsal.FRONTEND_PORT,
                            original_file_hashes={}))
    test_log = rehearsal.WORK / 'backend-tests.log'
    with test_log.open('wb') as output:
        result = subprocess.run([sys.executable, '-m', 'pytest', '-q',
                                 'tests/test_release_rehearsal.py', 'tests/test_release_security.py',
                                 'tests/test_release_readiness.py', 'tests/test_runtime_recovery.py'],
                                cwd=PROJECT / 'backend', env=rehearsal.child_env(APP_ENV='development',
                                     MODEL_API_KEY='', MODEL_BASE_URL='', IMAGE_BASE_URL='', SMS_LIVE_ENABLED='false'),
                                stdout=output, stderr=subprocess.STDOUT, timeout=120)
    if result.returncode:
        raise ValueError('linux_backend_tests_failed')
    rehearsal.build()
    rehearsal.exercise()
    receipt = json.loads((rehearsal.WORK / 'receipt.json').read_text())
    save(PROJECT / 'linux-result.json', dict(architecture=platform.machine(), platform=sys.platform,
         python=platform.python_version(), node=subprocess.check_output(['node', '--version']).decode().strip(),
         os_release=Path('/etc/os-release').read_text(), backend_tests=test_log.read_text().splitlines()[-1],
         dependency_install='fresh_linux', receipt=receipt))
    print('linux_13_acceptance_checks_passed', flush=True)


def resume() -> None:
    """Refresh the failed backend source snapshot, preserving installed Linux deps."""
    root = guest_root()
    from rehearse_release import source_files, zip_files
    archive = WORK / 'backend-source.zip'
    if (WORK / 'linux-result.json').exists():
        raise ValueError('cannot_replace_verified_sources')
    archive.unlink()
    zip_files(PROJECT / 'backend', source_files(PROJECT / 'backend'), archive)
    lima('copy', str(archive), INSTANCE + ':' + root + '/backend-source.zip')
    lima('copy', str(Path(__file__).resolve()), INSTANCE + ':' + root + '/backend/scripts/linux_rehearsal.py')
    # Only the controller changed; dependencies remain the freshly installed ones.
    lima('shell', INSTANCE, 'sh', '-c',
         'export PATH="$1/node-v24.21.0-linux-arm64/bin:$PATH"; '
         'python3 -m zipfile -e "$1/backend-source.zip" "$1/backend"; '
         'exec "$1/backend/.venv/bin/python" "$1/backend/scripts/linux_rehearsal.py" guest',
         'r813', root, timeout=600)
    print('linux_acceptance_resumed', flush=True)


def collect() -> None:
    root = guest_root()
    lock = WORK / 'requirements-linux-arm64.lock'
    lock.write_bytes(lima('shell', INSTANCE, root + '/backend/.venv/bin/pip', 'freeze'))
    lock.chmod(0o600)
    for name, remote in [('linux-result.json', root + '/linux-result.json'),
                         ('frontend-standalone-linux-arm64.zip', root + '/.runtime/r812-release-rehearsal/frontend-standalone-local.zip')]:
        lima('copy', INSTANCE + ':' + remote, str(WORK / name))
        (WORK / name).chmod(0o600)
    from dotenv import dotenv_values
    import re
    needles = set()
    for name in ('.env', 'backend/.env', 'frontend/.env.local'):
        file = PROJECT / name
        if file.exists():
            needles.update(v.encode() for k, v in dotenv_values(file, interpolate=False).items()
                           if v and len(v) >= 8 and re.search(r'KEY|SECRET|TOKEN|PASSWORD', k))
    artifacts = []
    for file in sorted(WORK.glob('*.zip')):
        with zipfile.ZipFile(file) as archive:
            from rehearse_release import denied
            if file.name.endswith('source.zip') and any(denied(n) for n in archive.namelist()):
                raise ValueError('private_source_member')
            if any(any(p.startswith('.env') and p not in ('.env.example', '.env.blueprint.example')
                       for p in Path(n).parts) for n in archive.namelist()):
                raise ValueError('private_environment_in_archive')
            if any(any(v in archive.read(n) for v in needles) for n in archive.namelist()):
                raise ValueError('host_secret_in_archive')
            native = []
            for n in archive.namelist():
                if n.endswith('.node') or Path(n).name.startswith('libz.so'):
                    header = archive.read(n)[:20]
                    if header[:4] != b'\x7fELF' or int.from_bytes(header[18:20], 'little') != 183:
                        raise ValueError('unexpected_native_binary_platform')
                    native.append(n)
            artifacts.append(dict(name=file.name, members=len(archive.namelist()), bytes=file.stat().st_size,
                                  sha256=hashlib.sha256(file.read_bytes()).hexdigest(), credential_matches=0,
                                  linux_arm64_native_binary_count=len(native)))
    baseline = json.loads((WORK / 'host-baseline.json').read_text())
    unchanged = all(hashlib.sha256((PROJECT / n).read_bytes()).hexdigest() == digest
                    for n, digest in baseline.items())
    if not unchanged:
        raise ValueError('original_configuration_changed')
    save(WORK / 'artifact-manifest.json', dict(artifacts=artifacts, scanned_secret_count=len(needles),
         original_configuration_unchanged=unchanged,
         linux_arm64_verified=True, x86_64_verified=False, cloud_release_verified=False,
         real_sms_verified=False, real_models_verified=False))
    print('linux_artifacts_collected_and_scanned', flush=True)


def cleanup() -> None:
    result = json.loads((WORK / 'linux-result.json').read_text())
    manifest = json.loads((WORK / 'artifact-manifest.json').read_text())
    if not all(result['receipt']['checks'].values()) or not manifest['linux_arm64_verified']:
        raise ValueError('cannot_cleanup_unverified_run')
    # Only this task's fixed instance is deleted. No global Lima home is touched.
    lima('stop', INSTANCE, timeout=60)
    lima('delete', '--force', INSTANCE, timeout=60)
    for name in ('_config', '_networks', '_disks', '_templates'):
        file = PROJECT / name
        if file.exists():
            shutil.rmtree(file)
    for name in ('tools', 'host-cache'):
        file = WORK / name
        if file.exists():
            shutil.rmtree(file)
    for name, _, _ in ASSETS:
        (WORK / name).unlink(missing_ok=True)
    for name in ('operations.log', 'guest.json'):
        (WORK / name).unlink(missing_ok=True)
    old = PROJECT / '.runtime/l13'
    if old.exists():
        old.rmdir()  # Empty failed initial socket-path attempt only.
    save(WORK / 'cleanup.json', dict(phase='finished', vm_deleted=True, guest_user_data_deleted=True,
                                   host_tools_removed=True, source_and_linux_packages_retained=True))
    print('temporary_vm_tools_and_synthetic_data_removed', flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['install', 'start', 'transfer', 'prepare', 'guest', 'resume', 'collect', 'stop', 'cleanup'])
    phase = parser.parse_args().phase
    if phase == 'stop':
        lima('stop', INSTANCE, timeout=60)
        print('linux_vm_stopped', flush=True)
    else:
        {'install': install, 'start': start, 'transfer': transfer, 'prepare': guest_prepare,
         'guest': guest, 'resume': resume, 'collect': collect, 'cleanup': cleanup}[phase]()


if __name__ == '__main__':
    main()
