"""One explicit manual recovery, within the original five-yuan total cap."""
import hashlib
import json
import sqlite3

from scripts.real_web_budget import Budget

REF = 'real-web-recovery-20261002-4.8cny-11requests'
SUPPLEMENT_REF = 'real-web-character-only-20261002-plus0.05cny-once'


def call_digest(budget, limit=7):
    with budget.db() as db:
        rows = db.execute('SELECT * FROM calls ORDER BY started_at,id LIMIT ?', (limit,)).fetchall()
    return hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()


class CharacterOnlyBudget(Budget):
    revision_start = 7
    revision_models = ('qwen3.8-flash', 'wan2.6-t2i')

    def __init__(self, root, endpoint):
        super().__init__(root/'recovery-1', endpoint, reference=REF,
                         budget_micro=4850000, requests_max=11)
        raw = (root/'character-only-authorization.json').read_bytes()
        self.grant = json.loads(raw)
        marker = json.loads((root/'active-character-only.json').read_text())
        base = recovery_budget(root, endpoint)
        self.base_digest = base.approval()
        if (marker.get('authorization_sha256') != hashlib.sha256(raw).hexdigest()
                or self.grant.get('authorization_ref') != SUPPLEMENT_REF
                or self.grant.get('confirmed') is not True
                or not self.grant.get('user_reply', '').strip()
                or self.grant.get('target_root') != str(root.resolve())
                or self.grant.get('endpoint') != endpoint
                or self.grant.get('original_authorization_sha256') != self.base_digest
                or self.grant.get('original_calls_sha256') != call_digest(base)
                or self.grant.get('original_requests') != 7
                or self.grant.get('original_reserved_cny') != 3.6848
                or self.grant.get('additional_budget_cny') != .05
                or self.grant.get('recovery_budget_cny') != 4.85
                or self.grant.get('combined_budget_cny') != 8.05
                or self.grant.get('max_new_model_requests') != 2
                or self.grant.get('source_character_id') != 6
                or self.grant.get('automatic_retries') != 0
                or self.grant.get('appearance_style_id') != 'whimsical-object-spirit-v2'):
            raise ValueError('Invalid single character-only supplement')
        from uuid import UUID
        self.revision_request_id = str(UUID(self.grant['request_id']))

    def approval(self):
        # Bind each claim to the addendum while retaining the original ledger digest.
        root = self.root.parent
        raw = (root/'character-only-authorization.json').read_bytes()
        marker = json.loads((root/'active-character-only.json').read_text())
        base = recovery_budget(root, self.endpoint)
        if (marker.get('authorization_sha256') != hashlib.sha256(raw).hexdigest()
                or json.loads(raw) != self.grant or base.approval() != self.base_digest
                or call_digest(base) != self.grant['original_calls_sha256']):
            raise ValueError('Character-only supplement changed')
        return self.base_digest

    def status(self):
        value = super().status()
        if value['requests'] >= self.revision_start + len(self.revision_models):
            value['paused'] = True
        return value


def original_digest(root):
    with sqlite3.connect((root/'model-budget.db').resolve().as_uri()+'?mode=ro',uri=True) as db:
        calls=db.execute('SELECT * FROM calls ORDER BY id').fetchall()
        stops=db.execute('SELECT * FROM stops ORDER BY reason').fetchall()
        # This recovery is specifically for the first malformed vision response.
        if (len(calls)!=1 or calls[0][1:5]!=('vision','ling-3.0-flash-vl',200000,'succeeded')
                or not any(row[0]=='business_failure' for row in stops)):
            raise ValueError('Original stopped batch does not match the reviewed failure')
    data=dict(authorization_sha256=hashlib.sha256((root/'authorization.json').read_bytes()).hexdigest(),
              calls=calls,stops=stops)
    return hashlib.sha256(json.dumps(data,sort_keys=True).encode()).hexdigest()


def recovery_budget(root,endpoint):
    return Budget(root/'recovery-1',endpoint,reference=REF,budget_micro=4800000,requests_max=11)


def prepare(root,endpoint):
    if (root/'recovery-1').exists():
        raise FileExistsError('Recovery already prepared; never reset a budget')
    digest=original_digest(root)
    result=recovery_budget(root,endpoint).status()
    plan=dict(original_digest=digest,budget_cny=4.8,requests_max=11,authorization_ref=REF,
        original_reserved_cny=.2,combined_budget_cny=5,combined_requests_max=12,
        automatic_retries=0,manual_confirmation_required=True)
    path=root/'recovery-1/plan.json'
    path.write_text(json.dumps(plan,ensure_ascii=False,indent=2));path.chmod(0o600)
    return {**plan,**result}


def selected(root,endpoint):
    marker=root/'active-recovery.json'
    if not marker.exists():
        return Budget(root,endpoint)
    plan=json.loads((root/'recovery-1/plan.json').read_text())
    selection=json.loads(marker.read_text())
    if (selection.get('authorization_ref')!=REF or selection.get('original_digest')!=original_digest(root)
            or selection.get('original_digest')!=plan.get('original_digest')):
        raise ValueError('Recovery original budget changed')
    budget=recovery_budget(root,endpoint)
    budget.approval()
    if (root/'active-character-only.json').exists():
        budget = CharacterOnlyBudget(root, endpoint)
        budget.approval()
    return budget


def activate(root,endpoint):
    plan=json.loads((root/'recovery-1/plan.json').read_text())
    digest=original_digest(root)
    if plan.get('original_digest')!=digest:
        raise ValueError('Original budget changed after recovery review')
    ledger=recovery_budget(root,endpoint)
    ledger.approval()
    with (root/'active-recovery.json').open('x') as file:
        json.dump(dict(authorization_ref=REF,original_digest=digest),file)
    (root/'active-recovery.json').chmod(0o600)
    return ledger.status()
