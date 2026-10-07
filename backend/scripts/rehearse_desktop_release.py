"""Isolated production invite rehearsal; outbound provider connections are blocked."""
import argparse
import json
import os
from pathlib import Path
import socket
import shutil
import subprocess
import sys
import time

from scripts import rehearse_release as shared

PROJECT = Path(__file__).resolve().parents[2]
WORK = PROJECT / ".runtime" / "desktop-release-20261002"
BACKEND_PORT, FRONTEND_PORT = 8062, 3062


def environment(state: Path) -> dict:
    return shared.child_env(
        APP_ENV="production", AUTH_MODE="invite", SMS_PROVIDER="mock", SMS_LIVE_ENABLED="false",
        DEV_AUTH_TOKEN="", DEV_SMS_FIXED_CODE="", LEGACY_CLAIM_USER_ID="",
        MODEL_API_KEY="synthetic-offline-key", MODEL_BASE_URL="https://example.invalid/v1",
        IMAGE_BASE_URL="", MODEL_MAX_RETRIES="0", DATABASE_URL="sqlite:///" + str(state / "app.db"),
        UPLOAD_DIR=str(state / "uploads"), LIFE_RUNTIME_ENABLED="false", LIFE_SIMULATION_ENABLED="false",
        LIFE_RUNTIME_PREVIEW_ENABLED="false", LIFE_LIVE_PLANNER_PREVIEW_ENABLED="false",
        GATHERING_DIALOGUE_ENABLED="false", GATHERING_DIALOGUE_AUTOMATIC_ENABLED="false",
        COMPETITION_AI_ENABLED="false", MOTION_GENERATION_ENABLED="false", VOICE_LIVE_REPLY_ENABLED="false",
        GENERATION_QUOTA_ENABLED="true", NEXT_PUBLIC_AUTH_MODE="invite",
        NEXT_DIST_DIR=".next-desktop-release", BACKEND_URL=f"http://127.0.0.1:{BACKEND_PORT}",
    )


def free_port(port):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))


def launch_backend(state):
    log = open(WORK / "backend.log", "ab")
    os.chmod(WORK / "backend.log", 0o600)
    proc = subprocess.Popen([sys.executable, "-m", "scripts.rehearse_desktop_release", "_serve"],
                            cwd=PROJECT / "backend", env=environment(state), stdout=log, stderr=log,
                            start_new_session=True)
    log.close()
    shared.wait_ready(proc, BACKEND_PORT, "/api/v1/auth/me")
    return proc


def start():
    free_port(BACKEND_PORT)
    free_port(FRONTEND_PORT)
    WORK.mkdir(mode=0o700)
    state = WORK / "state"
    state.mkdir(mode=0o700)
    proc = None
    front = None
    try:
        proc = launch_backend(state)
        log = open(WORK / "frontend.log", "ab")
        os.chmod(WORK / "frontend.log", 0o600)
        front = subprocess.Popen(["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1",
                                  "--port", str(FRONTEND_PORT)], cwd=PROJECT / "frontend", env=environment(state),
                                 stdout=log, stderr=log, start_new_session=True)
        log.close()
        shared.wait_ready(front, FRONTEND_PORT, "/")
        shared.private_json(WORK / "processes.json", {"backend": proc.pid, "frontend": front.pid})
        for _ in range(2):
            result = subprocess.run([sys.executable, "-m", "scripts.manage_invites", "create"],
                                    cwd=PROJECT / "backend", env=environment(state), capture_output=True,
                                    text=True, timeout=20)
            if result.returncode:
                raise RuntimeError("invite_creation_failed")
        print(json.dumps({"started": True, "url": f"http://127.0.0.1:{FRONTEND_PORT}",
                          "scope": "isolated production configuration, synthetic credentials, external network blocked"}))
    except Exception:
        shared.stop(proc)
        shared.stop(front)
        raise


def exercise():
    from scripts.check_full_flow_recovery import capture, restore_test
    state = WORK / "state"
    credentials = [json.loads(p.read_text()) for p in sorted((state / "private-invites").glob("*.json"))]
    checks = {}
    def check(name, ok):
        checks[name] = bool(ok)
        if not ok:
            raise RuntimeError("check_failed:" + name)
    status, _ = shared.request(FRONTEND_PORT, "/api/v1/auth/me")
    check("anonymous_denied", status == 401)
    status, _ = shared.request(FRONTEND_PORT, "/api/v1/auth/invite", payload={"code": "incorrect"})
    check("wrong_invite_denied", status == 401)
    sessions = []
    for credential in credentials:
        status, raw = shared.request(FRONTEND_PORT, "/api/v1/auth/invite", payload={"code": credential["code"]})
        response = json.loads(raw)
        check("invite_login_" + str(len(sessions)), status == 200 and response["user"]["id"] == credential["user_id"])
        sessions.append(response["token"])
    check("distinct_accounts", credentials[0]["user_id"] != credentials[1]["user_id"])
    status, _ = shared.request(FRONTEND_PORT, "/api/v1/auth/code", payload={"phone": "13900000001"})
    check("sms_disabled", status == 403)
    processes = json.loads((WORK / "processes.json").read_text())
    os.kill(processes["backend"], 15)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        with socket.socket() as sock:
            if sock.connect_ex(("127.0.0.1", BACKEND_PORT)) != 0:
                break
        time.sleep(.1)
    else:
        raise RuntimeError("backend_stop_timeout")
    check("complete_capture", bool(capture(source=state, snapshot=WORK / "snapshot", database_name="app.db",
                                           include_runtime_state=True)))
    check("new_directory_restore", bool(restore_test(WORK / "restored", source=state, snapshot=WORK / "snapshot",
                                                     database_name="app.db", include_runtime_state=True)))
    proc = launch_backend(WORK / "restored")
    processes["backend"] = proc.pid
    shared.private_json(WORK / "processes.json", processes)
    for index, token in enumerate(sessions):
        status, raw = shared.request(FRONTEND_PORT, "/api/v1/auth/me", token)
        check("session_restored_" + str(index), status == 200 and json.loads(raw)["id"] == credentials[index]["user_id"])
    status, _ = shared.request(FRONTEND_PORT, "/api/v1/auth/logout", sessions[0], payload={})
    check("logout", status == 204)
    status, _ = shared.request(FRONTEND_PORT, "/api/v1/auth/me", sessions[0])
    check("logout_revoked", status == 401)
    status, _ = shared.request(FRONTEND_PORT, "/api/v1/auth/invite", payload={"code": credentials[0]["code"]})
    check("credential_restored", status == 200)
    report = {"checks": checks, "passed": sum(checks.values()), "total": len(checks),
              "real_model_requests": 0, "cloud_deployed": False}
    shared.private_json(WORK / "result.json", report)
    print(json.dumps(report))


def cleanup():
    report = json.loads((WORK / "result.json").read_text())
    if report.get("passed") != 13 or report.get("total") != 13:
        raise RuntimeError("preserve_failed_rehearsal")
    processes = json.loads((WORK / "processes.json").read_text())
    for name, pid in processes.items():
        process = subprocess.run(["ps", "-p", str(pid), "-o", "args="], capture_output=True, text=True)
        if not process.stdout.strip():
            continue
        cwd = subprocess.run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], capture_output=True, text=True)
        expected = str(PROJECT / ("backend" if name == "backend" else "frontend"))
        if "n" + expected not in cwd.stdout.splitlines():
            raise RuntimeError("process_owner_mismatch")
        if (name == "backend" and "scripts.rehearse_desktop_release _serve" not in process.stdout
                or name == "frontend" and "next-server" not in process.stdout):
            raise RuntimeError("process_command_mismatch")
        os.kill(pid, 15)
    for _ in range(100):
        live = []
        for port in (BACKEND_PORT, FRONTEND_PORT):
            with socket.socket() as sock:
                live.append(sock.connect_ex(("127.0.0.1", port)) == 0)
        if not any(live):
            break
        time.sleep(.1)
    else:
        raise RuntimeError("rehearsal_stop_timeout")
    for name in ("state", "snapshot", "restored"):
        path = WORK / name
        if path.exists() and not path.is_symlink():
            shutil.rmtree(path)
    for name in ("backend.log", "frontend.log", "processes.json"):
        (WORK / name).unlink(missing_ok=True)
    print(json.dumps({"stopped": True, "synthetic_credentials_and_data_removed": True,
                      "result_preserved": True}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("phase", choices=["start", "exercise", "cleanup", "_serve"])
    args = parser.parse_args()
    if args.phase == "_serve":
        shared.block_external_network()
        import uvicorn
        uvicorn.run("app.main:app", host="127.0.0.1", port=BACKEND_PORT, access_log=False, log_level="warning")
    elif args.phase == "start":
        start()
    elif args.phase == "cleanup":
        cleanup()
    else:
        exercise()


if __name__ == "__main__":
    main()
