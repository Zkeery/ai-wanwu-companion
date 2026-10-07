"""Read-only release preflight. Never import the running app or database here."""
from __future__ import annotations

import ast
import math
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping
from urllib.parse import urlsplit

from dotenv import dotenv_values
from sqlalchemy.engine import make_url

from app.core.config import Settings
from app.services.sms_readiness import assess_sms


def frontend_environment(root: Path, environ: Mapping[str, str]) -> dict[str, str]:
    """Inspect intended production inputs, not an already-built frontend bundle."""
    values: dict[str, str] = {}
    for name in (".env", ".env.production", ".env.local", ".env.production.local"):
        file = root / "frontend" / name
        if file.exists():
            # Keep unresolved references visible; do not expand secrets into output.
            values.update({k: v or "" for k, v in dotenv_values(file, interpolate=False).items()})
    values.update(environ)
    return {k: v for k, v in values.items() if k.startswith("NEXT_PUBLIC_")}


def _tree(file: Path) -> ast.AST | None:
    try:
        return ast.parse(file.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, SyntaxError):
        return None


def _static_findings(root: Path) -> list[tuple[str, str, bool, str, str]]:
    """Known-pattern findings only. An absent match is NOT a security pass."""
    specs = [
        ("sms_provider", "backend/app/api/deps.py", "mock_sms",
         "默认短信发送器仍为模拟实现", "接入已获批准的短信平台，并完成收发与限流验收"),
        ("private_image_access", "backend/app/main.py", "static_uploads",
         "源码直接挂载 /uploads 静态目录，需要补齐私人图片访问边界", "核实匿名已知 URL 访问并实现兼容鉴权，复验公开与队内图片"),
        ("legacy_claim", "backend/app/api/auth.py", "claim_route",
         "仍有开发历史认领入口，需要确认生产限制", "验证认领授权与范围，禁止任意登录账号认领无主历史数据"),
    ]
    result = []
    for ident, source, pattern, message, action in specs:
        tree = _tree(root / source)
        found = False
        if tree is not None:
            for node in ast.walk(tree):
                if not isinstance(node, ast.Call):
                    continue
                if pattern == "mock_sms" and isinstance(node.func, ast.Name):
                    found |= node.func.id == "MockSmsProvider"
                if pattern == "static_uploads" and isinstance(node.func, ast.Attribute):
                    found |= (node.func.attr == "mount"
                              and any(isinstance(a, ast.Constant) and a.value == "/uploads" for a in node.args)
                              and any(isinstance(n, ast.Call) and isinstance(n.func, ast.Name)
                                      and n.func.id == "StaticFiles" for n in ast.walk(node)))
                if pattern == "claim_route" and isinstance(node.func, ast.Attribute):
                    found |= (node.func.attr == "post"
                              and any(isinstance(a, ast.Constant) and a.value == "/claim" for a in node.args))
            if pattern == "claim_route" and any(
                isinstance(n, ast.FunctionDef) and n.name == "claim"
                and any(isinstance(c, ast.Call) and isinstance(c.func, ast.Name)
                        and c.func.id == "require_legacy_claim" for c in ast.walk(n))
                for n in ast.walk(tree)
            ):
                found = False  # Guard found; runtime evidence is still required.
        result.append((ident, source, found, message, action))
    return result


def assess(settings: Settings, frontend: Mapping[str, str], root: Path) -> dict:
    """Return only fixed explanations and booleans; never serialize settings."""
    checks: list[dict[str, str]] = []

    def add(ident: str, status: str, message: str, source: str, action: str) -> None:
        checks.append(dict(id=ident, status=status, message=message, source=source, next_step=action))

    config_source = "backend/app/core/config.py"

    def condition(ident: str, ok: bool, good: str, bad: str, action: str) -> None:
        add(ident, "pass" if ok else "blocked", good if ok else bad, config_source, action)

    condition("production_environment", settings.app_env == "production",
              "已选择生产环境", "当前不是生产环境",
              "完成正式短信等阻塞项后使用生产配置；不直接修改本地开发服务")
    condition("legacy_claim_config", not settings.legacy_claim_user_id,
              "历史数据认领授权未配置", "仍配置历史数据认领授权",
              "正式环境移除开发历史认领配置")
    condition("life_preview", not any((settings.life_simulation_enabled,
              settings.life_runtime_preview_enabled, settings.life_live_planner_preview_enabled)),
              "生活模拟与隔离预览开关均关闭", "生活模拟或隔离预览仍启用",
              "正式环境关闭预览开关；真实功能须按独立验收与发布方案接入")
    condition("dev_token", not settings.dev_auth_token, "开发令牌未配置", "开发令牌仍启用",
              "生产环境禁用开发令牌；保留本地联调环境")
    condition("fixed_sms_code", not settings.dev_sms_fixed_code, "固定验证码未配置", "固定验证码仍启用",
              "生产环境移除固定验证码并验证错码拒绝")
    condition("model_provider", not settings.use_mock, "已配置模型凭证；未检验有效性", "当前模型为模拟模式",
              "真实模型验收前核实配置；本预检不调用模型")
    endpoints = [settings.model_base_url, settings.image_base_url or settings.model_base_url]

    def secure_endpoint(value: str) -> bool:
        try:
            url = urlsplit(value)
            return bool(url.scheme == "https" and url.hostname and not url.username and not url.password)
        except ValueError:
            return False

    condition("model_transport", all(secure_endpoint(x) for x in endpoints),
              "模型接口配置为 HTTPS 且无 URL 内嵌凭证", "模型接口为空、非 HTTPS 或含 URL 内嵌凭证",
              "核实当前服务商 HTTPS 接口；不在报告中输出地址")
    condition("model_call_bounds", math.isfinite(settings.model_timeout_seconds)
              and 0 < settings.model_timeout_seconds <= 300 and 0 <= settings.model_max_retries <= 3,
              "调用超时与重试在预检边界内", "调用超时或重试超出预检边界",
              "根据质量与费用方案设置正数超时（≤300 秒）及有限重试（0–3）；此范围不是性能验收")
    condition("generation_quota", settings.generation_quota_enabled,
              "生成额度开关已启用；扣返规则仍需验收", "生成额度开关仍关闭",
              "完成真实契约和额度验收后再开放，不由预检自动开启")
    add("scene_agent", "pending", "场景 Agent 已启用，仍需真实验收" if settings.scene_agent_enabled
        else "场景 Agent 尚未开放，需真实验收后决定启用", config_source, "完成确认／拒绝及真实回复质量验收")

    url = make_url(settings.database_url)
    memory = url.get_backend_name() == "sqlite" and (
        not url.database or url.database == ":memory:" or url.query.get("mode") == "memory")
    condition("persistent_database", not memory, "配置非内存数据库；未验证生产持久化",
              "配置为内存数据库", "生产数据须使用持久存储并验证备份恢复")
    frontend_source = "frontend/.env* + process environment (production inputs)"
    life_ui = frontend.get('NEXT_PUBLIC_LIFE_RUNTIME_ENABLED', '').strip()
    aligned = life_ui in ('', 'false', 'true') and (life_ui == 'true') == settings.life_runtime_enabled
    add('life_runtime_entry', 'pending' if aligned else 'blocked',
        ('自主生活正式入口配置一致，持续真实运行仍待验' if settings.life_runtime_enabled
         else '自主生活正式入口尚未开放，持续真实运行仍待验') if aligned
        else '自主生活前后端开关不一致或前端值无效',
        config_source + ' + ' + frontend_source,
        '配套启用正式入口，关闭预览；按批准额度验证持续调度、暂停、跨账号与恢复，不自动授予预算')
    for ident, key, label in (
        ("frontend_sms_hint", "NEXT_PUBLIC_DEV_SMS_CODE", "前端开发验证码提示"),
        ("frontend_offline", "NEXT_PUBLIC_OFFLINE_PREVIEW", "前端离线模拟入口"),
        ("frontend_life_preview", "NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW", "前端生活预览入口"),
    ):
        value = frontend.get(key, "").strip()
        active = bool(value) if ident == "frontend_sms_hint" else value.lower() not in ("", "false", "0")
        add(ident, "blocked" if active else "pass", label + ("仍配置" if active else "未配置"),
            frontend_source, "正式构建清除开发配置，再检查实际产物；运行时改变量不会清除已打包内容")
    secret_keys = any(v.strip() and re.search(r"(?:SECRET|TOKEN|PASSWORD|(?:API|ACCESS|PRIVATE)_?KEY)", k)
                      for k, v in frontend.items())
    add("frontend_public_secrets", "blocked" if secret_keys else "pass",
        "公开构建变量中发现密钥类命名" if secret_keys else "未发现已配置的公开密钥类变量",
        frontend_source, "密钥只留服务端；本项为命名检查，产物还需独立核查")

    frontend_auth = frontend.get("NEXT_PUBLIC_AUTH_MODE", "sms").strip() or "sms"
    condition("auth_mode_alignment", frontend_auth == settings.auth_mode,
              "前后端登录模式一致", "前后端登录模式不一致", "按相同登录模式重新构建前端")
    if settings.auth_mode == "sms":
        checks.extend(assess_sms(settings))
    else:
        condition("invite_sms_off", not settings.sms_live_enabled,
                  "邀请码模式已关闭短信", "邀请码模式仍启用短信", "关闭SMS_LIVE_ENABLED")
        add("invite_acceptance", "pending", "邀请码登录、撤销及跨账号隔离需实际验收",
            "backend/app/services/invites.py", "核对生产邀请码配置与持久数据，不把配置扫描当作验收")
    for ident, source, found, message, action in _static_findings(root):
        if ident == 'sms_provider':
            continue
        add(ident, "blocked" if found else "pending", message if found
            else "未匹配已知开发实现或源码不可读；替代实现仍需验证", source, action)

    for ident, message, action in (
        ("real_quality", "真实识别、差异化形象与回复质量待验", "明确样例、评分与费用授权后执行"),
        ("cost_cap", "整条模型链路成本上限及熔断证据待补齐", "区分账号生成次数与平台费用上限，明确内测预算"),
        ("data_lifecycle", "识别元数据、请求记录及完整删除期限待确认", "确认留存口径后实现并验证，保留已确认共居删除规则"),
        ("backup_restore", "生产数据库与角色图联合恢复尚待验证", "先隔离演练，不覆盖主数据"),
        ("hosting", "国内持久存储、HTTPS、日志告警及部署方案待验", "完成预算与平台确认后实施，当前不创建云资源"),
        ("end_to_end", "生产双账号权限和真实设备全链路待验", "按前端第6阶段路径收集证据；配置扫描不能替代"),
    ):
        add(ident, "pending", message, "docs/PRD/版本/V1.1/技术文档/第6阶段技术开发文档.md", action)

    counts = Counter(c["status"] for c in checks)
    return {
        "schema_version": 1,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "scope": "local configuration and source preflight; no network or database access",
        "ready_for_release": not (counts["blocked"] or counts["pending"]),
        "summary": {key: counts[key] for key in ("pass", "blocked", "pending")},
        "checks": checks,
    }
