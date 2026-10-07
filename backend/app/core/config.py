"""应用配置：从 .env 读取，代码不硬编码密钥与模型名。"""
from __future__ import annotations

from functools import lru_cache
import math
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic_settings import BaseSettings, SettingsConfigDict
from pydantic import field_validator, model_validator
from sqlalchemy.engine import make_url

BASE_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BASE_DIR / ".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    app_env: Literal["development", "test", "production"] = "development"
    life_simulation_enabled: bool = False
    gathering_dialogue_enabled: bool = False  # Real exchanges still require a single-use grant.
    gathering_dialogue_automatic_enabled: bool = False  # Requires its own bounded batch and owner opt-in.
    competition_ai_enabled: bool = False  # Every suggestion also requires an owner-scoped grant.
    life_runtime_preview_enabled: bool = False
    life_runtime_enabled: bool = False  # Real runtime only; never grants permission or budget.
    life_live_planner_preview_enabled: bool = False  # Test-only, default off; budget still defaults to zero.
    legacy_claim_user_id: str = ""  # Explicit local migration owner; disabled by default.

    # 模型
    model_base_url: str = ""
    image_base_url: str = ""
    model_api_key: str = ""
    vision_model: str = "qwen-vl-max"
    image_model: str = "wanx2.1-t2i-turbo"
    motion_atlas_base_url: str = ""
    motion_atlas_api_key: str = ""
    motion_generation_enabled: bool = False  # Requires a separate one-shot grant for every request.
    chat_model: str = "qwen-plus"
    voice_local_model_path: str = ""  # Optional preinstalled ASR model; never auto-download.
    voice_live_reply_enabled: bool = False  # Explicit operator enablement after live acceptance.

    # 数据与上传
    database_url: str = "sqlite:///./data/app.db"
    upload_dir: str = "./data/uploads"

    # 护栏
    model_timeout_seconds: float = 60.0
    model_max_retries: int = 2
    model_enable_thinking: bool | None = None  # Opt-in only after provider verification.
    vision_enable_thinking: bool | None = None  # Separate from chat; verified MaaS Ling only.
    model_http_pool_enabled: bool = False  # Enable after connection reuse verification.
    character_bundle_enabled: bool = True
    scene_agent_enabled: bool = False  # Enable only after real-provider acceptance.
    generation_quota_enabled: bool = False
    vision_max_edge: int = 2048  # Recognition copy only; accepted input still <=4096px.

    @field_validator("vision_max_edge")
    @classmethod
    def validate_vision_edge(cls, value: int) -> int:
        if not 512 <= value <= 4096:
            raise ValueError("VISION_MAX_EDGE must be between 512 and 4096")
        return value

    # 账号与会话
    auth_mode: Literal["sms", "invite"] = "sms"
    session_ttl_seconds: int = 30 * 86400  # 30 天滑动续期
    code_ttl_seconds: int = 300  # 验证码有效期 5 分钟
    code_resend_seconds: int = 60  # 同号 60 秒限发
    code_daily_limit: int = 10  # 同号单日上限
    code_max_attempts: int = 5  # 连续校验失败作废阈值
    dev_auth_token: str = ""  # 仅本地开发过渡；正式环境留空禁用
    dev_sms_fixed_code: str = ""  # 仅本地开发过渡：固定验证码；正式环境留空禁用
    sms_provider: Literal["mock", "volcengine"] = "mock"
    sms_live_enabled: bool = False
    sms_access_key_id: str = ""
    sms_secret_access_key: str = ""
    sms_account: str = ""
    sms_sign: str = ""
    sms_template_id: str = ""
    sms_daily_limit: int = 0  # Global UTC-day send reservations; failures still count.
    sms_timeout_seconds: float = 10.0

    @property
    def sms_real_ready(self) -> bool:
        return (self.sms_provider == "volcengine" and self.sms_live_enabled
                and all(value.strip() for value in (self.sms_access_key_id, self.sms_secret_access_key,
                                                    self.sms_account, self.sms_sign, self.sms_template_id))
                and 0 < self.sms_daily_limit <= 10000
                and math.isfinite(self.sms_timeout_seconds) and 0 < self.sms_timeout_seconds <= 15)

    @field_validator("upload_dir")
    @classmethod
    def resolve_upload_dir(cls, value: str) -> str:
        path = Path(value).expanduser()
        return str((path if path.is_absolute() else BASE_DIR / path).resolve())

    @field_validator("database_url")
    @classmethod
    def resolve_database_url(cls, value: str) -> str:
        url = make_url(value)
        # SQLAlchemy 2.1 escapes ':memory:' when rendering a URL. Preserve the
        # explicit SQLite in-memory/empty forms, including driver and query args.
        if url.get_backend_name() == "sqlite" and url.database in (None, "", ":memory:"):
            return value
        if url.get_backend_name() == "sqlite" and url.database not in (None, "", ":memory:"):
            path = Path(url.database).expanduser()
            if not path.is_absolute():
                url = url.set(database=str((BASE_DIR / path).resolve()))
        return url.render_as_string(hide_password=False)

    @property
    def use_mock(self) -> bool:
        return not self.model_api_key.strip()

    @model_validator(mode="after")
    def validate_life_runtime(self):
        if not self.life_runtime_enabled:
            return self
        from app.living.life_provider import BASE_URL as LIFE_BASE_URL, MODEL as LIFE_MODEL
        database = make_url(self.database_url)
        if (self.life_simulation_enabled or self.life_runtime_preview_enabled
                or self.life_live_planner_preview_enabled):
            raise ValueError("life_runtime_conflicts_with_preview")
        if (database.get_backend_name() != "sqlite" or not database.database
                or database.database == ":memory:" or database.query.get("mode") == "memory"):
            raise ValueError("life_runtime_requires_persistent_sqlite")
        if (self.model_base_url != LIFE_BASE_URL or self.chat_model != LIFE_MODEL
                or not self.model_api_key.strip()):
            raise ValueError("life_runtime_requires_validated_planner_configuration")
        return self

    @property
    def life_runtime_active(self) -> bool:
        return self.life_runtime_enabled or (self.app_env == 'test' and self.life_runtime_preview_enabled)

    @model_validator(mode="after")
    def validate_shared_automatic(self):
        if self.gathering_dialogue_automatic_enabled:
            from app.living.life_provider import BASE_URL as SHARED_BASE_URL
            database = make_url(self.database_url)
            if (database.get_backend_name() != 'sqlite' or not database.database
                    or database.database == ':memory:' or database.query.get('mode') == 'memory'):
                raise ValueError('shared_automatic_requires_persistent_sqlite')
            if (not self.gathering_dialogue_enabled or self.model_base_url != SHARED_BASE_URL
                    or not self.model_api_key.strip()):
                raise ValueError('shared_automatic_requires_validated_dialogue_configuration')
        return self

    @model_validator(mode="after")
    def isolate_live_life_preview(self):
        if not self.life_live_planner_preview_enabled:
            return self
        runtime_dir = (BASE_DIR.parent / ".runtime").resolve()
        database = make_url(self.database_url)
        database_path = database.database
        if (self.app_env != "test" or not self.life_runtime_preview_enabled
                or database.get_backend_name() != "sqlite"
                or not database_path or database_path == ":memory:"
                or not Path(database_path).resolve().is_relative_to(runtime_dir)
                or not Path(self.upload_dir).resolve().is_relative_to(runtime_dir)):
            raise ValueError("life_live_planner_preview_requires_isolated_test_runtime")
        return self

    @model_validator(mode="after")
    def protect_production(self):
        if self.app_env != "production":
            return self
        issues = []
        if self.auth_mode == "sms" and not self.sms_real_ready:
            issues.append("mock_sms" if self.sms_provider == "mock" else "sms_configuration")
        if self.auth_mode == "invite" and self.sms_live_enabled:
            issues.append("invite_mode_sms_enabled")
        if self.life_simulation_enabled or self.life_runtime_preview_enabled or self.life_live_planner_preview_enabled:
            issues.append("life_preview")
        if self.dev_auth_token or self.dev_sms_fixed_code or self.legacy_claim_user_id:
            issues.append("development_access")
        if self.use_mock:
            issues.append("mock_model")
        for value in (self.model_base_url, self.image_base_url or self.model_base_url):
            try:
                url = urlsplit(value)
                if url.scheme != "https" or not url.hostname or url.username or url.password:
                    issues.append("model_transport")
            except ValueError:
                issues.append("model_transport")
        if (not math.isfinite(self.model_timeout_seconds) or not 0 < self.model_timeout_seconds <= 300
                or not 0 <= self.model_max_retries <= 3):
            issues.append("model_call_bounds")
        database = make_url(self.database_url)
        if database.get_backend_name() == "sqlite" and (
                database.database in (None, "", ":memory:") or database.query.get("mode") == "memory"):
            issues.append("memory_database")
        if issues:
            raise ValueError("production_configuration_blocked: " + ", ".join(sorted(set(issues))))
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
