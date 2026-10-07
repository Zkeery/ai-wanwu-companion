"""数据模型：照片、识别对象、角色。"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, ForeignKeyConstraint, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Photo(Base):
    __tablename__ = "photos"

    id: Mapped[int] = mapped_column(primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    filename: Mapped[str] = mapped_column(String(255))
    theme_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="done")  # pending | done | failed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    objects: Mapped[list["Object"]] = relationship(
        back_populates="photo", cascade="all, delete-orphan"
    )


class Object(Base):
    __tablename__ = "objects"

    id: Mapped[int] = mapped_column(primary_key=True)
    photo_id: Mapped[int] = mapped_column(ForeignKey("photos.id"))
    label: Mapped[str] = mapped_column(String(255))
    category: Mapped[str] = mapped_column(String(16), default="unknown", server_default="unknown")
    visual_features: Mapped[str] = mapped_column(Text, default="", server_default="")
    character_concept_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    bbox_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    photo: Mapped["Photo"] = relationship(back_populates="objects")
    character: Mapped["Character | None"] = relationship(
        back_populates="object", uselist=False
    )


class PhotoRequest(Base):
    """Durable recognition receipts; never store original image bytes."""
    __tablename__ = "photo_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    digest: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="running")
    photo_id: Mapped[int | None] = mapped_column(ForeignKey("photos.id"), nullable=True)


class Character(Base):
    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(primary_key=True)
    object_id: Mapped[int] = mapped_column(ForeignKey("objects.id"))
    owner_id: Mapped[str | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True
    )
    current_space_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    theme_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    location_epoch: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    name: Mapped[str] = mapped_column(String(255))
    persona: Mapped[str] = mapped_column(Text)
    opening_line: Mapped[str] = mapped_column(Text)
    image_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    generation_brief_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="ready")  # generating | ready | failed
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    object: Mapped["Object"] = relationship(back_populates="character")
    messages: Mapped[list["Message"]] = relationship(
        back_populates="character", cascade="all, delete-orphan"
    )
    memories: Mapped[list["Memory"]] = relationship(
        back_populates="character", cascade="all, delete-orphan"
    )
    scene_state: Mapped["SceneState | None"] = relationship(
        back_populates="character", cascade="all, delete-orphan", uselist=False
    )


class CharacterMotionAsset(Base):
    __tablename__ = "character_motion_assets"

    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), primary_key=True)
    pack_id: Mapped[str] = mapped_column(String(32), unique=True)
    source_image_path: Mapped[str] = mapped_column(String(512))
    source_sha256: Mapped[str] = mapped_column(String(64))
    manifest_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class CharacterActivityMotionAsset(Base):
    __tablename__ = "character_activity_motion_assets"

    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), primary_key=True)
    activity: Mapped[str] = mapped_column(String(16), primary_key=True)
    pack_id: Mapped[str] = mapped_column(String(32), unique=True)
    source_image_path: Mapped[str] = mapped_column(String(512))
    source_sha256: Mapped[str] = mapped_column(String(64))
    manifest_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class MotionPreparationTask(Base):
    __tablename__ = "motion_preparation_tasks"

    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), primary_key=True)
    activity: Mapped[str] = mapped_column(String(16), primary_key=True)
    owner_id: Mapped[str] = mapped_column(String(36))
    source_image_path: Mapped[str] = mapped_column(String(512))
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    input_pack_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    state: Mapped[str] = mapped_column(String(16), default="waiting_source")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    retry_at: Mapped[int] = mapped_column(Integer, default=0)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class MotionCleanupTask(Base):
    __tablename__ = "motion_cleanup_tasks"

    pack_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class MotionGenerationRequest(Base):
    __tablename__ = 'motion_generation_requests'
    __table_args__ = (UniqueConstraint('character_id', 'source_image_path'),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey('characters.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[str] = mapped_column(String(36))
    source_image_path: Mapped[str] = mapped_column(String(512))
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[str] = mapped_column(String(32), default='waiting_authorization')
    approval_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    approval_sha256: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    price_verified_on: Mapped[str | None] = mapped_column(String(10), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class MotionGenerationActivityRequest(Base):
    """Additional activity requests; legacy walk rows remain untouched."""
    __tablename__ = 'motion_generation_activity_requests'
    __table_args__ = (UniqueConstraint('character_id', 'source_image_path', 'activity'),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    character_id: Mapped[int] = mapped_column(ForeignKey('characters.id', ondelete='CASCADE'), index=True)
    owner_id: Mapped[str] = mapped_column(String(36))
    activity: Mapped[str] = mapped_column(String(12))
    source_image_path: Mapped[str] = mapped_column(String(512))
    source_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    prompt_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state: Mapped[str] = mapped_column(String(32), default='waiting_authorization')
    approval_ref: Mapped[str | None] = mapped_column(String(128), nullable=True)
    approval_sha256: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    price_verified_on: Mapped[str | None] = mapped_column(String(10), nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(48), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class CharacterPersonality(Base):
    __tablename__ = "character_personalities"

    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), primary_key=True)
    original_persona: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(16), default="original")
    tags_json: Mapped[str] = mapped_column(Text, default="[]")
    custom_text: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[str | None] = mapped_column(String(16), nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=0)


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(
        ForeignKey("characters.id", ondelete="CASCADE")
    )
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)

    character: Mapped["Character"] = relationship(back_populates="messages")


class Memory(Base):
    __tablename__ = "memories"

    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(
        ForeignKey("characters.id", ondelete="CASCADE")
    )
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, onupdate=_utcnow
    )

    character: Mapped["Character"] = relationship(back_populates="memories")


class SceneState(Base):
    __tablename__ = "scene_states"

    id: Mapped[int] = mapped_column(primary_key=True)
    character_id: Mapped[int] = mapped_column(
        ForeignKey("characters.id", ondelete="CASCADE"), unique=True
    )
    state_json: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=_utcnow, onupdate=_utcnow
    )

    character: Mapped["Character"] = relationship(back_populates="scene_state")


class SceneProposal(Base):
    """每个角色最多一个待确认操作；来源消息删除后自动清除。"""
    __tablename__ = "scene_proposals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    character_id: Mapped[int] = mapped_column(
        ForeignKey("characters.id", ondelete="CASCADE"), unique=True
    )
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    action: Mapped[str] = mapped_column(String(32))
    space_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    space_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    location_epoch: Mapped[int | None] = mapped_column(Integer, nullable=True)


class SceneImport(Base):
    __tablename__ = "scene_imports"
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"), primary_key=True)
    space_id: Mapped[str] = mapped_column(String(36))
    source_json: Mapped[str] = mapped_column(Text)


class SceneAgentChat(Base):
    __tablename__ = "scene_agent_chats"
    __table_args__ = (UniqueConstraint("owner_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    request_id: Mapped[str] = mapped_column(String(36))
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"))
    source_message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"))
    context_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="running")
    result_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(32), nullable=True)


class GenerationCredits(Base):
    __tablename__ = "generation_credits"
    __table_args__ = (CheckConstraint("available >= 0 AND available <= 5"),)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    available: Mapped[int] = mapped_column(Integer, default=5)


class GenerationCharge(Base):
    __tablename__ = "generation_charges"
    __table_args__ = (Index("uq_active_generation_charge", "character_id", unique=True,
                           sqlite_where=text("status = 'reserved'")),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    character_id: Mapped[int | None] = mapped_column(ForeignKey("characters.id", ondelete="SET NULL"), nullable=True)
    status: Mapped[str] = mapped_column(String(16))  # reserved | spent | refunded


class Recreation(Base):
    __tablename__ = "recreations"
    __table_args__ = (UniqueConstraint("owner_id", "request_id"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    owner_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    request_id: Mapped[str] = mapped_column(String(36))
    source_id: Mapped[int | None] = mapped_column(ForeignKey("characters.id", ondelete="SET NULL"), nullable=True)
    character_id: Mapped[int | None] = mapped_column(ForeignKey("characters.id", ondelete="SET NULL"), nullable=True)
    charge_id: Mapped[str] = mapped_column(ForeignKey("generation_charges.id"))


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    phone: Mapped[str] = mapped_column(String(11), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class LoginInvite(Base):
    """Private reusable login credentials; only the SHA256 digest is stored."""
    __tablename__ = "login_invites"

    code_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class InviteLoginWindow(Base):
    __tablename__ = "invite_login_windows"

    source_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    minute: Mapped[int] = mapped_column(Integer, primary_key=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)


class ThemePublication(Base):
    """Explicit public consent; private content remains on the owned character."""
    __tablename__ = "theme_publications"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    character_id: Mapped[int] = mapped_column(
        ForeignKey("characters.id", ondelete="CASCADE"), unique=True
    )
    author_name: Mapped[str] = mapped_column(String(20))
    published_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow, index=True)


class Session(Base):
    """服务端只存令牌哈希；有效期滑动续期。"""
    __tablename__ = "sessions"

    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class VerificationCode(Base):
    """验证码只存哈希，不存明文；同一手机号一条记录，重发覆盖。"""
    __tablename__ = "verification_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    phone: Mapped[str] = mapped_column(String(11), unique=True, index=True)
    code_hash: Mapped[str] = mapped_column(String(64))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    last_sent_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
    send_day: Mapped[str] = mapped_column(String(10))
    send_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class SmsDailyQuota(Base):
    """Durable global reservations; delivery failure and process restart do not refund."""
    __tablename__ = "sms_daily_quotas"
    day: Mapped[str] = mapped_column(String(10), primary_key=True)
    used: Mapped[int] = mapped_column(Integer, default=0)


class LivingMembership(Base):
    """共居空间成员：某伙伴是某共享空间的成员；应用层维护一致性。"""
    __tablename__ = "living_memberships"

    space_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    companion_id: Mapped[str] = mapped_column(String(128), primary_key=True)


class Team(Base):
    __tablename__ = "teams"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    creator_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    title: Mapped[str] = mapped_column(String(30))
    theme_id: Mapped[str] = mapped_column(String(32))
    create_digest: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="active")
    invite_hash: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class TeamMember(Base):
    __tablename__ = "team_members"
    team_id: Mapped[str] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    id: Mapped[str] = mapped_column(String(36), unique=True)
    display_name: Mapped[str] = mapped_column(String(20))
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)


class TeamSubmission(Base):
    __tablename__ = "team_submissions"
    __table_args__ = (
        ForeignKeyConstraint(["team_id", "owner_id"], ["team_members.team_id", "team_members.user_id"], ondelete="CASCADE"),
        UniqueConstraint("team_id", "character_id"),
    )
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    team_id: Mapped[str] = mapped_column(String(36))
    owner_id: Mapped[str] = mapped_column(String(36))
    character_id: Mapped[int] = mapped_column(ForeignKey("characters.id", ondelete="CASCADE"))
    submitted_at: Mapped[datetime] = mapped_column(DateTime, default=_utcnow)
