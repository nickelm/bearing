/** The main thread's promoted vehicles (R2.8, decision 335), on a stand-in scene. */
import { describe, expect, it } from 'vitest';
import { Group } from 'three/webgpu';
import { destination } from '../src/core/greatCircle';
import type { Dir } from '../src/core/greatCircle';
import { Vec3d } from '../src/core/vec3d';
import { BUBBLE_MAX_RATE, GroundUnits, PROMOTE_RANGE } from '../src/follow/groundUnits';
import type { GlobeScene } from '../src/render/sim/globeScene';
import type { CampaignInputEvent } from '../src/sim/eventLog';
import { PROMOTED, rosterSize, strengthAfterKill } from '../src/sim/ground/promotion';
import type { BattalionPicture, GroundPicture } from '../src/sim/ground/war';

const R = 6.0e6;
const GROUND = 120;
const HOME: Dir = [0, 0, 1];

function scene() {
  const explosions: Vec3d[] = [];
  const globe = {
    lighting: { shadeDiffuse: (a: unknown) => a },
    vehicles: new Group(),
    terrainReady: true,
    useTiles: false,
    terrain: { displayHeightAt: () => GROUND, displaySurfaceAt: () => GROUND },
    effects: { explode: (at: Vec3d) => explosions.push(at.clone()) },
  } as unknown as GlobeScene;
  return { globe, explosions };
}

const bn = (id: number, point: Dir, over: Partial<BattalionPicture> = {}): BattalionPicture => ({
  id,
  side: 'pact',
  kind: 'mechanized',
  seed: 1000 + id,
  strength: 1,
  killed: [],
  point,
  heading: 0,
  ...over,
});

const picture = (battalions: BattalionPicture[]): GroundPicture => ({
  revision: 1,
  fronts: [],
  units: [],
  battalions,
  wrecks: [],
});

const eyeOver = (p: Dir, up = 500) => new Vec3d(p[0], p[1], p[2]).scale(R + GROUND + up);

describe('promoted vehicles near the player (R2.8)', () => {
  it('promotes the battalions within range, holds them, and demotes them far away', () => {
    const { globe } = scene();
    const posted: CampaignInputEvent[] = [];
    const u = new GroundUnits(globe, R, (i) => posted.push(i));
    const far = destination(HOME, 1, PROMOTE_RANGE + 5_000, R);
    u.setPicture(picture([bn(1, HOME), bn(2, far)]));
    u.place(eyeOver(HOME));
    expect(u.stats.battalions).toBe(1);
    expect(u.stats.vehicles).toBe(PROMOTED.mechanized);
    // The vehicles stand on the drawn ground, their centers above it.
    const targets = u.targets(eyeOver(HOME));
    expect(targets.length).toBe(PROMOTED.mechanized);
    for (const t of targets) expect(t.pos.length() - R).toBeGreaterThan(GROUND);
    // The front moves: a promoted battalion keeps where it stood until it is demoted.
    const moved = destination(HOME, 0, 3000, R);
    u.setPicture(picture([bn(1, moved), bn(2, far)]));
    u.place(eyeOver(HOME));
    expect(u.targets(eyeOver(HOME)).map((t) => t.pos)).toEqual(targets.map((t) => t.pos));
    // Far away, demoted; past 16×, the bubble collapses.
    u.place(eyeOver(destination(HOME, 3, 40_000, R)));
    expect(u.stats.battalions).toBe(0);
    u.place(eyeOver(HOME));
    expect(u.stats.battalions).toBe(1);
    u.rate = BUBBLE_MAX_RATE * 4;
    u.place(eyeOver(HOME));
    expect(u.stats.vehicles).toBe(0);
    expect(posted).toEqual([]);
  });

  it('destroys a vehicle at a damage of 1, posts it, and leaves a wreck that stays', () => {
    const { globe, explosions } = scene();
    const posted: CampaignInputEvent[] = [];
    const u = new GroundUnits(globe, R, (i) => posted.push(i));
    u.setPicture(picture([bn(1, HOME)]));
    u.place(eyeOver(HOME));
    const t = u.targets(eyeOver(HOME))[0]!;
    const hit = (amount: number) =>
      u.hit({ target: t.id, air: false, amount, cause: 'bomb', at: t.pos, time: 0 }, 42);
    expect(hit(0.5)).toBeNull();
    expect(hit(0.6)).not.toBeNull();
    expect(hit(0.6)).toBeNull();
    expect(explosions.length).toBe(1);
    expect(posted.length).toBe(1);
    const p = posted[0]!;
    expect(p.kind).toBe('vehicle-destroyed');
    if (p.kind !== 'vehicle-destroyed') return;
    expect(p.battalion).toBe(1);
    expect(p.by).toBe(42);
    u.place(eyeOver(HOME));
    expect(u.stats.vehicles).toBe(PROMOTED.mechanized - 1);
    expect(u.stats.wrecks).toBe(1);
    expect(u.targets(eyeOver(HOME)).some((x) => x.id === t.id)).toBe(false);
    // The wreck burns as a column.
    expect(u.columns(0, null).length).toBe(1);
    // The worker's picture brings the kill back: promoted again later, it stays dead.
    u.setPicture({
      ...picture([
        bn(1, HOME, { strength: strengthAfterKill('mechanized', 1), killed: [p.vehicle] }),
      ]),
      wrecks: [
        {
          battalion: 1,
          vehicle: p.vehicle,
          type: 'ifv',
          side: 'pact',
          point: p.point,
          heading: p.heading,
          time: 0,
        },
      ],
    });
    u.place(eyeOver(destination(HOME, 3, 40_000, R)));
    u.place(eyeOver(HOME));
    expect(u.targets(eyeOver(HOME)).some((x) => x.id === t.id)).toBe(false);
    expect(u.stats.wrecks).toBe(1);
    expect(rosterSize('mechanized')).toBeGreaterThan(PROMOTED.mechanized);
  });
});
