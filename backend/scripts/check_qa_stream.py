"""Real streaming probe against the disposable phase-4 mock fixture only."""
import json
from pathlib import Path
from time import perf_counter

import httpx

project = Path(__file__).resolve().parents[2]
with httpx.Client(base_url="http://127.0.0.1:8022", timeout=40) as client:
    assert all("mock" in client.get(f"/api/v1/characters/{i}").json()["name"] for i in (1, 2))
    photo = client.post("/api/v1/photos", files={"file": ("synthetic-cup.jpg", (project / "docs/PRD/版本/V1.0/验收证据/前端阶段3/规范化杯子.jpg").read_bytes(), "image/jpeg")}).json()
    start = perf_counter()
    events = []
    with client.stream("POST", "http://127.0.0.1:3022/api/v1/characters", json={"object_id": photo["objects"][0]["id"]}, headers={"Accept-Encoding": "gzip"}) as response:
        headers = dict(response.headers)
        for line in response.iter_lines():
            if line.startswith("event:"):
                events.append({"event": line[7:], "seconds": round(perf_counter() - start, 3)})
    result = {"mock": True, "transport": "httpx real TCP streaming", "headers": headers, "events": events,
              "passed": events[0]["seconds"] < 1 and events[2]["seconds"] < 5 and events[-1]["event"] == "done" and "content-encoding" not in headers}
    (project / "docs/PRD/版本/V1.0/验收证据/前端阶段4/SSE代理真实流复验.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result))
    raise SystemExit(0 if result["passed"] else 1)
