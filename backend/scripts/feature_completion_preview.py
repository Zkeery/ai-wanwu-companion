"""Isolated synthetic full-feature QA; no production data or external network."""
from pathlib import Path
import os,json,socket,sys
PROJECT=Path(__file__).resolve().parents[2]
ROOT=PROJECT/'.runtime/feature-completion-20261019/qa'
ROOT.mkdir(parents=True,exist_ok=True)
os.environ.update(APP_ENV='test',AUTH_MODE='sms',DATABASE_URL='sqlite:///'+str(ROOT/'app.db'),UPLOAD_DIR=str(ROOT/'uploads'),MODEL_API_KEY='',MODEL_BASE_URL='',IMAGE_BASE_URL='',DEV_AUTH_TOKEN='',LEGACY_CLAIM_USER_ID='',DEV_SMS_FIXED_CODE='123456',SMS_LIVE_ENABLED='false',GENERATION_QUOTA_ENABLED='true',SCENE_AGENT_ENABLED='false',LIFE_RUNTIME_ENABLED='false',LIFE_RUNTIME_PREVIEW_ENABLED='true',LIFE_SIMULATION_ENABLED='false',LIFE_LIVE_PLANNER_PREVIEW_ENABLED='false',GATHERING_DIALOGUE_ENABLED='false',GATHERING_DIALOGUE_AUTOMATIC_ENABLED='false',VOICE_LIVE_REPLY_ENABLED='false',MOTION_GENERATION_ENABLED='false',VOICE_LOCAL_MODEL_PATH='')
original_connect=socket.socket.connect
def guarded_connect(self,address):
 if isinstance(address,tuple) and address[0] not in ('127.0.0.1','::1','localhost'):
  with (ROOT/'blocked-network.jsonl').open('a') as log: log.write(json.dumps({'blocked':True,'kind':'external_socket'})+'\n')
  raise RuntimeError('QA_EXTERNAL_NETWORK_FORBIDDEN')
 return original_connect(self,address)
socket.socket.connect=guarded_connect
from app.main import app
from app.core.database import SessionLocal
from app.models.models import User,Photo,Object,Character
from app.services.model_client import ModelClient
rows=[]
with SessionLocal() as db:
 for uid,phone,names in [('feature-qa-owner','13900001901',['离线杯子','离线小叶']),('feature-qa-friend','13900001902',['离线松果','离线石头'])]:
  user=db.get(User,uid)
  if not user: db.add(User(id=uid,phone=phone));db.flush()
  for name in names:
   ch=db.query(Character).filter_by(owner_id=uid,name=name).first()
   if not ch:
    photo=Photo(owner_id=uid,filename='synthetic-only.png',status='done');db.add(photo);db.flush()
    obj=Object(photo_id=photo.id,label=name);db.add(obj);db.flush()
    ch=Character(object_id=obj.id,owner_id=uid,name=name,persona='明确的离线合成测试伙伴',opening_line='这是免费流程验证样例。',status='ready',image_path=ModelClient()._mock_image(name));db.add(ch);db.flush()
   rows.append({'owner':uid,'id':ch.id,'name':name})
 db.commit()
(ROOT/'fixture-manifest.json').write_text(json.dumps({'synthetic_only':True,'provider_requests':0,'characters':rows}))
if __name__=='__main__':
 import uvicorn
 uvicorn.run(app,host='127.0.0.1',port=8061,access_log=False)
