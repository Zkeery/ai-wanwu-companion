import { gatheringCompanionArea, type Gathering, type GatheringArea } from './gatherings';
export type LivingBubble = { kind: 'dialogue' | 'history' | 'preset'; text: string };
export type LivingBubbleReceipts = ReadonlyMap<string, number>;
type Snapshot = Pick<Gathering, 'id' | 'me' | 'events'>;
function realConversation(event: Gathering['events'][number]) {
  return event.kind === 'dialogue' && event.origin === 'real_provider'
    && event.area !== undefined && !!event.lines?.length;
}
/** Validate delivery against present membership and later activity, without shortening an audible line. */
export function isLivingConversationCaptionValid(g: Gathering, id: number, eventId: string, history = false): boolean {
  if (g.closed || !g.members.some(member => member.id === g.me)) return false;
  const companion = g.companions.find(c => c.id === id), index = g.events.findIndex(e => e.id === eventId && realConversation(e));
  const event = g.events[index];
  return !!companion && !!event && event.area === gatheringCompanionArea(g, companion)
    && !!event.lines?.some(line => line.character_id === id)
    && (history || !g.events.slice(index + 1).some(e => e.kind === 'activity' && e.characters.includes(id)));
}
/** Page-local delivery receipts contain IDs and times, never conversation text. */
export function createLivingBubbleClock(initial: Snapshot) {
  let scope = JSON.stringify([initial.id, initial.me]);
  const seen = new Set(initial.events.map(event => event.id));
  const received = new Map<string, number>();
  return {
    receipts: received as LivingBubbleReceipts,
    observe(snapshot: Snapshot, area: GatheringArea | 'all', now: number) {
      const nextScope = JSON.stringify([snapshot.id, snapshot.me]);
      if (scope !== nextScope) {
        scope = nextScope; seen.clear(); received.clear();
        snapshot.events.forEach(event => seen.add(event.id));
        return;
      }
      for (const event of snapshot.events) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        // Other-room events are seen; switching rooms must not restart them.
        if (realConversation(event) && (area === 'all' || event.area === area) && Number.isFinite(now)) received.set(event.id, now);
      }
    },
  };
}
/** Only authorized shared lines become speech, once in their saved order. */
export function livingBubble(g: Gathering, id: number, now: number, animate: boolean, replayAt: number | null = null, receipts?: LivingBubbleReceipts): LivingBubble | null {
  const companion = g.companions.find(c => c.id === id);
  if (!companion || !animate || g.closed || !g.members.some(member => member.id === g.me)) return null;
  const area = gatheringCompanionArea(g, companion);
  // Every character in this room shares one conversation and one speaking cursor.
  const index = g.events.findLastIndex(e => realConversation(e) && e.area === area);
  const latest = g.events[index];
  if (!latest?.lines?.length) return null;
  const history = replayAt !== null;
  const start = history ? replayAt : receipts?.get(latest.id);
  if (start === undefined || start === null) return null;
  const since = now - start;
  if (!Number.isFinite(since) || since < 0) return null;
  // An absent speaker leaves a silent slot; never advance everyone else's saved turn.
  const line = latest.lines[Math.floor(since / 3.5)];
  return line?.character_id === id && isLivingConversationCaptionValid(g, id, latest.id, history)
    ? { kind: history ? 'history' : 'dialogue', text: line.text } : null;
}
