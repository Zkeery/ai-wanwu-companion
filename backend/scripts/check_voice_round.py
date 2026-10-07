"""Plan by default; one real private voice round needs its own explicit approval."""
import argparse
import asyncio
import json
from pathlib import Path
import sqlite3
import time
from uuid import uuid4

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / '.runtime/r51'
DATABASE = PROJECT / '.runtime/c160-review/check.db'
TEXT = '你好，我今天有点累，想安静聊两句。'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--authorization-ref')
    args = parser.parse_args()
    if args.execute and not (args.authorization_ref and 8 <= len(args.authorization_ref) <= 120):
        parser.error('需要本轮新的具体费用授权编号，不填密钥')
    with sqlite3.connect(f'file:{DATABASE}?mode=ro', uri=True) as db:
        row = db.execute('SELECT owner_id,status FROM characters WHERE id=4').fetchone()
        if not row or not row[0] or row[1] != 'ready':
            raise RuntimeError('本人4号伙伴未就绪')
    if not (ROOT / 'input.wav').is_file():
        raise RuntimeError('本地合成语音样本未准备好')
    result = dict(character_id=4, source='local_synthetic_speech', corrected_text=TEXT,
        sends='同一伙伴的当前性格、私人会话与允许的记忆、心情及场景；原音只做本地识别',
        model='qwen3.8-flash', max_requests=1, budget_yuan='1.20', new_model_requests=0, state='planned')
    if not args.execute:
        print(json.dumps(result, ensure_ascii=False)); return
    receipt = ROOT / 'real-execution.json'
    result.update(authorization_ref=args.authorization_ref, state='claimed', request_id=str(uuid4()))
    with receipt.open('x') as file:
        json.dump(result, file, ensure_ascii=False)
    from scripts import check_candidate_review as qa
    from app.core.database import engine
    from app.core.config import get_settings
    from app.services.voice import VoiceService
    from app.services import voice_reply
    from app.services.transcription import transcribe
    from app.living.life_live_planner import check_current_catalog
    from app.living.life_provider import BASE_URL, MODEL, RESERVE_MICRO
    from dotenv import dotenv_values
    qa.flow.generate = qa.flow.dotenv_values = qa.reject_generation
    values = dotenv_values(PROJECT / 'backend/.env')
    if values.get('MODEL_BASE_URL') != BASE_URL or not values.get('MODEL_API_KEY') or RESERVE_MICRO > 1_200_000:
        raise RuntimeError('本项目配置或预算不符合本轮范围，未调用')
    asyncio.run(check_current_catalog())
    live = get_settings().model_copy(update=dict(app_env='development', model_base_url=BASE_URL,
        model_api_key=values['MODEL_API_KEY'], chat_model=MODEL, voice_live_reply_enabled=True,
        model_max_retries=0, model_timeout_seconds=30, model_enable_thinking=False))
    voice_reply.get_settings = lambda: live
    original_client = voice_reply.ModelClient
    class OnceClient(original_client):
        def _post_chat_completions(self, payload, settings):
            if (result['new_model_requests'] or payload['model'] != MODEL or payload['max_tokens'] != 1024
                    or settings.model_base_url != BASE_URL or settings.model_max_retries != 0
                    or len(json.dumps(payload, ensure_ascii=False).encode()) > 32768):
                raise RuntimeError('请求超出本轮范围')
            result['new_model_requests'] = 1
            receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
            started = time.monotonic()
            try:
                return super()._post_chat_completions(payload, settings)
            finally:
                result['model_seconds'] = round(time.monotonic() - started, 3)
    voice_reply.ModelClient = OnceClient
    started = time.monotonic()
    try:
        data = (ROOT / 'input.wav').read_bytes()
        result['recognized_text'] = transcribe(data, live.voice_local_model_path)
        result['asr_seconds'] = round(time.monotonic() - started, 3)
        service = VoiceService(engine)
        result['round'] = service.send(row[0], 4, result['request_id'], TEXT, data, offline=False)
        result['receipt'] = service.receipts(row[0], 4, result['request_id'])
        result['state'] = result['round']['state']
    except Exception:
        result['state'] = 'failed'
    finally:
        result.update(elapsed_seconds=round(time.monotonic()-started, 3),
            reserved_micro=RESERVE_MICRO if result['new_model_requests'] else 0, actual_charge='unverified')
        receipt.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
