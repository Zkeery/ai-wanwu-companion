"""Homepage facts: isolation, no writes, bounded queries and old API compatibility."""
from datetime import datetime, timedelta
import hashlib
import json
import subprocess
import sys
from time import perf_counter
from uuid import uuid4

import pytest
from sqlalchemy import event, select
from sqlalchemy.exc import OperationalError

from app.core.database import SessionLocal, engine
from app.living.store import LivingStore, spaces
from app.models.models import Character, LivingMembership, Message, Object, Photo, User
from app.services.character_overview import character_overviews
from tests.auth_helpers import TEST_USER_ID

OTHER = "00000000-0000-0000-0000-000000000002"


def seed(db, owner=TEST_USER_ID, status="ready", created=None):
    photo = Photo(filename="synthetic.png", owner_id=owner)
    db.add(photo)
    db.flush()
    obj = Object(photo_id=photo.id, label="测试物件")
    db.add(obj)
    db.flush()
    ch = Character(object_id=obj.id, owner_id=owner, name="合成伙伴",
                   persona="温和", opening_line="你好", status=status,
                   created_at=created or datetime(2026, 9, 22))
    db.add(ch)
    db.flush()
    return ch


def home(owner, companion=None, mode="private"):
    sid = str(uuid4())
    LivingStore(engine).create_space(owner, sid, "home", mode,
                                    str(companion) if companion else None)
    return sid


def test_empty_and_unauthenticated(client, anon):
    response = client.get("/api/v1/characters/overview")
    assert response.status_code == 200 and response.json() == []
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["vary"] == "Authorization"
    response = anon.get("/api/v1/characters/overview")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_ready_only_and_account_isolation(client):
    with SessionLocal() as db:
        db.add(User(id=OTHER, phone="13900000001"))
        db.flush()
        own = seed(db)
        mine = own.id
        foreign = seed(db, OTHER)
        seed(db, status="failed")
        seed(db, status="generating")
        db.add(Message(character_id=foreign.id, role="assistant", content="private-other"))
        db.commit()
    rows = client.get("/api/v1/characters/overview").json()
    assert [r["character"]["id"] for r in rows] == [mine]
    assert rows[0]["residence"] is None
    assert rows[0]["last_interaction_at"] is None
    assert "private-other" not in str(rows)


def test_current_home_latest_time_no_chat_content_and_legacy_compatible(client, ready_character_id):
    cid = ready_character_id
    sid = home(TEST_USER_ID, cid)
    with SessionLocal() as db:
        db.get(Character, cid).current_space_id = sid
        db.add_all([
            Message(character_id=cid, role="user", content="private-first",
                    created_at=datetime(2026, 9, 21, 8)),
            Message(character_id=cid, role="assistant", content="private-latest",
                    created_at=datetime(2026, 9, 22, 9)),
        ])
        db.commit()
    response = client.get("/api/v1/characters/overview")
    assert response.status_code == 200
    row = response.json()[0]
    assert row["residence"] == {"space_id": sid, "scene_type": "home", "mode": "private"}
    assert row["last_interaction_at"] == "2026-09-22T09:00:00Z"
    assert "private-first" not in response.text and "private-latest" not in response.text
    assert client.get(f"/api/v1/characters/{cid}").json() == row["character"]
    assert client.get("/api/v1/characters").json() == [row["character"]]


@pytest.mark.parametrize("reference", ["missing", "foreign", "other_character", "shared_nonmember"])
def test_invalid_home_is_hidden_without_repair(client, ready_character_id, reference):
    cid = ready_character_id
    sid = str(uuid4())
    if reference == "foreign":
        sid = home(OTHER, cid)
    elif reference == "other_character":
        sid = home(TEST_USER_ID, cid + 100)
    elif reference == "shared_nonmember":
        sid = home(TEST_USER_ID, mode="shared")
    with SessionLocal() as db:
        db.get(Character, cid).current_space_id = sid
        db.commit()
    row = client.get("/api/v1/characters/overview").json()[0]
    assert row["residence"] is None
    with SessionLocal() as db:
        assert db.get(Character, cid).current_space_id == sid


def test_shared_space_requires_valid_membership(client, ready_character_id):
    cid = ready_character_id
    sid = home(TEST_USER_ID, mode="shared")
    with SessionLocal() as db:
        db.get(Character, cid).current_space_id = sid
        db.add(LivingMembership(space_id=sid, companion_id=str(cid)))
        db.commit()
    assert client.get("/api/v1/characters/overview").json()[0]["residence"]["mode"] == "shared"
    with SessionLocal() as db:
        db.query(LivingMembership).delete()
        db.commit()
    assert client.get("/api/v1/characters/overview").json()[0]["residence"] is None


def test_no_business_writes_or_n_plus_one_and_connection_reopen():
    with SessionLocal() as db:
        for i in range(100):
            ch = seed(db, created=datetime(2026, 9, 22) + timedelta(seconds=i))
            db.add_all([Message(character_id=ch.id, role="user", content="synthetic",
                                created_at=datetime(2026, 9, 22) + timedelta(minutes=j))
                        for j in range(20)])
        db.commit()
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip().split()[0].upper())

    event.listen(engine, "before_cursor_execute", record)
    try:
        with SessionLocal() as db:
            start = perf_counter()
            data = character_overviews(db, TEST_USER_ID)
            elapsed = perf_counter() - start
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert len(data) == 100
    assert statements == ["SELECT", "SELECT", "SELECT"]
    assert data[0].character.created_at > data[-1].character.created_at
    assert elapsed < 1, f"Overview exceeded local 1s target: {elapsed:.3f}s"
    print(f"overview_sample characters=100 messages=2000 queries=3 elapsed_ms={elapsed * 1000:.2f}")
    engine.dispose()
    with SessionLocal() as db:
        assert character_overviews(db, TEST_USER_ID) == data
        assert list(db.execute(select(spaces))) == []
    # Read the same isolated database in a fresh process, not just a new session.
    expected = hashlib.sha256(json.dumps(
        [row.model_dump(mode="json") for row in data], sort_keys=True
    ).encode()).hexdigest()
    code = (
        "import hashlib,json; "
        "from app.core.database import SessionLocal; "
        "from app.services.character_overview import character_overviews; "
        "db=SessionLocal(); "
        f"rows=character_overviews(db,{TEST_USER_ID!r}); "
        "print(hashlib.sha256(json.dumps([r.model_dump(mode='json') "
        "for r in rows],sort_keys=True).encode()).hexdigest()); db.close()"
    )
    reopened = subprocess.run([sys.executable, "-c", code], capture_output=True,
                              text=True, check=True, timeout=10)
    assert reopened.stdout.strip() == expected


def test_database_failure_returns_safe_error(client, monkeypatch):
    def fail(*args):
        raise OperationalError("secret-sql", {}, RuntimeError("private-database-detail"))

    monkeypatch.setattr("app.api.characters.character_overviews", fail)
    response = client.get("/api/v1/characters/overview")
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "overview_unavailable"
    assert "private-database-detail" not in response.text and "secret-sql" not in response.text
