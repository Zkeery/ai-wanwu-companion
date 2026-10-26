import { describe, expect, it, vi } from 'vitest';
import { createHomeMahjongGame, HOME_MAHJONG_GAME_TILES as ALL, type HomeMahjongGamePreset, type HomeMahjongGameSnapshot, type HomeMahjongGameEvent } from '../lib/living-home-mahjong-game';
import { getSichuanWaits } from '../lib/living-home-sichuan-score';
const T = ALL.slice(0, 27), suits = ['万', '筒', '条'] as const;
const actors = [1,2,3,4].map(actorId => ({ actorId, seatId: 'seat-' + actorId }));
const offsets: Readonly<Record<string, number>> = {m:0,p:9,s:18};
const tiles = (codes: string) => codes.split(/\s+/).filter(Boolean).map(code => T[offsets[code[0]] + Number(code.slice(1)) - 1]);
const seeded = (seed: number) => { let state = seed >>> 0; return () => { state = (Math.imul(state,1664525)+1013904223)>>>0; return state/0x100000000; }; };
function preset(hints: readonly (readonly string[])[], first: readonly string[] = [], direction: 1|2|3 = 1): HomeMahjongGamePreset {
  const pool = T.flatMap(tile => Array<string>(4).fill(tile)), hands = Array.from({length:4},(_,i)=>[...(hints[i]??[])]);
  for (const tile of [...hands.flat(),...first]) { const at=pool.indexOf(tile); if(at<0)throw new Error('fifth fixture tile');pool.splice(at,1); }
  const random=seeded(4819);for(let i=pool.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pool[i],pool[j]]=[pool[j],pool[i]];}
  hands.forEach((hand,i)=>{while(hand.length<(i===0?14:13))hand.push(pool.pop()!);});
  return {hands,wall:[...first,...pool],turn:0,exchangeDirection:direction};
}
const exchangeHands = [tiles('m1 m2 m3 p1 p2 p3 p4 p5 s1 s2 s3 s4 s5 s6'),tiles('m4 m5 m6 m7 m8 p6 p7 p8 s1 s2 s3 s4 s5'),
  tiles('m1 m2 m3 m4 m5 p1 p2 p3 p4 p5 s7 s8 s9'),tiles('m6 m7 m8 p1 p2 p3 p4 p5 s1 s2 s3 s4 s5')];
const outgoing = [tiles('m1 m2 m3'),tiles('p6 p7 p8'),tiles('s7 s8 s9'),tiles('m6 m7 m8')];
function check(snapshot: HomeMahjongGameSnapshot, previous?: HomeMahjongGameSnapshot, event?: HomeMahjongGameEvent|null) {
  expect(snapshot.rules).toBe('sichuan');expect(snapshot.totalTiles).toBe(108);
  if(snapshot.status==='waiting')return;
  const physical=snapshot.players.flatMap(player=>[...player.hand,...player.discards,...player.melds.flatMap(m=>m.tiles)]);
  expect(physical.length+snapshot.wallRemaining).toBe(108);const counts=new Map<string,number>();
  for(const tile of physical){expect(T).toContain(tile);counts.set(tile,(counts.get(tile)??0)+1);}expect([...counts.values()].every(n=>n<=4)).toBe(true);
  expect(snapshot.players.reduce((sum,p)=>sum+(p.score??0),0)).toBe(0);
  const reconstructed=new Map(actors.map(a=>[a.actorId,0]));
  for(const transfer of snapshot.scoreTransfers??[]){expect(Number.isSafeInteger(transfer.points)&&transfer.points>0).toBe(true);reconstructed.set(transfer.fromActorId,reconstructed.get(transfer.fromActorId)!-transfer.points);reconstructed.set(transfer.toActorId,reconstructed.get(transfer.toActorId)!+transfer.points);}
  for(const player of snapshot.players){expect(player.score).toBe(reconstructed.get(player.actorId));expect(player.melds.every(m=>m.kind!=='chow')).toBe(true);}
  if(previous){
    for(const payment of (snapshot.scoreTransfers??[]).slice(previous.scoreTransfers?.length??0))if(payment.reason!=='kong-refund')expect(previous.players.find(p=>p.actorId===payment.fromActorId)?.won).not.toBe(true);
    if(event&&(event.kind==='draw'||event.kind==='discard'))expect(previous.players.find(p=>p.actorId===event.actorId)?.won).toBe(false);
    if(event?.kind==='discard'){const player=previous.players.find(p=>p.actorId===event.actorId)!;if(player.hand.some(tile=>tile.endsWith(player.missingSuit!)))expect(event.tile?.endsWith(player.missingSuit!)).toBe(true);}
  }
}
function runner(value?:HomeMahjongGamePreset,seed=8,randomOverride?:()=>number){
  const game=createHomeMahjongGame({rules:'sichuan',preset:value,random:randomOverride??seeded(seed)});let time=0;game.step({elapsed:0,moving:true,enabled:true,actors});
  const history: {event:HomeMahjongGameEvent;snapshot:HomeMahjongGameSnapshot;time:number}[]=[];
  const frame=(delta=.1)=>{const before=game.getSnapshot();time+=delta;const result=game.step({elapsed:time,moving:true,enabled:true,actors});check(result.snapshot,before,result.event);if(result.event)history.push({event:result.event,snapshot:result.snapshot,time});return result;};
  const phase=(target:HomeMahjongGameSnapshot['phase'],limit=1000)=>{for(let i=0;i<limit;i++){if(game.getSnapshot().phase===target)return game.getSnapshot();frame();}throw new Error('phase not reached: '+target);};
  return {game,frame,phase,history,now:()=>time};
}
describe('explicit Sichuan108 profile and preserved basic136',()=>{
  it('starts four legal seats with dealer14 and others13 using only108 suited tiles',()=>{
    const run=runner();const snapshot=run.game.getSnapshot();check(snapshot);expect(snapshot.phase).toBe('exchange');expect(snapshot.wallRemaining).toBe(55);
    expect(snapshot.players.map(p=>p.hand.length)).toEqual([14,13,13,13]);expect(snapshot.players.every(p=>p.won===false&&p.winningTile===null&&p.missingSuit===null&&p.score===0)).toBe(true);
    const basic=createHomeMahjongGame({rules:'basic',random:seeded(1)}).step({elapsed:0,moving:true,enabled:true,actors}).snapshot;
    expect(basic.players.map(p=>p.hand.length)).toEqual([13,13,13,13]);expect(basic.wallRemaining).toBe(84);expect(basic.rules).toBeUndefined();
  });
  it.each([1,2,3] as const)('exchanges same-suit three tiles in one shared direction %s without copying or losing a tile',direction=>{
    const value=preset(exchangeHands,tiles('m9'),direction), saved=JSON.stringify(value),run=runner(value);const before=run.game.getSnapshot();
    const after=run.phase('dingque');expect(after.exchangeDirection).toBe(direction);expect(run.history).toHaveLength(0);
    for(let giver=0;giver<4;giver++){expect(new Set(outgoing[giver].map(tile=>tile.slice(-1))).size).toBe(1);const receiver=(giver+direction)%4;
      const expected=[...before.players[receiver].hand];for(const tile of outgoing[receiver])expected.splice(expected.indexOf(tile),1);expected.push(...outgoing[giver]);
      expect([...after.players[receiver].hand].sort()).toEqual(expected.sort());}
    expect(after.players.map(p=>p.hand.length)).toEqual([14,13,13,13]);check(after);expect(JSON.stringify(value)).toBe(saved);
  });
  it('declares each least-count suit and really discards a remaining missing-suit tile before any useful tile',()=>{
    const run=runner(preset(exchangeHands,tiles('m9')));const declared=run.phase('hold');expect(declared.players.map(p=>p.missingSuit)).toEqual(['万','筒','条','万']);
    for(const p of declared.players){const counts=suits.map(s=>p.hand.filter(t=>t.endsWith(s)).length);expect(p.hand.filter(t=>t.endsWith(p.missingSuit!)).length).toBe(Math.min(...counts));}
    expect(declared.players[0].hand.filter(t=>t.endsWith('万'))).toHaveLength(3);
    while(!run.history.some(h=>h.event.kind==='discard'))run.frame();const first=run.history.find(h=>h.event.kind==='discard')!;expect(first.event.actorId).toBe(1);expect(first.event.tile?.endsWith('万')).toBe(true);
    expect(first.snapshot.phase).toBe('discard');
  });
  it('strictly rejects honor tiles, short108 decks, wrong dealer sizes and invalid fixed directions',()=>{
    const good=preset(exchangeHands);const clone=()=>JSON.parse(JSON.stringify(good)) as {hands:string[][];wall:string[];turn:number;exchangeDirection:1|2|3};
    const honor=clone();honor.wall[0]='白板';expect(()=>createHomeMahjongGame({rules:'sichuan',preset:honor})).toThrow(RangeError);
    const short=clone();short.wall.pop();expect(()=>createHomeMahjongGame({rules:'sichuan',preset:short})).toThrow(RangeError);
    const size=clone();size.hands[0].pop();size.hands[1].push('一万');expect(()=>createHomeMahjongGame({rules:'sichuan',preset:size})).toThrow(RangeError);
    expect(()=>createHomeMahjongGame({rules:'sichuan',preset:{...good,exchangeDirection:0 as 1}})).toThrow(RangeError);
    expect(()=>createHomeMahjongGame({rules:'unknown' as 'sichuan'})).toThrow(RangeError);
  });
  it('rebases pause, busy and clock gaps through exchange without repeating trades, and resets all local scores',()=>{
    const value=preset(exchangeHands),run=runner(value);for(let i=0;i<5;i++)run.frame();const before=run.game.getSnapshot();
    expect(run.game.step({elapsed:50,moving:false,enabled:true,actors}).snapshot).toBe(before);expect(run.game.step({elapsed:50.1,moving:true,enabled:true,actors}).snapshot).toBe(before);
    expect(run.game.step({elapsed:500,moving:true,enabled:true,actors}).snapshot).toBe(before);expect(run.game.step({elapsed:500.1,moving:true,enabled:true,busy:true,actors}).snapshot).toBe(before);
    expect(run.game.step({elapsed:501,moving:true,enabled:true,actors}).snapshot).toBe(before);
    run.game.reset();expect(run.game.getSnapshot().status).toBe('waiting');expect(run.game.getSnapshot().scoreTransfers).toEqual([]);
    const fresh=run.game.step({elapsed:502,moving:true,enabled:true,actors}).snapshot;expect(fresh.phase).toBe('exchange');expect(fresh.players.every(p=>p.melds.length===0&&p.score===0)).toBe(true);
    expect(Object.isFrozen(fresh.players[0].hand)).toBe(true);run.game.dispose();expect(run.game.step({elapsed:900,moving:true,enabled:true,actors}).snapshot).toBe(fresh);
  });
  it.each([3,11,27])('keeps108 physical tiles and zero-sum transfers, skips winners and finishes without an automatic new deal for seed%s',seed=>{
    const run=runner(undefined,seed);let frames=0;
    while(run.game.getSnapshot().status==='playing'&&frames++<10000)run.frame();
    const final=run.game.getSnapshot();expect(frames).toBeLessThan(10000);expect(['won','exhausted']).toContain(final.status);expect(final.settlement).toBeDefined();
    expect(run.history.every(h=>h.event.kind!=='chow')).toBe(true);
    if(final.status==='won'){expect(final.players.filter(p=>p.won)).toHaveLength(3);expect(final.settlement?.reason).toBe('three-winners');}
    else{expect(final.wallRemaining).toBe(0);expect(final.settlement?.reason).toBe('wall-exhausted');
      const active=final.players.filter(p=>!p.won),pigs=active.filter(p=>p.hand.some(t=>t.endsWith(p.missingSuit!)));
      expect(final.settlement?.flowerPigActorIds).toEqual(pigs.map(p=>p.actorId));
      const ready=active.filter(p=>!pigs.includes(p)&&getSichuanWaits(p.hand,p.melds,p.missingSuit!).length>0);expect(final.settlement?.readyActorIds).toEqual(ready.map(p=>p.actorId));
      for(const receipt of (final.scoreTransfers??[]).filter(t=>['exposed-kong','added-kong','concealed-kong'].includes(t.reason))){const winner=final.players.find(p=>p.actorId===receipt.toActorId)!;
        if(!winner.won&&!ready.includes(winner))expect(final.scoreTransfers).toContainEqual({fromActorId:receipt.toActorId,toActorId:receipt.fromActorId,points:receipt.points,reason:'kong-refund'});}
    }
    const transfers=final.scoreTransfers,events=run.history.length;for(let i=0;i<20;i++)run.frame();expect(run.history).toHaveLength(events);expect(run.game.getSnapshot().scoreTransfers).toBe(transfers);
  });
  it('uses no network, wall clock or timers for local Sichuan steps',()=>{
    const fetch=vi.spyOn(globalThis,'fetch'),timer=vi.spyOn(globalThis,'setTimeout'),interval=vi.spyOn(globalThis,'setInterval'),date=vi.spyOn(Date,'now');
    try{const run=runner(preset(exchangeHands));for(let i=0;i<90;i++)run.frame();run.game.dispose();expect(fetch).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();expect(interval).not.toHaveBeenCalled();expect(date).not.toHaveBeenCalled();}
    finally{fetch.mockRestore();timer.mockRestore();interval.mockRestore();date.mockRestore();}
  });
});

// Each preset is a complete legal108 deck, replayed through exchange and dingque.
const scenarios: Record<string,{preset:HomeMahjongGamePreset;randomStateAfterDeal?:number;randomConstant?:number}> = {"continueAfterWin":{"preset":{"hands":[["一万","三万","三万","五万","六万","二筒","四筒","一条","三条","四条","六条","六条","七条","九条"],["二万","六万","七万","九万","一筒","二筒","三筒","三筒","五筒","七筒","九筒","五条","八条"],["二万","四万","四万","五万","八万","一筒","五筒","八筒","九筒","九筒","二条","二条","六条"],["一万","一万","五万","九万","四筒","五筒","六筒","二条","三条","四条","四条","八条","九条"]],"wall":["三筒","四万","九条","七条","四条","四筒","九万","七筒","三条","八筒","二筒","七条","三条","八筒","八筒","四筒","五条","九筒","九万","七条","八万","一条","九条","四万","一条","六筒","六万","八万","五条","六筒","三万","七万","二万","三万","五万","三筒","七筒","八万","六条","五条","六万","八条","八条","二筒","七万","七筒","一万","六筒","二条","一筒","二万","一条","五筒","一筒","七万"],"turn":0,"exchangeDirection":1},"randomStateAfterDeal":923276397},"addedKong":{"preset":{"hands":[["八万","九万","三筒","三筒","三筒","五筒","五筒","六筒","八筒","九筒","三条","三条","四条","六条"],["二万","三万","三万","六万","八万","四筒","八筒","一条","二条","三条","五条","八条","八条"],["一万","一万","五万","五万","七万","二筒","四筒","五筒","六筒","六筒","六筒","九筒","二条"],["一万","四万","七万","八万","九万","二筒","五筒","七筒","七筒","九筒","二条","七条","八条"]],"wall":["一万","五万","八筒","七万","七条","一条","六条","三万","二万","三万","五条","一筒","九条","五条","七筒","九筒","九万","六万","四条","九条","一条","四条","四万","六条","六万","五万","二筒","一筒","三条","一筒","八条","四筒","八筒","八万","七条","七条","六条","九万","二筒","九条","四万","七筒","三筒","四万","二万","四条","二万","六万","四筒","一筒","一条","五条","九条","二条","七万"],"turn":0,"exchangeDirection":1},"randomStateAfterDeal":839106865},"ready":{"preset":{"hands":[["一万","二万","五万","六万","九万","二筒","五筒","六筒","九筒","三条","四条","四条","七条","九条"],["一万","三万","四万","六万","六万","九万","一筒","二筒","四筒","五筒","七筒","一条","四条"],["四万","六万","七万","八万","四筒","七筒","九筒","二条","三条","五条","八条","八条","九条"],["一万","二万","三万","九万","二筒","三筒","三筒","四筒","五筒","八筒","三条","七条","八条"]],"wall":["二条","九筒","一条","五万","五万","一筒","二万","九筒","八万","八筒","六条","三万","七筒","六条","二筒","八万","九条","二万","五筒","一条","七万","一万","八条","一条","八筒","八筒","七万","五万","三筒","二条","七筒","九条","五条","二条","六筒","四条","四万","一筒","六筒","八万","九万","七条","三筒","三条","四筒","五条","六筒","四万","六条","三万","一筒","六条","七条","五条","七万"],"turn":0,"exchangeDirection":2},"randomStateAfterDeal":1891806306},"refund":{"preset":{"hands":[["五万","五万","六万","九万","一筒","五筒","九筒","一条","三条","四条","五条","六条","八条","九条"],["二万","五万","七万","八万","八万","二筒","二筒","三筒","六筒","八筒","九筒","六条","八条"],["一万","一筒","三筒","四筒","五筒","五筒","八筒","八筒","三条","六条","七条","七条","九条"],["一万","二万","四万","六万","六万","四筒","五筒","七筒","二条","三条","四条","八条","九条"]],"wall":["二筒","九筒","三条","五条","四万","七万","六条","五条","二条","三万","三筒","九筒","四筒","六筒","五万","四万","五条","四万","一万","二条","七条","四条","一条","六筒","七筒","八条","八万","二万","三筒","七条","九条","一万","八筒","七筒","三万","九万","七筒","二筒","一筒","六筒","四筒","九万","九万","七万","二条","六万","三万","一条","三万","四条","一条","二万","一筒","八万","七万"],"turn":0,"exchangeDirection":2},"randomStateAfterDeal":2860336215},"robKong":{"preset":{"hands":[["二万","三万","三万","四万","六万","一筒","五筒","六筒","七筒","七筒","二条","二条","八条","九条"],["五万","七万","九万","二筒","三筒","四筒","四筒","五筒","一条","二条","三条","五条","六条"],["一万","一万","五万","五万","七万","七万","七万","三筒","五筒","九筒","三条","四条","五条"],["二万","三万","六万","九万","九万","九万","四筒","六筒","六筒","九筒","三条","六条","九条"]],"wall":["七条","五万","七条","四万","四筒","九条","七筒","六条","一筒","八筒","八筒","八条","七条","七筒","二筒","一万","三筒","六筒","九条","一筒","二筒","四万","三条","六万","八万","五条","五条","四万","四条","一条","九筒","七条","二万","八万","三万","六万","二条","八筒","一条","一筒","一万","八条","三筒","九筒","五筒","四条","八万","六条","八条","二筒","一条","二万","四条","八筒","八万"],"turn":0,"exchangeDirection":2},"randomStateAfterDeal":2229645016},"multi":{"preset":{"hands":[["一万","三万","四万","五万","九万","三筒","七筒","九筒","二条","二条","五条","六条","八条","九条"],["一万","六万","六万","三筒","六筒","七筒","七筒","八筒","八筒","二条","五条","六条","九条"],["二万","八万","二筒","五筒","六筒","六筒","八筒","二条","三条","四条","七条","八条","九条"],["二万","二万","三万","四万","五万","六万","六万","七万","四筒","八筒","九筒","三条","四条"]],"wall":["一条","一条","三条","七条","七万","九万","四筒","九条","三万","一万","一条","七条","九万","五万","九筒","一筒","四万","一筒","九筒","三条","五条","五筒","三万","六条","一筒","六筒","八万","四条","二筒","七条","五筒","四筒","四万","八条","七筒","三筒","一万","二万","二筒","五筒","三筒","八万","五条","五万","二筒","七万","四筒","六条","九万","一筒","一条","八条","七万","四条","八万"],"turn":0,"exchangeDirection":2},"randomStateAfterDeal":1724627824},"flowerPig":{"preset":{"hands":[["一万","二万","三万","一筒","二筒","三筒","四筒","五筒","一条","二条","三条","四条","五条","六条"],["四万","五万","六万","七万","八万","六筒","七筒","八筒","一条","二条","三条","四条","五条"],["一万","二万","三万","四万","五万","一筒","二筒","三筒","四筒","五筒","七条","八条","九条"],["六万","七万","八万","一筒","二筒","三筒","四筒","五筒","一条","二条","三条","四条","五条"]],"wall":["七筒","八条","九万","一万","六筒","二条","九万","四万","九筒","三条","二万","二万","四筒","七条","三万","六万","六筒","九条","五万","九万","二筒","四条","七万","七万","一筒","六条","五筒","八万","六筒","八条","一条","三万","七筒","六条","九筒","五万","九筒","五条","九条","一万","七筒","七条","三筒","四万","九筒","六条","九条","八万","八筒","八条","六万","八筒","七条","八筒","九万"],"turn":0,"exchangeDirection":1},"randomConstant":0}};
function scenarioRunner(key:string){const value=scenarios[key];return runner(value.preset,0,value.randomConstant===undefined?seeded(value.randomStateAfterDeal!):()=>value.randomConstant!);}
function finish(run:ReturnType<typeof runner>){let frames=0;while(run.game.getSnapshot().status==='playing'&&frames++<10000)run.frame();expect(frames).toBeLessThan(10000);return run.game.getSnapshot();}
type Transfer=NonNullable<HomeMahjongGameSnapshot['scoreTransfers']>[number];
describe('Sichuan real108 event priorities and exact settlement',()=>{
  it('marks a shared discard once for multiple independent winners, then ends after three winners without a new deal',()=>{
    const run=scenarioRunner('multi');let found=false,shared:HomeMahjongGameEvent|null=null;
    for(let frame=0;frame<10000&&run.game.getSnapshot().status==='playing';frame++){
      const before=run.game.getSnapshot(), result=run.frame();
      const added=result.snapshot.players.filter(p=>p.won&&!before.players.find(b=>b.actorId===p.actorId)!.won);
      if(added.length<2)continue;found=true;shared=result.event;expect(shared?.kind).toBe('win');expect(shared?.fromActorId).toBeDefined();expect(result.snapshot.phase).toBe('win');
      const source=before.players.find(p=>p.actorId===shared!.fromActorId)!;
      expect(source.discards.at(-1)).toBe(shared?.tile);expect(result.snapshot.players.find(p=>p.actorId===source.actorId)!.discards).toEqual(source.discards);
      for(const winner of added){expect(winner.hand).toEqual(before.players.find(p=>p.actorId===winner.actorId)!.hand);expect(winner.winningTile).toBe(shared?.tile);}
      expect((result.snapshot.scoreTransfers??[]).slice(before.scoreTransfers?.length??0)).toEqual(added.map(winner=>expect.objectContaining({fromActorId:source.actorId,toActorId:winner.actorId,reason:'win'})));
    }
    expect(found).toBe(true);const final=run.game.getSnapshot();expect(final.status).toBe('won');expect(final.players.filter(p=>p.won)).toHaveLength(3);
    const events=run.history.filter(h=>h.event.kind==='win'&&h.event.tile===shared!.tile&&h.event.fromActorId===shared!.fromActorId);
    expect(new Set(events.map(h=>h.event.actorId)).size).toBeGreaterThanOrEqual(2);expect(new Set(events.map(h=>h.event.id)).size).toBe(events.length);
    const last=run.history.length;for(let i=0;i<30;i++)run.frame();expect(run.game.getSnapshot()).toBe(final);expect(run.history).toHaveLength(last);
  });
  it('freezes each completed winner while remaining players really continue drawing and discarding',()=>{
    const run=scenarioRunner('continueAfterWin');let frozen:HomeMahjongGameSnapshot['players'][number]|undefined,laterDraw=false,laterDiscard=false;
    for(let frame=0;frame<10000&&run.game.getSnapshot().status==='playing';frame++){
      const result=run.frame();if(!frozen&&result.event?.kind==='win')frozen=result.snapshot.players.find(p=>p.actorId===result.event!.actorId);
      else if(frozen){const current=result.snapshot.players.find(p=>p.actorId===frozen!.actorId)!;expect(current.hand).toEqual(frozen.hand);expect(current.melds).toEqual(frozen.melds);expect(current.discards).toEqual(frozen.discards);
        if(result.event?.kind==='draw'){expect(result.event.actorId).not.toBe(frozen.actorId);laterDraw=true;}
        if(result.event?.kind==='discard'){expect(result.event.actorId).not.toBe(frozen.actorId);laterDiscard=true;}}
    }
    expect(frozen).toBeDefined();expect(laterDraw&&laterDiscard).toBe(true);expect(run.game.getSnapshot().status).toBe('won');
  });
  it.each(['continueAfterWin','addedKong'])('uses the wall front even for supplements and charges only actual active kong payers in %s',key=>{
    const run=scenarioRunner(key);let consumed=0;const kinds=new Set<string>();
    for(let frame=0;frame<10000&&run.game.getSnapshot().status==='playing';frame++){
      const before=run.game.getSnapshot(),result=run.frame(),event=result.event;
      if(event?.kind==='draw'){expect(event.tile).toBe(scenarios[key].preset.wall[consumed++]);if(event.afterKong)expect(before.lastEvent?.kind).toBe('kong');}
      if(event?.kind!=='kong')continue;
      const owner=before.players.find(p=>p.actorId===event.actorId)!,hadPung=owner.melds.some(m=>m.kind==='pung'&&m.tiles[0]===event.tile);
      const kind=event.fromActorId!==undefined?'exposed-kong':hadPung?'added-kong':'concealed-kong';kinds.add(kind);
      const actual=(result.snapshot.scoreTransfers??[]).slice(before.scoreTransfers?.length??0);
      const payers=kind==='exposed-kong'?[event.fromActorId!]:[1,2,3].map(d=>before.players[(before.players.indexOf(owner)+d)%4]).filter(p=>!p.won).map(p=>p.actorId);
      expect(actual).toEqual(payers.map(fromActorId=>({fromActorId,toActorId:event.actorId,points:kind==='added-kong'?1:2,reason:kind})));
      expect(result.snapshot.phase).toBe('draw');expect(result.snapshot.wallRemaining).toBe(before.wallRemaining);
      const meld=result.snapshot.players.find(p=>p.actorId===event.actorId)!.melds.find(m=>m.kind==='kong'&&m.tiles[0]===event.tile)!;
      expect(meld.concealed===true).toBe(kind==='concealed-kong');
    }
    if(key==='continueAfterWin'){expect(kinds).toContain('concealed-kong');expect(kinds).toContain('exposed-kong');}else expect(kinds).toContain('added-kong');
    expect(consumed).toBe(scenarios[key].preset.wall.length-run.game.getSnapshot().wallRemaining);
  });
  it('robbed added kong retains the original pung, publishes only its physical fourth tile and performs no supplement',()=>{
    const run=scenarioRunner('robKong');let robbed=false;
    for(let frame=0;frame<10000&&run.game.getSnapshot().status==='playing';frame++){
      const before=run.game.getSnapshot(),result=run.frame(),event=result.event;if(!event?.robbedKong)continue;robbed=true;
      expect(event.kind).toBe('win');expect(event.text).toBe('抢杠胡');expect(result.snapshot.wallRemaining).toBe(before.wallRemaining);
      const source=before.players.find(p=>p.actorId===event.fromActorId)!,after=result.snapshot.players.find(p=>p.actorId===source.actorId)!;
      expect(source.melds.some(m=>m.kind==='pung'&&m.tiles[0]===event.tile)).toBe(true);expect(after.melds).toEqual(source.melds);
      expect(after.hand.filter(t=>t===event.tile)).toHaveLength(source.hand.filter(t=>t===event.tile).length-1);
      expect(after.discards).toEqual([...source.discards,event.tile]);
      const winners=result.snapshot.players.filter(p=>p.won&&!before.players.find(old=>old.actorId===p.actorId)!.won);
      for(const winner of winners){expect(winner.hand).toEqual(before.players.find(old=>old.actorId===winner.actorId)!.hand);expect(winner.winningTile).toBe(event.tile);}
      expect((result.snapshot.scoreTransfers??[]).slice(before.scoreTransfers?.length??0).every(t=>t.reason==='win')).toBe(true);
      let next=run.frame();while(!next.event&&next.snapshot.status==='playing')next=run.frame();expect(next.event?.kind).toBe('draw');expect(next.event?.afterKong).not.toBe(true);expect(next.event?.actorId).not.toBe(event.fromActorId);break;
    }
    expect(robbed).toBe(true);
  });
  it.each(['ready','refund','flowerPig'])('applies exact wall-end flower pig, ready and historic kong refunds once for %s',key=>{
    const run=scenarioRunner(key);let before:HomeMahjongGameSnapshot|undefined;
    while(run.game.getSnapshot().status==='playing'){before=run.game.getSnapshot();run.frame();}
    const final=run.game.getSnapshot();expect(final.status).toBe('exhausted');expect(before?.wallRemaining).toBe(0);
    const active=before!.players.filter(p=>!p.won),pigs=active.filter(p=>p.hand.some(t=>t.endsWith(p.missingSuit!))),nonPigs=active.filter(p=>!pigs.includes(p));
    const waits=new Map(nonPigs.map(p=>[p.actorId,getSichuanWaits(p.hand,p.melds,p.missingSuit!)]));const ready=nonPigs.filter(p=>waits.get(p.actorId)!.length>0),expected:Transfer[]=[];
    for(const pig of pigs)for(const other of nonPigs)expected.push({fromActorId:pig.actorId,toActorId:other.actorId,points:16,reason:'flower-pig'});
    for(const payer of nonPigs.filter(p=>!ready.includes(p)))for(const other of ready)expected.push({fromActorId:payer.actorId,toActorId:other.actorId,points:Math.max(...waits.get(other.actorId)!.map(w=>w.points)),reason:'ready'});
    for(const receipt of before!.scoreTransfers??[])if(['exposed-kong','added-kong','concealed-kong'].includes(receipt.reason)&&active.some(p=>p.actorId===receipt.toActorId&&!ready.includes(p)))expected.push({fromActorId:receipt.toActorId,toActorId:receipt.fromActorId,points:receipt.points,reason:'kong-refund'});
    expect((final.scoreTransfers??[]).slice(before!.scoreTransfers?.length??0)).toEqual(expected);
    expect(expected.some(t=>t.reason===(key==='ready'?'ready':key==='refund'?'kong-refund':'flower-pig'))).toBe(true);
    if(key==='flowerPig'){expect(final.settlement?.flowerPigActorIds).toEqual([1]);expect(final.players.map(p=>p.score)).toEqual([-48,16,16,16]);}
    const saved=final.scoreTransfers;for(let i=0;i<30;i++)run.frame();expect(run.game.getSnapshot()).toBe(final);expect(run.game.getSnapshot().scoreTransfers).toBe(saved);
  });
  it('resets won flags, virtual winning references, declared suits, exchange and scores together after a real finished round',()=>{
    const run=scenarioRunner('multi');finish(run);expect(run.game.getSnapshot().players.some(p=>p.won)).toBe(true);run.game.reset();const empty=run.game.getSnapshot();expect(empty.status).toBe('waiting');expect(empty.players).toEqual([]);expect(empty.scoreTransfers).toEqual([]);expect(empty.settlement).toBeUndefined();
    const fresh=run.game.step({elapsed:run.now()+1,moving:true,enabled:true,actors}).snapshot;check(fresh);expect(fresh.phase).toBe('exchange');expect(fresh.players.every(p=>!p.won&&p.winningTile===null&&p.missingSuit===null&&p.score===0)).toBe(true);
  });
});
