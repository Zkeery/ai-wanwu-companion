/** Local Sichuan blood-battle profile: four fan cap, no cash or network. */
export type SichuanSuit='万'|'筒'|'条';
export type SichuanMeld=Readonly<{kind:'chow'|'pung'|'kong';tiles:readonly string[];concealed?:boolean}>;
export type SichuanScore=Readonly<{fan:number;rawFan:number;points:number;labels:readonly string[]}>;
export type SichuanScoreInput=Readonly<{hand:readonly string[];melds:readonly SichuanMeld[];missingSuit:SichuanSuit;winningTile?:string;selfDraw?:boolean;afterKong?:boolean;robbedKong?:boolean;kongDiscard?:boolean;lastTile?:boolean;heavenly?:boolean;earthly?:boolean}>;
const SUITS:readonly SichuanSuit[]=['万','筒','条'];
const NUMERALS=['一','二','三','四','五','六','七','八','九'];
const TILES=SUITS.flatMap(suit=>NUMERALS.map(n=>n+suit));
const INDEX=new Map(TILES.map((tile,index)=>[tile,index]));
function parse(tiles:readonly string[]):number[]|null{const result:number[]=[];for(const tile of tiles){const i=INDEX.get(tile);if(i===undefined)return null;result.push(i);}return result;}
function countsOf(tiles:readonly number[]){const counts=Array<number>(27).fill(0);for(const tile of tiles)counts[tile]++;return counts;}
function groups(counts:number[],remaining:number,terminalOnly=false):boolean{
  const first=counts.findIndex(c=>c>0);if(first<0)return remaining===0;if(remaining<=0)return false;
  if(counts[first]>=3&&(!terminalOnly||first%9===0||first%9===8)){counts[first]-=3;const ok=groups(counts,remaining-1,terminalOnly);counts[first]+=3;if(ok)return true;}
  if(first%9<=6&&counts[first+1]>0&&counts[first+2]>0&&(!terminalOnly||first%9===0||first%9===6)){
    counts[first]--;counts[first+1]--;counts[first+2]--;const ok=groups(counts,remaining-1,terminalOnly);counts[first]++;counts[first+1]++;counts[first+2]++;if(ok)return true;
  }return false;
}
function standard(counts:number[],meldCount:number,terminalOnly=false):boolean{
  for(let pair=0;pair<27;pair++)if(counts[pair]>=2&&(!terminalOnly||pair%9===0||pair%9===8)){counts[pair]-=2;const ok=groups(counts,4-meldCount,terminalOnly);counts[pair]+=2;if(ok)return true;}return false;
}
function triplets(counts:readonly number[],meldCount:number):boolean{
  for(let pair=0;pair<27;pair++)if(counts[pair]>=2){const rest=counts.map((n,index)=>n-(index===pair?2:0));if(rest.every(n=>n%3===0)&&rest.reduce((a,n)=>a+n/3,0)===4-meldCount)return true;}return false;
}
export function scoreSichuanHand(input:SichuanScoreInput):SichuanScore|null{
  if(!SUITS.includes(input.missingSuit)||input.melds.length>4)return null;
  const hand=parse(input.winningTile===undefined?input.hand:[...input.hand,input.winningTile]);if(!hand||hand.length!==14-input.melds.length*3)return null;
  const meldTiles:number[]=[];
  for(const meld of input.melds){const values=parse(meld.tiles);if(!values||!['pung','kong'].includes(meld.kind)||values.length!==(meld.kind==='kong'?4:3)||values.some(v=>v!==values[0]))return null;meldTiles.push(...values);}
  const all=[...hand,...meldTiles],counts=countsOf(hand),allCounts=countsOf(all);
  if(allCounts.some(n=>n>4)||all.some(tile=>SUITS[Math.floor(tile/9)]===input.missingSuit))return null;
  const seven=input.melds.length===0&&counts.every(n=>n%2===0),regular=standard([...counts],input.melds.length);
  if(!seven&&!regular)return null;
  let rawFan=0;const labels:string[]=[];const add=(label:string,fan:number)=>{labels.push(label);rawFan+=fan;};
  const allTriplets=regular&&triplets(counts,input.melds.length);
  if(seven)add('七对',2);else if(allTriplets)add('对对胡',1);
  if(new Set(all.map(tile=>Math.floor(tile/9))).size===1)add('清一色',2);
  if(regular&&meldTiles.every(tile=>tile%9===0||tile%9===8)&&standard([...counts],input.melds.length,true))add('带幺九',2);
  if(!seven&&allTriplets&&all.every(tile=>[1,4,7].includes(tile%9)))add('将对',2);
  if(input.melds.length===4)add('金钩钓',1);
  const roots=allCounts.filter(n=>n===4).length;if(roots)add(roots===1?'根':roots+'根',roots);
  if(input.selfDraw)add('自摸',1);if(input.afterKong)add('杠上花',1);if(input.kongDiscard)add('杠上炮',1);if(input.robbedKong)add('抢杠胡',1);if(input.lastTile)add(input.selfDraw?'海底捞月':'海底炮',1);
  if(input.heavenly){labels.push('天胡');rawFan=Math.max(rawFan,4);}else if(input.earthly){labels.push('地胡');rawFan=Math.max(rawFan,4);}
  if(labels.length===0)labels.push('平胡');const fan=Math.min(4,rawFan);
  return Object.freeze({fan,rawFan,points:2**fan,labels:Object.freeze(labels)});
}
export function getSichuanWaits(hand:readonly string[],melds:readonly SichuanMeld[],missingSuit:SichuanSuit):readonly Readonly<SichuanScore&{tile:string}>[]{
  if(!SUITS.includes(missingSuit)||hand.length!==13-melds.length*3)return Object.freeze([]);
  const own=parse([...hand,...melds.flatMap(m=>m.tiles)]);if(!own)return Object.freeze([]);const counts=countsOf(own);
  return Object.freeze(TILES.flatMap((tile,index)=>{if(counts[index]>=4||tile.endsWith(missingSuit))return[];const score=scoreSichuanHand({hand,melds,missingSuit,winningTile:tile});return score?[Object.freeze({...score,tile})]:[];}));
}
