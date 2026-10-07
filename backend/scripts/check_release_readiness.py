"""Run read-only preflight; 2 means completed with blockers, not a tool crash."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="只读上线预检，不调用模型、不启动应用")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        from app.core.config import Settings
        from app.services.release_readiness import assess, frontend_environment

        report = assess(Settings(), frontend_environment(BACKEND.parent, os.environ), BACKEND.parent)
    except Exception:
        print(json.dumps({"error": {"code": "preflight_input_invalid",
                                   "message": "配置或源码读取失败，请本地检查；敏感详情不回显"}}, ensure_ascii=False))
        return 1
    try:
        # Exclusive creation, private permissions. Existing reports/data are never overwritten.
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write("\n")
    except OSError:
        print(json.dumps({"error": {"code": "report_write_failed",
                                   "message": "报告未写入：请确认父目录存在、可写且目标文件不存在"}}, ensure_ascii=False))
        return 1
    print(json.dumps({"ready_for_release": report["ready_for_release"],
                      "summary": report["summary"]}, ensure_ascii=False))
    return 0 if report["ready_for_release"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
