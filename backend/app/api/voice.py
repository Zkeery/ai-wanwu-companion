from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, UploadFile, Response
from pydantic import BaseModel, ConfigDict, Field, StrictStr, field_validator, model_validator

from app.api.deps import get_current_user
from app.api.gatherings import no_cache
from app.core.config import get_settings
from app.core.database import engine
from app.core.errors import api_error
from app.models.models import User
from app.services.voice import VoiceService, MAX_BYTES, trim_mood_text
from app.services.transcription import transcribe

service = VoiceService(engine)
router = APIRouter(prefix='/characters/{character_id}/voice', tags=['voice'], dependencies=[Depends(no_cache)])


class SettingsRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    voice: str = Field(max_length=100)
    mood: Literal['happy', 'calm', 'sad', 'tired', 'anxious', 'irritated', 'unsure', 'custom'] | None
    automatic: bool = Field(strict=True)
    mood_text: StrictStr | None = None

    @field_validator('mood_text')
    @classmethod
    def normalize_mood_text(cls, value):
        if value is None:
            return None
        value = trim_mood_text(value)
        if not 1 <= len(value) <= 200:
            raise ValueError('当前心情请填写1至200个字')
        return value

    @model_validator(mode='after')
    def check_mood_text(self):
        if 'mood_text' in self.model_fields_set:
            if self.mood == 'custom' and self.mood_text is None:
                raise ValueError('自己描述心情时请填写当前感受')
            if self.mood != 'custom' and self.mood_text is not None:
                raise ValueError('只有自己描述心情时可以填写当前感受')
        return self


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra='forbid')
    voice: str = Field(max_length=100)


@router.get('/settings')
def settings(character_id: int, user: User = Depends(get_current_user)):
    return service.read_settings(user.id, character_id)


@router.put('/settings')
def save(character_id: int, payload: SettingsRequest, user: User = Depends(get_current_user)):
    extra = {'mood_text': payload.mood_text} if 'mood_text' in payload.model_fields_set else {}
    return service.save_settings(user.id, character_id, payload.voice, payload.mood, payload.automatic, **extra)


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
