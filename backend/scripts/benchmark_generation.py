"""Offline fixed-delay comparison. No provider calls or application database."""
import json
from pathlib import Path
import sys
from time import perf_counter, sleep

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.character_generation import finish_character
from app.services.parsers import Persona


class DelayedClient:
    def __init__(self):
        self.intervals = {}

    def wait(self, name, delay, result):
        start = perf_counter()
        sleep(delay)
        self.intervals[name] = (start, perf_counter())
        return result

    def generate_persona(self, label):
        return self.wait("persona", 0.2, Persona(name="计时杯", persona="固定延迟测试人设"))

    def generate_opening(self, persona):
        return self.wait("opening", 0.3, "你好")

    def generate_image(self, label, name, **appearance):
        return self.wait("image", 0.4, "offline-no-file.png")


def main():
    samples = []
    for _ in range(3):
        row = {}
        for parallel in (False, True):
            client = DelayedClient()
            start = perf_counter()
            persona = client.generate_persona("合成杯子")
            if parallel:
                finish_character(client, "合成杯子", persona)
            else:
                client.generate_opening(persona)
                client.generate_image("合成杯子", persona.name)
            elapsed = perf_counter() - start
            a, b = client.intervals["opening"], client.intervals["image"]
            overlap = max(0, min(a[1], b[1]) - max(a[0], b[0]))
            row["parallel" if parallel else "serial"] = {
                "seconds": round(elapsed, 4), "overlap_seconds": round(overlap, 4),
                "persona_precedes_both": client.intervals["persona"][1] <= min(a[0], b[0]),
            }
        row["passed"] = (row["parallel"]["overlap_seconds"] >= 0.25
                         and row["parallel"]["seconds"] < row["serial"]["seconds"] - 0.2
                         and row["parallel"]["persona_precedes_both"])
        samples.append(row)
    output = Path(__file__).resolve().parents[2] / "docs/PRD/版本/V1.0/验收证据/前端阶段4/离线并行计时.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    result = {"mock": True, "provider_calls": 0, "fixed_delays_seconds": {"persona": 0.2, "opening": 0.3, "image": 0.4},
              "samples": samples, "passed": all(row["passed"] for row in samples),
              "limitation": "Only verifies orchestration overlap; not evidence of real-provider latency."}
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "output": str(output)}))
    raise SystemExit(0 if result["passed"] else 1)


if __name__ == "__main__":
    main()
