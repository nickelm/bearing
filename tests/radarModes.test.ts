/**
 * The radar's second step (decision 223): air combat mode in a dogfight with its
 * automatic lock, ranges in each skin's units, click-to-lock spots on the scope, and the
 * threat warning's calls.
 */
import { describe, expect, it } from 'vitest';
import { Vec3d } from '../src/core/vec3d';
import { applyCommand, initialAvionics, radarDisplayRange } from '../src/sim/avionics/avionics';
import { ACM_CONE, ACM_RANGE, acmAcquire, SensorModel } from '../src/sim/sensors/sensors';
import type { OwnShip, RadarSpec, SensorPicture, SensorTarget } from '../src/sim/sensors/sensors';
import { clockPosition, threatCalls } from '../src/ui/displays/calls';
import type { SnapshotThreat } from '../src/ui/displays/snapshot';

const R = 1_000_000;
const at = (north: number, east: number, alt: number) => new Vec3d(east, north, R + alt);
const PD: RadarSpec = { kind: 'pulse-doppler', range: 70_000, azimuth: 1, elevation: 1, notch: 40 };
const fwd = new Vec3d(0, 1, 0);
const up = new Vec3d(0, 0, 1);

describe('air combat mode (decision 223)', () => {
  it('comes with dogfight and goes with it, a lock kept, a broken lock back to the cone', () => {
    let a = initialAvionics(false);
    a = applyCommand(a, { type: 'dogfight' });
    expect(a.radar.mode).toBe('acm');
    a = applyCommand(a, { type: 'radar-lock', id: 'x' });
    expect(a.radar.mode).toBe('stt');
    a = applyCommand(a, { type: 'radar-lock', id: null });
    expect(a.radar.mode).toBe('acm');
    a = applyCommand(a, { type: 'dogfight' });
    expect(a.radar).toMatchObject({ mode: 'rws', lock: null });
    // A lock held into and out of the dogfight stays.
    a = applyCommand(a, { type: 'radar-lock', id: 'y' });
    a = applyCommand(applyCommand(a, { type: 'dogfight' }), { type: 'dogfight' });
    expect(a.radar).toMatchObject({ mode: 'stt', lock: 'y' });
    // Another master mode by hand leaves air combat mode.
    a = applyCommand(applyCommand(initialAvionics(false), { type: 'dogfight' }), {
      type: 'master-mode',
      mode: 'air-to-air',
    });
    expect(a.radar.mode).toBe('rws');
  });

  it('scans only its cone and reach, and locks the nearest contact in it', () => {
    const own = (over: Partial<OwnShip> = {}): OwnShip => ({
      id: 'own',
      side: 'alliance',
      pos: at(0, 0, 5000),
      vel: new Vec3d(0, 250, 0),
      forward: fwd,
      up,
      radar: PD,
      radarOn: true,
      radarMode: 'acm',
      lock: null,
      rwr: false,
      datalink: false,
      ...over,
    });
    const target = (id: string, north: number, east: number): SensorTarget => ({
      id,
      side: 'pact',
      pos: at(north, east, 5000),
      vel: new Vec3d(0, -250, 0),
      rcs: 5,
      size: 15,
      airborne: true,
      emitter: null,
    });
    const targets = [
      target('near', 6000, 300),
      target('far', 12_000, -500),
      target('wide', 5000, 3000), // 31° off the nose
      target('beyond', ACM_RANGE + 3000, 0),
    ];
    const m = new SensorModel();
    const env = { time: 10, visibility: 0, daylight: 0, lineOfSight: () => true };
    m.update(own(), targets, env, null);
    expect(m.picture.contacts.map((c) => c.id)).toEqual(['far', 'near']);
    expect(acmAcquire(m.picture, own().pos, fwd, up, 10)).toBe('near');
    const empty: SensorPicture = { time: 10, contacts: [], threats: [] };
    expect(acmAcquire(empty, own().pos, fwd, up, 10)).toBeNull();
    expect(ACM_CONE).toBeCloseTo((10 * Math.PI) / 180, 9);
  });
});

describe('display ranges by skin (decision 223)', () => {
  it('steps in nautical miles for the Alliance and round kilometers for the Pact', () => {
    expect([0, 1, 2, 3].map((i) => radarDisplayRange('alliance', i) / 1852)).toEqual([
      10, 20, 40, 80,
    ]);
    expect([0, 1, 2, 3].map((i) => radarDisplayRange('pact', i) / 1000)).toEqual([20, 40, 80, 150]);
    expect(radarDisplayRange('alliance', 3, 'acm')).toBe(10 * 1852);
    expect(radarDisplayRange('pact', 3, 'acm')).toBe(20_000);
  });
});

describe("the threat warning's calls (decision 223)", () => {
  const t = (
    id: string,
    state: SnapshotThreat['state'],
    azimuth = Math.PI / 2,
  ): SnapshotThreat => ({
    id,
    kind: 'SA6',
    azimuth,
    state,
    ground: true,
  });

  it('gives clock positions', () => {
    expect(clockPosition(0)).toBe(12);
    expect(clockPosition(Math.PI / 2)).toBe(3);
    expect(clockPosition(-Math.PI / 2)).toBe(9);
    expect(clockPosition(Math.PI)).toBe(6);
    expect(clockPosition(0.4)).toBe(1);
  });

  it('calls a new emitter once, again when it tracks or launches, and again after it went quiet', () => {
    let heard = new Map<string, SnapshotThreat['state']>();
    const step = (threats: SnapshotThreat[]) => {
      const r = threatCalls(heard, threats);
      heard = r.heard;
      return r.calls;
    };
    expect(step([t('a', 'search')])).toEqual([
      { text: "SA6 search radar, 3 o'clock", warn: false, tone: 'new' },
    ]);
    expect(step([t('a', 'search')])).toEqual([]);
    expect(step([t('a', 'track')])).toEqual([
      { text: "SA6 tracking, 3 o'clock", warn: true, tone: 'track' },
    ]);
    expect(step([t('a', 'track')])).toEqual([]);
    expect(step([t('a', 'search')])).toEqual([]);
    expect(step([t('a', 'launch')])[0]).toMatchObject({ warn: true, tone: 'launch' });
    expect(step([])).toEqual([]);
    expect(step([t('a', 'track', -Math.PI / 2)])).toEqual([
      { text: "SA6 tracking, 9 o'clock", warn: true, tone: 'track' },
    ]);
  });
});
