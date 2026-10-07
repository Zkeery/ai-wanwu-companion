"""Offline preflight tests: fail closed, redact values, avoid app side effects."""
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from app.core.config import Settings
from app.services.release_readiness import assess, frontend_environment

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / "backend/scripts/check_release_readiness.py"


def config(**changes):
    values = dict(model_api_key="test-private-value", model_base_url="https://example.invalid/v1",
                  image_base_url="", dev_auth_token="", dev_sms_fixed_code="",
                  generation_quota_enabled=True, database_url="sqlite:///test-only.db",
                  model_timeout_seconds=60, model_max_retries=2)
    values.update(changes)
    return Settings(_env_file=None, **values)


def check(report, ident):
    return next(c for c in report["checks"] if c["id"] == ident)


def test_config_clean_does_not_bypass_manual_or_code_gates(tmp_path):
    report = assess(config(), {}, tmp_path)
    assert check(report, "dev_token")["status"] == "pass"
    assert check(report, "sms_provider")["status"] == "blocked"
    assert check(report, "backup_restore")["status"] == "pending"
    assert not report["ready_for_release"]
    assert sum(report["summary"].values()) == len(report["checks"])


@pytest.mark.parametrize("changes,ident", [
    ({"dev_auth_token": "secret-local-token"}, "dev_token"),
    ({"app_env": "test"}, "production_environment"),
    ({"legacy_claim_user_id": "synthetic-owner"}, "legacy_claim_config"),
    ({"life_simulation_enabled": True}, "life_preview"),
    ({"life_runtime_preview_enabled": True}, "life_preview"),
    ({"dev_auth_token": " "}, "dev_token"),
    ({"dev_sms_fixed_code": "123456"}, "fixed_sms_code"),
    ({"model_api_key": ""}, "model_provider"),
    ({"model_base_url": "http://example.invalid"}, "model_transport"),
    ({"image_base_url": "https://user:secret@example.invalid"}, "model_transport"),
    ({"model_base_url": "https://[broken"}, "model_transport"),
    ({"model_timeout_seconds": 0}, "model_call_bounds"),
    ({"model_timeout_seconds": float("inf")}, "model_call_bounds"),
    ({"model_timeout_seconds": 301}, "model_call_bounds"),
    ({"model_max_retries": -1}, "model_call_bounds"),
    ({"model_max_retries": 4}, "model_call_bounds"),
    ({"generation_quota_enabled": False}, "generation_quota"),
    ({"database_url": "sqlite:///:memory:"}, "persistent_database"),
    ({"database_url": "sqlite:///file:shared?mode=memory&uri=true"}, "persistent_database"),
])
def test_unsafe_config_blocks(tmp_path, changes, ident):
    assert check(assess(config(**changes), {}, tmp_path), ident)["status"] == "blocked"


def test_current_static_development_paths_are_detected():
    report = assess(config(), {}, ROOT)
    assert check(report, "sms_provider")["status"] == "blocked"
    # R6.2 removed static access and guarded claim. Static analysis cannot certify either.
    for ident in ("private_image_access", "legacy_claim"):
        assert check(report, ident)["status"] == "pending"


def test_unparseable_source_is_pending_not_pass(tmp_path):
    p = tmp_path / "backend/app/main.py"
    p.parent.mkdir(parents=True)
    p.write_text("not valid (", encoding="utf-8")
    assert check(assess(config(), {}, tmp_path), "private_image_access")["status"] == "pending"


def test_production_env_precedence_and_no_expansion(tmp_path):
    front = tmp_path / "frontend"
    front.mkdir()
    (front / ".env").write_text("NEXT_PUBLIC_DEV_SMS_CODE=base\nNEXT_PUBLIC_OFFLINE_PREVIEW=true\n")
    (front / ".env.production").write_text("NEXT_PUBLIC_DEV_SMS_CODE=prod\n")
    (front / ".env.local").write_text("NEXT_PUBLIC_DEV_SMS_CODE=local\n")
    (front / ".env.production.local").write_text("NEXT_PUBLIC_DEV_SMS_CODE=final\nNEXT_PUBLIC_OTHER=${MODEL_API_KEY}\n")
    env = frontend_environment(tmp_path, {"MODEL_API_KEY": "must-not-expand"})
    assert env["NEXT_PUBLIC_DEV_SMS_CODE"] == "final"
    assert env["NEXT_PUBLIC_OTHER"] == "${MODEL_API_KEY}"
    assert "MODEL_API_KEY" not in env
    env = frontend_environment(tmp_path, {"NEXT_PUBLIC_DEV_SMS_CODE": "", "NEXT_PUBLIC_OFFLINE_PREVIEW": "false"})
    report = assess(config(), env, tmp_path)
    assert check(report, "frontend_sms_hint")["status"] == "pass"
    assert check(report, "frontend_offline")["status"] == "pass"


@pytest.mark.parametrize("env,ident", [
    ({"NEXT_PUBLIC_DEV_SMS_CODE": "123456"}, "frontend_sms_hint"),
    ({"NEXT_PUBLIC_OFFLINE_PREVIEW": "true"}, "frontend_offline"),
    ({"NEXT_PUBLIC_OFFLINE_PREVIEW": "${PREVIEW}"}, "frontend_offline"),
    ({"NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW": "true"}, "frontend_life_preview"),
    ({"NEXT_PUBLIC_LIFE_RUNTIME_PREVIEW": "${PREVIEW}"}, "frontend_life_preview"),
    ({"NEXT_PUBLIC_MODEL_API_KEY": "sensitive"}, "frontend_public_secrets"),
    ({"NEXT_PUBLIC_AUTH_TOKEN": "sensitive"}, "frontend_public_secrets"),
])
def test_frontend_dev_and_sensitive_inputs_block(tmp_path, env, ident):
    assert check(assess(config(), env, tmp_path), ident)["status"] == "blocked"


def test_report_never_contains_configuration_values(tmp_path):
    marker = "sensitive-value-do-not-print"
    report = assess(config(model_api_key=marker, dev_auth_token=marker,
                           image_base_url="https://" + marker + ".invalid"),
                    {"NEXT_PUBLIC_MODEL_API_KEY": marker}, tmp_path)
    assert marker not in json.dumps(report)
    assert str(tmp_path) not in json.dumps(report)


def run_cli(tmp_path, **overrides):
    env = {**os.environ, "MODEL_API_KEY": "", "DEV_AUTH_TOKEN": "", "DEV_SMS_FIXED_CODE": "",
           "DATABASE_URL": "sqlite:///" + str(tmp_path / "untouched/missing.db"),
           "UPLOAD_DIR": str(tmp_path / "untouched/uploads"), **overrides}
    return subprocess.run([sys.executable, str(CLI), "--output", str(tmp_path / "report.json")],
                          cwd=tmp_path, env=env, text=True, capture_output=True, timeout=15)


def test_cli_reports_blocked_without_starting_app_or_creating_db(tmp_path):
    result = run_cli(tmp_path)
    assert result.returncode == 2, result.stdout
    report = json.loads((tmp_path / "report.json").read_text())
    assert not report["ready_for_release"]
    assert not (tmp_path / "untouched").exists()
    assert (tmp_path / "report.json").stat().st_mode & 0o777 == 0o600


def test_cli_refuses_overwrite(tmp_path):
    report = tmp_path / "report.json"
    report.write_text("keep me")
    result = run_cli(tmp_path)
    assert result.returncode == 1
    assert report.read_text() == "keep me"
    assert json.loads(result.stdout)["error"]["code"] == "report_write_failed"


def test_invalid_settings_do_not_print_secret_validation_input(tmp_path):
    marker = "a-secret-where-a-number-was-expected"
    result = run_cli(tmp_path, MODEL_TIMEOUT_SECONDS=marker)
    assert result.returncode == 1
    assert marker not in result.stdout + result.stderr
    assert json.loads(result.stdout)["error"]["code"] == "preflight_input_invalid"
    assert not (tmp_path / "report.json").exists()
