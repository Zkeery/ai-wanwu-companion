import { describe, expect, it, vi } from 'vitest';
import { createHomeTelevisionChannels, HOME_TELEVISION_CHANNEL_NAMES, type HomeTelevisionChannelsStep } from '../lib/living-home-television-channels';
const input=(elapsed:number,buttonPressed=false,heldByActorId:number|null=1,options:Partial<HomeTelevisionChannelsStep>={}):HomeTelevisionChannelsStep=>({elapsed,moving:true,powered:true,remote:{heldByActorId,buttonPressed},...options});
describe('local television channels with real button edges',()=>{
  it('publishes frozen channel0 before a baseline and rejects a held initial button',()=>{
    const tv=createHomeTelevisionChannels();const initial=tv.getSnapshot();expect(initial).toEqual({channel:0,name:'田园风景',elapsed:0,revision:0});expect(Object.isFrozen(initial)).toBe(true);
    expect(tv.step(input(10,true))).toBe(initial);expect(tv.step(input(10.1,true)).channel).toBe(0);
    tv.step(input(10.2,false));const changed=tv.step(input(10.3,true));expect(changed).toEqual({channel:1,name:'趣味动画',elapsed:0,revision:1});expect(Object.isFrozen(changed)).toBe(true);
  });
  it('changes once per rising edge, holds stable across pressed frames and wraps three named channels',()=>{
    const tv=createHomeTelevisionChannels();tv.step(input(0));
    expect(tv.step(input(.1,true)).channel).toBe(1);for(let i=2;i<=6;i++)expect(tv.step(input(i/10,true)).channel).toBe(1);
    tv.step(input(.7));expect(tv.step(input(.8,true)).channel).toBe(2);tv.step(input(.9));const wrapped=tv.step(input(1,true));expect(wrapped.channel).toBe(0);expect(wrapped.revision).toBe(3);
    expect(HOME_TELEVISION_CHANNEL_NAMES).toEqual(['田园风景','趣味动画','乡村美食']);
  });
  it.each([null,0,-1,.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])('invalid remote owner %s never switches and must release after a new valid owner baseline',owner=>{
    const tv=createHomeTelevisionChannels();tv.step(input(0));tv.step(input(.1,true,owner));expect(tv.step(input(.2,false,owner)).channel).toBe(0);
    expect(tv.step(input(.3,true,2)).channel).toBe(0);expect(tv.step(input(.4,true,2)).channel).toBe(0);tv.step(input(.5,false,2));expect(tv.step(input(.6,true,2)).channel).toBe(1);
  });
  it('does not transfer a previous owner released edge to a different valid owner',()=>{
    const tv=createHomeTelevisionChannels();tv.step(input(0));expect(tv.step(input(.1,true,2)).channel).toBe(0);tv.step(input(.2,false,2));expect(tv.step(input(.3,true,2)).channel).toBe(1);
    expect(tv.step(input(.4,true,3)).channel).toBe(1);tv.step(input(.5,false,3));expect(tv.step(input(.6,true,3)).channel).toBe(2);
  });
  it.each(['pause','power'] as const)('freezes programme through %s and requires a newly released button after resume',reason=>{
    const tv=createHomeTelevisionChannels();tv.step(input(0));tv.step(input(.1));const before=tv.getSnapshot();
    expect(tv.step(input(100,true,1,reason==='pause'?{moving:false}:{powered:false}))).toBe(before);
    expect(tv.step(input(101,true))).toBe(before);expect(tv.step(input(101.1,true)).channel).toBe(0);tv.step(input(101.2));expect(tv.step(input(101.3,true)).channel).toBe(1);
  });
  it.each([NaN,Infinity,-1,0,.1,50])('rebases invalid/non-forward/large time %s without replay or an inferred pressed edge',time=>{
    const tv=createHomeTelevisionChannels();tv.step(input(0));tv.step(input(.1));const before=tv.getSnapshot();expect(tv.step(input(time,true))).toBe(before);
    const resume=Number.isFinite(time)&&time>=0?time+.1:60;expect(tv.step(input(resume,true)).channel).toBe(0);tv.step(input(resume+.1,false));expect(tv.step(input(resume+.2,true)).channel).toBe(1);
  });
  it('uses only supplied legal deltas capped at0.1, plays without a held remote and resets programme at a channel change',()=>{
    const tv=createHomeTelevisionChannels();tv.step(input(5,false,null));expect(tv.step(input(5.6,false,null)).elapsed).toBeCloseTo(.1);expect(tv.step(input(5.65,false,null)).elapsed).toBeCloseTo(.15);expect(tv.getSnapshot().revision).toBe(0);
    tv.step(input(5.7,false,1));const changed=tv.step(input(5.75,true,1));expect(changed.channel).toBe(1);expect(changed.elapsed).toBe(0);expect(tv.step(input(5.8,true,1)).elapsed).toBeCloseTo(.05);
  });
  it('resets baseline/channel/time together and makes disposal idempotent and inert',()=>{
    const tv=createHomeTelevisionChannels();tv.step(input(0));tv.step(input(.1,true));tv.reset();const reset=tv.getSnapshot();expect(reset).toEqual({channel:0,name:'田园风景',elapsed:0,revision:2});
    expect(tv.step(input(10,true))).toBe(reset);tv.step(input(10.1,false));expect(tv.step(input(10.2,true)).channel).toBe(1);const last=tv.getSnapshot();tv.dispose();tv.dispose();tv.reset();expect(tv.step(input(11,false))).toBe(last);
  });
  it('does not mutate input and uses no media, network, timers or wall clock',()=>{
    const tv=createHomeTelevisionChannels(),value=Object.freeze({...input(0),remote:Object.freeze({heldByActorId:1,buttonPressed:false})});
    const fetch=vi.spyOn(globalThis,'fetch'),timer=vi.spyOn(globalThis,'setTimeout'),interval=vi.spyOn(globalThis,'setInterval'),date=vi.spyOn(Date,'now');
    try{tv.step(value);tv.step(input(.1,true));tv.reset();tv.dispose();expect(value.remote.buttonPressed).toBe(false);expect(fetch).not.toHaveBeenCalled();expect(timer).not.toHaveBeenCalled();expect(interval).not.toHaveBeenCalled();expect(date).not.toHaveBeenCalled();}
    finally{fetch.mockRestore();timer.mockRestore();interval.mockRestore();date.mockRestore();}
  });
});
