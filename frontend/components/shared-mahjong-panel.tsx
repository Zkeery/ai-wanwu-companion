'use client';
import { useState } from 'react';
import type { Gathering } from '@/lib/gatherings';
import type { useSharedMahjong } from '@/lib/use-shared-mahjong';
const blockedText: Record<string, string> = { wrong_scene: '麻将桌只在家庭庭院开放。', not_full: '请让四位伙伴分别入座，再开始本局。', no_owned_participant: '需要你自己的伙伴在桌边入座。', game_in_progress: '本局已经开始，正在接着打。', invalid_participant: '有伙伴暂时无法参与，请核对在场情况。', seat_conflict: '座位有冲突，请先核对四个座位。' };
const phaseNames: Record<string, string> = { exchange: '换三张', dingque: '定缺', draw: '摸牌', hold: '理牌', discard: '出牌', claim: '应牌', win: '本轮胡牌', ended: '本局结束' };
type Props = { gathering: Gathering; state: ReturnType<typeof useSharedMahjong>; suspended?: boolean };

export default function SharedMahjongPanel({ gathering, state, suspended = false }: Props) {
  const [handsOpen, setHandsOpen] = useState(false);
  const snapshot = state.snapshot, game = snapshot?.game, disabled = state.busy || suspended || state.needsRefresh;
  const name = (id: number) => gathering.companions.find(c => c.id === id)?.name ?? `伙伴 ${id}`;
  return <section className="team-panel hub-mahjong" aria-label="共同麻将桌">
    <div className="hub-section-heading"><div><h2>麻将桌</h2><p>四位伙伴一起打四川麻将，所有人看到同一局。规则演示免费，积分不涉及金钱。</p></div>
      <button className="button ghost" disabled={state.busy || suspended} onClick={() => void state.refresh()}>核对牌局</button></div>
    {state.error && <p role="alert">{state.error}</p>}
    {state.needsRefresh && <p role="status">上次操作尚未确认，已暂停自动推进。请先核对牌局，不会自动补发原操作。</p>}
    {!snapshot ? <p role="status">正在读取共同牌局…</p> : !game ? <><p>{blockedText[snapshot.start_blocked_reason ?? ''] ?? '四位伙伴入座后，可以开始第一局。'}</p>
      <button className="button" disabled={disabled || !snapshot.can_start} onClick={() => void state.start()}>开始本局麻将</button></>
      : <><p role="status">{game.status === 'interrupted' ? '有伙伴离席，本局已保留并停止。' : game.status === 'ended' ? '本局已结束，牌局和积分已保留。' : `${phaseNames[game.phase]} · ${name(game.turn_character_id)} · 牌墙剩余 ${game.wall_remaining} 张`}</p>
        {game.last_event && <p className="hub-mahjong-last-event">{name(game.last_event.character_id)}：{game.last_event.text}</p>}
        <div className="hub-mahjong-players" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(160px,1fr))', gap: 12 }}>
          {game.players.map(player => <article key={player.character_id} className="hub-mahjong-player"><strong>{name(player.character_id)}</strong><p>{player.hand_count} 张手牌 · 牌背{player.won ? ' · 已胡牌' : ''}</p><p>本局积分 {player.score}{player.missing_suit ? ` · 定缺${player.missing_suit}` : ''}</p>
            <p>已出：{player.discards.map(tile => tile.face).join('、') || '暂无'}</p><p>副露：{player.melds.map(meld => meld.concealed ? `暗杠（${meld.tile_count} 张牌背）` : `${meld.kind === 'kong' ? '杠' : '碰'} ${meld.tiles.map(tile => tile.face).join(' ')}`).join('；') || '暂无'}</p></article>)}
        </div>
        {game.own_hands.length > 0 && <div className="hub-own-mahjong-hands"><button className="button ghost" aria-expanded={handsOpen} onClick={() => setHandsOpen(value => !value)}>{handsOpen ? '收起我的手牌' : '查看我的手牌'}</button>
          {handsOpen && game.own_hands.map(hand => <div key={hand.character_id} aria-label={`${name(hand.character_id)}的本人手牌`}><strong>{name(hand.character_id)}</strong><p>{hand.tiles.map(tile => <span key={tile.id} style={{ display: 'inline-block', margin: 3, padding: '5px 8px', border: '1px solid #d8c9b8', borderRadius: 4 }}>{tile.face}</span>)}</p></div>)}</div>}
        {game.status !== 'playing' && <button className="button" disabled={disabled || !snapshot.can_new_round} onClick={() => void state.newRound()}>明确开始下一局</button>}
        <small>刷新会接着读取这一局；不会自动开局，也不会自动连开下一局。</small>
      </>}
  </section>;
}
