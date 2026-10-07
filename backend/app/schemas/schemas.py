"""请求/响应结构（Pydantic）。"""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ObjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    label: str
    visual_features: str = ""
    category: str = "unknown"


class PhotoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    status: str
    objects: list[ObjectOut]
    theme_id: str | None = None


class CharacterCreate(BaseModel):
    object_id: int
    free_creation: bool = Field(default=False, strict=True)
    label: str | None = Field(default=None, min_length=1, max_length=100)
    visual_features: str | None = Field(default=None, max_length=500)

    @field_validator("label", "visual_features", mode="before")
    @classmethod
    def trim_label(cls, value):
        return value.strip() if isinstance(value, str) else value


class CharacterRename(BaseModel):
    name: str = Field(min_length=1, max_length=40)

    @field_validator("name", mode="before")
    @classmethod
    def trim_name(cls, value):
        return value.strip() if isinstance(value, str) else value


class CharacterOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    persona: str
    opening_line: str
    image_path: str | None = None
    status: str
    created_at: datetime
    theme_id: str | None = None


class ResidenceOverview(BaseModel):
    space_id: str
    scene_type: Literal["home", "desert", "forest"]
    mode: Literal["private", "shared"]


class LifeActivitySummary(BaseModel):
    revision: int = Field(gt=0)
    occurred_at: datetime
    source: Literal["user"] = "user"
    text: str = Field(min_length=1, max_length=80)


class GatheringOverview(BaseModel):
    id: str
    title: str


class CharacterOverview(BaseModel):
    character: CharacterOut
    residence: ResidenceOverview | None
    last_interaction_at: datetime | None
    recent_activity: list[LifeActivitySummary] = Field(default_factory=list, max_length=3)
    gathering: GatheringOverview | None = None


class ChatRequest(BaseModel):
    message: str
    request_id: str | None = None

    @field_validator("request_id")
    @classmethod
    def validate_request_id(cls, value):
        if value is not None:
            from uuid import UUID
            return str(UUID(value))
        return value


class MessageOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    role: str
    content: str
    created_at: datetime


class MemoryCreate(BaseModel):
    content: str


class MemoryUpdate(BaseModel):
    content: str


class MemoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    content: str
    created_at: datetime
    updated_at: datetime


class SceneProposalOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    action: str


class SceneOut(BaseModel):
    living: dict | None = None
    scene_name: str
    elements: dict
    can_undo: bool
    action_labels: dict[str, str]
    feedback: str | None = None
    proposal: SceneProposalOut | None = None
