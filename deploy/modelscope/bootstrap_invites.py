"""Import operator-created invitation hashes once; never receive plaintext codes."""
from datetime import datetime, timedelta, timezone
import json
import os
import re
from uuid import UUID

from sqlalchemy.orm import Session


def import_invites(engine, payload: str) -> int:
    from app.core.database import Base
    from app.models.models import LoginInvite, User

    entries = json.loads(payload)
    if not isinstance(entries, list) or not 1 <= len(entries) <= 5:
        raise ValueError('invalid_bootstrap_invites')
    validated = []
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != {'user_id', 'code_hash', 'expires_at'}:
            raise ValueError('invalid_bootstrap_invite')
        uid = str(UUID(entry['user_id']))
        digest = entry['code_hash']
        if not isinstance(digest, str) or not re.fullmatch(r'[0-9a-f]{64}', digest):
            raise ValueError('invalid_bootstrap_hash')
        expiry = datetime.fromisoformat(entry['expires_at'])
        if expiry.tzinfo is not None:
            raise ValueError('bootstrap_expiry_must_be_utc_naive')
        validated.append((uid, digest, expiry))
    Base.metadata.create_all(engine)
    created = 0
    with Session(engine) as db:
        for uid, digest, expiry in validated:
            existing = db.get(LoginInvite, digest)
            if existing is not None:
                if existing.user_id != uid:
                    raise ValueError('bootstrap_owner_mismatch')
                # Reboots must never extend, un-revoke or replace an invitation.
                continue
            current = datetime.now(timezone.utc).replace(tzinfo=None)
            if not current < expiry <= current + timedelta(days=90):
                raise ValueError('invalid_bootstrap_expiry')
            if db.get(User, uid) is not None:
                raise ValueError('bootstrap_cannot_modify_existing_user')
            db.add(User(id=uid, phone='i' + UUID(uid).hex[:10]))
            db.flush()
            db.add(LoginInvite(code_hash=digest, user_id=uid, expires_at=expiry))
            created += 1
        db.commit()
    return created


def main() -> int:
    payload = os.environ.pop('BOOTSTRAP_INVITES', '')
    if not payload:
        return 0
    try:
        from app.core.config import get_settings
        from app.core.database import engine
        if get_settings().auth_mode != 'invite':
            raise ValueError('bootstrap_requires_invite_mode')
        count = import_invites(engine, payload)
        print(f'Invitation bootstrap complete: {count} new accounts')
        return 0
    except Exception:
        print('Invitation bootstrap failed; no credential details logged')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
