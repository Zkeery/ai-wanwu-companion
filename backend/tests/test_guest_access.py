"""Guest entry stays on its own account and its own limits."""
from datetime import datetime, timedelta, timezone

import httpx
from fastapi.testclient import TestClient

from app.core.database import SessionLocal
from app.models.models import Character, GuestAccount, GuestDaily, Object, Photo, User
from app.services.daily_model_quota import DailyModelQuota, guest_models, install_httpx_quota
from app.services.guest_access import release_guest_companion, reserve_guest_companion, shanghai_day


def _guest(anon):
    response = anon.post("/api/v1/auth/guest")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["user"]["phone"] == ""
    assert set(body["user"]) == {"id", "phone"}
    assert body["user"]["id"]
    return body["token"], body["user"]["id"]


def _client(app, token):
    return TestClient(app, headers={"Authorization": f"Bearer {token}"})


def _object_for(user_id):
    with SessionLocal() as db:
        photo = Photo(filename="synthetic.png", status="done", owner_id=user_id)
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label="合成杯子", visual_features="圆", category="cup")
        db.add(obj)
        db.commit()
        return obj.id


def _ready_character(user_id):
    object_id = _object_for(user_id)
    with SessionLocal() as db:
        character = Character(object_id=object_id, owner_id=user_id, name="体验杯",
                              persona="合成", opening_line="你好", status="ready")
        db.add(character)
        db.commit()
        return character.id


def test_guest_is_a_new_empty_account_and_cannot_see_existing_data(anon, ready_character_id):
    token, user_id = _guest(anon)
    guest = _client(anon.app, token)
    assert guest.get("/api/v1/characters").json() == []
    assert guest.get(f"/api/v1/characters/{ready_character_id}").status_code == 404
    with SessionLocal() as db:
        phone = db.get(User, user_id).phone
    assert phone.startswith("g") and len(phone) == 11 and phone != "13800000000"


def test_same_source_cannot_open_a_fourth_guest_within_an_hour(anon):
    for _ in range(3):
        assert anon.post("/api/v1/auth/guest").status_code == 200
    blocked = anon.post("/api/v1/auth/guest")
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "guest_ip_limited"
    assert "邀请码" in blocked.json()["error"]["message"]


def test_guest_companion_and_chat_limits_do_not_apply_to_existing_accounts(anon, client, ready_character_id):
    with SessionLocal() as db:
        db.add(GuestDaily(day=shanghai_day(), companions=8, messages=4000))
        db.commit()
    response = client.post(f"/api/v1/characters/{ready_character_id}/chat", json={"message": "你好呀"})
    assert response.status_code == 200
    assert "guest_" not in response.text
    token, user_id = _guest(anon)
    with SessionLocal() as db:
        account = db.get(GuestAccount, user_id)
        account.companions = 2
        account.messages = 30
        db.commit()
    guest = _client(anon.app, token)
    object_id = _object_for(user_id)
    blocked = guest.post("/api/v1/characters", json={"object_id": object_id, "free_creation": True})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "guest_companion_limit"
    assert "2 个伙伴" in blocked.json()["error"]["message"]
    character_id = _ready_character(user_id)
    chat = guest.post(f"/api/v1/characters/{character_id}/chat", json={"message": "再一句"})
    assert chat.status_code == 429
    assert chat.json()["error"]["code"] == "guest_chat_limit"
    assert "30 句" in chat.json()["error"]["message"]
    with SessionLocal() as db:
        assert db.get(GuestAccount, user_id).messages == 30
        assert db.query(Character).filter_by(owner_id=user_id, status="generating").count() == 0


def test_daily_guest_companion_cap_blocks_before_a_model_call(anon):
    token, user_id = _guest(anon)
    with SessionLocal() as db:
        db.add(GuestDaily(day=shanghai_day(), companions=8, messages=0))
        db.commit()
    guest = _client(anon.app, token)
    blocked = guest.post("/api/v1/characters", json={"object_id": _object_for(user_id), "free_creation": True})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "guest_daily_companion_limit"
    with SessionLocal() as db:
        assert db.get(GuestDaily, shanghai_day()).companions == 8


def test_existing_account_does_not_enter_the_guest_ledger(client):
    from app.models.models import User as UserModel
    with SessionLocal() as db:
        user = db.query(UserModel).filter_by(phone="13800000000").one()
        reserve_guest_companion(db, user)
        db.commit()
        assert db.get(GuestAccount, user.id) is None


def test_releasing_a_guest_reservation_restores_one_slot():
    with SessionLocal() as db:
        user = User(id="guest-release", phone="g" + "ab" * 5)
        db.add(user)
        db.flush()
        db.add(GuestAccount(user_id=user.id, companions=1, messages=0, recognitions=0, recognition_day=""))
        db.add(GuestDaily(day=shanghai_day(), companions=1, messages=0))
        db.commit()
        release_guest_companion(db, user.id)
        db.commit()
        assert db.get(GuestAccount, user.id).companions == 0
        assert db.get(GuestDaily, shanghai_day()).companions == 0


def test_guest_model_calls_do_not_consume_the_old_daily_request_counter(tmp_path):
    quota = DailyModelQuota(tmp_path / "quota.db", 1)
    restore = install_httpx_quota(quota, ["https://model.example/v1"])
    try:
        def transport(request):
            return httpx.Response(200, json={"ok": True})
        with httpx.Client(transport=httpx.MockTransport(transport)) as http:
            token = guest_models.set(True)
            try:
                http.post("https://model.example/v1/chat/completions", json={"x": 1})
            finally:
                guest_models.reset(token)
            assert quota.status()["used"] == 0
            http.post("https://model.example/v1/chat/completions", json={"x": 1})
            assert quota.status()["used"] == 1
    finally:
        restore()


def test_signup_window_expires(anon):
    for _ in range(3):
        assert anon.post("/api/v1/auth/guest").status_code == 200
    with SessionLocal() as db:
        from app.models.models import GuestSignup
        for row in db.query(GuestSignup):
            row.created_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=2)
        db.commit()
    assert anon.post("/api/v1/auth/guest").status_code == 200
