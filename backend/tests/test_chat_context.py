"""聊天上下文拼接测试（人设 + 记忆注入 + 历史截断）。"""
from __future__ import annotations

from app.models.models import Character, Memory, Message
from app.services.chat import HISTORY_LIMIT, build_messages


def _character() -> Character:
    return Character(name="杯子小伴", persona="一个来自杯子的安静伙伴")


def _history(n: int) -> list[Message]:
    return [
        Message(role="user" if i % 2 == 0 else "assistant", content=f"消息{i}")
        for i in range(n)
    ]


def test_system_contains_name_and_persona():
    messages = build_messages(_character(), [], [], "你好")
    system = messages[0]
    assert system["role"] == "system"
    assert "杯子小伴" in system["content"]
    assert "一个来自杯子的安静伙伴" in system["content"]


def test_memories_are_injected_into_system():
    memories = [Memory(content="我喜欢下雨天"), Memory(content="我养了一只猫")]
    messages = build_messages(_character(), memories, [], "你好")
    system = messages[0]["content"]
    assert "我喜欢下雨天" in system
    assert "我养了一只猫" in system


def test_user_message_is_last():
    messages = build_messages(_character(), [], _history(3), "今天天气不错")
    assert messages[-1] == {"role": "user", "content": "今天天气不错"}


def test_history_truncated_to_limit():
    history = _history(HISTORY_LIMIT + 5)
    messages = build_messages(_character(), [], history, "你好")
    # system + HISTORY_LIMIT 条历史 + 1 条用户消息
    assert len(messages) == 1 + HISTORY_LIMIT + 1
    # 最早的历史被截断，最近的在里面
    assert messages[1]["content"] == f"消息5"
    assert messages[-2]["content"] == f"消息{HISTORY_LIMIT + 4}"


def test_no_memory_no_extra_lines():
    messages = build_messages(_character(), [], [], "你好")
    assert len(messages) == 2  # system + user
