"""Transactional persistence, deliberately independent of the main app database.

Owner IDs are internal trusted inputs; this module does not implement login.
Only explicit initialize() creates tables. Importing never reads .env or opens a DB.
"""
from __future__ import annotations

import hashlib
import json
import time
from contextlib import nullcontext
from collections.abc import Callable
from uuid import UUID

from pydantic import BaseModel, ValidationError
from sqlalchemy import (CheckConstraint, Column, ForeignKey, Integer, MetaData,
                        String, Table, Text, UniqueConstraint, event, insert, select, update)
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError, SQLAlchemyError

from app.living.rules import CATALOG, Command, Item, LivingError, Snapshot, State, apply, public_items, settle

metadata = MetaData()
spaces = Table(
    "living_spaces", metadata,
    Column("id", String(36), primary_key=True),
    Column("owner_id", String(128), nullable=False),
    Column("scene_type", String(16), nullable=False),
    Column("mode", String(16), nullable=False),
    Column("companion_id", String(128)),
    Column("revision", Integer, nullable=False),
    Column("state_json", Text, nullable=False),
    UniqueConstraint("owner_id", "companion_id", "scene_type"),
    CheckConstraint("revision >= 0"),
    CheckConstraint("scene_type IN ('home', 'desert', 'forest')"),
    CheckConstraint("(mode = 'private' AND companion_id IS NOT NULL) OR "
                    "(mode = 'shared' AND companion_id IS NULL)"),
)
receipts = Table(
    "living_receipts", metadata,
    Column("space_id", String(36), ForeignKey("living_spaces.id", ondelete="CASCADE"), primary_key=True),
    Column("request_id", String(36), primary_key=True),
    Column("digest", String(64), nullable=False),
    Column("result_json", Text, nullable=False),
)


def _identity(value: str) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 128:
        raise LivingError("invalid_request", "身份标识不正确")
    return value


def _uuid(value: str) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
        return value
    except (ValueError, TypeError, AttributeError):
        raise LivingError("invalid_request", "请求或空间标识不正确") from None


def _require_complete_saved_model(value) -> None:
    """Defaults are for creation, not for silently repairing damaged saved data."""
    if isinstance(value, BaseModel):
        if (set(type(value).model_fields) - value.model_fields_set) - ({"flipped"} if isinstance(value, Item) else set()):
            raise ValueError("incomplete saved record")
        for field in type(value).model_fields:
            _require_complete_saved_model(getattr(value, field))
    elif isinstance(value, dict):
        for child in value.values():
            _require_complete_saved_model(child)
    elif isinstance(value, list):
        for child in value:
            _require_complete_saved_model(child)


def _enable_sqlite_foreign_keys(dbapi_connection, connection_record, connection_proxy):
    """Checkout also covers connections pooled before LivingStore was created."""
    try:
        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.execute("PRAGMA foreign_keys")
            enabled = cursor.fetchone() == (1,)
        finally:
            cursor.close()
    except Exception:
        raise LivingError("storage_unavailable", "场景数据约束暂时无法启用，请稍后重试") from None
    if not enabled:
        raise LivingError("storage_unavailable", "场景数据约束暂时无法启用，请稍后重试")


class LivingStore:
    def __init__(self, engine: Engine, clock: Callable[[], int] | None = None):
        self.engine = engine
        self.clock = clock or (lambda: int(time.time()))
        if engine.dialect.name == "sqlite" and not event.contains(
            engine, "checkout", _enable_sqlite_foreign_keys
        ):
            event.listen(engine, "checkout", _enable_sqlite_foreign_keys)

    def initialize(self) -> None:
        """Explicit isolated-schema setup; production migration belongs to R2."""
        try:
            metadata.create_all(self.engine)
        except SQLAlchemyError:
            raise LivingError("storage_unavailable", "场景数据库暂时无法初始化，请稍后重试") from None

    def _now(self) -> int:
        now = self.clock()
        if type(now) is not int or now < 0:
            raise LivingError("storage_unavailable", "服务端时间不可用")
        return now

    @staticmethod
    def _row(conn, owner_id: str, space_id: str):
        row = conn.execute(select(spaces).where(
            spaces.c.id == space_id, spaces.c.owner_id == owner_id
        )).mappings().first()
        if row is None:
            raise LivingError("not_found", "空间不存在或无权访问")
        return row

    @staticmethod
    def _state(row) -> State:
        try:
            raw = json.loads(row["state_json"])
            if isinstance(raw, dict) and raw.get("schema_version") == 1:
                # Only complete v1 envelopes are eligible for this explicit upgrade.
                if set(raw) != {"schema_version", "last_write_at", "items", "undo"}:
                    raise ValueError("incomplete v1 state")
                raw = {**raw, "schema_version": 2, "atmosphere": {"rain": False, "sound": True}}
            state = State.model_validate(raw)
            _require_complete_saved_model(state)
            if any(item.kind not in CATALOG[row["scene_type"]]["items"]
                   for item in state.items.values()):
                raise ValueError()
            return state
        except (ValidationError, ValueError, KeyError, TypeError):
            raise LivingError("corrupt_state", "场景存档无法读取，请保留数据并联系维护人员") from None

    @staticmethod
    def _snapshot(row, state: State, now: int) -> dict:
        projected = settle(state, now)
        return {"id": row["id"], "scene_type": row["scene_type"],
                "mode": row["mode"], "companion_id": row["companion_id"],
                "revision": row["revision"], "observed_at": now,
                "items": public_items(projected), "can_undo": projected.undo is not None,
                "atmosphere": projected.atmosphere.model_dump()}

    def create_space(self, owner_id: str, space_id: str, scene_type: str,
                     mode: str, companion_id: str | None = None) -> dict:
        owner_id, space_id = _identity(owner_id), _uuid(space_id)
        if not isinstance(scene_type, str) or scene_type not in CATALOG:
            raise LivingError("invalid_request", "请选择有效的生活场景")
        if mode not in ("private", "shared") or (mode == "private") != (companion_id is not None):
            raise LivingError("invalid_request", "请选择独居或同住；仅独居空间绑定私人伙伴")
        if companion_id is not None:
            _identity(companion_id)
        now = self._now()
        values = dict(id=space_id, owner_id=owner_id, scene_type=scene_type, mode=mode,
                      companion_id=companion_id, revision=0,
                      state_json=State(last_write_at=now).model_dump_json())
        try:
            with self.engine.begin() as conn:
                conn.execute(insert(spaces).values(**values))
        except IntegrityError:
            try:
                with self.engine.connect() as conn:
                    row = conn.execute(select(spaces).where(spaces.c.id == space_id)).mappings().first()
                    if row is None:
                        raise LivingError("conflict", "该伙伴已有此类私人空间，请读取已有空间")
                    if row["owner_id"] != owner_id:
                        raise LivingError("not_found", "空间不存在或无权访问")
                    if any(row[key] != values[key] for key in ("scene_type", "mode", "companion_id")):
                        raise LivingError("conflict", "相同空间标识不能用于不同的创建内容")
                    return self._snapshot(row, self._state(row), now)
            except SQLAlchemyError:
                raise LivingError("storage_unavailable", "场景暂时无法保存，请稍后重试") from None
        except SQLAlchemyError:
            raise LivingError("storage_unavailable", "场景暂时无法保存，请稍后重试") from None
        return self._snapshot(values, self._state(values), now)

    def read_space(self, owner_id: str, space_id: str) -> dict:
        owner_id, space_id = _identity(owner_id), _uuid(space_id)
        try:
            with self.engine.connect() as conn:
                row = self._row(conn, owner_id, space_id)
                return self._snapshot(row, self._state(row), self._now())
        except SQLAlchemyError:
            raise LivingError("storage_unavailable", "场景暂时无法读取，请稍后重试") from None

    @staticmethod
    def _receipt(conn, space_id, request_id, digest):
        row = conn.execute(select(receipts).where(
            receipts.c.space_id == space_id, receipts.c.request_id == request_id
        )).mappings().first()
        if row is None:
            return None
        if row["digest"] != digest:
            raise LivingError("conflict", "相同请求标识不能用于不同的操作")
        try:
            raw = json.loads(row["result_json"])
            legacy_keys = {"id", "scene_type", "mode", "companion_id", "revision", "observed_at", "items", "can_undo"}
            if isinstance(raw, dict) and set(raw) == legacy_keys:
                raw["atmosphere"] = {"rain": False, "sound": True}
            snapshot = Snapshot.model_validate(raw)
            _require_complete_saved_model(snapshot)
            result = snapshot.model_dump()
            if result["id"] != space_id:
                raise ValueError()
            return result
        except (ValidationError, ValueError, TypeError):
            raise LivingError("corrupt_state", "操作回执无法读取，请保留数据并联系维护人员") from None

    def execute(self, owner_id: str, space_id: str, request_id: str,
                expected_revision: int, command: dict, *, connection=None) -> dict:
        owner_id, space_id, request_id = _identity(owner_id), _uuid(space_id), _uuid(request_id)
        if type(expected_revision) is not int or expected_revision < 0:
            raise LivingError("invalid_request", "场景版本不正确")
        try:
            parsed = Command.validate_python(command)
        except ValidationError:
            raise LivingError("invalid_request", "操作参数不正确，请检查输入") from None
        payload = {"command": parsed.model_dump(), "expected_revision": expected_revision}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        try:
            with (nullcontext(connection) if connection is not None else self.engine.begin()) as conn:
                row = self._row(conn, owner_id, space_id)
                previous = self._receipt(conn, space_id, request_id, digest)
                if previous is not None:
                    return previous
                if row["revision"] != expected_revision:
                    raise LivingError("conflict", "场景已更新，请重新读取后再操作")
                now = self._now()
                state = apply(self._state(row), row["scene_type"], parsed, now)
                changed = conn.execute(update(spaces).where(
                    spaces.c.id == space_id, spaces.c.owner_id == owner_id,
                    spaces.c.revision == expected_revision
                ).values(state_json=state.model_dump_json(), revision=expected_revision + 1))
                if changed.rowcount != 1:
                    raise LivingError("conflict", "场景已更新，请重新读取后再操作")
                result = self._snapshot(dict(row, revision=expected_revision + 1), state, now)
                conn.execute(insert(receipts).values(space_id=space_id, request_id=request_id,
                                                     digest=digest, result_json=json.dumps(result)))
            return result
        except (LivingError, SQLAlchemyError) as error:
            if connection is not None:
                if isinstance(error, LivingError):
                    raise
                raise LivingError("storage_unavailable", "场景暂时无法保存，请稍后重试") from None
            # A simultaneous identical request may have committed while we waited.
            if isinstance(error, LivingError) and error.code != "conflict":
                raise
            try:
                with self.engine.connect() as conn:
                    self._row(conn, owner_id, space_id)
                    previous = self._receipt(conn, space_id, request_id, digest)
                    if previous is not None:
                        return previous
            except SQLAlchemyError:
                pass
            if isinstance(error, LivingError):
                raise
            raise LivingError("storage_unavailable", "场景暂时无法保存，请稍后重试") from None
