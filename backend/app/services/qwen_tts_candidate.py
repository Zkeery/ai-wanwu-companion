"""Bounded, offline-testable Qwen voice candidate transport. Never enabled by the chat service."""

from dataclasses import dataclass
from decimal import Decimal
from io import BytesIO
from typing import Callable
from urllib.parse import urlsplit, urlunsplit
import wave

import httpx


MODEL = 'qwen3-tts-instruct-flash-2026-01-26'
API_URL = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
MAX_AUDIO_BYTES = 8 * 1024 * 1024
MAX_TEXT_LENGTH = 300
PRICE_PER_10000_CHARS = Decimal('0.8')
SAMPLE_TEXT = '刚才有点累，先喝口水，歇一会儿。'
VOICES = {
    'Serena': '温柔自然的朋友口吻，语速适中，轻声回应，不要播音腔。',
    'Cherry': '亲切自然的朋友口吻，语速适中，轻快但不过分兴奋。',
}


class CandidateError(Exception):
    """A fixed user-facing error; never include provider bodies or signed URLs."""

    def __init__(self, message: str, *, stage: str = 'unknown', http_status: int | None = None):
        super().__init__(message)
        self.stage = stage
        self.http_status = http_status


def billed_characters(text: str) -> int:
    return sum(2 if '\u3400' <= char <= '\u9fff' else 1 for char in text)


def estimated_price() -> Decimal:
    # Count instructions too, even if the provider bills only the input text.
    total = sum(billed_characters(SAMPLE_TEXT + instruction) for instruction in VOICES.values())
    return PRICE_PER_10000_CHARS * Decimal(total) / 10000


def _validated_audio_url(value: object) -> str:
    if not isinstance(value, str):
        raise CandidateError('语音服务未返回可下载的音频')
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        if (parsed.scheme not in {'http', 'https'} or parsed.username or parsed.password
                or parsed.port is not None or parsed.fragment
                or host not in {'dashscope-result-bj.oss-cn-beijing.aliyuncs.com',
                    'dashscope-a717.oss-cn-beijing.aliyuncs.com'}
                or not parsed.path.lower().endswith('.wav') or not parsed.query):
            raise CandidateError('语音服务返回的音频地址不符合预期')
    except ValueError as exc:
        raise CandidateError('语音服务返回的音频地址不符合预期') from exc
    # Official examples show an HTTP signed URL. Fetch the same host over TLS.
    return urlunsplit(('https', parsed.netloc, parsed.path, parsed.query, ''))


def _read_wav(data: bytes) -> None:
    if not (44 <= len(data) <= MAX_AUDIO_BYTES and data[:4] == b'RIFF' and data[8:12] == b'WAVE'):
        raise CandidateError('语音服务返回的音频格式无效')
    try:
        with wave.open(BytesIO(data), 'rb') as sound:
            duration = sound.getnframes() / sound.getframerate()
            if not 0 < duration <= 60 or sound.getnchannels() not in (1, 2):
                raise CandidateError('语音服务返回的音频长度无效')
    except (wave.Error, ZeroDivisionError, EOFError, ValueError) as exc:
        raise CandidateError('语音服务返回的音频格式无效') from exc


@dataclass(frozen=True)
class CandidateAudio:
    wav: bytes
    billed_characters: int


def synthesize_candidate(api_key: str, voice: str, *, client: httpx.Client,
        on_response: Callable[[dict], None] | None = None) -> CandidateAudio:
    return synthesize_text(api_key, SAMPLE_TEXT, voice, client=client, on_response=on_response)


def synthesize_text(api_key: str, text: str, voice: str, *, client: httpx.Client,
        on_response: Callable[[dict], None] | None = None) -> CandidateAudio:
    if not api_key or voice not in VOICES:
        raise CandidateError('项目语音配置或音色无效')
    if not isinstance(text, str) or not 0 < len(text.strip()) <= MAX_TEXT_LENGTH or len(text) > MAX_TEXT_LENGTH:
        raise CandidateError('回复文本超出语音合成限定长度')
    payload = {'model': MODEL, 'input': {'text': text, 'voice': voice,
        'language_type': 'Chinese', 'instructions': VOICES[voice]}}
    stage = 'provider_request'
    try:
        response = client.post(API_URL, json=payload, headers={'Authorization': f'Bearer {api_key}'},
            timeout=httpx.Timeout(45.0, connect=10.0))
        response.raise_for_status()
        stage = 'provider_response'
        body = response.json()
        # Persist privately before validation, so a local parsing failure never
        # requires another billable synthesis just to inspect/recover its result.
        if isinstance(body, dict) and on_response is not None:
            on_response(body)
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
        raise CandidateError('语音服务请求失败，结果需人工核对',
            stage=stage, http_status=status) from exc
    return download_candidate(body, client=client)


def download_candidate(body: object, *, client: httpx.Client) -> CandidateAudio:
    """Recover a persisted response without issuing another synthesis request."""
    stage = 'provider_response'
    try:
        if not isinstance(body, dict) or not isinstance(body.get('output'), dict):
            raise CandidateError('语音服务返回格式无效')
        output = body['output']
        # Require HTTP success, then a valid signed URL and WAV below; the JSON
        # envelope may omit status_code or finish_reason, but explicit failure is rejected.
        if (body.get('status_code') not in (None, 200) or body.get('success') is False
                or output.get('finish_reason') not in (None, 'stop')):
            raise CandidateError('语音服务未完成合成')
        stage = 'audio_url'
        audio = output.get('audio')
        audio_url = _validated_audio_url(audio.get('url') if isinstance(audio, dict) else None)
        stage = 'usage_validation'
        usage_body = body.get('usage')
        usage = usage_body.get('characters') if isinstance(usage_body, dict) else None
        if type(usage) is not int or usage < 0 or usage > 2 * MAX_TEXT_LENGTH:
            raise CandidateError('语音服务未返回有效用量')
        stage = 'audio_download'
        with client.stream('GET', audio_url, timeout=httpx.Timeout(20.0, connect=10.0),
                follow_redirects=False) as stream:
            stream.raise_for_status()
            if 300 <= stream.status_code < 400:
                raise CandidateError('语音下载发生非预期跳转')
            data = bytearray()
            for chunk in stream.iter_bytes():
                data.extend(chunk)
                if len(data) > MAX_AUDIO_BYTES:
                    raise CandidateError('语音服务返回的音频过大')
        wav = bytes(data)
        stage = 'audio_validation'
        _read_wav(wav)
        return CandidateAudio(wav, usage)
    except CandidateError as exc:
        if exc.stage == 'unknown':
            exc.stage = stage
        raise
    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
        status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
        raise CandidateError('语音服务请求或下载失败，结果需人工核对',
            stage=stage, http_status=status) from exc
