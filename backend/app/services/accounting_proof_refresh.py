"""Consume reviewed private financial snapshots. No network or model client.

This is the internal snapshot contract, NOT an implementation of an unknown
vendor cash API. A separately approved official-source adapter must produce it.
The updater never creates a trial, resets a stopped gate, or changes source time.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import time
from uuid import uuid4

from app.services.trial_gate import TrialBlocked, integer

KINDS = ('private_life', 'shared_life')
REQUIRED = {'maas': 6873600}
CONFIG = 'funding-source.json'
STATE = 'funding-refresh-state.json'


def _raw(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, 'rb') as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 65536:
                raise ValueError()
            raw = handle.read(65537)
        if len(raw) > 65536:
            raise ValueError()
        return raw
    except (OSError, ValueError, TypeError):
        raise TrialBlocked('private_financial_snapshot_required') from None


def _private(path):
    raw = _raw(path)
    return _object(raw), raw


def _object(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    def constant(_value):
        raise ValueError()
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
        if not isinstance(value, dict):
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise TrialBlocked('private_financial_snapshot_required') from None


def _atomic(path, value):
    if path.is_symlink():
        raise TrialBlocked('financial_path_invalid')
    raw = value if isinstance(value, bytes) else json.dumps(value, sort_keys=True).encode()
    temp = path.with_name('.' + path.name + '-' + uuid4().hex)
    try:
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'wb') as out:
            out.write(raw); out.flush(); os.fsync(out.fileno())
        os.replace(temp, path)
        fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        if temp.exists():
            temp.unlink()


def _directory(directory):
    path = Path(directory).absolute()
    if path.is_symlink() or not path.is_dir() or path.stat().st_mode & 0o077:
        raise TrialBlocked('private_financial_directory_required')
    return path


@contextmanager
def _lock(directory):
    fd = os.open(directory / 'funding-refresh.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'a') as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise TrialBlocked('financial_refresh_busy') from None
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _config(directory):
    config, _ = _private(directory / CONFIG)
    if config.get('mode', 'life') not in ('life', 'shared_dialogue'):
        raise TrialBlocked('financial_source_contract_required')
    if type(config.get('schema_version')) is not int or config['schema_version'] != 1 or type(config.get('enabled')) is not bool:
        raise TrialBlocked('financial_source_contract_required')
    if not config['enabled']:
        return config
    contract = config.get('source_contract', {})
    ref, account = config.get('authorization_ref'), config.get('account')
    if (not isinstance(ref, str) or not 8 <= len(ref) <= 120
            or not isinstance(account, str) or not 0 < len(account) <= 128
            or config.get('vendor') != 'maas' or not isinstance(contract, dict)
            or contract.get('approved') is not True
            or contract.get('transport') != 'private_snapshot_v1'
            or contract.get('scope') != 'balance_and_full_pending'
            or contract.get('query_fee_verified') is not True
            or type(contract.get('query_fee_micro')) is not int or contract['query_fee_micro'] != 0
            or contract.get('permissions_approved') is not True
            or not isinstance(contract.get('official_reference'), str)
            or not contract['official_reference'].startswith('https://')):
        raise TrialBlocked('financial_source_contract_required')
    return config


def _validate(config, source, now):
    from app.services.trial_admission import validate_evidence
    single = config.get('mode') == 'shared_dialogue'
    kinds = ('shared_life',) if single else KINDS
    required = {'maas': 1145600} if single else REQUIRED
    if (type(source.get('schema_version')) is not int or source['schema_version'] != 1
            or source.get('source_type') not in ('official_api', 'official_console')
            or source.get('includes_unbilled') is not True
            or source.get('includes_unsettled') is not True
            or not integer(source.get('observed_at'))
            or not integer(source.get('covers_through'))
            or not 0 <= now - source['observed_at'] <= 900
            or not source['observed_at'] <= source['covers_through'] <= now):
        raise TrialBlocked('complete_financial_snapshot_required')
    evidence = source.get('evidence')
    if not isinstance(evidence, dict) or set(evidence) != set(kinds):
        raise TrialBlocked('complete_financial_snapshot_required')
    timestamps = []
    for kind in kinds:
        try:
            wallet, price = evidence[kind]['wallet'], evidence[kind]['price']
            if wallet['account'] != config['account'] or wallet['source_type'] != source['source_type']:
                raise KeyError()
            for record in (wallet, price):
                checked = record['checked_at']
                if not integer(checked) or checked > source['observed_at']:
                    raise KeyError()
                timestamps.append(checked)
        except (KeyError, TypeError):
            raise TrialBlocked('financial_snapshot_binding_invalid') from None
    result = validate_evidence(evidence, config['authorization_ref'], kinds, now, required)
    return evidence, min(timestamps), result['expires_at']


def check(directory, *, clock=time.time):
    """Read-only readiness. Never creates files or updates proof timestamps."""
    directory = _directory(directory)
    config = _config(directory)
    if not config['enabled']:
        return {'status': 'disabled', 'new_model_posts': 0, 'worker_started': False}
    state_path = directory / STATE
    if state_path.exists() or state_path.is_symlink():
        state, _ = _private(state_path)
        if state.get('status') != 'ready' or state.get('authorization_ref') != config['authorization_ref']:
            raise TrialBlocked('financial_refresh_stopped')
    source, _ = _private(directory / 'funding-input.json')
    _, _, expires = _validate(config, source, int(clock()))
    return {'status': 'ready_for_publication', 'expires_at': expires,
            'new_model_posts': 0, 'worker_started': False}


def refresh(directory, *, clock=time.time):
    """Publish once. Unknown/error latches stopped; scheduled reads never reopen it."""
    directory = _directory(directory)
    with _lock(directory):
        prior = None
        state_path = directory / STATE
        if state_path.exists() or state_path.is_symlink():
            prior, _ = _private(state_path)
            if prior.get('status') != 'ready':
                return {'status': 'stopped', 'code': 'financial_refresh_stopped',
                        'new_model_posts': 0, 'worker_started': False}
        elif any(directory.glob('funding-record-*')):
            # Historical receipts prove this is not a first publication.
            # Losing the guard cannot turn a stopped/unknown run into a new one.
            _atomic(state_path, {'status': 'stopped', 'checked_at': int(clock()),
                                 'code': 'financial_refresh_state_missing'})
            return {'status': 'stopped', 'code': 'financial_refresh_state_missing',
                    'new_model_posts': 0, 'worker_started': False}
        # The guard becomes blocking BEFORE reading any new financial input.
        now = int(clock())
        _atomic(state_path, {'status': 'updating', 'checked_at': now})
        receipt = directory / ('funding-record-' + uuid4().hex)
        config = None
        try:
            receipt.mkdir(mode=0o700)
            if (directory / 'evidence.json').exists():
                original = _raw(directory / 'evidence.json')
                _atomic(receipt / 'previous-evidence.json', original)
                if prior and hashlib.sha256(original).hexdigest() != prior.get('evidence_sha256'):
                    raise TrialBlocked('published_financial_proof_changed')
            elif prior:
                raise TrialBlocked('published_financial_proof_missing')
            config_raw = _raw(directory / CONFIG)
            _atomic(receipt / CONFIG, config_raw)
            raw = _raw(directory / 'funding-input.json')
            _atomic(receipt / 'source.json', raw)
            config = _config(directory)
            if not config['enabled']:
                raise TrialBlocked('financial_refresh_disabled')
            if prior and prior.get('authorization_ref') != config['authorization_ref']:
                raise TrialBlocked('financial_authorization_changed')
            source = _object(raw)
            evidence, source_at, expires = _validate(config, source, now)
            if prior and (source['observed_at'] < prior['observed_at'] or source_at < prior['source_checked_at']):
                raise TrialBlocked('financial_snapshot_replayed')
            proof = json.dumps(evidence, sort_keys=True).encode()
            digest = hashlib.sha256(proof).hexdigest()
            state = {'status': 'ready', 'authorization_ref': config['authorization_ref'],
                     'observed_at': source['observed_at'], 'source_checked_at': source_at,
                     'published_at': now, 'expires_at': expires, 'evidence_sha256': digest,
                     'source_sha256': hashlib.sha256(raw).hexdigest()}
            # Evidence is published first; a crash leaves the guard closed.
            _atomic(directory / 'evidence.json', proof)
            _atomic(state_path, state)
            _atomic(receipt / 'result.json', state)
            return {'status': 'ready', 'expires_at': expires,
                    'new_model_posts': 0, 'worker_started': False}
        except Exception as error:
            code = str(error) if isinstance(error, TrialBlocked) else 'financial_refresh_failed'
            state = {'status': 'stopped', 'checked_at': now, 'code': code}
            # A failure here leaves 'updating', which the reader also blocks.
            _atomic(state_path, state)
            _atomic(receipt / 'result.json', state)
            return {'status': 'stopped', 'code': code, 'new_model_posts': 0, 'worker_started': False}


def read_published(path, authorization_ref):
    """Optional strict guard for existing life readers; old manual proofs still work."""
    path = Path(path)
    state_path = path.parent / STATE
    if not state_path.exists() and not state_path.is_symlink():
        config_path = path.parent / CONFIG
        if config_path.exists() or config_path.is_symlink():
            # Opting into the updater closes the legacy path even before its
            # first publication, or if its state file was removed.
            raise TrialBlocked('financial_refresh_not_ready')
        from app.services.trial_wiring import private_json
        return private_json(path)
    state, _ = _private(state_path)
    config = _config(path.parent)
    evidence, raw = _private(path)
    if (not config['enabled'] or state.get('status') != 'ready'
            or state.get('authorization_ref') != authorization_ref
            or config['authorization_ref'] != authorization_ref
            or hashlib.sha256(raw).hexdigest() != state.get('evidence_sha256')):
        raise TrialBlocked('financial_refresh_not_ready')
    return evidence
