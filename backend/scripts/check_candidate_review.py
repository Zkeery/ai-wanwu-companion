"""Isolated, no-generation browser QA using the existing real apple candidate.

The review is a UI workflow exercise, not a new human quality acceptance.
Run `python -m scripts.check_candidate_review seed|serve|serve-life|status` in backend/.
serve-life exposes saved real-life state on the same review database/port.
serve-companions installs scoped life/dialogue clients without issuing budgets.
serve-shared-automatic additionally exposes the separately granted shared worker.
Other modes supply no life provider key; new paid execution requires a separate grant.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT/'.runtime/c160-review'
ROOT.mkdir(parents=True, exist_ok=True)
LIFE_REVIEW = __name__ == '__main__' and sys.argv[1:] in (['serve-life'], ['serve-voice'], ['serve-companions'], ['serve-shared-automatic'])
os.environ.update(DATABASE_URL=f'sqlite:///{ROOT / "check.db"}', UPLOAD_DIR=str(ROOT/'uploads'),
    WALK_WORKFLOW_ROOT=str(ROOT/'ledger'), APP_ENV='test', MODEL_API_KEY='', MODEL_BASE_URL='',
    IMAGE_BASE_URL='', MOTION_GENERATION_ENABLED='false', SCENE_AGENT_ENABLED='false', LIFE_SIMULATION_ENABLED='false',
    LIFE_RUNTIME_PREVIEW_ENABLED='true' if LIFE_REVIEW else 'false',
    LIFE_LIVE_PLANNER_PREVIEW_ENABLED='true' if LIFE_REVIEW else 'false', VOICE_LIVE_REPLY_ENABLED='false')

# Reuse this project's already installed offline ASR in the fixed review environment.
# No runtime download and no change to the separate paid-reply switch.
local_voice_model = PROJECT / '.runtime/models/faster-whisper-small'
if all((local_voice_model / name).is_file() for name in ('model.bin', 'config.json', 'tokenizer.json')):
    os.environ['VOICE_LOCAL_MODEL_PATH'] = str(local_voice_model)

from app.main import app  # noqa: E402,F401
from app.core.database import SessionLocal  # noqa: E402
from app.models.models import User, Photo, Object, Character  # noqa: E402
from app.services import character_walk_workflow as flow  # noqa: E402

OWNER = 'c160-browser-replay'
APPROVAL = 'b83b87f6cd1ef43e95c445aaf4fa7ed5ae49e4bcf73c06ba036649f489ec539c'


def reject_generation(*args, **kwargs):
    raise RuntimeError('No generation or key access in this browser replay')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=['seed', 'serve', 'serve-life', 'serve-voice', 'serve-companions', 'serve-shared-automatic', 'status', 'seed-pending', 'pending-status'])
    phase = parser.parse_args().phase
    flow.generate = flow.dotenv_values = reject_generation
    if phase in {'serve', 'serve-life', 'serve-voice', 'serve-companions', 'serve-shared-automatic'}:
        if phase in {'serve-voice', 'serve-companions', 'serve-shared-automatic'}:
            from app.api.voice import service
            from app.services.voice_sessions import project_reply
            from app.services.cloud_speech import QwenSpeech
            service.live_reply = project_reply
            service.live_speech = QwenSpeech(service.engine, service.clock)
        if phase in {'serve-companions', 'serve-shared-automatic'}:
            from scripts.review_life_bridge import install
            install(shared_automatic=phase == 'serve-shared-automatic')
        import uvicorn
        uvicorn.run(app, host='127.0.0.1', port=8048)
        return
    if phase in {'seed', 'seed-pending'}:
        source = PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg'
        if hashlib.sha256(source.read_bytes()).hexdigest() != '7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c':
            raise RuntimeError('Archived source changed')
        upload = ROOT/'uploads'; upload.mkdir(exist_ok=True)
        filename = 'pending-source.jpg' if phase == 'seed-pending' else 'source.jpg'
        target = upload/filename
        if not target.exists():
            shutil.copyfile(source, target)
        with SessionLocal() as db:
            if db.get(User, OWNER) is None:
                db.add(User(id=OWNER, phone='13900000160')); db.flush()
            ch = db.query(Character).filter_by(owner_id=OWNER, image_path=filename).one_or_none()
            if ch is None:
                photo = Photo(filename=filename, status='done', owner_id=OWNER)
                db.add(photo); db.flush()
                obj = Object(photo_id=photo.id, label='归档苹果界面回放'); db.add(obj); db.flush()
                ch = Character(object_id=obj.id, owner_id=OWNER, image_path=filename, status='ready',
                    name='苹果任务体验' if phase == 'seed-pending' else '苹果动作体验',
                    persona='隔离流程样例', opening_line='看看我的动作')
                db.add(ch); db.flush()
            cid = ch.id; db.commit()
        if phase == 'seed-pending':
            # Existing-character registration exercise. No candidate import,
            # generation, grant or preparation request is created by this seed.
            (ROOT/'pending-character.json').write_text(json.dumps({'character_id': cid}))
            print(json.dumps({'character_id': cid, 'new_model_requests': 0}))
            return
        legacy = PROJECT/'.runtime/c155-aihubmix-walk'
        result = flow.import_candidate(cid, OWNER, legacy/f'approval-{APPROVAL}.json', legacy/f'walk-{APPROVAL}.png')
        (ROOT/'job.json').write_text(json.dumps({'job_id': result['job_id'], 'character_id': cid}))
    elif phase == 'pending-status':
        from app.services.motion_generation import status
        cid = json.loads((ROOT/'pending-character.json').read_text())['character_id']
        print(json.dumps({'character_id': cid, **status(cid, OWNER)}))
        return
    else:
        job = json.loads((ROOT/'job.json').read_text())
        result = flow.status(job['job_id'], job['character_id'], OWNER)
    print(json.dumps({k: result[k] for k in ['job_id', 'character_id', 'state', 'generation_requests']}))


if __name__ == '__main__':
    main()
