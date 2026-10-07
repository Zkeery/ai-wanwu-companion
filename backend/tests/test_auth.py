"""账号：验证码、登录、会话与跨账号隔离。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.api.deps import set_sms_provider
from app.core.database import SessionLocal
from app.models.models import VerificationCode
from app.services.sms import MockSmsProvider


@pytest.fixture
def sms():
    provider = MockSmsProvider()
    set_sms_provider(provider)
    yield provider
    set_sms_provider(MockSmsProvider())


def _code_for(sms, phone):
    matches = [code for p, code in sms.sent if p == phone]
    assert matches, "验证码未发送"
    return matches[-1]


def _authed(app, token):
    return TestClient(app, headers={"Authorization": f"Bearer {token}"})


def test_full_login_flow(anon, sms):
    assert anon.post("/api/v1/auth/code", json={"phone": "138 0013 8000"}).status_code == 200
    code = _code_for(sms, "13800138000")
    res = anon.post("/api/v1/auth/login", json={"phone": "13800138000", "code": code})
    assert res.status_code == 200
    token = res.json()["token"]
    me = _authed(anon.app, token)
    assert me.get("/api/v1/auth/me").json()["phone"] == "13800138000"


def test_invalid_phone_rejected_without_send(anon, sms):
    assert anon.post("/api/v1/auth/code", json={"phone": "12345"}).status_code == 422
    assert sms.sent == []


def test_wrong_code_rejected(anon, sms):
    anon.post("/api/v1/auth/code", json={"phone": "13900000000"})
    res = anon.post("/api/v1/auth/login", json={"phone": "13900000000", "code": "000000"})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "code_invalid"


def test_code_is_single_use(anon, sms):
    phone = "13900000001"
    anon.post("/api/v1/auth/code", json={"phone": phone})
    code = _code_for(sms, phone)
    assert anon.post("/api/v1/auth/login", json={"phone": phone, "code": code}).status_code == 200
    assert anon.post("/api/v1/auth/login", json={"phone": phone, "code": code}).status_code == 400


def test_resend_rate_limit(anon, sms):
    phone = "13900000002"
    anon.post("/api/v1/auth/code", json={"phone": phone})
    assert anon.post("/api/v1/auth/code", json={"phone": phone}).status_code == 429


def test_send_limit_resets_on_a_new_day(anon, sms):
    phone = "13900000002"
    assert anon.post("/api/v1/auth/code", json={"phone": phone}).status_code == 200
    with SessionLocal() as db:
        rec = db.query(VerificationCode).filter(VerificationCode.phone == phone).one()
        rec.send_day = "2000-01-01"
        rec.send_count = 10
        rec.last_sent_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(days=1)
        db.commit()
    assert anon.post("/api/v1/auth/code", json={"phone": phone}).status_code == 200
    with SessionLocal() as db:
        rec = db.query(VerificationCode).filter(VerificationCode.phone == phone).one()
        assert rec.send_count == 1


def test_expired_code(anon, sms):
    phone = "13900000003"
    anon.post("/api/v1/auth/code", json={"phone": phone})
    code = _code_for(sms, phone)
    with SessionLocal() as db:
        rec = db.query(VerificationCode).filter(VerificationCode.phone == phone).first()
        rec.expires_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=1)
        db.commit()
    res = anon.post("/api/v1/auth/login", json={"phone": phone, "code": code})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "code_expired"


def test_unauthenticated_rejected(anon):
    assert anon.get("/api/v1/characters").status_code == 401
    assert anon.get("/api/v1/living/spaces").status_code == 401


def test_logout_invalidates_token(anon, sms):
    phone = "13900000004"
    anon.post("/api/v1/auth/code", json={"phone": phone})
    code = _code_for(sms, phone)
    token = anon.post("/api/v1/auth/login", json={"phone": phone, "code": code}).json()["token"]
    authed = _authed(anon.app, token)
    assert authed.get("/api/v1/auth/me").status_code == 200
    assert authed.post("/api/v1/auth/logout").status_code == 204
    assert authed.get("/api/v1/auth/me").status_code == 401


def test_cross_account_isolation(client, anon, sms, png_header, parse_sse):
    photo = client.post("/api/v1/photos", files={"file": ("cup.png", png_header, "image/png")}).json()
    cid = next(d for e, d in parse_sse(
        client.post("/api/v1/characters", json={"object_id": photo["objects"][0]["id"]}).text
    ) if e == "done")["id"]

    phone = "13900000005"
    anon.post("/api/v1/auth/code", json={"phone": phone})
    code = _code_for(sms, phone)
    token = anon.post("/api/v1/auth/login", json={"phone": phone, "code": code}).json()["token"]
    other = _authed(anon.app, token)

    assert other.get("/api/v1/characters").json() == []
    assert other.get(f"/api/v1/characters/{cid}").status_code == 404
    assert other.patch(f"/api/v1/characters/{cid}", json={"name": "越权"}).status_code == 404
    assert client.get(f"/api/v1/characters/{cid}").status_code == 200


def test_dev_fixed_code_login(anon, monkeypatch):
    """开发过渡：配置固定验证码后，该码可直接登录（正式环境必须留空）。"""
    from app.core.config import Settings
    monkeypatch.setattr("app.services.sms.get_settings",
                        lambda: Settings(_env_file=None, dev_sms_fixed_code="123456"))
    phone = "13900000006"
    anon.post("/api/v1/auth/code", json={"phone": phone})
    res = anon.post("/api/v1/auth/login", json={"phone": phone, "code": "123456"})
    assert res.status_code == 200
    assert res.json()["user"]["phone"] == phone
