"""Single-attempt JSON decisions through the project's existing text provider."""
import json

import httpx

from app.core.config import get_settings
from app.services.model_client import ModelClient


class ProviderAdapter:
    def __init__(self, *, settings_factory=get_settings, client_factory=httpx.Client):
        self.settings_factory, self.client_factory = settings_factory, client_factory

    def decide(self, history, *, timeout_seconds):
        settings = self.settings_factory()
        if settings.use_mock or not settings.model_base_url.strip():
            raise RuntimeError("Scene Agent requires an explicitly configured provider")
        messages = []
        for item in history:
            role = item["role"]
            content = item["content"]
            if role == "tool":
                role, content = "user", {"tool_result": item["name"], "data": content}
            messages.append({"role": role, "content": content if isinstance(content, str) else json.dumps(content, ensure_ascii=False)})
        payload = {"model": settings.chat_model, "messages": messages,
                   "stream": False, "max_tokens": 512, "temperature": 0.3}
        payload.update(ModelClient._text_options(settings))
        timeout = min(float(settings.model_timeout_seconds), timeout_seconds)
        if timeout <= 0:
            raise TimeoutError()
        # Construct inside decide: initialization failures are caught by the runtime.
        with self.client_factory(timeout=httpx.Timeout(timeout, connect=min(10.0, timeout))) as client:
            with client.stream("POST", settings.model_base_url.rstrip("/") + "/chat/completions",
                               headers={"Authorization": "Bearer " + settings.model_api_key}, json=payload) as response:
                response.raise_for_status()
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        raise ValueError("Decision response too large")
        data = json.loads(body)
        choice = data["choices"][0]
        if choice.get("finish_reason") != "stop":
            raise ValueError("Decision response incomplete")
        content = choice["message"]["content"]
        if not isinstance(content, str) or len(content) > 8192:
            raise ValueError("Invalid decision content")
        return json.loads(content)
