/**
 * Built models (builder.ts) as three.js geometry (decision 106): non-indexed
 * `BufferGeometry` with `position`, `normal` (the face normal), `color` (linear rgb)
 * and `ao` attributes, cached per model id and scheme.
 */
import { BufferAttribute, BufferGeometry } from 'three/webgpu';
import { buildModel } from './builder';
import type { BuiltModel } from './builder';
import { modelSpec } from './library';

export function modelGeometry(m: BuiltModel): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.position, 3));
  g.setAttribute('normal', new BufferAttribute(m.normal, 3));
  g.setAttribute('color', new BufferAttribute(m.color, 3));
  g.setAttribute('ao', new BufferAttribute(m.ao, 1));
  g.computeBoundingSphere();
  return g;
}

const built = new Map<string, BuiltModel>();

/** The built model of a library spec (cached; same spec and scheme, same model). */
export function libraryModel(id: string, scheme?: string): BuiltModel {
  const key = `${id}:${scheme ?? ''}`;
  let m = built.get(key);
  if (!m) built.set(key, (m = buildModel(modelSpec(id), { scheme })));
  return m;
}
