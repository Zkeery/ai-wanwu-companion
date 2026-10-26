"""One Hyper3D Gen2 model per adopted companion. Failures stay failed."""
from __future__ import annotations

import base64
import logging
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.database import SessionLocal
from app.models.models import Character, CharacterCourtyardMesh

log = logging.getLogger(__name__)
MODEL = "hyper3d-gen2-260112"
PARAMS = "--material Shaded --mesh_mode Quad --subdivisionlevel medium --fileformat glb"
MAX_BYTES = 25_000_000
POLL_SECONDS = 8
JOB_SECONDS = 20 * 60


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def enqueue(session: Session, character: Character) -> None:
    """Record one pending job for the creation image. Never replaces a finished or failed job."""
    if character.status != "ready" or not character.image_path:
        return
    if session.get(CharacterCourtyardMesh, character.id) is not None:
        return
    session.add(CharacterCourtyardMesh(
        character_id=character.id, source_image_path=character.image_path, status="pending",
    ))
    session.flush()


def public_status(session: Session, character_id: int) -> str:
    row = session.get(CharacterCourtyardMesh, character_id)
    if row is None:
        return "absent"
    return "pending" if row.status == "running" else row.status


def mesh_file(session: Session, character: Character) -> Path | None:
    row = session.get(CharacterCourtyardMesh, character.id)
    if row is None or row.status != "ready" or not row.file_path:
        return None
    root = Path(get_settings().upload_dir).resolve()
    candidate = Path(row.file_path)
    if candidate.is_absolute() or ".." in candidate.parts:
        return None
    candidate = (root / candidate).resolve()
    if not candidate.is_relative_to(root) or candidate.suffix.lower() != ".glb" or not candidate.is_file():
        return None
    return candidate


def _error_code(body, http_status: int) -> str:
    if isinstance(body, dict):
        error = body.get("error")
        if isinstance(error, dict) and isinstance(error.get("code"), str) and error["code"].strip():
            return error["code"].strip()[:64]
        if isinstance(body.get("code"), str) and body["code"].strip():
            return body["code"].strip()[:64]
    return f"http_{http_status}"


def _image_data_url(path: Path) -> str | None:
    if not path.is_file() or path.stat().st_size > 12 * 1024 * 1024:
        return None
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        kind = "png"
    elif data.startswith(b"\xff\xd8\xff"):
        kind = "jpeg"
    else:
        return None
    return f"data:image/{kind};base64," + base64.b64encode(data).decode()


def _urls(value, found: list[str] | None = None) -> list[str]:
    found = [] if found is None else found
    if isinstance(value, dict):
        for item in value.values():
            _urls(item, found)
    elif isinstance(value, list):
        for item in value:
            _urls(item, found)
    elif isinstance(value, str) and value.startswith("https://"):
        found.append(value)
    return found


def _finish(row: CharacterCourtyardMesh, status: str, http_status: int | None, code: str | None) -> None:
    row.status = status
    row.http_status = http_status
    row.error_code = code
    row.finished_at = _now()
    started = row.started_at or row.created_at
    row.duration_ms = max(0, int((row.finished_at - started).total_seconds() * 1000))
    log.info(
        "courtyard_mesh character=%s status=%s http=%s ms=%s code=%s",
        row.character_id, status, http_status, row.duration_ms, code or "",
    )


def run_once() -> bool:
    """Advance a single already-paid or pending job. Returns whether a job was touched."""
    session = SessionLocal()
    try:
        row = (session.query(CharacterCourtyardMesh)
               .filter(CharacterCourtyardMesh.status == "running")
               .order_by(CharacterCourtyardMesh.character_id.asc()).first())
        if row is None:
            row = (session.query(CharacterCourtyardMesh)
                   .filter(CharacterCourtyardMesh.status == "pending")
                   .order_by(CharacterCourtyardMesh.character_id.asc()).first())
            if row is None:
                return False
            row.status = "running"
            row.started_at = _now()
            session.commit()
        else:
            session.commit()
        character_id = row.character_id
    finally:
        session.close()

    session = SessionLocal()
    try:
        row = session.get(CharacterCourtyardMesh, character_id)
        if row is None or row.status != "running":
            return True
        _generate(session, row)
        session.commit()
        return True
    except Exception:
        session.rollback()
        log.warning("courtyard_mesh character=%s status=running http= code=transport", character_id)
        return False
    finally:
        session.close()


def _generate(session: Session, row: CharacterCourtyardMesh) -> None:
    settings = get_settings()
    key = settings.ark_api_key.strip()
    if len(key) < 8:
        _finish(row, "failed", None, "key_missing")
        return
    root = Path(settings.upload_dir).resolve()
    source = (root / row.source_image_path).resolve()
    if not source.is_relative_to(root):
        _finish(row, "failed", None, "image_missing")
        return
    image = _image_data_url(source)
    if image is None:
        _finish(row, "failed", None, "image_missing")
        return
    url = settings.ark_base_url.rstrip("/") + "/contents/generations/tasks"
    timeout = httpx.Timeout(120.0, connect=20.0)
    headers = {"Authorization": f"Bearer {key}"}
    with httpx.Client(timeout=timeout) as client:
        if not row.task_id:
            response = client.post(url, headers=headers, json={
                "model": MODEL, "seed": 1026,
                "content": [
                    {"type": "text", "text": PARAMS},
                    {"type": "image_url", "image_url": {"url": image}},
                ],
            })
            body = _json(response)
            task_id = body.get("id") if isinstance(body, dict) else None
            if response.status_code != 200 or not isinstance(task_id, str) or not task_id:
                _finish(row, "failed", response.status_code, _error_code(body, response.status_code))
                return
            row.task_id = task_id[:128]
            session.commit()
        deadline = _now().timestamp() + JOB_SECONDS
        while _now().timestamp() < deadline:
            response = client.get(f"{url}/{row.task_id}", headers=headers)
            body = _json(response)
            state = body.get("status") if isinstance(body, dict) else ""
            if response.status_code != 200:
                _finish(row, "failed", response.status_code, _error_code(body, response.status_code))
                return
            if state == "succeeded":
                saved = _save_model(client, row, body)
                if saved is None:
                    _finish(row, "failed", response.status_code, "model_missing")
                    return
                row.file_path = saved
                _finish(row, "ready", response.status_code, None)
                return
            if state in {"failed", "cancelled"}:
                _finish(row, "failed", response.status_code, _error_code(body, response.status_code) if state == "failed" else "cancelled")
                return
            time.sleep(POLL_SECONDS)
    _finish(row, "failed", None, "timeout")


def _json(response: httpx.Response):
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _save_model(client: httpx.Client, row: CharacterCourtyardMesh, body: dict) -> str | None:
    found = _urls(body)
    chosen = next((item for item in found if ".glb" in item.lower()), found[0] if found else None)
    if chosen is None:
        return None
    response = client.get(chosen, timeout=httpx.Timeout(180.0, connect=20.0))
    if response.status_code != 200:
        return None
    data = response.content
    if len(data) < 20 or len(data) > MAX_BYTES or not data.startswith(b"glTF"):
        return None
    relative = f"meshes/{row.character_id}.glb"
    dest = (Path(get_settings().upload_dir).resolve() / relative)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return relative


async def consume(stop) -> None:
    import asyncio
    while not stop.is_set():
        worked = await asyncio.to_thread(run_once)
        if stop.is_set():
            return
        try:
            await asyncio.wait_for(stop.wait(), timeout=0.2 if worked else 2)
        except asyncio.TimeoutError:
            pass
