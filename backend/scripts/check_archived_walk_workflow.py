"""Zero-network replay of archived real pixels in a dedicated disposable QA DB.

Review here is a workflow exercise reusing C1.57's isolated preview, not a new
human acceptance of animation quality. Never touches the 8020/8047 databases.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil

PROJECT = Path(__file__).resolve().parents[2]
ROOT = PROJECT / '.runtime/c159-walk-workflow'
ROOT.mkdir(parents=True, exist_ok=True)
os.environ.update(DATABASE_URL=f'sqlite:///{ROOT / "check.db"}', UPLOAD_DIR=str(ROOT/'uploads'),
                  APP_ENV='test', MODEL_API_KEY='', MODEL_BASE_URL='', IMAGE_BASE_URL='',
                  SCENE_AGENT_ENABLED='false', LIFE_SIMULATION_ENABLED='false',
                  LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false', VOICE_LIVE_REPLY_ENABLED='false')

from app.main import app  # noqa: E402,F401 - initialize only the dedicated schema
from app.core.database import SessionLocal  # noqa: E402
from app.models.models import User, Photo, Object, Character  # noqa: E402
from app.services import character_walk_workflow as flow  # noqa: E402
from app.services.motion_preparation import preparation_status, process_one  # noqa: E402

OWNER = 'c159-archived-replay'
SOURCE = PROJECT/'docs/PRD/版本/V1.2/验收证据/阶段7/R7.14古灵精怪免费体验/apple-9b.jpg'
LEGACY = PROJECT/'.runtime/c155-aihubmix-walk'
APPROVAL = 'b83b87f6cd1ef43e95c445aaf4fa7ed5ae49e4bcf73c06ba036649f489ec539c'
SOURCE_SHA = '7195f21cd80cefe8385308005f54acdabef54e12ac5e0c0254d2a7651445063c'
IMAGE_SHA = 'e2b1dae76783440aef7343d1054b4d7939c5dc6c0dda86d673088043a58301b1'


def reject_network(*args, **kwargs):
    raise RuntimeError('This replay must not read a key or call a provider')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase', choices=('import', 'review', 'consume', 'status'))
    phase = parser.parse_args().phase
    flow.generate = flow.dotenv_values = reject_network
    if hashlib.sha256(SOURCE.read_bytes()).hexdigest() != SOURCE_SHA:
        raise RuntimeError('Archived source changed')
    upload = ROOT/'uploads'; upload.mkdir(exist_ok=True)
    source = upload/'source.jpg'
    if not source.exists():
        shutil.copyfile(SOURCE, source)
    if hashlib.sha256(source.read_bytes()).hexdigest() != SOURCE_SHA:
        raise RuntimeError('Replay source changed')
    with SessionLocal() as db:
        if db.get(User, OWNER) is None:
            db.add(User(id=OWNER, phone='13900000159')); db.flush()
        ch = db.query(Character).filter_by(owner_id=OWNER, image_path='source.jpg').one_or_none()
        if ch is None:
            photo = Photo(filename='source.jpg', status='done', owner_id=OWNER)
            db.add(photo); db.flush()
            obj = Object(photo_id=photo.id, label='真实归档苹果的隔离流程回放')
            db.add(obj); db.flush()
            ch = Character(object_id=obj.id, owner_id=OWNER, image_path='source.jpg', status='ready',
                           name='归档流程回放', persona='流程验收样例', opening_line='归档素材')
            db.add(ch); db.flush()
        cid = ch.id
        db.commit()
    if phase == 'import':
        result = flow.import_candidate(cid, OWNER, LEGACY/f'approval-{APPROVAL}.json',
                                       LEGACY/f'walk-{APPROVAL}.png', root=ROOT/'ledger')
        (ROOT/'job.json').write_text(json.dumps({'job_id': result['job_id'], 'character_id': cid}))
    else:
        job = json.loads((ROOT/'job.json').read_text())
        if job['character_id'] != cid:
            raise RuntimeError('Replay identity changed')
        if phase == 'review':
            result = flow.review(job['job_id'], cid, OWNER, decision='accept', candidate_sha256=IMAGE_SHA,
                review_ref='c157-isolated-preview-replay-not-production-acceptance', root=ROOT/'ledger')
        else:
            if phase == 'consume':
                with SessionLocal() as db:
                    process_one(db)
            result = flow.status(job['job_id'], cid, OWNER, root=ROOT/'ledger')
    with SessionLocal() as db:
        result['preparation'] = preparation_status(db, cid, OWNER)
    print(json.dumps({'phase': phase, 'new_model_requests': 0, 'review_scope': 'isolated_workflow_replay', **result}))


if __name__ == '__main__':
    main()
