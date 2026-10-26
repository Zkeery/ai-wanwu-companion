import {describe,expect,it} from 'vitest';
import {getSichuanWaits,scoreSichuanHand,type SichuanMeld,type SichuanScoreInput} from '../lib/living-home-sichuan-score';
const tiles=(text:string)=>text.split(' ');
const flat=tiles('一万 二万 三万 四万 五万 六万 七万 八万 九万 二筒 三筒 四筒 五筒 五筒');
const input=(hand:readonly string[]=flat,other:Partial<SichuanScoreInput>={}):SichuanScoreInput=>({hand,melds:[],missingSuit:'条',...other});
const meld=(tile:string,kind:'pung'|'kong'='pung'):SichuanMeld=>({kind,tiles:Array(kind==='kong'?4:3).fill(tile)});
describe('chosen Sichuan blood-battle local score profile',()=>{
  it('scores a reference ordinary two-suit win as zero fan and one point',()=>{expect(scoreSichuanHand(input())).toEqual({fan:0,rawFan:0,points:1,labels:['平胡']});});
  it('scores all triplets, pure suit and seven pairs independently',()=>{
    expect(scoreSichuanHand(input(tiles('一万 一万 一万 三万 三万 三万 六万 六万 六万 二筒 二筒 二筒 五筒 五筒')))).toMatchObject({fan:1,points:2,labels:['对对胡']});
    expect(scoreSichuanHand(input(tiles('一万 二万 三万 四万 五万 六万 七万 八万 九万 二万 三万 四万 五万 五万')))).toMatchObject({fan:2,points:4,labels:['清一色']});
    expect(scoreSichuanHand(input(tiles('一万 一万 二万 二万 三万 三万 四万 四万 五筒 五筒 六筒 六筒 七筒 七筒')))).toMatchObject({fan:2,points:4,labels:['七对']});
  });
  it('counts a four-copy root only once, including dragon seven pairs',()=>{
    expect(scoreSichuanHand(input(tiles('一万 一万 一万 一万 二万 二万 三万 三万 五筒 五筒 六筒 六筒 七筒 七筒')))).toMatchObject({fan:3,points:8,labels:['七对','根']});
    expect(scoreSichuanHand(input(tiles('三万 三万 三万 六万 六万 六万 二筒 二筒 二筒 五筒 五筒'),{melds:[{...meld('一万','kong'),concealed:true}]}))).toMatchObject({fan:2,points:4,labels:['对对胡','根']});
  });
  it('requires a valid terminal-containing decomposition for dai-yao-jiu',()=>{
    expect(scoreSichuanHand(input(tiles('一万 二万 三万 七万 八万 九万 一筒 二筒 三筒 七筒 八筒 九筒 九筒 九筒')))).toMatchObject({fan:2,points:4,labels:['带幺九']});
    expect(scoreSichuanHand(input())).not.toBeNull();expect(scoreSichuanHand(input())!.labels).not.toContain('带幺九');
  });
  it('recognizes jiang-dui without adding it to arbitrary 258 sequences',()=>{
    const score=scoreSichuanHand(input(tiles('二万 二万 二万 五万 五万 五万 八万 八万 八万 二筒 二筒 二筒 五筒 五筒')));expect(score).toMatchObject({fan:3,points:8,labels:['对对胡','将对']});
    expect(scoreSichuanHand(input())!.labels).not.toContain('将对');
  });
  it('scores golden-hook from four actual exposed groups and a pair',()=>{expect(scoreSichuanHand(input(['五筒','五筒'],{melds:[meld('一万'),meld('三万'),meld('六万'),meld('二筒')]}))).toMatchObject({fan:2,points:4,labels:['对对胡','金钩钓']});});
  it.each([['selfDraw','自摸'],['afterKong','杠上花'],['robbedKong','抢杠胡'],['kongDiscard','杠上炮'],['lastTile','海底炮']] as const)('adds only the declared event bonus %s',(flag,label)=>{expect(scoreSichuanHand(input(flat,{[flag]:true}))).toMatchObject({fan:1,points:2,labels:[label]});});
  it('combines real self-draw/kong/last-tile bonuses and caps at four fan',()=>{
    const score=scoreSichuanHand(input(tiles('一万 二万 三万 四万 五万 六万 七万 八万 九万 二万 三万 四万 五万 五万'),{selfDraw:true,afterKong:true,lastTile:true}));expect(score).toMatchObject({rawFan:5,fan:4,points:16});expect(score!.labels).toContain('海底捞月');
  });
  it.each([['heavenly','天胡'],['earthly','地胡']] as const)('caps the genuine opening flag %s',(flag,label)=>{expect(scoreSichuanHand(input(flat,{[flag]:true}))).toMatchObject({fan:4,points:16,labels:[label]});});
  it('never awards a complete hand that still contains the declared missing suit',()=>{expect(scoreSichuanHand(input(flat,{missingSuit:'万'}))).toBeNull();expect(scoreSichuanHand(input(tiles('一万 二万 三万 四万 五万 六万 二条 三条 四条 二筒 三筒 四筒 五筒 五筒')))).toBeNull();});
  it('rejects honors, chow, malformed groups, wrong counts and a fifth own copy',()=>{
    expect(scoreSichuanHand(input([...flat.slice(0,13),'东风']))).toBeNull();expect(scoreSichuanHand(input(flat.slice(0,13)))).toBeNull();
    expect(scoreSichuanHand(input(flat.slice(3),{melds:[{kind:'chow',tiles:['一万','二万','三万']}]}))).toBeNull();
    expect(scoreSichuanHand(input(flat.slice(3),{melds:[{kind:'pung',tiles:['一万','二万','三万']}]}))).toBeNull();
    expect(scoreSichuanHand(input(tiles('一万 一万 一万 一万 一万 三万 三万 三万 六万 六万 六万 五筒 五筒 五筒')))).toBeNull();
  });
  it('uses a virtual shared winning tile without changing physical hand arrays',()=>{
    const hand=Object.freeze(flat.slice(0,13)),before=[...hand];const score=scoreSichuanHand(input(hand,{winningTile:'五筒'}));expect(score).toMatchObject({points:1});expect(hand).toEqual(before);expect(hand).toHaveLength(13);expect(Object.isFrozen(score)).toBe(true);expect(Object.isFrozen(score!.labels)).toBe(true);
  });
  it('finds ready tiles and maximum non-event value without fifth-copy waits',()=>{
    const waits=getSichuanWaits(flat.slice(0,13),[],'条');expect(waits.map(w=>w.tile)).toContain('五筒');expect(waits.every(w=>!w.tile.endsWith('条')&&!w.tile.includes('风'))).toBe(true);expect(waits.every(w=>!w.labels.includes('自摸'))).toBe(true);expect(Object.isFrozen(waits)).toBe(true);
    const four=tiles('一万 一万 一万 一万 二万 三万 四万 五万 六万 七万 八筒 八筒 八筒');expect(getSichuanWaits(four,[],'条').some(w=>w.tile==='一万')).toBe(false);expect(getSichuanWaits(flat.slice(0,13),[],'万')).toHaveLength(0);
  });
});
