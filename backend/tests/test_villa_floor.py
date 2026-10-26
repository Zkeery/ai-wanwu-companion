import copy
import json
from uuid import uuid4
import pytest
from sqlalchemy import select
from app.core.database import engine
from app.living.rules import LivingError
from app.living.villa_floor import VillaFloorStore, floors, journal
from tests.auth_helpers import TEST_USER_ID as UID
from tests.test_gatherings import create, command, member
from tests.test_gathering_activity_areas import add_character, raw_group
from app.living.gatherings import GatheringStore
import app.living.gathering_mahjong  # register tables before the isolated fixture

@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setattr('socket.socket.connect',lambda *_:pytest.fail('network forbidden'))

@pytest.fixture
def floor(ready_character_id):
    clock=[1800000000.0];gstore=GatheringStore(engine,lambda:int(clock[0]));g=command(gstore,create(gstore),'visit',character_id=ready_character_id)
    fs=VillaFloorStore(engine,lambda:clock[0]);return fs,gstore,g,ready_character_id,clock

def write(fs,g,s,action,uid=UID,**payload):
    return fs.mutate(uid,'shared',g['id'],str(uuid4()),s['revision'],action,**payload)

def pose(x=1.65,y=0,z=-1.42):return dict(x=x,y=y,z=z,yaw=0,tilt=0,scale=1,blend=0)
def checkpoint(cid,activity='sleep',distance=0,phase='walking'):
    points=[pose(),pose(y=3.496,z=-7.15)]
    length=((3.496)**2+(-7.15+1.42)**2)**.5;t=distance/length;p=pose(y=3.496*t,z=-1.42+(-7.15+1.42)*t)
    state=dict(id=cid,radius=.8,activity=activity,fromActivity=None,direction='up',phase=phase,distance=distance,pose=p,points=points,support=[],homePlan=dict(activity=activity,points=points,support=[]))
    return dict(version=1,active=cid,states=[state])

def prepare(floor):
    fs,gs,g,cid,clock=floor;s=fs.read(UID,'shared',g['id']);s=write(fs,g,s,'command',actor_id=cid,activity='sleep');viewer=str(uuid4());s=write(fs,g,s,'claim',viewer=viewer);return s,viewer

def test_checkpoint_restart_and_no_original_mutation(floor):
    fs,gs,g,cid,clock=floor;s,v=prepare(floor);before=raw_group(g['id']);clock[0]+=1
    cp=checkpoint(cid,distance=.5);s=write(fs,g,s,'checkpoint',viewer=v,applied=1,checkpoint=cp)
    assert VillaFloorStore(engine,lambda:clock[0]).read(UID,'shared',g['id'])['checkpoint']==cp
    assert raw_group(g['id'])==before
    assert engine.connect().execute(select(journal)).fetchall()

def test_other_owner_cannot_command_and_outsider_cannot_read(floor):
    fs,gs,g,cid,clock=floor;g=member(gs,g,'other');s=fs.read('other','shared',g['id'])
    with pytest.raises(LivingError):write(fs,g,s,'command',uid='other',actor_id=cid,activity='sleep')
    with pytest.raises(LivingError):fs.read('outsider','shared',g['id'])

def test_same_bed_and_stale_commands_rejected(floor):
    fs,gs,g,cid,clock=floor;g=member(gs,g,'other');other=add_character('other','其他伙伴');g=command(gs,g,'visit',uid='other',character_id=other)
    s,v=prepare((fs,gs,g,cid,clock));clock[0]+=1;s=write(fs,g,s,'checkpoint',viewer=v,applied=1,checkpoint=checkpoint(cid))
    with pytest.raises(LivingError,match='占用'):write(fs,g,s,'command',uid='other',actor_id=other,activity='sleep')
    good=write(fs,g,s,'command',uid='other',actor_id=other,activity='rest')
    with pytest.raises(LivingError,match='更新'):write(fs,g,s,'command',uid='other',actor_id=other,activity='observe')
    assert good['commands'][0]['id']==other

def test_lease_exclusive_expiry_and_replay(floor):
    fs,gs,g,cid,clock=floor;s,v=prepare(floor)
    with pytest.raises(LivingError,match='另一个'):write(fs,g,s,'claim',viewer=str(uuid4()))
    clock[0]+=7
    with pytest.raises(LivingError,match='暂停'):write(fs,g,s,'checkpoint',viewer=v,applied=1,checkpoint=checkpoint(cid))
    rid=str(uuid4());other=str(uuid4());s2=fs.mutate(UID,'shared',g['id'],rid,s['revision'],'claim',viewer=other)
    assert fs.mutate(UID,'shared',g['id'],rid,s['revision'],'claim',viewer=other)==s2
    with pytest.raises(LivingError,match='同一'):fs.mutate(UID,'shared',g['id'],rid,s['revision'],'claim',viewer=v)

@pytest.mark.parametrize('bad',['foreign','target','speed','nan','pose','duplicate','active'])
def test_invalid_checkpoint_keeps_previous_record(floor,bad):
    fs,gs,g,cid,clock=floor;s,v=prepare(floor);clock[0]+=.5;cp=checkpoint(cid,distance=.1)
    if bad=='foreign':cp['states'][0]['id']=999;cp['active']=999
    if bad=='target':cp['states'][0]['activity']='rest';cp['states'][0]['homePlan']['activity']='rest'
    if bad=='speed':cp=checkpoint(cid,distance=5)
    if bad=='nan':cp['states'][0]['pose']['x']=float('nan')
    if bad=='pose':cp['states'][0]['pose']['y']=4
    if bad=='duplicate':cp['states'].append(copy.deepcopy(cp['states'][0]))
    if bad=='active':cp['active']=None
    before=fs.read(UID,'shared',g['id'])
    with pytest.raises(LivingError):write(fs,g,s,'checkpoint',viewer=v,applied=1,checkpoint=cp)
    assert fs.read(UID,'shared',g['id'])==before

def test_floor_occupied_blocks_layout_and_original_activity(floor):
    fs,gs,g,cid,clock=floor;s,v=prepare(floor)
    with pytest.raises(LivingError,match='下楼'):command(gs,g,'activity',character_ids=[cid],activity='walk')
    with pytest.raises(LivingError,match='下楼'):command(gs,g,'recall',character_id=cid)
    assert gs.read(UID,g['id'])==g

def test_cancel_queued_retains_journal_and_unblocks(floor):
    fs,gs,g,cid,clock=floor;s,v=prepare(floor);clock[0]+=1;s=write(fs,g,s,'checkpoint',viewer=v,applied=1,checkpoint=checkpoint(cid,phase='approach'))
    s=write(fs,g,s,'command',actor_id=cid,activity=None);s=write(fs,g,s,'checkpoint',viewer=v,applied=2,checkpoint=dict(version=1,active=None,states=[]))
    assert not s['checkpoint']['states'];assert command(gs,g,'activity',character_ids=[cid],activity='walk')
    with engine.connect() as conn:assert len(conn.execute(select(journal)).all())==5

def test_private_floor_requires_owner_and_resident(ready_character_id):
    from app.living.store import LivingStore
    store=LivingStore(engine,lambda:1800000000);home=store.create_space(UID,str(uuid4()),'home','private',str(ready_character_id));fs=VillaFloorStore(engine)
    assert fs.read(UID,'private',home['id'])['revision']==0
    with pytest.raises(LivingError):fs.read('other','private',home['id'])
    gstore=GatheringStore(engine);g=command(gstore,create(gstore),'visit',character_id=ready_character_id)
    with pytest.raises(LivingError):fs.read(UID,'private',home['id'])

def test_http_schema_auth_no_cache(client,anon,ready_character_id):
    gs=GatheringStore(engine);g=command(gs,create(gs),'visit',character_id=ready_character_id);url='/api/v1/living/floors/shared/'+g['id']
    assert anon.get(url).status_code==401
    r=client.get(url);assert r.status_code==200 and r.headers['cache-control']=='private, no-store'
    bad=client.post(url,json=dict(request_id=str(uuid4()),expected_revision=0,action='claim',viewer=str(uuid4()),activity='sleep'));assert bad.status_code==422


def test_returning_actor_keeps_slot_reserved(floor):
    fs,gs,g,cid,clock=floor;g=member(gs,g,'other');other=add_character('other','其他伙伴');g=command(gs,g,'visit',uid='other',character_id=other)
    s,v=prepare((fs,gs,g,cid,clock));clock[0]+=1;s=write(fs,g,s,'checkpoint',viewer=v,applied=1,checkpoint=checkpoint(cid,distance=.3))
    s=write(fs,g,s,'command',actor_id=cid,activity=None);cp=checkpoint(cid,distance=.3);cp['states'][0]['direction']='down'
    s=write(fs,g,s,'checkpoint',viewer=v,applied=2,checkpoint=cp)
    with pytest.raises(LivingError,match='占用'):write(fs,g,s,'command',uid='other',actor_id=other,activity='sleep')
