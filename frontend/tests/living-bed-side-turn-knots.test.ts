import {expect,it} from 'vitest';
import {createHomeJourneyController,type JourneyContext,type JourneyPose} from '@/lib/living-home-journey';
import {createLivingNavigation} from '@/lib/living-navigation';

it.each([.1,1/60])('keeps every verified pure-yaw sitting corner at delta=%s',delta=>{
 const controller=createHomeJourneyController(),graph=createLivingNavigation({bounds:{minX:-1,maxX:1,minZ:-1,maxZ:1},blocked:[],clearance:.05});
 const start:JourneyPose={x:0,y:0,z:0,yaw:0,tilt:0,scale:1,area:'bedroom',contact:'sleep',bedSeat:1};
 const a={...start,yaw:.2},b={...a,y:.1},c={...b,yaw:0},end:JourneyPose={...start,contact:null,bedSeat:0};
 controller.reconcile(5,{key:'bed',pose:start,approach:end},start);controller.reconcile(5,{key:'observe',pose:end,approach:end},start);
 const context:JourneyContext={radius:.05,coordinateContacts:true,plan:(from,to)=>graph.planTo({from,to,id:5}),isClear:()=>true,portalClear:()=>true,doorOpen:()=>true,
 contactPath:()=>[{pose:start,blend:1},{pose:a,blend:1},{pose:b,blend:1},{pose:c,blend:1},{pose:{...c,y:0},blend:1},{pose:end,blend:0}],
 isContactClear:(from,to)=>[Math.abs(to.y-from.y),Math.abs(to.yaw-from.yaw)].filter(value=>value>1e-9).length<=1};
 const seen=new Set<string>();for(let frame=0;frame<500&&controller.get(5)?.active;frame++){const p=controller.prepare(5,delta,context)!;expect(p.canTraverse(p.position,p.desired),'never shortcut a checked yaw/height corner').toBe(true);controller.commit(5,p.desired,delta);const pose=controller.get(5)!.pose;for(const [label,expected]of [['a',a],['b',b],['c',c]]as const)if(Math.abs(pose.y-expected.y)<1e-10&&Math.abs(pose.yaw-expected.yaw)<1e-10)seen.add(label);}
 expect([...seen].sort()).toEqual(['a','b','c']);expect(controller.get(5)?.active).toBe(false);expect(controller.get(5)?.pose).toEqual(end);
});
