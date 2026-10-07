"""测试环境隔离：数据库与上传目录用临时路径，避免污染开发数据。"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

import pytest

_temporary = tempfile.TemporaryDirectory(prefix="aiwwb-test-")
_tmp = Path(_temporary.name)
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp / 'test.db'}"
os.environ["UPLOAD_DIR"] = str(_tmp / "uploads")
# 强制 mock：覆盖 .env 中的真实 Key，避免测试误走真实模型
os.environ["MODEL_API_KEY"] = ""
os.environ["MODEL_BASE_URL"] = ""
os.environ["IMAGE_BASE_URL"] = ""

from app.core.database import Base, engine  # noqa: E402

from tests.auth_helpers import TEST_PHONE, TEST_TOKEN, TEST_USER_ID  # noqa: E402


def _seed_user_and_session():
    from datetime import datetime, timedelta, timezone

    from app.core.security import hash_token
    from app.models.models import Session, User
    from app.core.database import SessionLocal
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        if db.get(User, TEST_USER_ID) is None:
            db.add(User(id=TEST_USER_ID, phone=TEST_PHONE))
            db.flush()
        db.add(Session(token_hash=hash_token(TEST_TOKEN), user_id=TEST_USER_ID,
                       created_at=now, expires_at=now + timedelta(days=30),
                       last_seen_at=now))
        db.commit()


@pytest.fixture(autouse=True)
def _clean_db():
    import app.models.models  # noqa: F401  确保所有表已注册到 Base.metadata
    import app.living.competitions  # noqa: F401  聚会测试单独运行时也要先注册活动表
    from app.living.store import metadata as living_metadata
    living_metadata.drop_all(bind=engine)
    living_metadata.create_all(bind=engine)
    Base.metadata.drop_all(bind=engine)
    from app.scene_agent import chat as agent_chat
    from app.scene_agent.runtime import metadata as agent_metadata
    agent_metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    agent_chat.initialize()
    _seed_user_and_session()
    yield


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app, headers={"Authorization": f"Bearer {TEST_TOKEN}"})


@pytest.fixture
def anon():
    """无认证客户端，供登录与隔离测试使用。"""
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture
def ready_character_id():
    """不经过模型的合成伙伴，供输入/场景规则回归使用。"""
    from app.core.database import SessionLocal
    from app.models.models import Character, Object, Photo
    with SessionLocal() as db:
        photo = Photo(filename="synthetic.png", status="done", owner_id=TEST_USER_ID)
        db.add(photo)
        db.flush()
        obj = Object(photo_id=photo.id, label="合成杯子")
        db.add(obj)
        db.flush()
        character = Character(object_id=obj.id, owner_id=TEST_USER_ID, name="测试杯",
                              persona="合成测试伙伴", opening_line="你好", status="ready")
        db.add(character)
        db.commit()
        return character.id


@pytest.fixture
def png_header() -> bytes:
    """真实可解码 PNG；保留 fixture 名称，覆盖原有全部 API 回归。"""
    from io import BytesIO
    from PIL import Image
    output = BytesIO()
    with Image.new("RGB", (16, 12), "beige") as image:
        image.save(output, format="PNG")
    return output.getvalue()


@pytest.fixture
def parse_sse():
    def _parse(text: str):
        events = []
        for block in text.split("\n\n"):
            block = block.strip()
            if not block:
                continue
            event = data = None
            for line in block.splitlines():
                if line.startswith("event:"):
                    event = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    data = json.loads(line[len("data:"):].strip())
            events.append((event, data))
        return events

    return _parse
