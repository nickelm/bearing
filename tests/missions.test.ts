import { describe, expect, it } from 'vitest';
import { DEFAULT_JUMP_IN, MISSION_PROFILES } from '../src/sim/air/mission';
import type { Mission } from '../src/sim/air/mission';
import { MASTER_MODES } from '../src/sim/avionics/avionics';
import { DOCTRINE, scheduleTimes } from '../src/sim/command/doctrine';
import { bySegment } from '../src/sim/command/missions/common';
import { isPending, PLUGIN_PARTS } from '../src/sim/command/missions/plugin';
import type { BriefingInput, MissionOutcome } from '../src/sim/command/missions/plugin';
import { MISSION_PLUGINS, pendingParts } from '../src/sim/command/missions/registry';
import { rng } from '../src/core/rng';
import { HOUR } from '../src/core/units';
import type { FrontSegment } from '../src/sim/command/front';

const DEMO = ['cap', 'interdiction', 'cas', 'airlift'];

describe('the mission registry', () => {
  it('registers each type once, the four demo types first', () => {
    const types = MISSION_PLUGINS.map((p) => p.type);
    expect(new Set(types).size).toBe(types.length);
    expect(types.slice(0, 4)).toEqual(DEMO);
    for (const p of MISSION_PLUGINS)
      expect(p.status).toBe(DEMO.includes(p.type) ? 'demo' : 'provisional');
  });

  it('gives every type its eight parts, or a marker naming the milestone that builds one', () => {
    for (const p of MISSION_PLUGINS) {
      for (const part of PLUGIN_PARTS) {
        const v = p[part];
        expect(v, `${p.type}.${part}`).toBeDefined();
        if (isPending(v)) expect(v.pending, `${p.type}.${part}`).toMatch(/^R\d\.\d+$/);
      }
      // Every type plans and packages now; the ATO depends on it.
      expect(isPending(p.planner), p.type).toBe(false);
      expect(isPending(p.package), p.type).toBe(false);
    }
  });

  it('pins the parts still pending, so the list only shrinks', () => {
    // The demo types are complete (decision 282).
    const provisional = [
      'support',
      'escort',
      'sead',
      'deep-strike',
      'strategic-bombing',
      'recon',
      'helo-cas',
    ];
    expect(pendingParts()).toEqual([
      ...provisional.flatMap((t) => [
        `${t}.resolver: R4.2`,
        `${t}.behavior: R4.2`,
        `${t}.success: R4.2`,
        `${t}.interface: R4.2`,
      ]),
    ]);
  });

  it('keeps jump-in windows as the mission profiles have them', () => {
    for (const p of MISSION_PLUGINS) {
      expect(p.jumpIn, p.type).toEqual(MISSION_PROFILES[p.type].jumpIn ?? DEFAULT_JUMP_IN);
    }
  });

  it('gives the demo types an interface for every phase, in master modes that exist', () => {
    for (const p of MISSION_PLUGINS.filter((x) => x.status === 'demo')) {
      const ui = p.interface;
      if (isPending(ui)) throw new Error(`${p.type} has no interface defaults`);
      for (const phase of [
        'departure',
        'climb-out',
        'ingress',
        'fence-in',
        'on-target',
        'egress',
        'approach',
        'recovery',
      ] as const) {
        expect(ui[phase], `${p.type} ${phase}`).toBeDefined();
        expect(MASTER_MODES).toContain(ui[phase]!.masterMode);
      }
    }
  });

  it('judges outcomes and names their consequences', () => {
    const mission = (type: Mission['type'], target: Mission['target']): Mission =>
      ({
        type,
        theater: 0,
        aircraft: 2,
        needKey: 'k',
        target,
        timeline: [
          { phase: 'on-target', time: 1000 },
          { phase: 'egress', time: 2000 },
          { phase: 'complete', time: 3000 },
        ],
      }) as unknown as Mission;
    const o = (x: Partial<MissionOutcome>): MissionOutcome => ({
      completed: true,
      aborted: false,
      onStation: 0,
      effect: 0,
      delivered: 0,
      losses: 0,
      kills: 0,
      ...x,
    });
    const crit = (t: string) => {
      const s = MISSION_PLUGINS.find((p) => p.type === t)!.success;
      if (isPending(s)) throw new Error(t);
      return s;
    };
    const station = {
      kind: 'station' as const,
      id: -1,
      name: 's',
      point: [0, 0, 1] as [number, number, number],
    };
    const site = {
      kind: 'site' as const,
      id: 3,
      name: 'b',
      point: [0, 0, 1] as [number, number, number],
    };
    const base = {
      kind: 'airbase' as const,
      id: 5,
      name: 'a',
      point: [0, 0, 1] as [number, number, number],
    };
    expect(crit('cap').success(mission('cap', station), o({ onStation: 900 }))).toBe(true);
    expect(crit('cap').success(mission('cap', station), o({ onStation: 500 }))).toBe(false);
    expect(
      crit('interdiction').consequences(mission('interdiction', site), o({ effect: 0.6 })),
    ).toEqual([{ kind: 'damage', target: 3, amount: 0.6 }]);
    expect(crit('cas').success(mission('cas', station), o({ onStation: 600, effect: 0.1 }))).toBe(
      true,
    );
    const lift = crit('airlift').consequences(mission('airlift', base), o({ delivered: 1 }));
    expect(lift[0]).toMatchObject({ kind: 'stocks', base: { kind: 'airbase', id: 5 } });
  });

  it('writes briefings with the named places', () => {
    const b: BriefingInput = {
      type: 'cas',
      callsign: 'Pontiac 35',
      unit: '23rd Attack Squadron',
      aircraftName: 'A-15 Buzzard',
      aircraft: 2,
      base: 'Gar Air Base',
      places: {
        theater: 'the Lynvania front',
        target: 'the Kessar Gap',
        front: 'the Lynvania front',
        corridor: 'the Kessar Gap',
        town: 'Brod',
      },
      need: 'Close air support at the Kessar Gap',
      when: '14:05',
      stationTime: 25 * 60,
    };
    for (const p of MISSION_PLUGINS) {
      if (isPending(p.briefing)) continue;
      const text = p.briefing({ ...b, type: p.type });
      expect(text, p.type).toContain('Pontiac 35');
      expect(text, p.type).toContain('Gar Air Base');
    }
    const cas = MISSION_PLUGINS.find((p) => p.type === 'cas')!.briefing;
    if (isPending(cas)) throw new Error('cas');
    expect(cas(b)).toBe(
      'Pontiac 35, two A-15 Buzzards of the 23rd Attack Squadron from Gar Air Base. Close air support at the Kessar Gap on the Lynvania front near Brod. Check in with the ground controller at 14:05 and stay 25 minutes on call against enemy armor and artillery; keep clear of friendly troops on the line.',
    );
  });
});

describe('doctrine', () => {
  it('spreads the Alliance through the window and sends the Pact in waves', () => {
    const w: [number, number] = [0, 12 * HOUR];
    const a = scheduleTimes('alliance', 'strike', 12, w, rng(1, 't'));
    const p = scheduleTimes('pact', 'strike', 12, w, rng(1, 't'));
    // Spread: one per hour's share.
    a.forEach((t, i) =>
      expect(Math.abs(t - (i + 0.5) * HOUR)).toBeLessThanOrEqual(HOUR / 3 + 1e-6),
    );
    // Waves: every three hours from an hour in, within three minutes.
    const waves = new Set(p.map((t) => Math.round((t - HOUR) / (3 * HOUR))));
    expect(waves.size).toBe(4);
    for (const t of p) {
      const k = Math.round((t - HOUR) / (3 * HOUR));
      expect(Math.abs(t - (HOUR + k * 3 * HOUR))).toBeLessThanOrEqual(180 + 1e-6);
    }
    // Other missions spread on both sides.
    expect(scheduleTimes('pact', 'spread', 12, w, rng(1, 't'))).toEqual(
      scheduleTimes('alliance', 'spread', 12, w, rng(1, 't')),
    );
    expect(DOCTRINE.alliance.revisionHours).toBeLessThan(DOCTRINE.pact.revisionHours);
  });

  it('splits sorties over front segments by pressure', () => {
    const seg = (pressure: number) => ({ pressure }) as FrontSegment;
    expect(bySegment([seg(1), seg(0.2), seg(0.2), seg(0.6)], 20)).toEqual([10, 2, 2, 6]);
    expect(bySegment([seg(1), seg(1), seg(1)], 4).reduce((a, b) => a + b)).toBe(4);
  });
});
