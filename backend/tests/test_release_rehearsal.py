"""Boundary checks for the local-only archive and isolated process controller."""
import os
from pathlib import Path
import socket
import zipfile

import pytest

from scripts import rehearse_release as rehearsal


@pytest.mark.parametrize('name', ['../outside', '/absolute', 'a\\outside', '.env',
                                  'a/.env.production', 'data/user.db', 'uploads/private.png',
                                  '.runtime/check.db', 'node_modules/dependency/index.js',
                                  'root.sqlite3-wal'])
def test_private_or_escaping_sources_are_denied(name):
    assert rehearsal.denied(name)


def test_archive_refuses_symlinks_and_traversal(tmp_path):
    base = tmp_path / 'source'
    base.mkdir()
    outside = tmp_path / 'outside.txt'
    outside.write_text('keep')
    (base / 'alias').symlink_to(outside)
    for name, target in [('alias', 'alias.zip'), ('../outside.txt', 'traversal.zip')]:
        with pytest.raises(ValueError):
            rehearsal.zip_files(base, [name], tmp_path / target)
    assert outside.read_text() == 'keep'


def test_safe_archive_contains_exact_files_and_never_overwrites(tmp_path):
    base = tmp_path / 'source'
    base.mkdir()
    (base / 'app.py').write_text('pass')
    output = tmp_path / 'source.zip'
    rehearsal.zip_files(base, ['app.py'], output)
    with zipfile.ZipFile(output) as archive:
        assert archive.namelist() == ['app.py']
        assert archive.read('app.py') == b'pass'
    before = output.read_bytes()
    with pytest.raises(ValueError):
        rehearsal.zip_files(base, ['app.py'], output)
    assert output.read_bytes() == before
    assert output.stat().st_mode & 0o777 == 0o600


def test_untrusted_archive_fails_before_creating_target(tmp_path):
    archive_path = tmp_path / 'unsafe.zip'
    with zipfile.ZipFile(archive_path, 'w') as archive:
        archive.writestr('../escape.txt', 'unsafe')
    target = tmp_path / 'restored'
    with pytest.raises(ValueError):
        rehearsal.unpack(archive_path, target)
    assert not target.exists()
    assert not (tmp_path / 'escape.txt').exists()


def test_existing_work_is_untouched(monkeypatch, tmp_path):
    marker = tmp_path / 'marker'
    marker.write_text('keep')
    monkeypatch.setattr(rehearsal, 'WORK', tmp_path)
    with pytest.raises(FileExistsError):
        rehearsal.prepare()
    assert marker.read_text() == 'keep'


def test_child_environment_never_inherits_real_provider_credentials(monkeypatch, tmp_path):
    for key in ('MODEL_API_KEY', 'SMS_SECRET_ACCESS_KEY', 'VOLC_TOKEN', 'NEXT_PUBLIC_DEV_SMS_CODE'):
        monkeypatch.setenv(key, 'real-input-must-not-be-inherited')
    env = rehearsal.backend_env(tmp_path)
    assert 'real-input-must-not-be-inherited' not in env.values()
    assert env['MODEL_API_KEY'] == 'synthetic-offline-model-key'
    assert 'VOLC_TOKEN' not in env
    assert env['DEV_AUTH_TOKEN'] == env['DEV_SMS_FIXED_CODE'] == ''
    assert env['LIFE_RUNTIME_ENABLED'] == env['GATHERING_DIALOGUE_AUTOMATIC_ENABLED'] == 'false'


def test_network_guard_rejects_external_resolution_and_connections():
    original_connect, original_resolve = socket.socket.connect, socket.getaddrinfo
    try:
        rehearsal.block_external_network()
        with pytest.raises(RuntimeError):
            socket.getaddrinfo('example.invalid', 443)
        with socket.socket() as client:
            with pytest.raises(RuntimeError):
                client.connect(('203.0.113.1', 443))
    finally:
        socket.socket.connect, socket.getaddrinfo = original_connect, original_resolve
