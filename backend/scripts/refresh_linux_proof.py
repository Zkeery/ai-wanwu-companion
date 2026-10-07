"""Repeat production process/recovery proof after installing the native PNG codec."""
import json
from importlib.metadata import version
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from linux_rehearsal import PROJECT, WORK, INSTANCE, guest_root, lima, save
from rehearse_release import source_files, zip_files, unpack


def guest():
    if sys.platform != 'linux' or platform.machine() != 'aarch64':
        raise ValueError('requires_isolated_linux_arm64_guest')
    import rehearse_release as proof
    receipt = json.loads((proof.WORK / 'receipt.json').read_text())
    if receipt['phase'] not in ('exercised', 'built'):
        raise ValueError('requires_finished_initial_process_proof')
    proof.private_json(proof.WORK / 'before-codec-receipt.json', receipt)
    for name in ('backend-source', 'backend-state', 'snapshot', 'restored-state'):
        if (proof.WORK / name).exists():
            shutil.rmtree(proof.WORK / name)
    (proof.WORK / 'session.json').unlink(missing_ok=True)
    unpack(PROJECT / 'backend-source.zip', proof.WORK / 'backend-source')
    original_env = proof.backend_env

    def native_env(state):
        return {**original_env(state), 'LD_LIBRARY_PATH': str(PROJECT / '.runtime/r813-codec/lib')}

    proof.backend_env = native_env
    receipt.update(phase='built')
    for name in ('checks', 'backup', 'restore'):
        receipt.pop(name, None)
    proof.private_json(proof.WORK / 'receipt.json', receipt)
    proof.exercise()
    value = json.loads((PROJECT / 'linux-result.json').read_text())
    value['receipt'] = json.loads((proof.WORK / 'receipt.json').read_text())
    value['native_codec'] = 'zlib-ng 2.3.3 compat'
    value['sqlalchemy'] = version('SQLAlchemy')
    save(PROJECT / 'linux-result.json', value)
    package = PROJECT / '.runtime/r813-codec-package'
    if package.exists():
        shutil.rmtree(package)  # This proof's previous synthetic packaging copy.
    (package / 'lib').mkdir(mode=0o700, parents=True)
    prefix = PROJECT / '.runtime/r813-codec'
    for file in (prefix / 'lib').glob('libz.so*'):
        if not file.resolve().is_relative_to(prefix):
            raise ValueError('unexpected_native_library_target')
        shutil.copyfile(file, package / 'lib' / file.name)  # Regular copies; no archive symlinks.
    shutil.copyfile(PROJECT / '.runtime/r813-codec-source/LICENSE.md', package / 'LICENSE.md')
    names = [str(p.relative_to(package)) for p in package.rglob('*') if p.is_file()]
    (PROJECT / 'codec-linux-arm64.zip').unlink(missing_ok=True)
    zip_files(package, names, PROJECT / 'codec-linux-arm64.zip', source=False)
    print('native_production_restart_and_restore_13_checks_passed')


def host():
    root = guest_root()
    old = dict(result=json.loads((WORK / 'linux-result.json').read_text()),
               manifest=json.loads((WORK / 'artifact-manifest.json').read_text()))
    save(WORK / 'before-codec-proof.json', old)
    archive = WORK / 'backend-source-final.zip'
    archive.unlink(missing_ok=True)  # Replace only the failed draft from this proof.
    zip_files(PROJECT / 'backend', source_files(PROJECT / 'backend'), archive)
    lima('copy', str(archive), INSTANCE + ':' + root + '/backend-source.zip')
    lima('shell', INSTANCE, 'python3', '-m', 'zipfile', '-e', root + '/backend-source.zip', root + '/backend')
    lima('shell', INSTANCE, 'env', 'LD_LIBRARY_PATH=' + root + '/.runtime/r813-codec/lib',
         'PATH=' + root + '/node-v24.21.0-linux-arm64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
         root + '/backend/.venv/bin/python', root + '/backend/scripts/refresh_linux_proof.py', 'guest', timeout=120)
    for name in ('linux-result.json', 'codec-linux-arm64.zip'):
        lima('copy', INSTANCE + ':' + root + '/' + name, str(WORK / name))
        (WORK / name).chmod(0o600)
    (WORK / 'backend-source.zip').unlink()
    archive.rename(WORK / 'backend-source.zip')
    print('updated_linux_source_and_native_codec_package_ready')


if __name__ == '__main__':
    if sys.argv[1:] == ['guest']:
        guest()
    elif not sys.argv[1:]:
        host()
    else:
        raise ValueError('unknown_mode')
