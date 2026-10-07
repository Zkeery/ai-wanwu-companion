"""R4.1 offline boundary tests; scripted decisions are not model validation."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import create_engine, select, text, update

from app.scene_agent.runtime import AgentError, Limits, Runtime, available_actions, runs


def tool(name, **arguments):
    return {"type": "tool", "name": name, "arguments": arguments}


class Scripted:
    def __init__(self, *steps):
        self.steps, self.calls = list(steps), []

    def decide(self, history, *, timeout_seconds):
        self.calls.append((deepcopy(history), timeout_seconds))
        step = self.steps.pop(0)
        return step(history) if callable(step) else step


@pytest.fixture
def case(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'agent.db'}")
    runtime = Runtime(engine)
    runtime.initialize()
    args = {"owner_id": "owner-a", "request_id": str(uuid4()), "message": "想种一棵树",
            "context": {"companion_id": 7, "source_message_id": 11, "name": "小杯",
                        "persona": "温柔", "space_id": str(uuid4()), "scene_type": "home",
                        "revision": 5, "location_epoch": 2, "elements": {"tree": 1}}}
    yield runtime, args
    engine.dispose()


def test_proposal_queries_bound_context_and_never_writes_scene(case):
    runtime, args = case
    original = deepcopy(args)
    with runtime.engine.begin() as conn:
        conn.execute(text("CREATE TABLE living_spaces (id TEXT PRIMARY KEY, state_json TEXT)"))
        conn.execute(text("INSERT INTO living_spaces VALUES ('retained', 'unchanged')"))
    adapter = Scripted(tool("read_companion"), tool("read_scene"),
                       tool("propose_scene_action", action="plant_tree"))
    run = runtime.start(**args, adapter=adapter)
    assert (run.status, run.action, run.model_calls, run.tool_calls) == ("waiting_confirmation", "plant_tree", 3, 3)
    assert run.context.source_message_id == 11 and run.context.location_epoch == 2
    assert "确认后" in run.reply
    assert adapter.calls[1][0][-1]["content"] == {"name": "小杯", "persona": "温柔"}
    scene = adapter.calls[2][0][-1]["content"]
    assert scene["elements"] == {"tree": 1} and scene["revision"] == 5
    assert "owner_id" not in json.dumps(scene)
    assert runtime.read(args["owner_id"], run.id) == run and args == original
    with runtime.engine.connect() as conn:
        assert conn.execute(text("SELECT state_json FROM living_spaces")).scalar_one() == "unchanged"


def test_chat_finish_and_identical_request_are_not_rerun(case):
    runtime, args = case
    adapter = Scripted({"type": "finish", "reply": " 我在这里。 "})
    run = runtime.start(**args, adapter=adapter)
    duplicate = runtime.start(**args, adapter=adapter)
    assert run == duplicate and len(adapter.calls) == 1
    assert (run.status, run.reply, run.tool_calls) == ("completed", "我在这里。", 0)


def test_reused_key_with_changed_input_is_conflict(case):
    runtime, args = case
    adapter = Scripted({"type": "finish", "reply": "你好"})
    runtime.start(**args, adapter=adapter)
    args["context"]["location_epoch"] += 1
    with pytest.raises(AgentError, match="相同请求标识") as error:
        runtime.start(**args, adapter=adapter)
    assert error.value.code == "conflict" and len(adapter.calls) == 1


def test_account_isolation_and_scoped_request_ids(case):
    runtime, args = case
    adapter = Scripted({"type": "finish", "reply": "你好"}, {"type": "finish", "reply": "你好"})
    first = runtime.start(**args, adapter=adapter)
    with pytest.raises(AgentError) as error:
        runtime.read("owner-b", first.id)
    assert error.value.code == "not_found"
    second = runtime.start(**{**args, "owner_id": "owner-b"}, adapter=adapter)
    assert first.id != second.id and len(adapter.calls) == 2


@pytest.mark.parametrize("decision", [
    None, "not-json", {"type": "finish", "reply": " "},
    {"type": "finish", "reply": "x" * 1001}, {"type": "finish", "reply": "hi", "action": "plant_tree"},
    tool("execute_scene_action", action="plant_tree"), tool("read_scene", owner_id="other"),
    tool("read_companion", companion_id=9), tool("propose_scene_action", action=1),
    tool("propose_scene_action", action="plant_tree", space_id=str(uuid4())),
    tool("propose_scene_action", action="plant_tree"),
])
def test_invalid_decisions_fail_without_retry(case, decision):
    runtime, args = case
    adapter = Scripted(decision)
    run = runtime.start(**args, adapter=adapter)
    assert (run.status, run.error_code, run.action) == ("failed", "invalid_decision", None)
    assert len(adapter.calls) == 1
    assert runtime.start(**args, adapter=adapter) == run


@pytest.mark.parametrize("scene,action,accepted", [
    ("home", "plant_flower", True), ("home", "light_rain", True),
    ("desert", "plant_tree", True), ("forest", "plant_tree", True),
    ("desert", "light_rain", False), ("forest", "place_bench", False), ("home", "delete", False),
])
def test_scene_specific_allowlist(case, scene, action, accepted):
    runtime, args = case
    args["context"]["scene_type"] = scene
    run = runtime.start(**args, adapter=Scripted(tool("read_scene"), tool("propose_scene_action", action=action)))
    assert run.status == ("waiting_confirmation" if accepted else "failed")
    assert run.action == (action if accepted else None)


def test_allowlist_matches_existing_chat_bridge():
    from app.services.scene_bridge import allowed_actions
    for scene in ("home", "desert", "forest"):
        assert available_actions(scene) == allowed_actions(scene)


def test_model_reservation_is_saved_before_adapter_and_init_error_is_redacted(case):
    runtime, args = case
    def initialize_sdk(_history):
        with runtime.engine.connect() as conn:
            saved = json.loads(conn.execute(select(runs.c.state_json)).scalar_one())
        assert saved["model_calls"] == 1 and saved["status"] == "running"
        raise RuntimeError("private-sdk-value-must-not-escape")
    run = runtime.start(**args, adapter=Scripted(initialize_sdk))
    assert run.error_code == "adapter_failed" and run.model_calls == 1
    assert "private-sdk-value" not in run.model_dump_json()


def test_call_budget_is_bounded(case):
    runtime, args = case
    adapter = Scripted(*[tool("read_scene")] * 3)
    run = runtime.start(**args, adapter=adapter)
    assert (run.model_calls, run.tool_calls, run.error_code) == (3, 3, "limit_exceeded")
    assert len(adapter.calls) == 3


def test_tool_budget_blocks_second_tool(case):
    runtime, args = case
    adapter = Scripted(tool("read_scene"), tool("propose_scene_action", action="plant_tree"))
    run = runtime.start(**args, adapter=adapter, limits=Limits(tools=1))
    assert (run.model_calls, run.tool_calls, run.error_code, run.action) == (2, 1, "limit_exceeded", None)


def test_late_adapter_result_is_discarded(case):
    runtime, args = case
    now = [0.0]
    runtime.clock = lambda: now[0]
    def late(_history):
        now[0] = 6.0
        return {"type": "finish", "reply": "too late"}
    adapter = Scripted(late)
    run = runtime.start(**args, adapter=adapter, limits=Limits(seconds=5.0))
    assert run.error_code == "timed_out" and run.reply is None
    assert adapter.calls[0][1] == 5.0


def test_expired_budget_does_not_call_adapter(case):
    runtime, args = case
    ticks = iter([0.0, 61.0])
    runtime.clock = lambda: next(ticks)
    adapter = Scripted()
    run = runtime.start(**args, adapter=adapter)
    assert run.error_code == "timed_out" and run.model_calls == 0 and not adapter.calls


def test_concurrent_duplicate_reads_running_without_second_call(case):
    runtime, args = case
    entered, release = Event(), Event()
    def pause(_history):
        entered.set()
        assert release.wait(5)
        return {"type": "finish", "reply": "done"}
    adapter = Scripted(pause)
    with ThreadPoolExecutor(max_workers=2) as pool:
        future = pool.submit(runtime.start, **args, adapter=adapter)
        try:
            assert entered.wait(5)
            duplicate = runtime.start(**args, adapter=Scripted())
            assert duplicate.status == "running" and duplicate.model_calls == 1
        finally:
            release.set()
        completed = future.result(timeout=5)
    assert completed.id == duplicate.id and completed.status == "completed" and len(adapter.calls) == 1


def test_recovery_wins_over_late_worker(case):
    runtime, args = case
    def recovered(_history):
        # Simulates an old worker result arriving after an explicit recovery.
        assert Runtime(runtime.engine).recover_interrupted() == 1
        return {"type": "finish", "reply": "obsolete"}
    run = runtime.start(**args, adapter=Scripted(recovered))
    assert run.status == "failed" and run.error_code == "interrupted" and run.reply is None
    assert runtime.recover_interrupted() == 0


def test_new_process_reads_completed_and_recovers_crash_without_replay(case, tmp_path):
    runtime, args = case
    completed = runtime.start(**args, adapter=Scripted(tool("read_scene"), tool("propose_scene_action", action="plant_tree")))
    crash_args = {**args, "request_id": str(uuid4())}
    input_path = tmp_path / "request.json"
    input_path.write_text(json.dumps(crash_args), encoding="utf8")
    db_url = str(runtime.engine.url)
    env = {**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    crash = subprocess.run([sys.executable, "-c", '''
import json, os, sys
from sqlalchemy import create_engine
from app.scene_agent.runtime import Runtime
class Crash:
    def decide(self, history, *, timeout_seconds):
        os._exit(17)
r = Runtime(create_engine(sys.argv[1]))
r.start(**json.load(open(sys.argv[2])), adapter=Crash())
''', db_url, str(input_path)], env=env, capture_output=True, text=True, timeout=10)
    assert crash.returncode == 17
    restored = subprocess.run([sys.executable, "-c", '''
import json, sys
from sqlalchemy import create_engine, select
from app.scene_agent.runtime import Runtime, runs
r = Runtime(create_engine(sys.argv[1]))
n = r.recover_interrupted()
with r.engine.connect() as c:
    states = [json.loads(x) for x in c.execute(select(runs.c.state_json)).scalars()]
print(json.dumps({"recovered": n, "states": states}))
''', db_url], env=env, capture_output=True, text=True, timeout=10, check=True)
    result = json.loads(restored.stdout)
    assert result["recovered"] == 1
    by_id = {s["id"]: s for s in result["states"]}
    assert by_id[completed.id] == completed.model_dump()
    failed = next(s for s in result["states"] if s["id"] != completed.id)
    assert (failed["status"], failed["error_code"], failed["model_calls"]) == ("failed", "interrupted", 1)
    assert runtime.start(**crash_args, adapter=Scripted()).id == failed["id"]


@pytest.mark.parametrize("change", [
    lambda s: s.pop("model_calls"), lambda s: s.update(model_calls=4),
    lambda s: s.update(revision=-1), lambda s: s.update(action="plant_tree"),
    lambda s: s["context"].update(location_epoch=100), lambda s: s.update(reply=""),
    lambda s: s.update(tool_calls=True),
])
def test_corrupt_records_are_not_defaulted_or_replayed(case, change):
    runtime, args = case
    run = runtime.start(**args, adapter=Scripted({"type": "finish", "reply": "done"}))
    state = run.model_dump()
    change(state)
    with runtime.engine.begin() as conn:
        conn.execute(update(runs).where(runs.c.id == run.id).values(state_json=json.dumps(state)))
    with pytest.raises(AgentError) as error:
        runtime.read(args["owner_id"], run.id)
    assert error.value.code == "corrupt_state"
    with pytest.raises(AgentError):
        runtime.start(**args, adapter=Scripted())


@pytest.mark.parametrize("patch", [{"source_message_id": 0}, {"elements": {"tree": True}},
                                     {"elements": {"secret": 1}}, {"space_id": "bad"}])
def test_invalid_bound_context_fails_before_adapter(case, patch):
    runtime, args = case
    args["context"].update(patch)
    adapter = Scripted()
    with pytest.raises(AgentError) as error:
        runtime.start(**args, adapter=adapter)
    assert error.value.code == "invalid_request" and not adapter.calls
    with runtime.engine.connect() as conn:
        assert conn.execute(select(runs.c.id)).first() is None


def test_storage_failure_prevents_paid_decision(case, monkeypatch):
    from sqlalchemy.exc import OperationalError
    runtime, args = case
    actual_save = runtime._save
    def broken(run):
        with monkeypatch.context() as patch:
            def fail():
                raise OperationalError("secret-sql", {}, Exception("secret-detail"))
            patch.setattr(runtime.engine, "begin", fail)
            actual_save(run)
    monkeypatch.setattr(runtime, "_save", broken)
    adapter = Scripted()
    with pytest.raises(AgentError) as error:
        runtime.start(**args, adapter=adapter)
    assert error.value.as_dict() == {"error": {"code": "storage_unavailable", "message": "建议暂时无法保存，未执行场景操作"}}
    assert not adapter.calls


def test_adapter_cannot_mutate_bound_history(case):
    runtime, args = case
    def mutate(history):
        history[0]["content"] = "replace-system"
        return {"type": "finish", "reply": "done"}
    run = runtime.start(**args, adapter=Scripted(mutate))
    assert run.history[0]["content"] != "replace-system"


@pytest.mark.parametrize('patch', [
    {'space_id': None}, {'scene_type': None}, {'revision': None},
    {'space_id': None, 'scene_type': None, 'revision': None, 'elements': {'tree': 1}},
])
def test_location_context_rejects_partial_or_fictional_scene(case, patch):
    runtime, args = case
    args['context'].update(patch)
    adapter = Scripted({'type': 'finish', 'reply': '你好'})
    with pytest.raises(AgentError, match='参数不正确'):
        runtime.start(**args, adapter=adapter)
    assert not adapter.calls


def test_unselected_scene_survives_reload_and_has_no_available_actions(case):
    runtime, args = case
    args['context'].update(space_id=None, scene_type=None, revision=None, elements={})
    adapter = Scripted(tool('read_scene'), {'type': 'finish', 'reply': '我们先聊聊吧'})
    run = runtime.start(**args, adapter=adapter)
    assert run.status == 'completed' and run.action is None
    assert adapter.calls[1][0][-1]['content'] == {'scene_name': None, 'revision': None, 'elements': {}, 'allowed_actions': {}}
    assert runtime.read(args['owner_id'], run.id) == run
