"""A paid voice-reply batch must stay bounded and retain failed attempts."""
from decimal import Decimal
import json
from pathlib import Path
import sys

import httpx
import pytest

from app.core.config import get_settings
from scripts import run_voice_reply_smoke as smoke
from scripts import run_voice_reply_prompt_v2 as style_v2
from scripts import run_voice_reply_prompt_v3 as style_v3
from scripts import run_voice_reply_prompt_v3b as style_v3b


def test_frozen_prompts_use_actual_mood_and_scene_assembly():
    cases = smoke.prepare_cases()
    assert [case["case_id"] for case in cases] == [f"V{i:02d}" for i in range(1, 9)]
    systems = {case["case_id"]: case["messages"][0]["content"] for case in cases}
    assert "可能表达的心情" in systems["V02"]
    assert "主动表达或纠正的当前心情：平静" in systems["V03"]
    assert "可能表达的心情" not in systems["V04"]
    assert "本轮仅提议操作 plant_tree，尚未执行" in systems["V06"]
    assert all(case["input_token_ceiling"] <= smoke.MAX_INPUT_BYTES for case in cases)
    assert sum(Decimal(case["reserved_cny"]) for case in cases) < smoke.BUDGET_CNY


def test_original_batch_refuses_changed_voice_prompt_without_calling_provider(tmp_path, monkeypatch):
    monkeypatch.setattr(smoke, "EVIDENCE", tmp_path)
    monkeypatch.setattr(smoke, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(smoke, "RESULT_PATH", tmp_path / "result.json")
    monkeypatch.setattr(smoke, "check_price_today", lambda: {"checked_at_utc": "offline-test"})
    monkeypatch.setenv("MODEL_BASE_URL", smoke.BASE_URL)
    monkeypatch.setenv("MODEL_API_KEY", "offline-fixture-not-a-secret")
    monkeypatch.setenv("CHAT_MODEL", smoke.MODEL)
    monkeypatch.delenv("MODEL_ENABLE_THINKING", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("VOICE_LIVE_REPLY_ENABLED", "true")
    monkeypatch.setattr(sys, "argv", ["run_voice_reply_smoke.py", "--run"])
    calls = []

    def failed_provider(_client, url, *args, **kwargs):
        calls.append(url)
        return httpx.Response(503, json={"error": {"code": "offline_fixture"}},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.Client, "post", failed_provider)
    get_settings.cache_clear()
    try:
        smoke.main()
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["outbound_calls"] == 0
        assert len(result["cases"]) == 1
        assert result["cases"][0]["status"] == "failed"
        assert result["cases"][0]["error_type"] == "RuntimeError"
        assert result["cases"][0]["reserved_cny"]
        assert calls == []
        with pytest.raises(SystemExit, match="Prior paid result exists"):
            smoke.main()
        assert calls == []
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize('runner,version,phrase', [
    (style_v2, 'v2', '像当面聊天一样自然'),
    (style_v3, 'v3', '简单、暖一点的口语'),
    (style_v3b, 'v3b', '简单、暖一点的口语'),
])
def test_style_batch_uses_frozen_prompt_and_stops_after_failed_provider(
        tmp_path, monkeypatch, runner, version, phrase):
    cases = runner.prepare_cases()
    assert len(cases) == 8
    assert all(phrase in c['messages'][0]['content'] for c in cases)
    assert all(phrase not in c['base_messages'][0]['content'] for c in cases)
    monkeypatch.setattr(runner, "EVIDENCE", tmp_path)
    monkeypatch.setattr(runner, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(runner, "RESULT_PATH", tmp_path / "result.json")
    monkeypatch.setattr(runner, "check_price_today", lambda: {"checked_at_utc": "offline-test"})
    monkeypatch.setenv("MODEL_BASE_URL", runner.BASE_URL)
    monkeypatch.setenv("MODEL_API_KEY", "offline-fixture-not-a-secret")
    monkeypatch.setenv("CHAT_MODEL", runner.MODEL)
    monkeypatch.delenv("MODEL_ENABLE_THINKING", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("VOICE_LIVE_REPLY_ENABLED", "true")
    monkeypatch.setattr(sys, "argv", [f"run_voice_reply_prompt_{version}.py", "--run"])
    calls = []

    def failed_provider(_client, url, *args, **kwargs):
        calls.append(url)
        return httpx.Response(503, json={"error": {"code": "offline_fixture"}},
                              request=httpx.Request("POST", url))

    monkeypatch.setattr(httpx.Client, "post", failed_provider)
    get_settings.cache_clear()
    try:
        runner.main()
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["outbound_calls"] == 1
        assert len(result["cases"]) == 1
        assert result["cases"][0]["status"] == "failed"
        assert result["cases"][0]["reserved_cny"]
        if version == 'v3b':
            assert result["cases"][0]["cause_type"] == "HTTPStatusError"
        assert calls == [runner.BASE_URL + "/chat/completions"]
        with pytest.raises(SystemExit, match=f"Prior {version} result exists"):
            runner.main()
        assert len(calls) == 1
    finally:
        get_settings.cache_clear()


def test_style_v3b_retains_safe_timeout_class_without_retry(tmp_path, monkeypatch):
    monkeypatch.setattr(style_v3b, "MANIFEST_PATH", tmp_path / "manifest.json")
    monkeypatch.setattr(style_v3b, "RESULT_PATH", tmp_path / "result.json")
    monkeypatch.setattr(style_v3b, "check_price_today", lambda: {"checked_at_utc": "offline-test"})
    monkeypatch.setenv("MODEL_BASE_URL", style_v3b.BASE_URL)
    monkeypatch.setenv("MODEL_API_KEY", "offline-fixture-not-a-secret")
    monkeypatch.setenv("CHAT_MODEL", style_v3b.MODEL)
    monkeypatch.delenv("MODEL_ENABLE_THINKING", raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("VOICE_LIVE_REPLY_ENABLED", "true")
    monkeypatch.setattr(sys, "argv", ["run_voice_reply_prompt_v3b.py", "--run"])
    calls = []

    def timed_out(_client, url, *args, **kwargs):
        calls.append(url)
        raise httpx.ReadTimeout("private-provider-info")

    monkeypatch.setattr(httpx.Client, "post", timed_out)
    get_settings.cache_clear()
    try:
        style_v3b.main()
        result = json.loads((tmp_path / "result.json").read_text())
        assert result["outbound_calls"] == 1
        assert result["cases"][0]["status"] == "failed"
        assert result["cases"][0]["error_type"] == "ModelError"
        assert result["cases"][0]["cause_type"] == "ReadTimeout"
        assert "private-provider-info" not in (tmp_path / "result.json").read_text()
        assert calls == [style_v3b.BASE_URL + "/chat/completions"]
    finally:
        get_settings.cache_clear()
