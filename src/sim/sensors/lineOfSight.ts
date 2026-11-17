import { Vec3d } from '../../core/vec3d';

/**
 * Whether nothing blocks the line from `a` to `b` (decision 218): the ground (sea level at
 * least) sampled at 32 points along it, which also finds the horizon on a long line.
 */
export function lineOfSight(
  a: Readonly<Vec3d>,
  b: Readonly<Vec3d>,
  radius: number,
  ground: { height(dir: Readonly<Vec3d>): number },
): boolean {
  const p = new Vec3d();
  const N = 32;
  for (let i = 1; i < N; i++) {
    const f = i / N;
    p.set(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
    const r = p.length();
    if (r - radius < Math.max(0, ground.height(p.scale(1 / r)))) return false;
  }
  return true;
}
