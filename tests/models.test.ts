/** Model specs and the procedural builder (decision 106). */
import { describe, expect, it } from 'vitest';
import { buildModel, withinBudget } from '../src/render/common/models/builder';
import { MODEL_SPECS } from '../src/render/common/models/library';
import { hexToLinear, SCHEMES } from '../src/render/common/models/palettes';
import { ModelSpecError, validateSpec } from '../src/render/common/models/spec';
import type { ModelSpec } from '../src/render/common/models/spec';

/** Signed volume of a triangle list (positive when faces point outward). */
function signedVolume(p: Float32Array): number {
  let v = 0;
  for (let i = 0; i < p.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = p.subarray(i, i + 9) as unknown as number[];
    v +=
      (ax! * (by! * cz! - bz! * cy!) -
        ay! * (bx! * cz! - bz! * cx!) +
        az! * (bx! * cy! - by! * cx!)) /
      6;
  }
  return v;
}

const one = (part: object, extra: Partial<ModelSpec> = {}): ModelSpec =>
  validateSpec(
    {
      name: 'test',
      class: 'building',
      groups: { a: '#808080' },
      parts: [{ group: 'a', ...part }],
      ...extra,
    },
    'test',
  );

describe('model library', () => {
  const ids = Object.keys(MODEL_SPECS);

  it('has the first aircraft and the base and town kit', () => {
    for (const id of [
      'alliance-fighter',
      'alliance-strike',
      'pact-fighter',
      'pact-strike',
      'hangar',
      'shelter',
      'tower',
      'radar-mast',
      'radar-dome',
      'fuel-tank',
      'revetment',
      'house',
      'block',
    ])
      expect(ids).toContain(id);
  });

  it('keeps every model within its class triangle budget (Part I)', () => {
    for (const id of ids) {
      const m = buildModel(MODEL_SPECS[id]!, { noAo: id.includes('carrier') });
      expect(withinBudget(m), `${id}: ${m.triangles} triangles for a ${m.class}`).toBe(true);
    }
  });

  it('builds the same bytes from the same spec', () => {
    const a = buildModel(MODEL_SPECS['pact-strike']!);
    const b = buildModel(MODEL_SPECS['pact-strike']!);
    for (const k of ['position', 'normal', 'color', 'ao'] as const)
      expect(Buffer.from(a[k].buffer).equals(Buffer.from(b[k].buffer))).toBe(true);
  });

  it('colors camouflage faces from the scheme only, and bakes occlusion into 0..1', () => {
    const m = buildModel(MODEL_SPECS['alliance-strike']!);
    const allowed = [...SCHEMES['alliance-woodland']!.colors].map(hexToLinear);
    const body = m.groupNames.indexOf('body');
    for (let t = 0; t < m.triangles; t++) {
      if (m.group[t] !== body) continue;
      const c = [m.color[t * 9]!, m.color[t * 9 + 1]!, m.color[t * 9 + 2]!];
      expect(allowed.some((a) => a.every((x, i) => Math.abs(x - c[i]!) < 1e-6))).toBe(true);
    }
    const used = new Set<string>();
    for (let t = 0; t < m.triangles; t++)
      if (m.group[t] === body) used.add(m.color.subarray(t * 9, t * 9 + 3).join());
    expect(used.size).toBeGreaterThan(1);
    expect(Math.min(...m.ao)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...m.ao)).toBeLessThanOrEqual(1);
    expect(Math.min(...m.ao)).toBeLessThan(0.9);
  });

  it('mirrors emissives and puts the red light to port', () => {
    const m = buildModel(MODEL_SPECS['alliance-strike']!);
    expect(m.emissives.filter((e) => e.kind === 'afterburner')).toHaveLength(2);
    expect(m.emissives.find((e) => e.kind === 'nav-red')!.position[2]).toBeLessThan(0);
    expect(m.emissives.find((e) => e.kind === 'nav-green')!.position[2]).toBeGreaterThan(0);
  });
});

describe('model builder primitives', () => {
  it('turns every face of closed primitives outward', () => {
    const cases: [object, number][] = [
      [{ type: 'box', center: [0, 1, 0], size: [2, 2, 2] }, 8],
      [{ type: 'box', center: [0, 1, 0], size: [2, 2, 2], bevel: 0.2, yaw: 30 }, 0],
      [{ type: 'frustum', center: [0, 0, 0], base: [2, 2], top: [0, 0], height: 3 }, 4],
      [{ type: 'cylinder', from: [0, 0, 0], to: [3, 1, 0], radius: 1, sides: 8 }, 0],
      [{ type: 'blob', center: [0, 0, 0], radius: [1, 2, 1], detail: 1 }, 0],
      [{ type: 'arch', center: [0, 0, 0], length: 10, width: 8, height: 4, sides: 6 }, 0],
      [{ type: 'house', center: [0, 0, 0], size: [10, 5, 8], roof: 3, roofGroup: 'a' }, 520],
      [
        {
          type: 'loft',
          sides: 6,
          stations: [
            { x: 2, w: 0, h: 0 },
            { x: 0, w: 1, h: 1 },
            { x: -3, w: 0.5, h: 0.5 },
          ],
        },
        0,
      ],
      [
        {
          type: 'wing',
          root: [0, 0, 0.5],
          rootChord: 3,
          tipChord: 1,
          span: 4,
          sweep: 30,
          mirror: true,
        },
        0,
      ],
    ];
    for (const [part, volume] of cases) {
      const m = buildModel(one(part), { noAo: true });
      const v = signedVolume(m.position);
      expect(v, JSON.stringify(part)).toBeGreaterThan(0);
      if (volume) expect(v).toBeCloseTo(volume, 3);
    }
  });

  it('keeps mirrored parts outward-facing', () => {
    const half = buildModel(one({ type: 'box', center: [0, 0, 3], size: [1, 1, 1] }), {
      noAo: true,
    });
    const both = buildModel(
      one({ type: 'box', center: [0, 0, 3], size: [1, 1, 1], mirror: true }),
      { noAo: true },
    );
    expect(both.triangles).toBe(2 * half.triangles);
    expect(signedVolume(both.position)).toBeCloseTo(2, 6);
  });
});

describe('model spec validation', () => {
  const base = { name: 'x', class: 'building', groups: { a: '#808080' } };
  const bad: [object, RegExp][] = [
    [{ ...base, parts: [] }, /parts: must be a non-empty list/],
    [
      {
        ...base,
        class: 'zeppelin',
        parts: [{ type: 'box', group: 'a', center: [0, 0, 0], size: [1, 1, 1] }],
      },
      /class/,
    ],
    [
      { ...base, parts: [{ type: 'sphere', group: 'a' }] },
      /parts\[0\]\.type: unknown part type "sphere"/,
    ],
    [
      { ...base, parts: [{ type: 'box', group: 'b', center: [0, 0, 0], size: [1, 1, 1] }] },
      /parts\[0\]\.group/,
    ],
    [
      { ...base, parts: [{ type: 'box', group: 'a', center: [0, 0], size: [1, 1, 1] }] },
      /parts\[0\]\.center: missing or not a vec3/,
    ],
    [
      { ...base, parts: [{ type: 'box', group: 'a', center: [0, 0, 0], size: [1, -1, 1] }] },
      /size: must be positive/,
    ],
    [
      {
        ...base,
        groups: { a: 'camo' },
        parts: [{ type: 'box', group: 'a', center: [0, 0, 0], size: [1, 1, 1] }],
      },
      /needs a scheme/,
    ],
    [
      {
        ...base,
        scheme: 'polka',
        parts: [{ type: 'box', group: 'a', center: [0, 0, 0], size: [1, 1, 1] }],
      },
      /unknown scheme "polka"/,
    ],
    [
      {
        ...base,
        groups: { a: 'plaid' },
        parts: [{ type: 'box', group: 'a', center: [0, 0, 0], size: [1, 1, 1] }],
      },
      /unknown color "plaid"/,
    ],
    [
      {
        ...base,
        parts: [
          {
            type: 'loft',
            group: 'a',
            sides: 2,
            stations: [
              { x: 0, w: 1, h: 1 },
              { x: 1, w: 1, h: 1 },
            ],
          },
        ],
      },
      /sides: must be 3–16/,
    ],
    [
      {
        ...base,
        parts: [{ type: 'box', group: 'a', center: [0, 0, 0], size: [1, 1, 1] }],
        emissives: [{ kind: 'laser', at: [0, 0, 0] }],
      },
      /emissives\[0\]\.kind/,
    ],
  ];
  it('names the first problem with its path', () => {
    for (const [spec, msg] of bad) {
      expect(() => validateSpec(spec, 'bad')).toThrow(ModelSpecError);
      expect(() => validateSpec(spec, 'bad')).toThrow(msg);
    }
  });

  it('accepts model color names as groups without declaring them', () => {
    expect(() =>
      validateSpec({
        ...base,
        parts: [{ type: 'box', group: 'canopy', center: [0, 0, 0], size: [1, 1, 1] }],
      }),
    ).not.toThrow();
  });
});

describe('ink outline normals', () => {
  it('points corner outline normals out along the diagonal of a box', () => {
    const m = buildModel(one({ type: 'box', center: [0, 0, 0], size: [2, 2, 2] }), { noAo: true });
    for (let i = 0; i < m.position.length; i += 3) {
      const n = [m.outlineNormal[i]!, m.outlineNormal[i + 1]!, m.outlineNormal[i + 2]!];
      expect(Math.hypot(...n)).toBeCloseTo(1, 5);
      for (let k = 0; k < 3; k++)
        expect(n[k]! * Math.sign(m.position[i + k]!)).toBeCloseTo(1 / Math.sqrt(3), 5);
    }
  });

  it('gives every vertex of every library model a unit outline normal', () => {
    for (const id of ['alliance-fighter', 'hangar', 'radar-mast']) {
      const m = buildModel(MODEL_SPECS[id]!, { noAo: true });
      for (let i = 0; i < m.outlineNormal.length; i += 3)
        expect(
          Math.hypot(m.outlineNormal[i]!, m.outlineNormal[i + 1]!, m.outlineNormal[i + 2]!),
        ).toBeCloseTo(1, 4);
    }
  });
});
