"""Static local ASR check. No .env, database, downloads, or model loading."""
import argparse
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.services.transcription_config import STATUS_MESSAGES, transcription_status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-path', default=os.environ.get('VOICE_LOCAL_MODEL_PATH', ''))
    args = parser.parse_args()
    status = transcription_status(args.model_path)
    print(json.dumps({'status': status, 'message': STATUS_MESSAGES[status]}, ensure_ascii=False))
    return 0 if status == 'configured' else 2


if __name__ == '__main__':
    sys.exit(main())
