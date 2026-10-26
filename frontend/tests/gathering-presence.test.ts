import { expect, it } from 'vitest';
import { parseGathering } from '@/lib/gatherings';
import { describeCompanionPresence, type GatheringFloorPresence } from '@/lib/gathering-presence';

function fixture() { return parseGathering({ id:'synthetic-presence',title:'合成住处',scene_type:'home',revision:2,closed:false,is_manager:true,me:'owner-a',invitation:null,
  members:[{id:'owner-a',name:'甲',manager:true}],companions:[{id:1,name:'合成伙伴',owner_id:'owner-a',activity:'talk',area:'outdoor',x:.3,y:.5}],
  items:[],votes:[],events:[],stories:[],story_enabled:false,goal:null,season:{current_season:null} }); }
function floor(phase: string, activity: GatheringFloorPresence['activity']='sleep',id=1): GatheringFloorPresence { return {id,phase,floor:phase==='upper'?2:1,activity}; }

it('uses the saved activity and area when no live status has arrived',()=>{
 const g=fixture();expect(describeCompanionPresence(g,g.companions[0])).toEqual({id:1,activityLabel:'相聚',locationLabel:'院子'});
});

for(const [activity,label] of [['observe','看风景'],['rest','休息'],['sleep','睡觉']] as const) it('projects upstairs '+activity+' over the unchanged downstairs saved pose',()=>{
 const g=fixture(),before=JSON.stringify(g),visit=floor('upper',activity),savedVisit=JSON.stringify(visit);
 expect(describeCompanionPresence(g,g.companions[0],{floorVisit:visit,activityLabel:'正在就位',locationLabel:'院子'})).toEqual({id:1,activityLabel:label,locationLabel:'二楼'});
 expect(JSON.stringify(g)).toBe(before);expect(JSON.stringify(visit)).toBe(savedVisit);
});

for(const [phase,activityLabel,locationLabel] of [['queued','等候楼梯','楼梯口'],['waiting','通道等候','楼梯'],['approach','上下楼途中','楼梯'],['walking','上下楼途中','楼梯']] as const) it('shows '+phase+' as a route state rather than arrival upstairs',()=>{
 const g=fixture();expect(describeCompanionPresence(g,g.companions[0],{floorVisit:floor(phase)})).toEqual({id:1,activityLabel,locationLabel});
});

for(const visit of [floor('upper','sleep',2),floor('returned'),floor('future-unknown')]) it('does not reuse a different or inactive floor state '+visit.id+'/'+visit.phase,()=>{
 const g=fixture();expect(describeCompanionPresence(g,g.companions[0],{floorVisit:visit})).toEqual({id:1,activityLabel:'相聚',locationLabel:'院子'});
});

it('keeps live physical activity and location labels without writing the saved activity',()=>{
 const g=fixture(),before=JSON.stringify(g);
 expect(describeCompanionPresence(g,g.companions[0],{activityLabel:'走向院子，准备相聚',locationLabel:'客厅'})).toEqual({id:1,activityLabel:'走向院子，准备相聚',locationLabel:'客厅'});
 expect(JSON.stringify(g)).toBe(before);
});

it('uses a saved leisure activity rather than its original ordinary activity',()=>{
 const g=fixture();g.companions[0].leisure={activity:'television',seat_id:'television-1',station_version:1};g.companions[0].area='indoor';
 expect(describeCompanionPresence(g,g.companions[0])).toEqual({id:1,activityLabel:'看电视',locationLabel:'客厅'});
});

it('falls back to the saved physical labels after a returned visit',()=>{
 const g=fixture();g.companions[0].activity='rest';g.companions[0].area='indoor';
 expect(describeCompanionPresence(g,g.companions[0],{floorVisit:floor('returned')})).toEqual({id:1,activityLabel:'休息',locationLabel:'客厅'});
});
