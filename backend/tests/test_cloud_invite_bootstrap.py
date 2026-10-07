import importlib.util
import json
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.security import hash_token
from app.models.models import LoginInvite, User
from app.services.invites import authenticate, now

spec = importlib.util.spec_from_file_location('cloud_bootstrap',
    Path(__file__).resolve().parents[2] / 'deploy/modelscope/bootstrap_invites.py')
bootstrap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bootstrap)


def invitation():
    code = str(uuid4()) + str(uuid4())
    return code, {'user_id': str(uuid4()), 'code_hash': hash_token(code),
                  'expires_at': (now() + timedelta(days=1)).isoformat()}


def test_import_survives_restart_and_authenticates(tmp_path):
    url = f'sqlite:///{tmp_path / "cloud.db"}'
    engine = create_engine(url)
    code, entry = invitation()
    assert bootstrap.import_invites(engine, json.dumps([entry])) == 1
    engine.dispose()
    engine = create_engine(url)
    assert bootstrap.import_invites(engine, json.dumps([entry])) == 0
    with Session(engine) as db:
        assert authenticate(db, code, 'probe').id == entry['user_id']
        assert db.query(User).count() == 1
    engine.dispose()


def test_reboot_never_unrevokes_or_extends_expiry(tmp_path):
    engine = create_engine(f'sqlite:///{tmp_path / "cloud.db"}')
    _, entry = invitation()
    bootstrap.import_invites(engine, json.dumps([entry]))
    original = now() - timedelta(days=1)
    with Session(engine) as db:
        row = db.get(LoginInvite, entry['code_hash'])
        row.revoked, row.expires_at = True, original
        db.commit()
    assert bootstrap.import_invites(engine, json.dumps([entry])) == 0
    with Session(engine) as db:
        row = db.get(LoginInvite, entry['code_hash'])
        assert row.revoked and row.expires_at == original
    engine.dispose()


@pytest.mark.parametrize('change', ['expired', 'plaintext', 'existing_user'])
def test_invalid_import_is_atomic(tmp_path, change):
    engine = create_engine(f'sqlite:///{tmp_path / "cloud.db"}')
    _, existing = invitation()
    bootstrap.import_invites(engine, json.dumps([existing]))
    _, valid = invitation()
    code, invalid = invitation()
    if change == 'expired':
        invalid['expires_at'] = (now() - timedelta(days=1)).isoformat()
    elif change == 'plaintext':
        invalid['code_hash'] = code
    else:
        invalid['user_id'] = existing['user_id']
    with pytest.raises(ValueError):
        bootstrap.import_invites(engine, json.dumps([valid, invalid]))
    with Session(engine) as db:
        assert db.query(User).count() == db.query(LoginInvite).count() == 1
    engine.dispose()
