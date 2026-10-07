from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, UploadFile, Response
from pydantic import BaseModel, ConfigDict, Field

from app.api.deps import get_current_user
from app.api.gatherings import no_cache
from app.core.config import get_settings
from app.core.database import engine
from app.core.errors import api_error
from app.models.models import User
from app.services.voice import VoiceService, MAX_BYTES
from app.services.transcription import transcribe

service = VoiceService(engine)
router = APIRouter(prefix='/characters/{character_id}/voice', tags=['voice'], dependencies=[Depends(no_cache)])


class SettingsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    voice: str = Field(max_length=100)
    mood: Literal['happy', 'calm', 'sad', 'tired', 'anxious', 'unsure'] | None
    automatic: bool = Field(strict=True)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    voice: str = Field(max_length=100)


@router.get('/settings')
def settings(character_id: int, user: User = Depends(get_current_user)):
    return service.read_settings(user.id, character_id)


@router.put('/settings')
def save(character_id: int, payload: SettingsRequest, user: User = Depends(get_current_user)):
    return service.save_settings(user.id, character_id, payload.voice, payload.mood, payload.automatic)


@router.post('/session/end')
def end_session(character_id: int, user: User = Depends(get_current_user)):
    return service.end_live_session(user.id, character_id)


@router.post('/preview')
def preview(character_id: int, payload: PreviewRequest, user: User = Depends(get_current_user)):
    service.read_settings(user.id, character_id)
    try:
        data = service.preview(user.id, character_id, payload.voice)
    except Exception:
        raise api_error(503, 'audio_unavailable', '音色暂时不可用，可以继续文字交流') from None
    return Response(data, media_type='audio/wav', headers={'Cache-Control': 'private, no-store', 'Vary': 'Authorization'})


@router.get('/audio')
def history(character_id: int, user: User = Depends(get_current_user)):
    return service.history(user.id, character_id)


@router.get('/rounds')
def receipts(character_id: int, user: User = Depends(get_current_user)):
    return service.receipts(user.id, character_id)


@router.get('/rounds/{request_id}')
def receipt(character_id: int, request_id: UUID, user: User = Depends(get_current_user)):
    return service.receipts(user.id, character_id, str(request_id))


@router.get('/audio/{audio_id}')
def audio(character_id: int, audio_id: UUID, user: User = Depends(get_current_user)):
    data, mime = service.read_audio(user.id, character_id, str(audio_id))
    return Response(data, media_type=mime, headers={'Cache-Control': 'private, no-store', 'Vary': 'Authorization',
        'X-Content-Type-Options': 'nosniff'})


@router.delete('/audio/{audio_id}', status_code=204)
def delete_audio(character_id: int, audio_id: UUID, user: User = Depends(get_current_user)):
    service.delete_audio(user.id, character_id, str(audio_id))


@router.post('/audio/{audio_id}/retry')
def retry_audio(character_id: int, audio_id: UUID, user: User = Depends(get_current_user)):
    return service.retry_audio(user.id, character_id, str(audio_id))


@router.post('/send')
def send(character_id: int, request_id: UUID = Form(), transcript: str = Form(max_length=2000),
         recording: UploadFile = File(), user: User = Depends(get_current_user)):
    # Bound memory independently of claimed filename, extension and content type.
    try:
        data = recording.file.read(MAX_BYTES + 1)
    finally:
        recording.file.close()
    return service.send(user.id, character_id, str(request_id), transcript, data,
        offline=get_settings().app_env == 'test' or get_settings().use_mock)


@router.post('/transcribe')
def recognize(character_id: int, recording: UploadFile = File(), user: User = Depends(get_current_user)):
    service.read_settings(user.id, character_id)
    try:
        data = recording.file.read(MAX_BYTES + 1)
    finally:
        recording.file.close()
    return {'text': transcribe(data, get_settings().voice_local_model_path)}
