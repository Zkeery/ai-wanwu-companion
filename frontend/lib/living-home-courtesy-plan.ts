import type { LivingNavigation, LivingNavigationRoute, NavPoint } from './living-navigation';

export type CourtesyBody = Readonly<{ id: number; position: NavPoint; radius: number }>;
export type CourtesyMove = Readonly<{ id: number; goal: NavPoint; route: readonly NavPoint[] }>;
type Avoid = Readonly<{ position: NavPoint; radius: number }>;
const distance = (a: NavPoint, b: NavPoint) => Math.hypot(a.x - b.x, a.z - b.z);
function segmentDistance(p: NavPoint, a: NavPoint, b: NavPoint) {
  const dx = b.x - a.x, dz = b.z - a.z, squared = dx * dx + dz * dz;
  const t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / squared)) : 0;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

export type PairedCourtesyPlan = Readonly<{ wait?: CourtesyMove; moves: readonly CourtesyMove[] }>;
/** Each yield is a scheduling boundary: animation frames own a small work budget. */
export function* createPairedHomeCourtesyPlanner(input: {
  requester: CourtesyBody; goal: NavPoint; bodies: readonly CourtesyBody[]; eligibleIds: readonly number[];
  keepFree: readonly Avoid[]; graph: (id: number) => LivingNavigation;
}): Generator<undefined, PairedCourtesyPlan | null, void> {
  const { requester, goal, bodies, keepFree, graph } = input;
  const eligible = bodies.filter(body => input.eligibleIds.includes(body.id)).sort((a, b) => a.id - b.id);
  const routeClear = (route: LivingNavigationRoute, from: NavPoint, to: NavPoint, radius: number, g: LivingNavigation, avoid: readonly Avoid[]) =>
    !route.blocked && route.points.length >= 2 && distance(route.points[0], from) < 1e-6 && distance(route.points.at(-1)!, to) < 1e-6
    && route.points.slice(1).every((end, index) => g.isSegmentClear(route.points[index], end)
      && avoid.every(peer => segmentDistance(peer.position, route.points[index], end) >= radius + peer.radius + .035 - 1e-6));
  function* candidates(body: CourtesyBody, avoid: readonly Avoid[]): Generator<CourtesyMove | undefined, void, void> {
    const g = graph(body.id), points = new Map<string, NavPoint>();
    for (const length of [1.4, 2.2, 3.2, 4.5, 6]) for (let n = 0; n < 16; n++) {
      yield;
      const to = g.findSafePoint({ x: body.position.x + Math.sin(n * Math.PI / 8) * length, z: body.position.z + Math.cos(n * Math.PI / 8) * length }, avoid);
      if (to && distance(to, body.position) > .4 && distance(to, goal) > body.radius + requester.radius + .2
        && [...avoid, ...keepFree].every(peer => distance(to, peer.position) >= body.radius + peer.radius + .035 - 1e-6)) points.set(to.x + '/' + to.z, to);
    }
    const ordered=[...points.values()];
    for(const to of ordered){
      yield;
      const route = g.planTo({ from: body.position, to, id: body.id, avoid });
      if(routeClear(route, body.position, to, body.radius, g, avoid))yield { id: body.id, goal: to, route: route.points };
    }
  }
  const requesterGraph=graph(requester.id),waits=new Map<string,NavPoint>();
  waits.set(requester.position.x+'/'+requester.position.z,requester.position);
  for(const length of [1.2,2.4,3.6])for(let n=0;n<8;n++){
    yield;
    const to=requesterGraph.findSafePoint({x:requester.position.x+Math.sin(n*Math.PI/4)*length,z:requester.position.z+Math.cos(n*Math.PI/4)*length},bodies);
    if(to&&distance(to,requester.position)>.4&&distance(to,goal)>distance(requester.position,goal))waits.set(to.x+'/'+to.z,to);
  }
  for(const wait of [...waits.values()].slice(0,6)){
    let waiting:CourtesyMove|undefined;
    if(distance(wait,requester.position)>1e-6){
      yield;
      const route=requesterGraph.planTo({from:requester.position,to:wait,id:requester.id,avoid:bodies});
      if(!routeClear(route,requester.position,wait,requester.radius,requesterGraph,bodies))continue;
      waiting={id:requester.id,goal:wait,route:route.points};
    }
    const waitingRequester={...requester,position:wait};
  for (const first of eligible) {
    const firstAvoid = [...bodies.filter(body => body.id !== first.id), waitingRequester];
    for (const a of candidates(first, firstAvoid)) {
      if(!a){yield;continue;}
      for (const second of eligible) {
        if (first.id === second.id) continue;
        const secondAvoid = [...bodies.filter(body => body.id !== second.id).map(body => body.id === first.id ? { ...body, position: a.goal } : body), waitingRequester];
        for (const b of candidates(second, secondAvoid)) {
          if(!b){yield;continue;}
          const finalAvoid = bodies.map(body => ({ ...body, position: body.id === first.id ? a.goal : body.id === second.id ? b.goal : body.position }));
          yield;
          const g = graph(requester.id), onward = g.planTo({ from: wait, to: goal, id: requester.id, avoid: finalAvoid });
          if (routeClear(onward, wait, goal, requester.radius, g, finalAvoid)) return {wait:waiting,moves:[a,b]};
        }
      }
    }
  }
  }
  return null;
}

/** Recheck a completed plan against current body positions before granting a route. */
export function validatePairedHomeCourtesy(input: {
 requester: CourtesyBody; goal: NavPoint; bodies: readonly CourtesyBody[]; keepFree: readonly Avoid[];
 graph: (id: number) => LivingNavigation;
}, plan: PairedCourtesyPlan): PairedCourtesyPlan | null {
 const positions=new Map(input.bodies.map(body=>[body.id,{...body,position:{...body.position}}]));
 let requester={...input.requester,position:{...input.requester.position}};
 const move=(body:CourtesyBody,goal:NavPoint,avoid:readonly Avoid[])=>{
   const graph=input.graph(body.id),route=graph.planTo({from:body.position,to:goal,id:body.id,avoid});
   return !route.blocked&&route.points.length>=2&&distance(route.points[0],body.position)<1e-6&&distance(route.points.at(-1)!,goal)<1e-6?{id:body.id,goal,route:route.points}:null;
 };
 let wait:CourtesyMove|undefined;
 if(plan.wait&&distance(requester.position,plan.wait.goal)>1e-6){
   const next=move(requester,plan.wait.goal,[...positions.values()]);if(!next)return null;wait=next;requester={...requester,position:next.goal};
 }
 const moves:CourtesyMove[]=[];
 for(const saved of plan.moves){
   const body=positions.get(saved.id);if(!body||input.keepFree.some(peer=>distance(saved.goal,peer.position)<body.radius+peer.radius+.035-1e-6))return null;
   const next=move(body,saved.goal,[...positions.values()].filter(peer=>peer.id!==body.id).concat(requester));if(!next)return null;
   moves.push(next);positions.set(body.id,{...body,position:next.goal});
 }
 if(!move(requester,input.goal,[...positions.values()]))return null;
 return {wait,moves};
}
