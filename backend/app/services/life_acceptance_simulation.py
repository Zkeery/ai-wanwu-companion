"""Explicit synthetic bootstrap. Never copies users or accesses production data."""
from __future__ import annotations

import hashlib
from pathlib import Path
from uuid import uuid4


from app.services.life_acceptance_setup import create_business
from app.services.daily_model_quota import DailyModelQuota
from app.services.trial_gate import TrialGate, PRICE_CAPS
from app.services.life_acceptance_worker import MOCK_KEY, save_json, source_manifest


def synthetic_evidence(gate, kind, at):
    base = {'verified': True, 'vendor': 'maas', 'currency': 'CNY', 'checked_at': at,
            'authorization_ref': gate.policy['authorization_ref']}
    return {'wallet': dict(base, account=gate.policy['accounts']['maas'],
                           available_micro=20000000, pending_micro=0),
            'price': dict(base, model='qwen3.8-flash', rates=PRICE_CAPS['maas'].copy())}


def prepare(directory, *, scenario=None, starts_at=1792425540):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=False, exist_ok=False)
    ref = 'simulation-only-' + str(uuid4())
    characters = [{'id': cid, 'name': '合成伙伴' + str(cid), 'persona': '仅用于隔离模拟', 'opening_line': ''}
                  for cid in (4, 6)]
    scope = create_business(directory, 'synthetic-owner', characters, 6, [4, 6], ref, starts_at)
    policy = {'approved': True, 'authorization_ref': ref, 'mode': 'life',
        'starts_at': starts_at, 'ends_at': starts_at + 86400, 'budget_micro': 7000000,
        'scopes': {'private_life': {'owner': scope['owner'], 'subject': scope['private_subject']},
                   'shared_life': {'owner': scope['owner'], 'subject': scope['shared_subject']}},
        'accounts': {'maas': 'synthetic-account-only'},
        'credentials': {'maas': hashlib.sha256(MOCK_KEY.encode()).hexdigest()}}
    daily = DailyModelQuota(directory / 'daily.db', 30, clock=lambda: starts_at)
    gate = TrialGate.create(directory / 'trial.db', daily, policy, clock=lambda: starts_at)
    (directory / 'daily.db').chmod(0o600)
    save_json(directory / 'evidence.json', {kind: synthetic_evidence(gate, kind, starts_at)
              for kind in policy['scopes']}, exclusive=True)
    manifest = {'schema_version': 1, 'origin': 'mock_simulated', 'scenario': scenario,
        'starts_at': starts_at, 'authorization_ref': ref, 'scope': scope,
        'synthetic_seeds_only': True, 'live_model_authorized': False,
        'limits': {'seconds': 86400, 'per_group': 3, 'total': 6, 'budget_micro': 7000000,
                   'max_gap': 120, 'interval': 30, 'auto_retry': 0}}
    save_json(directory / 'manifest.json', manifest, exclusive=True)
    save_json(directory / 'manifest-binding.json',
              {'sha256': hashlib.sha256((directory / 'manifest.json').read_bytes()).hexdigest()}, exclusive=True)
    save_json(directory / 'source-manifest.json', source_manifest(), exclusive=True)
    return manifest
