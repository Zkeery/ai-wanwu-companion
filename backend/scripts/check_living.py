"""Free R1 evidence: two independent processes, temporary DB, no app config/model.

Run in backend: .venv/bin/python scripts/check_living.py --output <evidence directory>
"""
from __future__ import annotations

import argparse
import html
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import create_engine

from app.living.rules import DAY
from app.living.store import LivingStore

SPACE = str(UUID(int=1))
PLACE_REQUEST = str(UUID(int=2))
OWNER = "synthetic-owner"
PLACE = {"action": "place", "kind": "tree", "x": .25, "y": .5}


def worker(path: Path, phase: str) -> dict:
    if any(name in sys.modules for name in ("app.core.config", "app.core.database", "app.services.model_client")):
        raise RuntimeError("isolated verification imported production configuration")
    clock = [0 if phase == "setup" else 36 * 3600]
    engine = create_engine(f"sqlite:///{path}")
    store = LivingStore(engine, lambda: clock[0])

    def act(action, **values):
        revision = store.read_space(OWNER, SPACE)["revision"]
        return store.execute(OWNER, SPACE, str(uuid4()), revision, {"action": action, **values})

    def snapshot():
        return store.read_space(OWNER, SPACE)

    try:
        if phase == "setup":
            store.initialize()
            store.create_space(OWNER, SPACE, "home", "private", "synthetic-fruit")
            placed = store.execute(OWNER, SPACE, PLACE_REQUEST, 0, PLACE)
            tree = placed["items"][0]["id"]
            act("care", item_id=tree)
            clock[0] = 36 * 3600
            return {"after_36h": snapshot(), "place_receipt": placed}
        restored = snapshot()
        replay = store.execute(OWNER, SPACE, PLACE_REQUEST, 0, PLACE)
        tree = restored["items"][0]["id"]
        act("care", item_id=tree)
        clock[0] = 42 * 3600
        stored = act("store", item_id=tree)
        clock[0] = 66 * 3600
        after_storage = snapshot()
        placed_again = act("restore", item_id=tree, x=.8, y=.2)
        act("care", item_id=tree)
        clock[0] += DAY
        act("care", item_id=tree)
        clock[0] += 18 * 3600
        matured = snapshot()
        return {"restored": restored, "replayed_receipt": replay,
                "stored": stored, "after_storage": after_storage,
                "placed_again": placed_again, "matured": matured}
    finally:
        engine.dispose()


def verify() -> dict:
    with tempfile.TemporaryDirectory(prefix="aiwwb-r1-") as folder:
        path = Path(folder) / "living.sqlite3"
        outputs = []
        for phase in ("setup", "continue"):
            completed = subprocess.run([sys.executable, str(Path(__file__).resolve()),
                                        "--worker", phase, "--database", str(path)],
                                       text=True, capture_output=True, check=True, timeout=30)
            outputs.append(json.loads(completed.stdout))
    first, second = outputs
    checks = {
        "跨进程恢复空间、物件与进度": first["after_36h"] == second["restored"],
        "跨进程重复请求返回原回执": first["place_receipt"] == second["replayed_receipt"],
        "36 小时离线仅累计 24 小时成长": first["after_36h"]["items"][0]["growth_seconds"] == DAY,
        "收纳 24 小时不增加成长": second["stored"]["items"][0]["growth_seconds"] == second["after_storage"]["items"][0]["growth_seconds"] == 30 * 3600,
        "摆出保留身份且过期需照料": second["placed_again"]["items"][0]["id"] == first["place_receipt"]["items"][0]["id"] and second["placed_again"]["items"][0]["growth_status"] == "needs_care",
        "累计 72 小时有效成长后成熟": second["matured"]["items"][0]["growth_seconds"] == 3 * DAY and second["matured"]["items"][0]["stage"] == "mature",
    }
    return {"scope": "R1 隔离内核验证；合成伙伴、可控服务端时钟；不是实际等待数天或产品界面",
            "model_calls": 0, "checks": checks, "passed": all(checks.values()),
            "snapshots": {**first, **second}}


def render(result: dict) -> str:
    checks = "".join(f"<li>{'✓' if passed else '✗'} {html.escape(label)}</li>"
                     for label, passed in result["checks"].items())
    rows = []
    for key, label in [("after_36h", "照料后离线 36 小时"), ("stored", "补充照料，成长 6 小时后收纳"),
                       ("after_storage", "收纳 24 小时后"), ("placed_again", "重新摆出，等待照料"),
                       ("matured", "继续照料，累计成熟")]:
        item = result["snapshots"][key]["items"][0]
        rows.append(f"<tr><td>{label}</td><td>{item['growth_seconds'] // 3600} 小时</td>"
                    f"<td>{'已收纳' if item['stored'] else '已摆出'}</td></tr>")
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>R1 场景与养成验证</title>
<style>body{{margin:0;background:#f7f2fc;color:#352a45;font:16px/1.8 system-ui,sans-serif}}
main{{max-width:840px;margin:40px auto;padding:32px;background:#fff;border-radius:24px}}
h1{{font-size:28px}}h2{{font-size:20px}}p{{color:#655971}}ul{{padding-left:24px}}
table{{border-collapse:collapse;width:100%}}th,td{{text-align:left;padding:12px;border-bottom:1px solid #eee}}
.note{{background:#fceef4;border-radius:16px;padding:18px}}@media(max-width:600px){{main{{margin:12px;padding:18px}}th,td{{padding:8px}}}}</style>
<main><p>AI万物伙伴 · 技术开发第一阶段</p><h1>场景能保存，植物按规则慢慢长大</h1>
<p>此页由实际隔离验证脚本生成。结果：{'通过' if result['passed'] else '未通过'}。模型调用 0 次。</p>
<div class="note">{html.escape(result['scope'])}。真实登录、居住成员管理、旧花园迁移及正式页面尚未接入。</div>
<h2>成长与收纳的实际结果</h2><table><thead><tr><th>场景</th><th>有效成长</th><th>物件状态</th></tr></thead>
<tbody>{''.join(rows)}</tbody></table><h2>持久化与规则检查</h2><ul>{checks}</ul>
<p>完整规则与边界见同目录的《开发与验证报告》。本页不代表完整首版已完成。</p></main></html>"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--worker", choices=("setup", "continue"), help=argparse.SUPPRESS)
    parser.add_argument("--database", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.worker:
        if args.database is None:
            parser.error("worker needs database")
        print(json.dumps(worker(args.database, args.worker), ensure_ascii=False))
        return
    result = verify()
    if args.output:
        args.output.mkdir(parents=True, exist_ok=True)
        (args.output / "规则与恢复结果.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        (args.output / "验证结果.html").write_text(render(result))
    print(json.dumps({"passed": result["passed"], "checks": result["checks"], "model_calls": 0}, ensure_ascii=False))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
