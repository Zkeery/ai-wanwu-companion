"""Isolated H1 runtime. Only the model is simulated; tools and state are real."""
from __future__ import annotations

import json
import sqlite3
import sys
import time
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Protocol

PROJECT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PROJECT / "backend"))
# Pure business rules only. Never import app.main, settings or the production DB.
from app.services.scene import ACTIONS, apply_action, default_elements, feedback_for

MAX_MODEL_CALLS = 3
MAX_TOOL_CALLS = 3
MAX_RUN_SECONDS = 5
COMPANION = {"name": "果果", "persona": "一颗爱看星星的青苹果，温柔、好奇，喜欢慢慢布置花园。",
             "memories": ["花园里的每个新变化，都先问问你的意见。"]}


class DemoError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


class Model(Protocol):
    def respond(self, messages: list[dict]) -> dict: ...


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class MockCompanionModel:
    """Explicitly scripted adapter, not an LLM or evidence of NLU quality."""
    TERMS = {
        "place_bench": ("坐", "椅", "休息的地方"),
        "light_campfire": ("暖", "营火", "篝火"),
        "release_fireflies": ("萤火虫", "发光", "小星星"),
        "plant_tree": ("树",), "plant_flower": ("花丛", "种花", "颜色", "小花"),
        "grow_mushroom": ("蘑菇",), "add_pond": ("水池", "池塘"),
        "light_rain": ("下雨", "小雨", "雨声"), "quiet": ("安静", "静音", "太吵"),
    }

    def respond(self, messages):
        if messages[-1].get("role") == "execution":
            result = messages[-1]["content"]
            return {"text": result["message"] + " 我们就在这里待一小会儿吧。"}
        text = next(m["content"] for m in messages if m["role"] == "user")
        results = {m["name"]: m["content"] for m in messages if m["role"] == "tool"}
        if not results:
            return {"tool_calls": [
                {"id": "context", "name": "get_companion_context", "arguments": {}},
                {"id": "garden", "name": "get_garden_state", "arguments": {}},
            ]}
        if any(word in text for word in ("不要", "不想", "别放", "别种", "不用", "别改")):
            return {"text": "好，花园先保持原样。你想聊聊天，我也在。"}
        actions = [a for a, words in self.TERMS.items() if any(w in text for w in words)]
        if len(actions) > 1:
            return {"text": "我们一次做一件小事吧。你想先布置哪一样？可以选下方的一句话试试。"}
        if not actions:
            return {"text": "我在这里陪你。这个离线 demo 先演示几种花园愿望；试试“这里缺一个能坐的地方”，或点下面的推荐表达。真实自由对话还没有接入。"}
        action = actions[0]
        scene = results["get_garden_state"]["elements"]
        if apply_action(scene, action) == scene:
            return {"text": f"我看过花园了，“{ACTIONS[action]['label']}”已经布置好或达到上限，这次不用重复添加。我们试试别的小变化？"}
        return {"tool_calls": [{"id": "proposal", "name": "propose_garden_action",
                                "arguments": {"action": action, "reason": "为你的花园添一个小小的变化。"}}]}


class Runtime:
    def __init__(self, db_path: Path, model: Model | None = None):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.model = model if model is not None else MockCompanionModel()
        with self.connection() as c:
            c.executescript("""
                CREATE TABLE IF NOT EXISTS demo_sessions (
                    id TEXT PRIMARY KEY, elements TEXT NOT NULL, undo TEXT, version INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS agent_runs (
                    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES demo_sessions(id),
                    request_key TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL,
                    UNIQUE(session_id, request_key));
                CREATE TABLE IF NOT EXISTS agent_steps (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES agent_runs(id),
                    kind TEXT NOT NULL, title TEXT NOT NULL, created REAL NOT NULL);
            """)

    @contextmanager
    def connection(self):
        c = sqlite3.connect(self.db_path, timeout=5, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        c.execute("PRAGMA busy_timeout=5000")
        try:
            yield c
        finally:
            c.close()

    @contextmanager
    def transaction(self):
        with self.connection() as c:
            c.execute("BEGIN IMMEDIATE")
            try:
                yield c
                c.execute("COMMIT")
            except BaseException:
                c.execute("ROLLBACK")
                raise

    def ensure_session(self, sid):
        with self.transaction() as c:
            c.execute("INSERT OR IGNORE INTO demo_sessions(id,elements) VALUES (?,?)", (sid, dump(default_elements())))

    def _save(self, c, run):
        c.execute("UPDATE agent_runs SET payload=? WHERE id=?", (dump(run), run["id"]))

    def _event(self, c, run, kind, title):
        c.execute("INSERT INTO agent_steps(run_id,kind,title,created) VALUES (?,?,?,?)", (run["id"], kind, title, time.time()))

    def _run(self, c, sid, rid):
        row = c.execute("SELECT payload FROM agent_runs WHERE id=? AND session_id=?", (rid, sid)).fetchone()
        if row is None:
            raise DemoError("not_found", "找不到这次操作，请刷新后再试。", 404)
        return json.loads(row["payload"])

    def recover(self):
        with self.transaction() as c:
            for row in c.execute("SELECT payload FROM agent_runs").fetchall():
                run = json.loads(row["payload"])
                if run["status"] in ("running", "finishing"):
                    if run.get("execution"):
                        run.update(status="completed", response=run["execution"]["message"])
                    else:
                        run.update(status="failed", response="上次的流程被中断了，花园没有被自动修改。你可以重新说一次愿望。", error="interrupted")
                    self._event(c, run, "recovery", "服务恢复：核对已保存结果，没有重复执行")
                    self._save(c, run)

    def state(self, sid):
        with self.connection() as c:
            row = c.execute("SELECT * FROM demo_sessions WHERE id=?", (sid,)).fetchone()
            if row is None:
                raise DemoError("session_missing", "请刷新页面。", 404)
            runs = []
            for item in reversed(c.execute("SELECT payload FROM agent_runs WHERE session_id=? ORDER BY created DESC LIMIT 12", (sid,)).fetchall()):
                run = json.loads(item["payload"])
                visible = {k: run.get(k) for k in ("id", "user_text", "status", "response", "action", "proposal_id", "model_calls", "tool_calls", "error")}
                visible["action_label"] = ACTIONS.get(run.get("action"), {}).get("label")
                visible["steps"] = [dict(s) for s in c.execute("SELECT kind,title FROM agent_steps WHERE run_id=? ORDER BY id", (run["id"],))]
                runs.append(visible)
            return {"mode": "offline-simulation", "companion": COMPANION, "elements": json.loads(row["elements"]),
                    "version": row["version"], "can_undo": row["undo"] is not None, "runs": runs,
                    "limits": {"model_calls": MAX_MODEL_CALLS, "tool_calls": MAX_TOOL_CALLS}}

    def start(self, sid, text, request_key):
        if not isinstance(text, str) or not 1 <= len(text.strip()) <= 4000:
            raise DemoError("invalid_input", "请输入 1–4000 字的愿望。")
        if not isinstance(request_key, str) or not 1 <= len(request_key) <= 80:
            raise DemoError("invalid_request", "请求标识不正确，请刷新后重试。")
        with self.transaction() as c:
            existing = c.execute("SELECT id FROM agent_runs WHERE session_id=? AND request_key=?", (sid, request_key)).fetchone()
            if existing:
                return existing["id"]
            for row in c.execute("SELECT payload FROM agent_runs WHERE session_id=?", (sid,)):
                if json.loads(row["payload"])["status"] in ("running", "awaiting_confirmation", "finishing"):
                    raise DemoError("pending_action", "先确认或拒绝上一条提议，再告诉我新的愿望。", 409)
            run = {"id": str(uuid.uuid4()), "session_id": sid, "user_text": text.strip(), "status": "running",
                   "response": "", "model_calls": 0, "tool_calls": 0, "messages": [{"role": "user", "content": text.strip()}]}
            c.execute("INSERT INTO agent_runs VALUES (?,?,?,?,?)", (run["id"], sid, request_key, dump(run), time.time()))
            self._event(c, run, "start", "收到你的愿望")
        self._drive(sid, run["id"])
        return run["id"]

    def _decision(self, run):
        if run["model_calls"] >= MAX_MODEL_CALLS:
            raise DemoError("model_budget", "这一轮已经达到调用上限，先停在这里。")
        run["model_calls"] += 1
        output = self.model.respond(run["messages"])
        if not isinstance(output, dict) or set(output) not in ({"text"}, {"tool_calls"}):
            raise DemoError("invalid_model_output", "模拟模型返回格式不正确，流程已停止。")
        if "text" in output:
            if not isinstance(output["text"], str) or not 1 <= len(output["text"]) <= 4000:
                raise DemoError("invalid_model_output", "回复格式不正确。")
        else:
            calls = output["tool_calls"]
            if not isinstance(calls, list) or not calls or run["tool_calls"] + len(calls) > MAX_TOOL_CALLS:
                raise DemoError("tool_budget", "这一轮已达到工具调用上限，花园没有被自动修改。")
            ids = set()
            previous_ids = {call["id"] for message in run["messages"] if message.get("role") == "assistant"
                            for call in message.get("tool_calls", [])}
            for call in calls:
                if not isinstance(call, dict) or set(call) != {"id", "name", "arguments"}:
                    raise DemoError("invalid_tool", "工具调用格式不正确。")
                if not isinstance(call["id"], str) or not 1 <= len(call["id"]) <= 80 or call["id"] in ids or call["id"] in previous_ids:
                    raise DemoError("invalid_tool", "工具调用标识不正确。")
                ids.add(call["id"])
                self._validate_tool(call)
            proposals = [i for i, call in enumerate(calls) if call["name"] == "propose_garden_action"]
            if len(proposals) > 1 or (proposals and proposals[0] != len(calls) - 1):
                raise DemoError("invalid_tool_batch", "操作提议必须是这一轮唯一且最后一个提议。")
        return output

    def _validate_tool(self, call):
        name, args = call["name"], call["arguments"]
        if name not in ("get_companion_context", "get_garden_state", "propose_garden_action"):
            raise DemoError("unknown_tool", "这个工具不在允许范围内，已停止。")
        if not isinstance(args, dict):
            raise DemoError("invalid_tool_args", "工具参数不正确。")
        if name != "propose_garden_action" and args:
            raise DemoError("invalid_tool_args", "查询只能使用当前伙伴，不接受额外参数。")
        if name == "propose_garden_action":
            if set(args) != {"action", "reason"} or not isinstance(args["action"], str) or args["action"] not in ACTIONS:
                raise DemoError("invalid_tool_args", "这项花园操作不在支持范围内。")
            if not isinstance(args["reason"], str) or not 1 <= len(args["reason"].strip()) <= 120:
                raise DemoError("invalid_tool_args", "操作说明不正确。")

    def _tool(self, c, run, call):
        self._validate_tool(call)
        run["tool_calls"] += 1
        name, args = call["name"], call["arguments"]
        row = c.execute("SELECT * FROM demo_sessions WHERE id=?", (run["session_id"],)).fetchone()
        scene = json.loads(row["elements"])
        if name == "get_companion_context":
            self._event(c, run, "read", "记起果果的性格与我们的小约定")
            return COMPANION
        if name == "get_garden_state":
            self._event(c, run, "read", "查看当前花园，核对已有布置")
            return {"elements": scene, "version": row["version"], "actions": list(ACTIONS)}
        if run.get("proposal_id"):
            raise DemoError("one_proposal", "每轮只能提出一个待确认动作。")
        if apply_action(scene, args["action"]) == scene:
            self._event(c, run, "limit", "已布置或达到上限，没有创建重复提议")
            return {"status": "unchanged", "message": "已经布置或达到上限。"}
        run.update(status="awaiting_confirmation", action=args["action"], base_version=row["version"],
                   proposal_id=str(uuid.uuid4()), response=f"我看过现在的花园了。建议的小变化是「{ACTIONS[args['action']]['label']}」。你点确认，我才会动手。")
        self._event(c, run, "proposal", "提出一个小变化，等待你确认")
        return {"status": "awaiting_confirmation", "proposal_id": run["proposal_id"]}

    def _drive(self, sid, rid):
        started = time.monotonic()
        with self.transaction() as c:
            run = self._run(c, sid, rid)
            if run["status"] not in ("running", "finishing"):
                return
            try:
                while run["status"] in ("running", "finishing"):
                    if time.monotonic() - started > MAX_RUN_SECONDS:
                        raise DemoError("timeout", "这一轮用时过长，已经停止。")
                    output = self._decision(run)
                    if time.monotonic() - started > MAX_RUN_SECONDS:
                        raise DemoError("timeout", "这一轮用时过长，已经停止。")
                    self._event(c, run, "model", f"模拟模型完成第 {run['model_calls']} 轮判断")
                    if "text" in output:
                        run.update(status="completed", response=output["text"])
                        break
                    if run.get("execution"):
                        raise DemoError("post_execution_tool", "动作已完成，停止追加工具调用。")
                    run["messages"].append({"role": "assistant", **output})
                    for call in output["tool_calls"]:
                        result = self._tool(c, run, call)
                        run["messages"].append({"role": "tool", "tool_call_id": call["id"], "name": call["name"], "content": result})
                        if run["status"] == "awaiting_confirmation":
                            break
                if run["status"] == "completed":
                    self._event(c, run, "done", "根据已知结果回复，这一轮结束")
            except Exception as exc:
                code = exc.code if isinstance(exc, DemoError) else "model_failure"
                message = exc.message if isinstance(exc, DemoError) else "模拟模型暂时无法回应，这一轮已经停止。"
                if run.get("execution"):
                    run.update(status="completed", response=run["execution"]["message"] + "（回复未完成，以上为实际执行结果。）", error=code)
                else:
                    run.update(status="failed", response=message, error=code)
                self._event(c, run, "error", "已停止追加调用；保留当前真实状态")
            self._save(c, run)

    def decide(self, sid, rid, proposal_id, decision):
        if decision not in ("confirm", "reject"):
            raise DemoError("invalid_decision", "请选择确认或拒绝。")
        resume = False
        with self.transaction() as c:
            run = self._run(c, sid, rid)
            if not run.get("proposal_id") or proposal_id != run["proposal_id"]:
                raise DemoError("invalid_proposal", "这条提议已失效。", 409)
            if run["status"] != "awaiting_confirmation":
                return  # Already decided: replay never applies the action again.
            row = c.execute("SELECT * FROM demo_sessions WHERE id=?", (sid,)).fetchone()
            if row["version"] != run["base_version"]:
                run.update(status="cancelled", response="花园已经发生变化，旧提议已取消。请重新告诉我你的愿望。")
                self._event(c, run, "cancel", "花园状态变化，旧提议失效")
            elif decision == "reject":
                run.update(status="cancelled", response="好，那就先不改。你的花园还是原来的样子。")
                self._event(c, run, "cancel", "你选择暂时不改，花园保持原样")
            else:
                scene = json.loads(row["elements"])
                result = apply_action(scene, run["action"])
                if result != scene:
                    c.execute("UPDATE demo_sessions SET elements=?,undo=?,version=version+1 WHERE id=?", (dump(result), dump(scene), sid))
                receipt = {"message": feedback_for(run["action"]) if result != scene else "花园已经是这个状态，没有重复修改。", "elements": result}
                run.update(status="finishing", execution=receipt)
                run["messages"].append({"role": "execution", "content": receipt})
                self._event(c, run, "execute", "你已确认：变化已保存到花园")
                resume = True
            self._save(c, run)
        if resume:
            self._drive(sid, rid)

    def change(self, sid, action):
        if action not in ("undo", "reset"):
            raise DemoError("invalid_action", "操作不受支持。")
        with self.transaction() as c:
            row = c.execute("SELECT * FROM demo_sessions WHERE id=?", (sid,)).fetchone()
            if action == "undo" and row["undo"] is None:
                raise DemoError("nothing_to_undo", "还没有可以撤销的变化。", 409)
            value = row["undo"] if action == "undo" else dump(default_elements())
            c.execute("UPDATE demo_sessions SET elements=?,undo=NULL,version=version+1 WHERE id=?", (value, sid))
            for item in c.execute("SELECT payload FROM agent_runs WHERE session_id=?", (sid,)).fetchall():
                run = json.loads(item["payload"])
                if run["status"] in ("running", "finishing", "awaiting_confirmation"):
                    run.update(status="cancelled", response="花园已撤销或重新开始，这条旧提议已取消。")
                    self._event(c, run, "cancel", "状态改变，旧提议不会再执行")
                    self._save(c, run)
