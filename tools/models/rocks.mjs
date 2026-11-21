/**
 * The rock dressing kit (Proposal 0010, decision 299): writes src/data/models/rock-*.json,
 * sixteen pieces and their far models, flat-shaded and chunky, in each rock's colors.
 * Model frame: y is the instance's up (the slope's normal for slabs, the vertical for
 * towers), origin at the foot; pieces reach below y = 0 so they sink into the ground.
 *
 *   node tools/models/rocks.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '../../src/data/models');
const C = {
  sand: ['#B06A3A', '#C4925C', '#965532'],
  granite: ['#9C9A94', '#B5B2AA', '#85837D'],
  lime: ['#D8D2C2', '#C8C1AE', '#B9B19C'],
  basalt: ['#3E3836', '#4A3F3A', '#2E2B2B'],
  schist: ['#6E7468', '#5E665C', '#7C8174'],
  scree: ['#8A8478', '#9A948A', '#7A746A'],
};
const groups = (k) => ({ a: C[k][0], b: C[k][1], c: C[k][2] });
const box = (group, center, size, yaw = 0, bevel = 0) => ({
  type: 'box',
  group,
  center,
  size,
  ...(yaw ? { yaw } : {}),
  ...(bevel ? { bevel } : {}),
});
const blob = (group, center, radius, seed, jitter = 0.2, detail = 1, half = false) => ({
  type: 'blob',
  group,
  center,
  radius,
  detail,
  jitter,
  seed,
  ...(half ? { half } : {}),
});
const column = (group, sides, rings, seed, jitter = 0.12, top = 0) => ({
  type: 'column',
  group,
  sides,
  rings,
  seed,
  jitter,
  ...(top ? { top } : {}),
});
const frustum = (group, center, base, top, height, yaw = 0) => ({
  type: 'frustum',
  group,
  center,
  base,
  top,
  height,
  ...(yaw ? { yaw } : {}),
});

/** id → [name, rock, near parts, far parts]. Sizes at scale 1, in meters. */
const KIT = {
  // Sandstone: blocky and banded.
  'rock-sand-slab': [
    'Sandstone slab',
    'sand',
    [
      box('a', [0, 1.5, 0], [22, 7, 14], 0, 1),
      box('b', [1, 7, -1], [19, 5, 12], 6, 1),
      box('c', [-1, 11, 0], [15, 3, 10], -4, 0.5),
    ],
    [box('a', [0, 3, 0], [22, 12, 14])],
  ],
  'rock-sand-ledge': [
    'Sandstone ledge',
    'sand',
    [
      box('b', [0, 0, 0], [34, 6, 9], 0, 1),
      box('a', [2, 4, 2], [28, 3, 11], 3, 0.6),
      box('c', [-3, -3, -1], [30, 4, 8], -2),
    ],
    [box('b', [0, 1, 0], [34, 9, 10])],
  ],
  'rock-sand-buttress': [
    'Sandstone buttress',
    'sand',
    [
      box('a', [0, 4, 0], [16, 12, 14], 0, 1),
      box('b', [0, 14, -2], [12, 10, 10], 8, 1),
      box('c', [0, 22, -3], [8, 7, 7], -6, 0.8),
      box('a', [0, 27, -3], [6, 4, 5], 10),
    ],
    [frustum('a', [0, -2, 0], [16, 14], [6, 5], 32)],
  ],
  'rock-sand-spire': [
    'Sandstone spire',
    'sand',
    [
      column(
        'a',
        5,
        [
          { y: -4, r: 9 },
          { y: 10, r: 7.5 },
          { y: 22, r: 6.5, x: 0.6 },
        ],
        11,
      ),
      column(
        'c',
        5,
        [
          { y: 21, r: 7.2, x: 0.6 },
          { y: 27, r: 7.6, x: 0.8 },
        ],
        12,
        0.08,
      ),
      column(
        'b',
        5,
        [
          { y: 27, r: 5.6, x: 0.8 },
          { y: 36, r: 4.2, x: 1.2 },
        ],
        13,
        0.1,
        2,
      ),
    ],
    [
      column(
        'a',
        5,
        [
          { y: -4, r: 9 },
          { y: 36, r: 4.5, x: 1 },
        ],
        11,
        0.08,
        2,
      ),
    ],
  ],
  // Granite: rounded and massive.
  'rock-granite-dome': [
    'Granite dome',
    'granite',
    [blob('a', [0, -2, 0], [18, 14, 15], 21, 0.14, 1, true)],
    [blob('a', [0, -2, 0], [18, 14, 15], 21, 0.1, 0, true)],
  ],
  'rock-granite-boulder': [
    'Granite boulder',
    'granite',
    [blob('b', [0, 2.5, 0], [6, 5, 5], 22, 0.22), blob('c', [5, 1, 3], [3, 2.5, 3], 23, 0.25, 0)],
    [blob('b', [0, 2.5, 0], [6, 5, 5], 22, 0.2, 0)],
  ],
  'rock-granite-tor': [
    'Granite tor',
    'granite',
    [
      blob('a', [0, 3, 0], [10, 6, 9], 24, 0.18),
      blob('b', [1, 10, 0], [7, 4, 6.5], 25, 0.2, 0),
      blob('c', [0.5, 15, 0.5], [4.5, 3, 4], 26, 0.2, 0),
    ],
    [
      blob('a', [0, 3, 0], [10, 6, 9], 24, 0.15, 0),
      blob('b', [1, 11, 0], [7, 6, 6.5], 25, 0.15, 0),
    ],
  ],
  // Limestone: pale and fluted.
  'rock-lime-slab': [
    'Limestone slab',
    'lime',
    [
      column(
        'a',
        8,
        [
          { y: -3, r: 12 },
          { y: 6, r: 10.5 },
          { y: 9, r: 8 },
        ],
        31,
        0.18,
      ),
    ],
    [
      column(
        'a',
        6,
        [
          { y: -3, r: 12 },
          { y: 9, r: 8 },
        ],
        31,
        0.12,
      ),
    ],
  ],
  'rock-lime-pinnacle': [
    'Limestone pinnacle',
    'lime',
    [
      column(
        'a',
        8,
        [
          { y: -4, r: 8 },
          { y: 12, r: 6 },
          { y: 24, r: 4.5, z: 0.8 },
        ],
        32,
        0.22,
        4,
      ),
      column(
        'c',
        8,
        [
          { y: -4, r: 8.6 },
          { y: 3, r: 8.2 },
        ],
        33,
        0.12,
      ),
    ],
    [
      column(
        'a',
        6,
        [
          { y: -4, r: 8 },
          { y: 24, r: 4.5 },
        ],
        32,
        0.15,
        4,
      ),
    ],
  ],
  // Basalt: columnar.
  'rock-basalt-columns': [
    'Basalt columns',
    'basalt',
    [
      column(
        'a',
        6,
        [
          { y: -4, r: 2.6 },
          { y: 18, r: 2.6 },
        ],
        41,
        0.03,
      ),
      {
        ...column(
          'b',
          6,
          [
            { y: -4, r: 2.6, x: 4.6 },
            { y: 14, r: 2.6, x: 4.6 },
          ],
          42,
          0.03,
        ),
      },
      {
        ...column(
          'c',
          6,
          [
            { y: -4, r: 2.6, x: -4.6 },
            { y: 15, r: 2.6, x: -4.6 },
          ],
          43,
          0.03,
        ),
      },
      {
        ...column(
          'b',
          6,
          [
            { y: -4, r: 2.6, x: 2.3, z: 4 },
            { y: 11, r: 2.6, x: 2.3, z: 4 },
          ],
          44,
          0.03,
        ),
      },
      {
        ...column(
          'a',
          6,
          [
            { y: -4, r: 2.6, x: -2.3, z: 4 },
            { y: 16, r: 2.6, x: -2.3, z: 4 },
          ],
          45,
          0.03,
        ),
      },
      {
        ...column(
          'c',
          6,
          [
            { y: -4, r: 2.6, x: 2.3, z: -4 },
            { y: 12, r: 2.6, x: 2.3, z: -4 },
          ],
          46,
          0.03,
        ),
      },
    ],
    [
      column(
        'a',
        6,
        [
          { y: -4, r: 7.5 },
          { y: 16, r: 7 },
        ],
        41,
        0.05,
      ),
    ],
  ],
  'rock-basalt-wall': [
    'Basalt wall',
    'basalt',
    [0, 1, 2, 3, 4, 5].map((i) =>
      column(
        'abc'[i % 3],
        6,
        [
          { y: -4, r: 2.4, x: (i - 2.5) * 4.2 },
          { y: 10 + ((i * 7) % 5) * 1.6, r: 2.4, x: (i - 2.5) * 4.2 },
        ],
        50 + i,
        0.03,
      ),
    ),
    [box('a', [0, 4, 0], [26, 16, 5])],
  ],
  // Schist: slabby.
  'rock-schist-slab': [
    'Schist slabs',
    'schist',
    [
      box('a', [0, 1, 0], [20, 3, 12], 0, 0.5),
      box('b', [2, 3.5, 1], [16, 2.5, 10], 12, 0.4),
      box('c', [-1, 5.5, -1], [12, 2, 8], -9, 0.3),
    ],
    [box('a', [0, 2, 0], [20, 6, 12])],
  ],
  'rock-schist-fin': [
    'Schist fins',
    'schist',
    [
      frustum('a', [0, -3, 0], [14, 3], [10, 1.5], 14, 0),
      frustum('b', [3, -3, 4], [12, 2.5], [8, 1.2], 11, 8),
      frustum('c', [-2, -3, -4], [11, 2.5], [7, 1], 9, -6),
    ],
    [frustum('a', [0, -3, 0], [15, 10], [9, 3], 13)],
  ],
  // Any rock: scree, crest teeth, boulders.
  'rock-scree': [
    'Scree fan',
    'scree',
    [
      blob('a', [0, -0.5, 0], [16, 2.2, 12], 61, 0.3, 1, true),
      blob('b', [-6, 0.3, 4], [2, 1.4, 2], 62, 0.3, 0),
      blob('c', [5, 0.4, -3], [2.4, 1.6, 2], 63, 0.3, 0),
    ],
    [blob('a', [0, -0.5, 0], [16, 2.4, 12], 61, 0.2, 0, true)],
  ],
  'rock-crest-tooth': [
    'Crest tooth',
    'granite',
    [
      frustum('a', [0, -4, 0], [10, 8], [1.5, 1.2], 22, 0),
      frustum('c', [5, -4, 2], [6, 5], [1, 1], 13, 20),
    ],
    [frustum('a', [0, -4, 0], [11, 9], [1.5, 1.2], 22)],
  ],
  'rock-boulder': [
    'Boulder',
    'scree',
    [blob('b', [0, 1.6, 0], [4, 3, 3.4], 71, 0.25)],
    [blob('b', [0, 1.6, 0], [4, 3, 3.4], 71, 0.2, 0)],
  ],
};

for (const [id, [name, rock, near, far]] of Object.entries(KIT)) {
  for (const [suffix, parts, label] of [
    ['', near, name],
    ['-lod', far, `${name} (far)`],
  ]) {
    const spec = { name: label, class: 'rock', groups: groups(rock), parts };
    writeFileSync(join(OUT, `${id}${suffix}.json`), JSON.stringify(spec, null, 2) + '\n');
  }
}
console.log(`wrote ${Object.keys(KIT).length * 2} rock specs`);
