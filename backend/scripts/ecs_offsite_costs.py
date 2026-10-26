"""Fail-closed, local-only spending gate for the ECS offsite adapter.

An operator's short-lived console observation is not a live balance API or an
account spending cap. Missing observations never imply available funds.
"""
from __future__ import annotations

from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import re
import stat

POLICY_FILE = 'offsite-cost-controls.json'
BALANCE_FILE = 'offsite-balance-evidence.json'
MAX_AGE = 900
FLOOR = Decimal('0.50')


def approval_sha(config: dict) -> str:
    return hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate_field')
        result[key] = value
    return result


def private_json(path: Path) -> tuple[dict, str]:
    # O_NONBLOCK also prevents a malformed FIFO from hanging the spending gate.
    if path.parent.is_symlink():
        raise ValueError('unsafe_parent')
    parent = path.parent.stat()
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.geteuid() or parent.st_mode & 0o077:
        raise ValueError('private_parent_required')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o077 or not 0 < info.st_size <= 16384):
            raise ValueError('private_regular_file_required')
        raw = stream.read(16385)
    if len(raw) > 16384:
        raise ValueError('oversized_evidence')
    data = json.loads(raw, object_pairs_hook=unique_object)
    if not isinstance(data, dict):
        raise ValueError('object_required')
    return data, hashlib.sha256(raw).hexdigest()


def money(value) -> Decimal:
    if not isinstance(value, str) or not re.fullmatch(r'-?\d{1,10}(?:\.\d{1,6})?', value):
        raise ValueError('invalid_money')
    return Decimal(value)


def policy(root: Path) -> dict:
    try:
        data, checksum = private_json(root / 'private' / POLICY_FILE)
        if (type(data.get('schema_version')) is not int or data['schema_version'] != 1
                or type(data.get('enabled')) is not bool
                or data.get('minimum_remaining_cny') != '0.50'
                or type(data.get('max_balance_age_seconds')) is not int
                or data['max_balance_age_seconds'] != MAX_AGE
                or data.get('verification_mode') != 'metadata'
                or data.get('allow_full_download') is not False):
            raise ValueError('invalid_policy')
        if not data['enabled']:
            return {'allowed': False, 'reason': 'offsite_cost_controls_paused'}
        return {'allowed': True, 'policy_sha256': checksum}
    except FileNotFoundError:
        return {'allowed': False, 'reason': 'offsite_cost_policy_missing'}
    except (ValueError, OSError, TypeError):
        return {'allowed': False, 'reason': 'offsite_cost_policy_invalid'}


def check(root: Path, config: dict, now: int, *, own_run: str | None = None) -> dict:
    gate = policy(root)
    if not gate['allowed']:
        return gate
    try:
        data, checksum = private_json(root / 'private' / BALANCE_FILE)
        checksum = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        if (type(data.get('schema_version')) is not int or data['schema_version'] != 1
                or data.get('source') != 'volcengine_console_readonly'
                or data.get('approval_sha256') != approval_sha(config)
                or data.get('unbilled_reviewed') is not True
                or not isinstance(data.get('evidence_ref'), str)
                or not 1 <= len(data['evidence_ref'].strip()) <= 200):
            return {'allowed': False, 'reason': 'offsite_balance_unknown'}
        checked, until = data.get('checked_at'), data.get('valid_until')
        if (type(checked) is not int or type(until) is not int
                or not 0 < until - checked <= MAX_AGE
                or not checked <= now < until or now - checked > MAX_AGE):
            return {'allowed': False, 'reason': 'offsite_balance_stale'}
        available = money(data.get('available_balance_cny'))
        unbilled = money(data.get('unbilled_cost_cny'))
        reserve = money(config.get('reserve_cny_per_attempt'))
        if unbilled < 0 or reserve <= 0:
            return {'allowed': False, 'reason': 'offsite_balance_unknown'}
        if available - unbilled - reserve < FLOOR:
            return {'allowed': False, 'reason': 'offsite_balance_insufficient'}
        for folder in (root / 'private/offsite-backup').glob('run-*'):
            if folder.name == own_run:
                continue
            intent, _ = private_json(folder / 'intent.json')
            if intent.get('balance_evidence_sha256') == checksum:
                return {'allowed': False, 'reason': 'offsite_balance_evidence_used'}
        return {**gate, 'balance_evidence_sha256': checksum,
                'balance_checked_at': checked, 'balance_valid_until': until}
    except FileNotFoundError:
        return {'allowed': False, 'reason': 'offsite_balance_unknown'}
    except (ValueError, OSError, TypeError):
        return {'allowed': False, 'reason': 'offsite_balance_unknown'}
