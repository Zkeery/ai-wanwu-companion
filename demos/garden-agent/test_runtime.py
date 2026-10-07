from __future__ import annotations

import json
import tempfile
import unittest
import uuid
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from runtime import DemoError, MockCompanionModel, Runtime
from server import create_app


class FixedModel:
    def __init__(self, response):
        self.response = response

    def respond(self, messages):
        return self.response


class FailureAfterExecution(MockCompanionModel):
    def respond(self, messages):
        if messages[-1].get("role") == "execution":
            raise RuntimeError("fixture failure")
        return super().respond(messages)


def call(name, args=None, cid="t1"):
    return {"id": cid, "name": name, "arguments": args if args is not None else {}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "state.sqlite3"
        self.runtime = Runtime(self.path)
        self.sid = str(uuid.uuid4())
        self.runtime.ensure_session(self.sid)

    def start(self, text="这里缺一个能坐下来的地方", key=None):
        return self.runtime.start(self.sid, text, key or str(uuid.uuid4()))

    def latest(self):
        return self.runtime.state(self.sid)["runs"][-1]

    def confirm(self):
        run = self.latest()
        self.runtime.decide(self.sid, run["id"], run["proposal_id"], "confirm")
        return run

    def test_tool_loop_uses_real_state_and_pauses_before_write(self):
        self.start()
        run = self.latest()
        self.assertEqual(run["status"], "awaiting_confirmation")
        self.assertEqual((run["model_calls"], run["tool_calls"]), (2, 3))
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 0)
        self.assertEqual(len([s for s in run["steps"] if s["kind"] == "read"]), 2)

    def test_confirmation_executes_then_model_observes_result(self):
        self.start()
        self.confirm()
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 1)
        self.assertEqual(self.latest()["model_calls"], 3)
        self.assertEqual(self.latest()["status"], "completed")
        self.assertIn("长椅放好了", self.latest()["response"])

    def test_duplicate_confirm_is_idempotent(self):
        self.start("种一棵树")
        run = self.confirm()
        self.runtime.decide(self.sid, run["id"], run["proposal_id"], "confirm")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["tree"], 1)
        self.assertEqual(self.latest()["model_calls"], 3)

    def test_concurrent_confirm_applies_once(self):
        self.start("种一棵树")
        run = self.latest()
        def decide(_):
            self.runtime.decide(self.sid, run["id"], run["proposal_id"], "confirm")
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(decide, range(2)))
        self.assertEqual(self.runtime.state(self.sid)["elements"]["tree"], 1)

    def test_reject_then_confirm_never_executes(self):
        self.start()
        run = self.latest()
        self.runtime.decide(self.sid, run["id"], run["proposal_id"], "reject")
        self.runtime.decide(self.sid, run["id"], run["proposal_id"], "confirm")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 0)
        self.assertEqual(self.latest()["status"], "cancelled")

    def test_same_request_does_not_create_second_run(self):
        rid = self.start(key="same-key")
        self.assertEqual(self.start(key="same-key"), rid)
        self.assertEqual(len(self.runtime.state(self.sid)["runs"]), 1)

    def test_new_request_blocked_while_pending(self):
        self.start()
        with self.assertRaises(DemoError) as err:
            self.start("种树")
        self.assertEqual(err.exception.code, "pending_action")

    def test_pending_survives_new_runtime_and_recovery(self):
        self.start()
        self.runtime = Runtime(self.path)
        self.runtime.recover()
        self.assertEqual(self.latest()["status"], "awaiting_confirmation")
        self.confirm()
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 1)

    def test_reset_invalidates_old_confirmation(self):
        self.start()
        run = self.latest()
        self.runtime.change(self.sid, "reset")
        self.runtime.decide(self.sid, run["id"], run["proposal_id"], "confirm")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 0)

    def test_version_mismatch_does_not_execute(self):
        self.start()
        with self.runtime.transaction() as c:
            c.execute("UPDATE demo_sessions SET version=version+1 WHERE id=?", (self.sid,))
        self.confirm()
        self.assertEqual(self.latest()["status"], "cancelled")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 0)

    def test_other_session_cannot_confirm(self):
        self.start()
        run = self.latest()
        other = str(uuid.uuid4())
        self.runtime.ensure_session(other)
        with self.assertRaises(DemoError) as err:
            self.runtime.decide(other, run["id"], run["proposal_id"], "confirm")
        self.assertEqual(err.exception.status, 404)

    def test_unknown_tool_is_rejected(self):
        self.runtime.model = FixedModel({"tool_calls": [call("run_shell", {"cmd": "anything"})]})
        self.start()
        self.assertEqual(self.latest()["error"], "unknown_tool")
        self.assertEqual(self.runtime.state(self.sid)["version"], 0)

    def test_extra_scope_argument_is_rejected(self):
        self.runtime.model = FixedModel({"tool_calls": [call("get_garden_state", {"session_id": "other"})]})
        self.start()
        self.assertEqual(self.latest()["error"], "invalid_tool_args")

    def test_unsupported_action_is_rejected(self):
        self.runtime.model = FixedModel({"tool_calls": [call("propose_garden_action", {"action": "delete_all", "reason": "test"})]})
        self.start()
        self.assertEqual(self.latest()["error"], "invalid_tool_args")

    def test_tool_budget_stops_before_execution(self):
        self.runtime.model = FixedModel({"tool_calls": [call("get_garden_state", cid=f"q{i}") for i in range(4)]})
        self.start()
        self.assertEqual(self.latest()["error"], "tool_budget")
        self.assertEqual(self.latest()["tool_calls"], 0)

    def test_repeated_loop_has_model_call_limit(self):
        class LoopModel:
            def respond(self, messages):
                return {"tool_calls": [call("get_garden_state", cid=str(len(messages)))]}
        self.runtime.model = LoopModel()
        self.start()
        self.assertEqual(self.latest()["error"], "model_budget")
        self.assertEqual((self.latest()["model_calls"], self.latest()["tool_calls"]), (3, 3))

    def test_invalid_model_payload_is_contained(self):
        self.runtime.model = FixedModel({"text": "ok", "tool_calls": []})
        self.start()
        self.assertEqual(self.latest()["error"], "invalid_model_output")

    def test_denial_does_not_propose(self):
        self.start("不要放长椅")
        self.assertEqual(self.latest()["status"], "completed")
        self.assertIsNone(self.latest()["proposal_id"])

    def test_multiple_actions_ask_for_one(self):
        self.start("先种树再放长椅")
        self.assertIn("一次做一件", self.latest()["response"])
        self.assertIsNone(self.latest()["proposal_id"])

    def test_existing_object_does_not_repropose(self):
        self.start()
        self.confirm()
        self.start()
        self.assertEqual(self.latest()["status"], "completed")
        self.assertIsNone(self.latest()["proposal_id"])

    def test_tree_limit_is_preserved(self):
        for _ in range(7):
            self.start("种树")
            self.confirm()
        self.start("种树")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["tree"], 7)
        self.assertIsNone(self.latest()["proposal_id"])

    def test_undo_restores_once(self):
        self.start("种树")
        self.confirm()
        self.runtime.change(self.sid, "undo")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["tree"], 0)
        with self.assertRaises(DemoError):
            self.runtime.change(self.sid, "undo")

    def test_reply_failure_keeps_committed_action(self):
        self.runtime.model = FailureAfterExecution()
        self.start()
        run = self.confirm()
        self.assertEqual(self.latest()["status"], "completed")
        self.assertIn("实际执行结果", self.latest()["response"])
        self.runtime.decide(self.sid, run["id"], run["proposal_id"], "confirm")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["bench"], 1)

    def test_startup_recovers_committed_execution_without_replay(self):
        self.start("种树")
        self.confirm()
        with self.runtime.transaction() as c:
            row = c.execute("SELECT payload FROM agent_runs").fetchone()
            run = json.loads(row["payload"])
            run["status"] = "finishing"
            self.runtime._save(c, run)
        self.runtime = Runtime(self.path)
        self.runtime.recover()
        self.assertEqual(self.latest()["status"], "completed")
        self.assertEqual(self.runtime.state(self.sid)["elements"]["tree"], 1)

    def test_empty_input_is_rejected(self):
        with self.assertRaises(DemoError):
            self.start("   ")

    def test_api_contract_and_cookie_isolation(self):
        app = create_app(Path(self.temp.name) / "api")
        with TestClient(app) as a, TestClient(app) as b:
            self.assertEqual(a.get("/api/state").status_code, 200)
            data = a.post("/api/chat", json={"text": "种树", "request_key": "one"}).json()
            run = data["runs"][-1]
            response = b.post("/api/decide", json={"run_id": run["id"], "proposal_id": run["proposal_id"], "decision": "confirm"})
            self.assertEqual(response.status_code, 404)
            self.assertEqual(set(response.json()["error"]), {"code", "message"})
            self.assertEqual(a.post("/api/chat", json={"text": "", "request_key": "two"}).status_code, 422)
            self.assertEqual(a.post("/api/garden", json={"action": "reset"}, headers={"Origin": "https://elsewhere.test"}).status_code, 403)
            self.assertEqual(a.get("/api/state").json()["elements"]["tree"], 0)


if __name__ == "__main__":
    unittest.main()
