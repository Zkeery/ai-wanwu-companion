import { describe, expect, it } from 'vitest';
import { parseSavedLeisure, type Gathering } from '../lib/gatherings';
import { persistentLivingScope, planLivingLeisure } from '../lib/living-persistent-world';
import { getHomePresenceActor } from '../lib/living-home-presence';
import { createHomeLeisureController, type HomeLeisureSeat } from '../lib/living-home-leisure';

const gathering = (): Gathering => ({ id:'real-space',me:'owner-a',title:'家园',scene_type:'home',revision:1,closed:false,is_manager:true,invitation:null,
  dialogue_enabled:false,members:[{id:'owner-a',name:'A',manager:true},{id:'owner-b',name:'B',manager:false}],
  companions:[{id:1,name:'甲',owner_id:'owner-a',activity:'observe',x:.2,y:.5,dialogue_allowed:false},{id:2,name:'乙',owner_id:'owner-b',activity:'observe',x:.8,y:.5,dialogue_allowed:false}],
  items:[],votes:[],events:[],story_enabled:false,stories:[],goal:null,season:null });
const seat = (id:string,physicalId=id): HomeLeisureSeat => ({id,physicalId,station:'tea',area:'outdoor',x:0,y:.5,z:1,yaw:0});

describe('saved living presentation boundary',()=>{
  it('requires explicit opt-in and an authorized member snapshot',()=>{
    const g=gathering();expect(persistentLivingScope(g)).toBe(false);expect(persistentLivingScope(g,true)).toBe(true);
    expect(persistentLivingScope({...g,closed:true},true)).toBe(false);
    expect(persistentLivingScope({...g,me:'outsider'},true)).toBe(false);
    expect(persistentLivingScope({...g,members:g.members.slice(0,1)},true)).toBe(false);
  });
  it('does not relabel real identities as synthetic',()=>{
    const scope={groupId:'real-space',ownerId:'owner-a',synthetic:false,optIn:true};
    const input={scope,actors:[{id:1,ownerId:'owner-a'}],seats:[seat('tea-1')]};
    expect(createHomeLeisureController(input).assign({actorId:1,activity:'tea'}).ok).toBe(false);
    const live=createHomeLeisureController({...input,scope:{...scope,persistent:true}});
    expect(live.assign({actorId:1,activity:'tea'}).ok).toBe(true);
    expect(live.getSnapshot().scope.synthetic).toBe(false);
    live.reconcile({...input,scope:{...scope,persistent:false}});expect(live.getSnapshot().assignments).toEqual([]);
  });
  it('reads physical presence only in the matching explicit world scope',()=>{
    const snap={groupId:'real-space',ownerId:'owner-a',actors:[{id:1,area:'indoor' as const,active:false,phase:'idle' as const,targetArea:'indoor' as const}]};
    const scope={groupId:'real-space',ownerId:'owner-a',sceneType:'forest',enabled:true,localNaturalWorld:true,actorIds:[1]};
    expect(getHomePresenceActor(snap,scope,1)).toBeNull();
    expect(getHomePresenceActor(snap,{...scope,persistentWorld:true},1)?.area).toBe('indoor');
    expect(getHomePresenceActor(snap,{...scope,persistentWorld:true,ownerId:'owner-b'},1)).toBeNull();
  });
});
describe('owner-only free activity intents',()=>{
  it('never selects another owner, including a four-seat activity',()=>{
    const g=gathering();const slots=[seat('tea-1')];
    expect(planLivingLeisure(g,slots,'tea',2)).toBeNull();
    expect(planLivingLeisure(g,slots,'tea',999)).toBeNull();
    expect(planLivingLeisure(g,slots,'tea')).toEqual({activity:'tea',actorId:1,seatId:'tea-1'});
    const tiles=[0,1,2,3].map(i=>({...seat('mahjong-'+i),station:'mahjong' as const}));
    expect(planLivingLeisure(g,tiles,'mahjong')).toEqual({activity:'mahjong',actorId:1,seatId:'mahjong-0'});
  });
  it('respects physical seat aliases, reservations and disabled geometry',()=>{
    const g=gathering();g.companions[1].leisure={activity:'bench',seat_id:'bench-old-0',station_version:1};
    const slots=[seat('tea-0','same-bench'),{...seat('bench-old-0','same-bench'),station:'bench' as const},{...seat('tea-1'),x:2}];
    expect(planLivingLeisure(g,slots,'tea',1)?.seatId).toBe('tea-1');
    expect(planLivingLeisure(g,slots.map(s=>({...s,available:false})),'tea',1)).toBeNull();
    expect(planLivingLeisure(g,[{...seat('tea-1'),reservedByActorId:2}],'tea',1)).toBeNull();
  });
  it('rejects different seat IDs whose occupied physical positions are too close',()=>{
    const g=gathering();g.companions[1].leisure={activity:'bench',seat_id:'bench-other-0',station_version:1};
    const occupied={...seat('bench-other-0'),station:'bench' as const};
    expect(planLivingLeisure(g,[occupied,{...seat('tea-1'),x:1.24}],'tea',1)).toBeNull();
    expect(planLivingLeisure(g,[occupied,{...seat('tea-1'),x:1.25}],'tea',1)?.seatId).toBe('tea-1');
  });
  it('retains the existing seat and does not mutate the snapshot',()=>{
    const g=gathering();g.companions[0].leisure={activity:'tea',seat_id:'tea-1',station_version:1};
    const before=JSON.stringify(g);
    expect(planLivingLeisure(g,[seat('tea-0'),seat('tea-1')],'tea',1)?.seatId).toBe('tea-1');
    expect(planLivingLeisure(g,[],null,1)).toEqual({activity:null,actorId:1});
    expect(planLivingLeisure(g,[],null,2)).toBeNull();expect(JSON.stringify(g)).toBe(before);
  });
  it('keeps television and mahjong out of natural scene contracts',()=>{
    const g={...gathering(),scene_type:'forest'};
    expect(planLivingLeisure(g,[{...seat('television-0'),station:'television'}],'television',1)).toBeNull();
    expect(planLivingLeisure(g,[seat('natural-forest-tea-0')],'tea',1)?.actorId).toBe(1);
  });
  it('rejects unsupported station versions and unknown activities',()=>{
    expect(parseSavedLeisure({activity:'tea',seat_id:'tea-1',station_version:1})).toEqual({activity:'tea',seat_id:'tea-1',station_version:1});
    expect(()=>parseSavedLeisure({activity:'tea',seat_id:'tea-1',station_version:2})).toThrow();
    expect(()=>parseSavedLeisure({activity:'ai-chat',seat_id:'tea-1',station_version:1})).toThrow();
    expect(()=>parseSavedLeisure({activity:'tea',seat_id:'',station_version:1})).toThrow();
  });
});
