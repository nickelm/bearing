/**
 * The sky's background node on Dawn (decision 140): the stars keep their
 * places among each other under a turning camera and a turning sky, day
 * evaluates no star, the moon shows its phase with the lit limb toward the
 * sun, and the sun's disk sits where the sun is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NoToneMapping, PerspectiveCamera, Scene } from 'three/webgpu';
import { DEG, PLANET_RADIUS } from '../../src/core/units';
import { Vec3d } from '../../src/core/vec3d';
import { starVisibility } from '../../src/render/sim/atmosphere/skyView';
import { PlanetLighting } from '../../src/render/sim/lighting/planetLighting';
import { testGpu } from './device';
import { headlessRenderer } from './renderer';
import type { HeadlessRenderer } from './renderer';
import { encodePng } from '../../tools/png';

const gpu = await testGpu();
const SIZE = 256;

interface Sky {
  head: HeadlessRenderer;
  lighting: PlanetLighting;
  camera: PerspectiveCamera;
  /** Draws the sky looking along `forward` with `up` and returns the frame's bytes. */
  draw(forward: Vec3d, up: Vec3d, name?: string): Promise<Uint8Array>;
}

/** A camera at the north pole, 100 m up, under a bare sky. */
async function sky(fov: number): Promise<Sky> {
  const head = await headlessRenderer(gpu!.device, SIZE, SIZE);
  head.renderer.toneMapping = NoToneMapping;
  const lighting = new PlanetLighting();
  const scene = new Scene();
  scene.backgroundNode = lighting.atmosphere.skyNode();
  const camera = new PerspectiveCamera(fov, 1, 0.1, 10);
  return {
    head,
    lighting,
    camera,
    async draw(forward, up, name) {
      camera.position.set(0, 0, 0);
      camera.up.set(up.x, up.y, up.z);
      camera.lookAt(forward.x, forward.y, forward.z);
      camera.updateMatrixWorld();
      lighting.atmosphere.bakeSky(head.renderer);
      head.renderer.render(scene, camera);
      await gpu!.finish();
      const rgb = await head.readRgb();
      // SKY_DUMP=dir keeps the frames as PNGs, to look at what a test saw.
      if (process.env.SKY_DUMP && name) {
        mkdirSync(process.env.SKY_DUMP, { recursive: true });
        writeFileSync(join(process.env.SKY_DUMP, `${name}.png`), encodePng(SIZE, SIZE, rgb));
      }
      return rgb;
    },
  };
}

const EYE = new Vec3d(0, PLANET_RADIUS + 100, 0);
/** A direction at an elevation above the pole's horizon and an azimuth about +Y (degrees). */
const aim = (elevation: number, azimuth: number) =>
  new Vec3d(
    Math.cos(elevation * DEG) * Math.sin(azimuth * DEG),
    Math.sin(elevation * DEG),
    Math.cos(elevation * DEG) * Math.cos(azimuth * DEG),
  );
/** The camera's up for a view along `forward`: the zenith, tipped back. */
const upFor = (forward: Vec3d) => new Vec3d(0, 1, 0).addScaled(forward, -forward.y).normalize();

const value = (rgb: Uint8Array, x: number, y: number) =>
  rgb[(y * SIZE + x) * 3]! + rgb[(y * SIZE + x) * 3 + 1]! + rgb[(y * SIZE + x) * 3 + 2]!;

interface Spot {
  x: number;
  y: number;
  flux: number;
}

/** Bright points of a frame: local maxima above the background, with centroid and summed light. */
function spots(rgb: Uint8Array, threshold: number): Spot[] {
  const out: Spot[] = [];
  for (let y = 4; y < SIZE - 4; y++) {
    for (let x = 4; x < SIZE - 4; x++) {
      const v = value(rgb, x, y);
      if (v < threshold) continue;
      let peak = true;
      for (let dy = -2; dy <= 2 && peak; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const w = value(rgb, x + dx, y + dy);
          if (w > v || (w === v && (dy < 0 || (dy === 0 && dx < 0)))) {
            peak = false;
            break;
          }
        }
      }
      if (!peak) continue;
      // Above the sky around it, or the centroid would lean toward the window's middle.
      let floor = Infinity;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) floor = Math.min(floor, value(rgb, x + dx, y + dy));
      }
      let sum = 0;
      let sx = 0;
      let sy = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const w = value(rgb, x + dx, y + dy) - floor;
          sum += w;
          sx += w * (x + dx);
          sy += w * (y + dy);
        }
      }
      out.push({ x: sx / sum, y: sy / sum, flux: sum });
    }
  }
  return out;
}

/** The world direction through a pixel position of a camera looking along `forward`. */
function rayThrough(s: Sky, forward: Vec3d, up: Vec3d, x: number, y: number): Vec3d {
  const t = Math.tan((s.camera.fov * DEG) / 2);
  const right = forward.clone().cross(up).normalize();
  const top = right.clone().cross(forward).normalize();
  const u = (((x + 0.5) / SIZE) * 2 - 1) * t;
  const v = (1 - ((y + 0.5) / SIZE) * 2) * t;
  return forward.clone().addScaled(right, u).addScaled(top, v).normalize();
}

/** The pixel position at which a camera looking along `forward` sees a world direction. */
function pixelOf(s: Sky, forward: Vec3d, up: Vec3d, d: Vec3d): [number, number] {
  const t = Math.tan((s.camera.fov * DEG) / 2);
  const right = forward.clone().cross(up).normalize();
  const top = right.clone().cross(forward).normalize();
  const z = d.dot(forward);
  return [
    ((d.dot(right) / z / t + 1) / 2) * SIZE - 0.5,
    ((1 - d.dot(top) / z / t) / 2) * SIZE - 0.5,
  ];
}

const night = (s: Sky, rotation = 0.4, clock = 12.3) => {
  // The sun far below, the moon down: a dark sky and every star.
  s.lighting.update(EYE, aim(-50, 0), aim(-60, 180));
  s.lighting.atmosphere.sky.setCelestial(-50 * DEG, 1, 0, rotation, clock);
  s.lighting.atmosphere.sky.moonDisk.value = 0;
  s.lighting.atmosphere.sky.earthshine.value = 0;
};

describe.skipIf(!gpu)('sky background (TSL on Dawn)', () => {
  it('draws stars as points that keep their places when the camera turns', async () => {
    const s = await sky(40);
    night(s);
    const f0 = aim(48, 20);
    const a = spots(await s.draw(f0, upFor(f0), 'stars-a'), 120);
    // A turn of a few pixels and a fraction: every star lands between pixel centers.
    const f1 = aim(48.31, 20.83);
    // Fainter ones count too in the second frame: a star's brightest pixel changes as it moves.
    const b = spots(await s.draw(f1, upFor(f1), 'stars-b'), 40);
    s.head.dispose();
    expect(gpu!.errors).toEqual([]);
    expect(a.length).toBeGreaterThan(25);
    expect(a.length).toBeLessThan(400);

    const misses: number[] = [];
    const changes: number[] = [];
    for (const star of a) {
      const [x, y] = pixelOf(s, f1, upFor(f1), rayThrough(s, f0, upFor(f0), star.x, star.y));
      if (x < 8 || y < 8 || x > SIZE - 9 || y > SIZE - 9) continue;
      let best: Spot | null = null;
      let distance = Infinity;
      for (const other of b) {
        const d = Math.hypot(other.x - x, other.y - y);
        if (d < distance) {
          distance = d;
          best = other;
        }
      }
      expect(best).not.toBeNull();
      misses.push(distance);
      changes.push(Math.abs(best!.flux - star.flux) / star.flux);
    }
    misses.sort((p, q) => p - q);
    changes.sort((p, q) => p - q);
    const at = (list: number[], share: number) => list[Math.floor(share * (list.length - 1))]!;
    console.log(
      `stars: ${a.length} in view, ${misses.length} followed; miss median ${at(misses, 0.5).toFixed(2)} px, ` +
        `90% within ${at(misses, 0.9).toFixed(2)} px, worst ${at(misses, 1).toFixed(2)} px; ` +
        `light changes by ${(at(changes, 0.5) * 100).toFixed(0)}% (median), ${(at(changes, 0.9) * 100).toFixed(0)}% (90%)`,
    );
    expect(misses.length).toBeGreaterThan(20);
    // Each star is where the turn takes it and as bright as before: none crawls against
    // the others, appears or vanishes. The few larger misses are pairs of stars sharing
    // a centroid window.
    expect(at(misses, 0.5)).toBeLessThan(0.08);
    expect(at(misses, 0.9)).toBeLessThan(0.3);
    expect(at(misses, 1)).toBeLessThan(1.5);
    expect(at(changes, 0.9)).toBeLessThan(0.2);
  }, 240_000);

  it('turns the stars with the celestial sphere, as one body', async () => {
    const s = await sky(40);
    const f0 = aim(55, 0);
    night(s, 0.4);
    const a = await s.draw(f0, upFor(f0), 'turn-a');
    // The sphere turns by 17° about the pole; a camera turned with it sees the same sky.
    night(s, 0.4 + 17 * DEG);
    const f1 = aim(55, 17);
    const b = await s.draw(f1, upFor(f1), 'turn-b');
    // The same camera as at first now sees other stars.
    const c = await s.draw(f0, upFor(f0));
    s.head.dispose();
    expect(gpu!.errors).toEqual([]);
    /** The share of the first frame's stars that stand at the same place in the second. */
    const kept = (p: Uint8Array, q: Uint8Array) => {
      const first = spots(p, 120);
      const second = spots(q, 40);
      expect(first.length).toBeGreaterThan(25);
      let same = 0;
      for (const star of first) {
        if (second.some((o) => Math.hypot(o.x - star.x, o.y - star.y) < 0.15)) same++;
      }
      return same / first.length;
    };
    expect(kept(a, b)).toBeGreaterThan(0.97);
    expect(kept(a, c)).toBeLessThan(0.1);
  }, 240_000);

  it('evaluates no star by day', async () => {
    // The uniform that gates the stars is exactly zero until the sun is well down.
    for (const elevation of [90, 30, 5, 0, -1.5]) expect(starVisibility(elevation * DEG)).toBe(0);
    expect(starVisibility(-3 * DEG)).toBeGreaterThan(0);
    expect(starVisibility(-8 * DEG)).toBe(1);

    const s = await sky(30);
    const f = aim(40, 30);
    const day = (poison: boolean) => {
      s.lighting.update(EYE, aim(35, 100), aim(-60, 180));
      const sky = s.lighting.atmosphere.sky;
      sky.setCelestial(35 * DEG, 0, 0, poison ? Number.NaN : 0.4, poison ? Number.NaN : 3);
      expect(sky.stars.value).toBe(0);
    };
    day(false);
    const clean = await s.draw(f, upFor(f));
    // Not-a-number in everything only the stars read: if any of it were evaluated and
    // merely multiplied by zero, the frame would change.
    day(true);
    const poisoned = await s.draw(f, upFor(f));
    s.head.dispose();
    expect(gpu!.errors).toEqual([]);
    expect(Array.from(poisoned)).toEqual(Array.from(clean));
    // And it is a sky: blue and not black.
    expect(clean[2]!).toBeGreaterThan(clean[0]!);
    expect(clean[2]!).toBeGreaterThan(40);
  }, 240_000);

  it('shows the moon with its phase, the lit limb toward the sun', async () => {
    const s = await sky(4);
    const moon = aim(40, 0);
    const up = upFor(moon);
    const right = moon.clone().cross(up).normalize();
    const lit = async (sun: Vec3d, name: string) => {
      s.lighting.update(EYE, sun, moon);
      s.lighting.atmosphere.sky.setCelestial(-40 * DEG, 1, 0.5, 0, 0);
      s.lighting.atmosphere.sky.stars.value = 0;
      const rgb = await s.draw(moon, up, `moon-${name}`);
      // Light in the disk's right and left halves above the sky's (the moon is 0.52° of
      // the 4° view).
      const sky = value(rgb, 6, 6);
      let leftSum = 0;
      let rightSum = 0;
      const radius = Math.ceil((0.52 / 4) * SIZE);
      for (let y = SIZE / 2 - radius; y < SIZE / 2 + radius; y++) {
        for (let x = SIZE / 2 - radius; x < SIZE / 2 + radius; x++) {
          const light = Math.max(0, value(rgb, x, y) - sky);
          if (x < SIZE / 2) leftSum += light;
          else rightSum += light;
        }
      }
      return { leftSum, rightSum, all: leftSum + rightSum };
    };
    // The sun 27° below the horizon to the moon's right: a little past first quarter, lit
    // from the right. Then from the left.
    const down = new Vec3d(0, -0.5, 0);
    const fromRight = await lit(right.clone().add(down).normalize(), 'lit-from-right');
    const fromLeft = await lit(right.clone().scale(-1).add(down).normalize(), 'lit-from-left');
    // Opposite the moon: full.
    const full = await lit(moon.clone().scale(-1), 'full');
    // Next to it, by day: new, and all but invisible.
    const fresh = await lit(moon.clone().addScaled(right, 0.05).normalize(), 'new');
    s.head.dispose();
    expect(gpu!.errors).toEqual([]);
    expect(fromRight.rightSum).toBeGreaterThan(3 * fromRight.leftSum);
    expect(fromLeft.leftSum).toBeGreaterThan(3 * fromLeft.rightSum);
    expect(full.leftSum).toBeGreaterThan(0.8 * full.rightSum);
    expect(full.rightSum).toBeGreaterThan(0.8 * full.leftSum);
    expect(full.all).toBeGreaterThan(1.3 * fromRight.all);
    expect(fresh.all).toBeLessThan(0.1 * full.all);
  }, 240_000);

  it('puts the sun where the sun is, bright at the center and dimmer at the limb', async () => {
    const s = await sky(4);
    const sun = aim(30, 60);
    s.lighting.update(EYE, sun, aim(-60, 180));
    s.lighting.atmosphere.sky.setCelestial(30 * DEG, 0, 0, 0, 0);
    // Keep the disk within the frame's range to see across it.
    s.lighting.atmosphere.sky.sunDisk.value = 0.4;
    const forward = aim(30.4, 60.5);
    const rgb = await s.draw(forward, upFor(forward), 'sun');
    s.head.dispose();
    expect(gpu!.errors).toEqual([]);
    const [x, y] = pixelOf(s, forward, upFor(forward), sun);
    const center = value(rgb, Math.round(x), Math.round(y));
    const radius = (0.4 / 4) * SIZE;
    const limb = value(rgb, Math.round(x + 0.85 * radius), Math.round(y));
    const outside = value(rgb, Math.round(x + 1.3 * radius), Math.round(y));
    expect(center).toBeGreaterThan(limb + 20);
    expect(limb).toBeGreaterThan(outside + 20);
  }, 240_000);
});
