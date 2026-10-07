import json
import logging
from concurrent.futures import ThreadPoolExecutor

import httpx
import pytest

from app.core.config import Settings
from app.services import model_client
from app.services.generation_timing import current_operation_id, timed_call
from app.services.model_client import ModelClient, ModelError


@pytest.fixture(autouse=True)
def capture_timing_logs(caplog, monkeypatch):
    # TCP tests configure uvicorn with propagation disabled. Capture directly
    # and restore the logger afterwards, independent of test execution order.
    logger = logging.getLogger("uvicorn.error")
    monkeypatch.setattr(logger, "handlers", [caplog.handler])
    monkeypatch.setattr(logger, "propagate", False)


def timing_records(caplog):
    return [json.loads(record.message.removeprefix("generation_timing "))
            for record in caplog.records if record.message.startswith("generation_timing ")]


@pytest.mark.parametrize("failure", [None, "image_http", "image_download", "image_store"])
def test_image_stages_share_task_id_and_record_failures_without_content(tmp_path, monkeypatch, caplog, failure):
    settings = Settings(_env_file=None, model_base_url="https://fixture.example/v1",
                        model_api_key="fixture-secret", model_max_retries=0,
                        upload_dir=str(tmp_path), model_http_pool_enabled=False)
    calls = []

    def handle(request):
        calls.append(request.method)
        if request.method == "POST":
            if failure == "image_http":
                raise httpx.ReadTimeout("private exception details", request=request)
            return httpx.Response(200, json={"data": [{"url": "https://fixture.example/private.png?signature=private"}]})
        if failure == "image_download":
            return httpx.Response(503, content=b"private provider details")
        return httpx.Response(200, content=b"original-image", headers={"Content-Type": "image/png"})

    real_client = httpx.Client
    monkeypatch.setattr(model_client.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(handle), **kwargs))
    if failure == "image_store":
        monkeypatch.setattr(model_client.Path, "write_bytes", lambda *args: (_ for _ in ()).throw(OSError("private disk details")))
    caplog.set_level(logging.INFO, logger="uvicorn.error")
    run = lambda: ModelClient()._call_image_generation("private-label", "private-name", settings)
    if failure is None:
        result = timed_call("image", "fixture-task", run)
        assert (tmp_path / result).read_bytes() == b"original-image"
    else:
        with pytest.raises((ModelError, httpx.HTTPStatusError, OSError)):
            timed_call("image", "fixture-task", run)
    rows = timing_records(caplog)
    stages = ["image_http", "image_download", "image_store"]
    expected = stages if failure is None else stages[:stages.index(failure) + 1]
    assert [row["stage"] for row in rows] == expected + ["image"]
    for row in rows:
        assert set(row) == {"stage", "operation_id", "elapsed_ms", "outcome"}
        assert row["operation_id"] == "fixture-task"
        assert row["elapsed_ms"] >= 0
        assert row["outcome"] == ("failed" if failure and row["stage"] in (failure, "image") else "succeeded")
    assert "private" not in json.dumps(rows) and "fixture-secret" not in json.dumps(rows)
    assert calls == (["POST"] if failure == "image_http" else ["POST", "GET"])
    assert current_operation_id() is None


def test_task_timing_context_is_isolated_and_restored_after_nested_failure():
    def task(task_id):
        def parent():
            assert current_operation_id() == task_id
            with pytest.raises(ValueError):
                timed_call("child", "nested", lambda: (_ for _ in ()).throw(ValueError("fixture")))
            assert current_operation_id() == task_id
            return task_id
        result = timed_call("parent", task_id, parent)
        assert current_operation_id() is None
        return result
    with ThreadPoolExecutor(max_workers=4) as executor:
        assert list(executor.map(task, ["one", "two", "three", "four"])) == ["one", "two", "three", "four"]
