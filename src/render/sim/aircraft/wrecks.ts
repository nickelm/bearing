/**
 * Aircraft shot down at full fidelity (decision 301): each falls from where it was hit with
 * its velocity, tumbling, burning and trailing smoke (drawn as a `Flying` with its motor
 * lit, by `MissileViews`), until it reaches the drawn ground and explodes there.
 */
import { Quatd } from '../../../core/quat';
import { Vec3d } from '../../../core/vec3d';
import { stepFalling } from '../../../sim/flight/ballistics';
import type { FallingStore } from '../../../sim/flight/ballistics';
import type { Flying } from './missileViews';

/** A wreck's mass (kg) and drag area (m²): a fighter broken up, slowed hard by the air. */
const MASS = 9000;
const DRAG_AREA = 6;
const STEP = 1 / 60;
/** How long a wreck falls at most (s). */
const MAX_FALL = 120;

interface Wreck {
  key: object;
  model: string;
  body: FallingStore;
  age: number;
}

export class Wrecks {
  private readonly list: Wreck[] = [];
  private acc = 0;

  /** A wreck of the aircraft drawn with `model` (a model spec id), at `pos` with `vel`. */
  add(model: string, pos: Readonly<Vec3d>, vel: Readonly<Vec3d>, seed: number): void {
    const s = (k: number) => Math.sin(seed * 12.9898 + k * 78.233) * 0.5;
    this.list.push({
      key: {},
      model,
      body: {
        pos: pos.clone(),
        vel: vel.clone(),
        q: new Quatd(),
        mass: MASS,
        dragArea: DRAG_AREA,
        tumble: [1.2 + s(1), 0.6 * s(2), 0.4 * s(3)],
      },
      age: 0,
    });
  }

  /**
   * Steps the wrecks by `dt` game seconds on a planet of radius R; a wreck at the ground
   * (`groundAt`, m) goes, and `onImpact` hears where.
   */
  update(
    dt: number,
    R: number,
    groundAt: (dir: Readonly<Vec3d>) => number,
    onImpact: (at: Vec3d) => void,
  ): void {
    this.acc += Math.min(dt, 0.5);
    while (this.acc >= STEP) {
      this.acc -= STEP;
      for (const w of this.list) {
        stepFalling(w.body, STEP, R);
        w.age += STEP;
      }
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const w = this.list[i]!;
      const p = w.body.pos;
      if (p.length() - R <= groundAt(p.clone().normalize())) {
        onImpact(p.clone());
        this.list.splice(i, 1);
      } else if (w.age > MAX_FALL) this.list.splice(i, 1);
    }
  }

  /** The wrecks as the view draws them: burning, trailing smoke. */
  get flying(): Flying[] {
    return this.list.map((w) => ({
      key: w.key,
      model: w.model,
      pos: w.body.pos,
      vel: w.body.vel,
      burning: true,
    }));
  }

  clear(): void {
    this.list.length = 0;
  }
}
