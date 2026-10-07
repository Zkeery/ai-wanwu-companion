"""Private-space seasons: deterministic projection, separate from growth and layout."""
from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Annotated, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator
from sqlalchemy import Column, ForeignKey, Integer, String, Table, Text, insert, select, update

from app.living.rules import LivingError
from app.living.store import metadata, LivingStore

SEASONS = ("spring", "summer", "autumn", "winter")
TIMEZONE = "Asia/Shanghai"


class RealSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    mode: Literal["real"]
    hemisphere: Literal["north", "south"]


class VirtualSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    mode: Literal["virtual"]
    weeks: Literal[1, 2, 4]
    start_season: Literal["spring", "summer", "autumn", "winter"]

    @field_validator("weeks", mode="before")
    @classmethod
    def integer_weeks(cls, value):
        if type(value) is not int:
            raise ValueError("weeks must be an integer")
        return value


Settings = Annotated[RealSettings | VirtualSettings, Field(discriminator="mode")]
settings_adapter = TypeAdapter(Settings)

preferences = Table(
    "living_seasons", metadata,
    Column("space_id", String(36), ForeignKey("living_spaces.id", ondelete="CASCADE"), primary_key=True),
    Column("settings_json", Text, nullable=False),
    Column("started_at", Integer, nullable=False),
    Column("revision", Integer, nullable=False),
)
receipts = Table(
    "living_season_receipts", metadata,
    Column("space_id", String(36), ForeignKey("living_spaces.id", ondelete="CASCADE"), primary_key=True),
    Column("request_id", String(36), primary_key=True),
    Column("digest", String(64), nullable=False),
    Column("result_json", Text, nullable=False),
    Column("created_at", Integer, nullable=False),
)


def project(settings: Settings | None, started_at: int | None, revision: int, now: int) -> dict:
    current, boundary = None, None
    if isinstance(settings, RealSettings):
        local = datetime.fromtimestamp(now, ZoneInfo(TIMEZONE))
        index = ((local.month % 12) // 3 - 1) % 4
        if settings.hemisphere == "south":
            index = (index + 2) % 4
        current = SEASONS[index]
        month = next((m for m in (3, 6, 9, 12) if m > local.month), 3)
        year = local.year + (1 if local.month == 12 else 0)
        boundary = int(datetime(year, month, 1, tzinfo=ZoneInfo(TIMEZONE)).timestamp())
    elif isinstance(settings, VirtualSettings):
        duration = settings.weeks * 7 * 86400
        elapsed = max(0, now - started_at)
        step = elapsed // duration
        current = SEASONS[(SEASONS.index(settings.start_season) + step) % 4]
        boundary = started_at + (step + 1) * duration
    return {"settings": settings.model_dump() if settings else None,
            "started_at": started_at, "revision": revision, "observed_at": now,
            "timezone": TIMEZONE, "current_season": current, "next_change_at": boundary}


def read(conn, owner_id: str, space_id: str, now: int) -> dict:
    space = LivingStore._row(conn, owner_id, space_id)
    if space["mode"] != "private":
        raise LivingError("invalid_action", "共同空间的四季需要成员共同决定，暂未开放")
    row = conn.execute(select(preferences).where(preferences.c.space_id == space_id)).mappings().first()
    if row is None:
        return project(None, None, 0, now)
    try:
        settings = settings_adapter.validate_json(row["settings_json"])
        if row["revision"] < 1 or row["started_at"] < 0:
            raise ValueError()
        return project(settings, row["started_at"], row["revision"], now)
    except (ValueError, TypeError, OverflowError):
        raise LivingError("corrupt_state", "四季设置暂时无法读取，请稍后重试") from None


def preview(conn, owner_id: str, space_id: str, settings: Settings, now: int) -> dict:
    existing = read(conn, owner_id, space_id, now)
    unchanged = existing["settings"] == settings.model_dump()
    return project(settings, existing["started_at"] if unchanged else now, existing["revision"], now)


def save(conn, owner_id: str, space_id: str, request_id: str, expected_revision: int,
         settings: Settings, now: int) -> dict:
    existing = read(conn, owner_id, space_id, now)
    encoded = json.dumps({"settings": settings.model_dump(), "revision": expected_revision}, sort_keys=True)
    digest = hashlib.sha256(encoded.encode()).hexdigest()
    receipt = conn.execute(select(receipts).where(receipts.c.space_id == space_id,
                                                  receipts.c.request_id == request_id)).mappings().first()
    if receipt:
        if receipt["digest"] != digest:
            raise LivingError("conflict", "同一请求不能更换设置，请重新核对")
        try:
            result = json.loads(receipt["result_json"])
            stored = settings_adapter.validate_python(result["settings"])
            rebuilt = project(stored, result["started_at"], result["revision"], result["observed_at"])
            if rebuilt != result:
                raise ValueError()
            return result
        except (ValueError, KeyError, TypeError):
            raise LivingError("corrupt_state", "保存记录暂时无法核对") from None
    if existing["revision"] != expected_revision:
        raise LivingError("conflict", "四季设置已更新，请先核对最新设置")
    changed = existing["settings"] != settings.model_dump()
    result = project(settings, now if changed else existing["started_at"],
                     expected_revision + int(changed), now)
    if changed:
        values = {"settings_json": settings.model_dump_json(), "started_at": now,
                  "revision": result["revision"]}
        if expected_revision == 0:
            conn.execute(insert(preferences).values(space_id=space_id, **values))
        else:
            conn.execute(update(preferences).where(preferences.c.space_id == space_id).values(**values))
    conn.execute(insert(receipts).values(space_id=space_id, request_id=request_id, digest=digest,
                                         result_json=json.dumps(result), created_at=now))
    return result
