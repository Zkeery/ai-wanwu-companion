"""Zero-cost chat streaming check via the isolated 3022/8022 fixture."""
import json
from pathlib import Path
from time import perf_counter
import httpx

project = Path(__file__).resolve().parents[2]
with httpx.Client(timeout=40) as client:
    character = client.get("http://127.0.0.1:8022/api/v1/characters/2").json()
    assert character["name"] == "测试小杯（mock）", "Use the disposable fixture only"
    started = perf_counter()
    events = []
    event = ""
    with client.stream("POST", "http://127.0.0.1:3022/api/v1/characters/2/chat",
                       json={"message": "今天想安静地聊一会儿"},
                       headers={"Accept-Encoding": "gzip"}) as response:
        assert response.status_code == 200
        headers = dict(response.headers)
        for line in response.iter_lines():
            if line.startswith("event:"):
                event = line[6:].strip()
            elif line.startswith("data:"):
                events.append({"event": event, "seconds": round(perf_counter() - started, 3)})
    chunks = [item for item in events if item["event"] == "chunk"]
    passed = (len(chunks) > 1 and events[-1]["event"] == "done"
              and chunks[-1]["seconds"] - chunks[0]["seconds"] > 0.5
              and "no-transform" in headers.get("cache-control", "")
              and "content-encoding" not in headers)
    result = {"mock": True, "provider_calls": 0, "passed": passed,
              "transport": "real TCP via Next proxy; mock response delayed 80ms per character",
              "headers": headers, "events": events,
              "first_chunk_seconds": chunks[0]["seconds"] if chunks else None,
              "total_seconds": events[-1]["seconds"] if events else None}
    path = project / "docs/PRD/版本/V1.1/验收证据/网页体验整改/聊天流代理验收.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({key: result[key] for key in ("passed", "mock", "provider_calls", "first_chunk_seconds", "total_seconds")}))
    raise SystemExit(0 if passed else 1)
