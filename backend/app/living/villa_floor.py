"""Free, owner-authorized floor commands and leased physical checkpoints.
No provider/timer work. All old commands/checkpoints remain in the journal.
"""
from __future__ import annotations
import copy
import hashlib
import json
import math
import time
from sqlalchemy import Column, Integer, String, Table, Text, insert, select, update
from app.living.store import metadata, LivingStore, _uuid
from app.living.gatherings import GatheringStore, fail

floors = Table('life_villa_floors', metadata,
    Column('scope', String(90), primary_key=True), Column('revision', Integer, nullable=False),
    Column('state_json', Text, nullable=False))
journal = Table('life_villa_floor_journal', metadata,
    Column('scope', String(90), primary_key=True), Column('request_id', String(36), primary_key=True),
    Column('owner_id', String(128), nullable=False), Column('digest', String(64), nullable=False),
    Column('result_json', Text, nullable=False), Column('at', Integer, nullable=False))
ACTIVITIES = ('observe', 'rest', 'sleep')
EMPTY = dict(version=1, active=None, states=[])
POSE_KEYS = {'x','y','z','yaw','tilt','scale','blend'}
STATE_KEYS = {'id','radius','activity','fromActivity','direction','phase','distance','pose','points','support','homePlan'}

def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)

def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()

def context_fingerprint(layout,actors):
    # Keep the original record format and hash contract for existing floor saves.
    return digest(dict(layout=layout,actors=[{k:a.get(k) for k in
        ('id','owner_id','activity','area','x','y','leisure','world')}
        for a in sorted(actors,key=lambda a:a['id'])]))

def physical_care_layout(layout):
    from app.living.rules import State
    value=State.model_validate(layout).model_dump()
    value.pop('last_write_at')
    for item in value['items'].values():
        for field in ('growth_seconds','cared_until','settled_at'):
            item.pop(field)
    return value

def finite(v):
    return type(v) in (int, float) and math.isfinite(v)

def pose(p):
    if not isinstance(p, dict) or set(p) != POSE_KEYS or not all(finite(v) for v in p.values()):
        fail('楼层坐标不正确', 'invalid_request')
    if not (-9 <= p['x'] <= 9 and -9 <= p['z'] <= 0 and 0 <= p['y'] <= 6
            and abs(p['yaw']) <= math.pi*20 and abs(p['tilt']) <= math.pi
            and .5 <= p['scale'] <= 1.5 and 0 <= p['blend'] <= 1):
        fail('楼层坐标超出范围', 'invalid_request')

def metric(a,b):
    return max(math.dist([a[k] for k in ('x','y','z')],[b[k] for k in ('x','y','z')]),abs(a['tilt']-b['tilt'])*.8,abs(a['blend']-b['blend'])*.8)

def length(points):
    return sum(metric(a,b) for a,b in zip(points,points[1:]))

def validate_checkpoint(cp):
    if not isinstance(cp,dict) or set(cp) != {'version','active','states'} or type(cp['version']) is not int or cp['version'] != 1 or not isinstance(cp['states'],list) or len(cp['states']) > 3:
        fail('楼层检查点不正确','invalid_request')
    ids=set(); slots=set(); running=[]
    for s in cp['states']:
        if not isinstance(s,dict) or set(s)!=STATE_KEYS or type(s['id']) is not int or s['id']<=0 or s['id'] in ids or s['activity'] not in ACTIVITIES or s['activity'] in slots:
            fail('楼层伙伴或位置重复','invalid_request')
        ids.add(s['id']);slots.add(s['activity'])
        if not finite(s['radius']) or not 0<s['radius']<=.98 or s['direction'] not in ('up','down','change') or s['phase'] not in ('queued','approach','walking','waiting','upper') or not finite(s['distance']) or s['distance']<0:
            fail('楼层进度不正确','invalid_request')
        plan=s['homePlan']
        if not isinstance(plan,dict) or set(plan)!= {'activity','points','support'} or plan['activity']!=s['activity']:
            fail('楼层目的地不正确','invalid_request')
        for points in (s['points'],plan['points']):
            if not isinstance(points,list) or not 2<=len(points)<=512: fail('楼层路线不正确','invalid_request')
            for p in points: pose(p)
        for support in (s['support'],plan['support']):
            if not isinstance(support,list) or len(support)>16 or any(not isinstance(v,str) or len(v)>120 or not v.startswith('villa-') for v in support):
                fail('楼层支撑物不正确','invalid_request')
        if s['direction']!='change':
            first=s['points'][0]
            if math.dist([first[k] for k in ('x','y','z')],[1.65,0,-1.42])>1e-6 or s['fromActivity'] is not None:
                fail('楼梯起点不正确','invalid_request')
        elif s['fromActivity'] not in ACTIVITIES: fail('原活动不正确','invalid_request')
        end=length(s['points'])
        if end>100 or s['distance']>end+1e-6: fail('楼层进度超出路线','invalid_request')
        pose(s['pose']);left=s['distance'];expected=s['points'][-1]
        for a,b in zip(s['points'],s['points'][1:]):
            span=metric(a,b)
            if left<=span+1e-8:
                t=min(1,max(0,left/span)) if span else 1
                expected={k:a[k]+(b[k]-a[k])*t for k in POSE_KEYS};break
            left-=span
        if any(abs(s['pose'][k]-expected[k])>1e-5 for k in POSE_KEYS-{'yaw'}): fail('位置与路线进度不一致','invalid_request')
        if s['phase']=='upper' and (abs(s['distance']-end)>1e-5 or s['direction']!='up'): fail('尚未到达二楼位置','invalid_request')
        if s['phase']=='approach' and (s['distance']!=0 or s['direction']!='up'): fail('楼梯入口进度不正确','invalid_request')
        if s['phase'] in ('approach','walking','waiting'): running.append(s['id'])
    if len(running)>1 or cp['active']!=(running[0] if running else None): fail('楼梯只能依次通行','invalid_request')
    return cp

def floor_busy(conn,kind,sid):
    row=conn.execute(select(floors.c.state_json).where(floors.c.scope==kind+':'+sid)).first()
    if not row:return False
    s=json.loads(row[0]);return bool(s['targets'] or s['commands'] or s['checkpoint']['states'])

def require_floor_idle(conn,kind,sid):
    if floor_busy(conn,kind,sid): fail('请先让二楼伙伴下楼，再更改布置或一楼活动','conflict')

def prepare_shared_parallel(conn,g,cmd):
    """Admit a narrow same-transaction change; never repair an old fingerprint."""
    action=cmd.get('action')
    care=action=='layout' and isinstance(cmd.get('command'),dict) and cmd['command'].get('action')=='care'
    if action not in ('activity','leisure','recall') and not care:
        return None
    row=conn.execute(select(floors).where(floors.c.scope=='shared:'+g['id'])).mappings().first()
    if not row:
        return None
    try:
        state=json.loads(row['state_json'])
        if not isinstance(state,dict) or not isinstance(state['targets'],dict) or not isinstance(state['commands'],list):
            raise ValueError()
        cp=state['checkpoint']
        if not isinstance(cp,dict) or not isinstance(cp.get('states'),list):
            raise ValueError()
        if not (state['targets'] or state['commands'] or cp['states']):
            return None
        if g['scene_type']!='home' or state['fingerprint']!=context_fingerprint(g['layout'],g['companions'].values()):
            fail('住处或伙伴已变化，旧楼层记录已保留，请核对','conflict')
        validate_checkpoint(cp)
        tracked=set()
        for cid,activity in state['targets'].items():
            if not isinstance(cid,str) or not cid.isascii() or not cid.isdigit() or str(int(cid))!=cid or int(cid)<=0 or activity is not None and activity not in ACTIVITIES:
                raise ValueError()
            tracked.add(int(cid))
        for pending in state['commands']:
            if not isinstance(pending,dict) or type(pending.get('id')) is not int or pending['id']<=0 or pending.get('activity') is not None and pending['activity'] not in ACTIVITIES:
                raise ValueError()
            tracked.add(pending['id'])
        tracked.update(p['id'] for p in cp['states'])
        if any(str(cid) not in g['companions'] for cid in tracked):
            raise ValueError()
        ids=[] if care else cmd.get('character_ids') if action=='activity' else [cmd.get('character_id')]
        if not isinstance(ids,list) or not care and (not ids or any(type(cid) is not int or cid<=0 for cid in ids) or len(set(ids))!=len(ids)):
            fail('请选择有效的在场伙伴','invalid_request')
        if tracked.intersection(ids):
            fail('请先让该伙伴下楼，再调整一楼活动或回家','conflict')
        return dict(scope=row['scope'],revision=row['revision'],raw=row['state_json'],state=copy.deepcopy(state),
            group=copy.deepcopy(g),ids=set(ids),action=action,care=care)
    except (ValueError,TypeError,KeyError,OverflowError):
        fail('楼层记录暂时无法核对，原进度已保留','conflict')

def finish_shared_parallel(conn,g,guard):
    """Rebind only context after verifying all protected data, on the original lock."""
    if guard is None:
        return
    previous=guard['group'];ids=guard['ids']
    # A care call can advance the existing common growth goal, but no other group settings.
    excluded={'events','companions','layout'} | ({'goal'} if guard['care'] else set())
    if {k:v for k,v in previous.items() if k not in excluded}!={k:v for k,v in g.items() if k not in excluded}:
        fail('共同住处状态已变化，原楼层进度已保留','conflict')
    old_actors=previous['companions'];new_actors=g['companions']
    if {k:v for k,v in old_actors.items() if int(k) not in ids}!={k:v for k,v in new_actors.items() if int(k) not in ids}:
        fail('其他伙伴状态已变化，原楼层进度已保留','conflict')
    for cid in ids:
        old=old_actors.get(str(cid));new=new_actors.get(str(cid))
        if guard['action']=='recall':
            if new is not None:fail('伙伴回家状态无法核对','conflict')
        else:
            allowed={'activity','area','area_origin','x','y','leisure'} if guard['action']=='activity' else {'leisure'}
            if old is None or new is None or {k:v for k,v in old.items() if k not in allowed}!={k:v for k,v in new.items() if k not in allowed}:
                fail('伙伴身份状态已变化，原楼层进度已保留','conflict')
    if guard['care']:
        try:
            same_physical_layout=physical_care_layout(previous['layout'])==physical_care_layout(g['layout'])
        except (ValueError,TypeError,KeyError):
            same_physical_layout=False
        if not same_physical_layout:
            fail('照料不能改变二楼行程中的物理布置','conflict')
    elif previous['layout']!=g['layout']:
        fail('布置已变化，原楼层进度已保留','conflict')
    state=guard['state'];state['fingerprint']=context_fingerprint(g['layout'],new_actors.values())
    changed=conn.execute(update(floors).where(floors.c.scope==guard['scope'],floors.c.revision==guard['revision'],
        floors.c.state_json==guard['raw']).values(state_json=encoded(state)))
    if changed.rowcount!=1:
        fail('楼层进度已更新，请先核对','conflict')

class VillaFloorStore(GatheringStore):
    def __init__(self,engine,clock=None):
        super().__init__(engine,clock or time.time)

    def context(self,conn,uid,kind,sid):
        _uuid(sid)
        if kind=='shared':
            g,_=self.load(conn,sid);self.member(g,uid)
            if g['scene_type']!='home':fail('当前住处没有二楼')
            actors=list(g['companions'].values());layout=g['layout']
        elif kind=='private':
            row=LivingStore._row(conn,uid,sid)
            if row['mode']!='private' or row['scene_type']!='home':fail('当前住处没有二楼')
            from app.models.models import Character
            from app.living.gatherings import visits
            cid=int(row['companion_id']);ch=conn.execute(select(Character.__table__).where(Character.id==cid,Character.owner_id==uid)).mappings().first()
            if not ch or ch['status']!='ready' or conn.execute(select(visits.c.character_id).where(visits.c.character_id==cid)).first() or ch['current_space_id'] not in (None,sid):fail('伙伴不在自己的住处','not_found')
            layout=json.loads(row['state_json']);actors=[dict(id=cid,owner_id=uid,world=layout.get('world'))]
        else:fail('住处类型不正确','invalid_request')
        return actors,context_fingerprint(layout,actors)

    @staticmethod
    def blank(fingerprint):
        return dict(fingerprint=fingerprint,seq=0,applied=0,commands=[],targets={},checkpoint=copy.deepcopy(EMPTY),lease=None,lease_until=0,progress_at=0)

    def load_floor(self,conn,scope,fingerprint):
        row=conn.execute(select(floors).where(floors.c.scope==scope)).mappings().first()
        if not row:return self.blank(fingerprint),0
        s=json.loads(row['state_json'])
        if s['fingerprint']!=fingerprint:
            if s['targets'] or s['checkpoint']['states']:fail('住处或伙伴已变化，旧楼层记录已保留，请核对','conflict')
            s['fingerprint']=fingerprint;s['checkpoint']=copy.deepcopy(EMPTY)
        return s,row['revision']

    def public(self,s,revision,now,viewer=None,uid=None):
        return dict(revision=revision,seq=s['seq'],applied=s['applied'],commands=s['commands'],checkpoint=s['checkpoint'],
            fingerprint=s['fingerprint'],driver=bool(viewer and s['lease']==[uid,viewer] and s['lease_until']>now),
            lease_until=s['lease_until'],server_time=now)

    def read(self,uid,kind,sid,viewer=None):
        with self.engine.connect() as conn:
            _,fingerprint=self.context(conn,uid,kind,sid);s,rev=self.load_floor(conn,kind+':'+sid,fingerprint)
            return self.public(s,rev,self.clock(),viewer,uid)

    def mutate(self,uid,kind,sid,rid,revision,action,**payload):
        _uuid(rid);scope=kind+':'+sid;body=dict(revision=revision,action=action,**payload)
        try:
            if len(encoded(body))>400000:fail('楼层检查点过大','invalid_request')
            mark=digest(body)
        except (ValueError,TypeError):fail('楼层参数不正确','invalid_request')
        with self.transaction() as conn:
            actors,fingerprint=self.context(conn,uid,kind,sid)
            old=conn.execute(select(journal).where(journal.c.scope==scope,journal.c.request_id==rid)).mappings().first()
            if old:
                if old['owner_id']!=uid or old['digest']!=mark:fail('同一请求不能改变内容','conflict')
                return json.loads(old['result_json'])
            s,rev=self.load_floor(conn,scope,fingerprint);now=self.clock()
            if type(revision) is not int or revision!=rev:fail('楼层进度已更新，请先核对','conflict')
            viewer=payload.get('viewer')
            if action=='command':
                cid=payload.get('actor_id');activity=payload.get('activity')
                if type(cid) is not int or not any(a['id']==cid and a['owner_id']==uid for a in actors):fail('只能安排自己的在场伙伴','not_found')
                if activity is not None and activity not in ACTIVITIES:fail('二楼活动不正确','invalid_request')
                if s['commands']:fail('上一项安排正在同步，请稍后再操作','conflict')
                if activity is None and str(cid) not in s['targets']:fail('伙伴没有上楼安排')
                if activity is not None and (any(k!=str(cid) and v==activity for k,v in s['targets'].items()) or any(p['id']!=cid and (p['activity']==activity or (p['direction']=='change' and p['fromActivity']==activity)) for p in s['checkpoint']['states'])):fail('这个二楼位置已被占用','conflict')
                actor=next(a for a in actors if a['id']==cid)
                if actor.get('leisure') or (actor.get('world') or {}).get('leisure'):fail('请先结束当前休闲活动')
                current=next((p for p in s['checkpoint']['states'] if p['id']==cid),None)
                if current and activity is not None and current['activity']!=activity and current['phase']!='upper':fail('请等伙伴到达后再换活动','conflict')
                if current and activity is None and current['direction']=='change':fail('请等伙伴走到新位置后再下楼','conflict')
                s['seq']+=1;s['targets'][str(cid)]=activity;s['commands']=[dict(seq=s['seq'],id=cid,activity=activity)]
            elif action=='claim':
                _uuid(viewer)
                if s['lease_until']>now and s['lease']!=[uid,viewer]:fail('另一个页面正在同步楼层','conflict')
                if s['lease']!=[uid,viewer] or s['lease_until']<=now:s['progress_at']=now
                s['lease']=[uid,viewer];s['lease_until']=now+6
            elif action=='checkpoint':
                if s['lease']!=[uid,viewer] or s['lease_until']<=now:fail('楼层同步已暂停，请重新核对','conflict')
                cp=validate_checkpoint(payload.get('checkpoint'));applied=payload.get('applied')
                if type(applied) is not int or applied!=s['seq']:fail('必须先核对最新活动命令','conflict')
                present={str(p['id']):p for p in cp['states']}
                if any(str(p['id']) not in s['targets'] for p in cp['states']):fail('检查点包含未授权的伙伴','invalid_request')
                for cid,target in s['targets'].items():
                    p=present.get(cid)
                    if target is not None and (not p or p['activity']!=target or p['direction']=='down'):fail('检查点改变了主人安排','invalid_request')
                    if target is None and p and p['direction']!='down':fail('下楼安排尚未执行','invalid_request')
                old_states={p['id']:p for p in s['checkpoint']['states']};command_ids={p['id'] for p in s['commands']}
                travelled=0
                for p in cp['states']:
                    prev=old_states.get(p['id'])
                    if not prev:travelled+=p['distance']
                    elif p['id'] not in command_ids:
                        if prev['points']!=p['points'] or prev['homePlan']!=p['homePlan']:
                            if not (prev['direction']=='change' and p['phase']=='upper' and prev['homePlan']==p['homePlan']):fail('已有路线不能被替换','invalid_request')
                            travelled+=max(0,length(prev['points'])-prev['distance'])
                        else:travelled+=abs(p['distance']-prev['distance'])
                    elif p['direction']=='change':travelled+=p['distance']
                    else:travelled+=abs(p['distance']-prev['distance'])
                for cid,prev in old_states.items():
                    if str(cid) not in present:travelled+=prev['distance']
                allowance=min(6,max(0,now-s['progress_at']))*.72+.15
                if travelled>allowance:fail('楼层移动快于允许速度，请核对已保存进度','conflict')
                s['checkpoint']=copy.deepcopy(cp);s['applied']=applied;s['commands']=[]
                s['targets']={k:v for k,v in s['targets'].items() if v is not None or k in present}
                s['progress_at']=now;s['lease_until']=now+6
            else:fail('楼层操作不正确','invalid_request')
            rev+=1;result=self.public(s,rev,now,viewer,uid)
            exists=conn.execute(select(floors.c.scope).where(floors.c.scope==scope)).first()
            values=dict(revision=rev,state_json=encoded(s))
            if exists:conn.execute(update(floors).where(floors.c.scope==scope).values(**values))
            else:conn.execute(insert(floors).values(scope=scope,**values))
            conn.execute(insert(journal).values(scope=scope,request_id=rid,owner_id=uid,digest=mark,result_json=encoded(result),at=int(now)))
            return result
