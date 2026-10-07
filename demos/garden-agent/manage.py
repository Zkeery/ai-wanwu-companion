"""Start/stop only this isolated demo. Run with the system Python."""
from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / ".data"
PID_FILE = DATA / "server.pid"
CONFIG = json.loads((ROOT / "demo.json").read_text())
PYTHON = ROOT.parents[1] / "backend/.venv/bin/python"


def alive():
    if not PID_FILE.exists():
        return None
    try:
        info = json.loads(PID_FILE.read_text())
        result = subprocess.run(["ps", "-p", str(info["pid"]), "-o", "command="], capture_output=True, text=True)
        if str(ROOT / "server.py") in result.stdout and f"--port {info['port']}" in result.stdout:
            return info
    except (OSError, ValueError, KeyError):
        pass
    return None


def port_open(port):
    with socket.socket() as sock:
        sock.settimeout(.3)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("start", "stop", "status"))
    args = parser.parse_args()
    info = alive()
    if args.action == "status":
        print(json.dumps({"running": bool(info), "url": f"http://127.0.0.1:{info['port']}/" if info else None}))
        return
    if args.action == "stop":
        if info:
            os.kill(info["pid"], signal.SIGTERM)
            for _ in range(30):
                if not alive():
                    break
                time.sleep(.1)
            if alive():
                raise SystemExit("Demo 尚未停止，请检查本 demo 的进程。")
        PID_FILE.unlink(missing_ok=True)
        print("Demo 已停止。")
        return
    if info:
        print(f"Demo 已在运行：http://127.0.0.1:{info['port']}/")
        return
    port = CONFIG["port"]
    if port_open(port):
        raise SystemExit(f"端口 {port} 已占用，未启动或停止任何其他服务。")
    if not PYTHON.exists():
        raise SystemExit("缺少本项目 backend/.venv；请先按项目后端说明准备环境。")
    DATA.mkdir(exist_ok=True)
    with (DATA / "server.log").open("ab") as log:
        proc = subprocess.Popen([str(PYTHON), str(ROOT / "server.py"), "--port", str(port)],
                                cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
    PID_FILE.write_text(json.dumps({"pid": proc.pid, "port": port}))
    for _ in range(60):
        if proc.poll() is not None:
            PID_FILE.unlink(missing_ok=True)
            raise SystemExit("Demo 启动失败，详情仅在 .data/server.log 中。")
        if port_open(port):
            print(f"Demo 已启动：http://127.0.0.1:{port}/")
            return
        time.sleep(.1)
    raise SystemExit("Demo 启动未就绪，请检查 .data/server.log。")


if __name__ == "__main__":
    main()
