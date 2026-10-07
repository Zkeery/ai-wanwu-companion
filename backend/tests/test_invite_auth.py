from datetime import timedelta

import pytest
from pydantic import ValidationError

from app.core.config import Settings, get_settings
from app.core.database import SessionLocal
from app.core.security import hash_token
from app.models.models import LoginInvite, User
from app.services.invites import now, provision, revoke


@pytest.fixture
def invite(monkeypatch):
    monkeypatch.setattr(get_settings(), "auth_mode", "invite")
    with SessionLocal() as db:
        code, uid = provision(db)
        db.commit()
    return code, uid


def login(anon, code):
    return anon.post("/api/v1/auth/invite", json={"code": code})


def test_invite_relogin_has_same_owner_without_sms(anon, invite):
    first = login(anon, invite[0])
    second = login(anon, invite[0])
    assert first.status_code == second.status_code == 200
    assert first.json()["user"] == second.json()["user"] == {"id": invite[1], "phone": ""}
    assert first.json()["token"] != second.json()["token"]
    with SessionLocal() as db:
        credential = db.get(LoginInvite, hash_token(invite[0]))
        assert credential.code_hash != invite[0]
        assert db.get(User, invite[1]).phone.startswith("i")
    assert anon.post("/api/v1/auth/code", json={"phone": "13900000201"}).status_code == 403
    assert anon.post("/api/v1/auth/login", json={"phone": "13900000201", "code": "123456"}).status_code == 403


def test_wrong_expired_revoked_are_indistinguishable(anon, invite):
    wrong = login(anon, "not-an-invite")
    with SessionLocal() as db:
        db.get(LoginInvite, hash_token(invite[0])).expires_at = now() - timedelta(seconds=1)
        db.commit()
    expired = login(anon, invite[0])
    with SessionLocal() as db:
        row = db.get(LoginInvite, hash_token(invite[0]))
        row.expires_at = now() + timedelta(days=1)
        row.revoked = True
        db.commit()
    revoked = login(anon, invite[0])
    assert wrong.status_code == expired.status_code == revoked.status_code == 401
    assert wrong.json() == expired.json() == revoked.json()


def test_revoke_invalidates_existing_sessions(anon, invite):
    token = login(anon, invite[0]).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert anon.get("/api/v1/auth/me", headers=headers).status_code == 200
    with SessionLocal() as db:
        revoke(db, invite[1])
    assert anon.get("/api/v1/auth/me", headers=headers).status_code == 401
    assert login(anon, invite[0]).status_code == 401


def test_invite_cannot_read_other_owners_character(anon, invite, ready_character_id):
    token = login(anon, invite[0]).json()["token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert anon.get(f"/api/v1/characters/{ready_character_id}", headers=headers).status_code == 404
    assert anon.get("/api/v1/characters", headers=headers).json() == []


def test_throttle_survives_new_db_sessions(anon, invite, monkeypatch):
    monkeypatch.setattr("app.services.invites.time.time", lambda: 1800000000)
    for _ in range(20):
        assert login(anon, "wrong").status_code == 401
    assert login(anon, invite[0]).status_code == 429
    monkeypatch.setattr("app.services.invites.time.time", lambda: 1800000061)
    assert login(anon, invite[0]).status_code == 200


def test_sms_mode_keeps_invite_disabled(anon):
    assert login(anon, "not-enabled").status_code == 403


def test_existing_account_can_receive_invite_without_data_claim(anon, monkeypatch):
    from tests.auth_helpers import TEST_USER_ID
    monkeypatch.setattr(get_settings(), "auth_mode", "invite")
    with SessionLocal() as db:
        before = db.query(User).count()
        code, uid = provision(db, user_id=TEST_USER_ID)
        db.commit()
        assert db.query(User).count() == before
    assert login(anon, code).json()["user"]["id"] == uid == TEST_USER_ID


def production(**overrides):
    values = dict(_env_file=None, app_env="production", auth_mode="invite", dev_auth_token="",
                  dev_sms_fixed_code="", legacy_claim_user_id="", model_api_key="synthetic-key",
                  model_base_url="https://example.invalid", sms_live_enabled=False)
    values.update(overrides)
    return Settings(**values)


def test_production_invite_works_without_real_sms():
    assert production().auth_mode == "invite"


@pytest.mark.parametrize("override", [{"dev_sms_fixed_code": "123456"}, {"dev_auth_token": "unsafe"},
                                     {"model_api_key": ""}, {"sms_live_enabled": True}])
def test_invite_does_not_bypass_other_production_guards(override):
    with pytest.raises(ValidationError, match="production_configuration_blocked"):
        production(**override)
