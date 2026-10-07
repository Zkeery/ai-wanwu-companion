"""Plan two fixed natural-voice candidates; paid execution needs a fresh approved batch."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import time

from dotenv import dotenv_values
import httpx

from app.services.qwen_tts_candidate import (
    CandidateError, MODEL, PRICE_PER_10000_CHARS, SAMPLE_TEXT, VOICES,
    estimated_price, synthesize_candidate,
)


PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / '.runtime/tts-candidates'
MAX_BUDGET_CNY = 0.10


def _save_receipt(path: Path, data: dict) -> None:
    temporary = path.with_suffix('.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        os.chmod(temporary, 0o600)
        json.dump(data, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def run_batch(batch_id: str, api_key: str) -> dict:
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{7,79}', batch_id):
        raise ValueError('需要8至80位的新批次编号，仅允许小写字母、数字与连接号')
    if not api_key:
        raise ValueError('本项目 backend/.env 尚未配置 QWEN_TTS_API_KEY')
    if estimated_price() > MAX_BUDGET_CNY:
        raise ValueError('本批费用上界超过预定范围')
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    folder = ROOT / batch_id
    folder.mkdir(mode=0o700)  # Existing or interrupted batch is never retried.
    receipt = folder / 'receipt.json'
    result = dict(batch_id=batch_id, model=MODEL, state='started', voices=list(VOICES),
        max_budget_cny=MAX_BUDGET_CNY, calls=[], created_at=datetime.now(timezone.utc).isoformat())
    _save_receipt(receipt, result)
    try:
        with httpx.Client(follow_redirects=False) as client:
            for voice in VOICES:
                call = dict(voice=voice, state='started')
                result['calls'].append(call)
                _save_receipt(receipt, result)
                started = time.monotonic()
                try:
                    candidate = synthesize_candidate(api_key, voice, client=client,
                        on_response=lambda body: _save_receipt(folder / f'{voice}.response.json', body))
                    audio_path = folder / f'{voice}.wav'
                    with audio_path.open('xb') as stream:
                        os.chmod(audio_path, 0o600)
                        stream.write(candidate.wav)
                        stream.flush()
                        os.fsync(stream.fileno())
                    call.update(state='ready', billed_characters=candidate.billed_characters,
                        audio_bytes=len(candidate.wav), elapsed_ms=round((time.monotonic() - started) * 1000))
                except Exception as exc:
                    call.update(state='failed', error='provider_failed' if isinstance(exc, CandidateError) else 'save_failed')
                    if isinstance(exc, CandidateError):
                        call['stage'] = exc.stage
                        if exc.http_status is not None:
                            call['http_status'] = exc.http_status
                    result['state'] = 'failed'
                    _save_receipt(receipt, result)
                    break
                _save_receipt(receipt, result)
        if result['state'] == 'started':
            result['state'] = 'ready'
            _save_receipt(receipt, result)
    except BaseException:
        # A crash or interruption leaves the durable receipt in started/unknown state.
        raise
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true', help='requires separate approval and project key')
    parser.add_argument('--approval-ref')
    args = parser.parse_args()
    if not args.run:
        print(json.dumps(dict(model=MODEL, voices=list(VOICES), fixed_text=SAMPLE_TEXT,
            requests=len(VOICES), published_price_cny_per_10000=str(PRICE_PER_10000_CHARS),
            estimated_ceiling_cny=str(estimated_price()), batch_budget_ceiling_cny=MAX_BUDGET_CNY,
            state='planned', provider_calls=0), ensure_ascii=False))
        return
    if not args.approval_ref:
        parser.error('收费执行需要本次用户同意的具体批次编号')
    key = dotenv_values(PROJECT / 'backend/.env').get('QWEN_TTS_API_KEY')
    try:
        result = run_batch(args.approval_ref, key or '')
    except (ValueError, FileExistsError) as exc:
        parser.error(str(exc))
    print(json.dumps(dict(batch_id=result['batch_id'], state=result['state'], calls=result['calls'],
        receipt=str(ROOT / result['batch_id'] / 'receipt.json')), ensure_ascii=False))


if __name__ == '__main__':
    main()
