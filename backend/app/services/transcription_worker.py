"""Isolated optional faster-whisper worker, invoked with a complete local model."""
import json
from pathlib import Path
import sys


def main():
    from faster_whisper import WhisperModel
    from opencc import OpenCC
    model_path, recording, output = sys.argv[1:]
    model = WhisperModel(model_path, device='cpu', compute_type='int8',
        cpu_threads=2, num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(recording, language='zh', beam_size=1,
        temperature=0, condition_on_previous_text=False)
    text = ''
    for segment in segments:
        text += segment.text
        if len(text) > 2000:
            raise ValueError('Transcript too long')
    # language='zh' selects Chinese but does not constrain the writing system.
    text = OpenCC('t2s').convert(text)
    if len(text) > 2000:
        raise ValueError('Transcript too long')
    Path(output).write_text(json.dumps(text, ensure_ascii=False), encoding='utf-8')


if __name__ == '__main__':
    main()
