/**
 * The threat warning's calls (decision 223): what the RWR says when an emitter appears
 * or changes state, as a message line and a tone. Pure: the caller keeps the states
 * heard last time and passes them back.
 */
import type { SnapshotThreat } from './snapshot';

export type ThreatTone = 'new' | 'track' | 'launch';

export interface ThreatCall {
  text: string;
  warn: boolean;
  tone: ThreatTone;
}

/** A bearing off the nose (rad, + right) as a clock position: 12 ahead, 3 to the right. */
export function clockPosition(azimuth: number): number {
  const h = Math.round((azimuth / (2 * Math.PI)) * 12);
  return ((h % 12) + 12) % 12 || 12;
}

const RANK = { search: 0, track: 1, launch: 2 } as const;

/**
 * The calls for `threats` against `heard` (id → state last time), and the states to keep.
 * A new emitter is called once; one that starts tracking or launching is called again, as a
 * warning. An emitter that goes quiet and comes back is new again.
 */
export function threatCalls(
  heard: ReadonlyMap<string, SnapshotThreat['state']>,
  threats: readonly SnapshotThreat[],
): { calls: ThreatCall[]; heard: Map<string, SnapshotThreat['state']> } {
  const calls: ThreatCall[] = [];
  const next = new Map<string, SnapshotThreat['state']>();
  for (const t of threats) {
    next.set(t.id, t.state);
    const before = heard.get(t.id);
    const at = `${clockPosition(t.azimuth)} o'clock`;
    if (t.state === 'launch' && before !== 'launch')
      calls.push({ text: `Missile launch, ${t.kind}, ${at}`, warn: true, tone: 'launch' });
    else if (t.state === 'track' && (before === undefined || RANK[before] < RANK.track))
      calls.push({ text: `${t.kind} tracking, ${at}`, warn: true, tone: 'track' });
    else if (before === undefined)
      calls.push({
        text: `${t.kind} ${t.ground ? 'search radar' : 'radar'}, ${at}`,
        warn: false,
        tone: 'new',
      });
  }
  return { calls, heard: next };
}
