/**
 * The points-of-interest kit (Proposal 0010, decision 302): writes
 * src/data/models/poi-*.json, a near and a far model per type, flat-shaded and chunky,
 * modern and of the period: radomes, lattice masts, bunkers, a dam wall, a lighthouse.
 * Towers are chunky frusta, not lattices (Part I: no thin geometry).
 * Model frame: meters, y up, origin on the ground; parts reach a little below it.
 *
 *   node tools/models/poi.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(import.meta.dirname, '../../src/data/models');
const G = {
  concrete: '#9A968E',
  dark: '#5E5B55',
  white: '#E8E6DF',
  red: '#B0402E',
  steel: '#7C8174',
  rust: '#8A5A3A',
  olive: '#6B6A4A',
  glass: '#F2D27A',
};
const box = (group, center, size, yaw = 0, bevel = 0) => ({
  type: 'box',
  group,
  center,
  size,
  ...(yaw ? { yaw } : {}),
  ...(bevel ? { bevel } : {}),
});
const blob = (group, center, radius, detail = 1, half = false) => ({
  type: 'blob',
  group,
  center,
  radius,
  detail,
  ...(half ? { half } : {}),
});
const cyl = (group, from, to, radius, sides = 6, radius2) => ({
  type: 'cylinder',
  group,
  from,
  to,
  radius,
  sides,
  ...(radius2 !== undefined ? { radius2 } : {}),
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

const KIT = {
  'poi-radar-station': [
    'Radar station',
    [
      box('concrete', [8, 2, 0], [12, 6, 9], 0, 0.5),
      cyl('concrete', [-4, -2, 0], [-4, 14, 0], 3.2, 8),
      blob('white', [-4, 18, 0], [6, 6, 6], 1),
      frustum('steel', [10, -1, 6], [2.4, 2.4], [0.8, 0.8], 23),
    ],
    [box('concrete', [6, 2, 0], [14, 6, 9]), blob('white', [-4, 16, 0], [6, 6, 6], 0)],
  ],
  'poi-early-warning-radar': [
    'Early-warning radar',
    [
      box('concrete', [0, 3, 0], [34, 10, 30], 0, 0.6),
      blob('white', [0, 8, 0], [15, 15, 15], 1, true),
      box('dark', [22, 2, 0], [8, 6, 12]),
    ],
    [box('concrete', [0, 3, 0], [34, 10, 30]), blob('white', [0, 8, 0], [15, 15, 15], 0, true)],
  ],
  'poi-relay-tower': [
    'Relay tower',
    [
      frustum('steel', [0, -1, 0], [6, 6], [1.6, 1.6], 61),
      box('concrete', [6, 1, 4], [5, 4, 4]),
      box('red', [0, 60, 0], [2.5, 2, 2.5]),
    ],
    [frustum('steel', [0, -1, 0], [6, 6], [1.5, 1.5], 61)],
  ],
  'poi-bunker-complex': [
    'Bunker complex',
    [
      box('olive', [0, 0.5, 0], [30, 5, 18], 0, 1.5),
      box('olive', [22, 0, 6], [10, 4, 10], 20, 1.2),
      frustum('dark', [-17, -1, 0], [6, 8], [4, 6], 4),
      box('concrete', [-20, 1.5, -10], [3, 3, 3]),
    ],
    [box('olive', [0, 0.5, 0], [34, 5, 20])],
  ],
  'poi-coastal-battery': [
    'Coastal battery',
    [
      box('concrete', [0, 0.5, -12], [10, 4, 9], 0, 1),
      box('concrete', [0, 0.5, 0], [10, 4, 9], 0, 1),
      box('concrete', [0, 0.5, 12], [10, 4, 9], 0, 1),
      cyl('dark', [3, 2.5, -12], [16, 2.8, -12], 0.6, 6),
      cyl('dark', [3, 2.5, 0], [16, 2.8, 0], 0.6, 6),
      cyl('dark', [3, 2.5, 12], [16, 2.8, 12], 0.6, 6),
    ],
    [box('concrete', [0, 0.5, 0], [12, 4, 34])],
  ],
  'poi-observation-post': [
    'Observation post',
    [
      box('olive', [0, 1.5, 0], [7, 5, 7], 0, 0.6),
      box('glass', [0, 4.5, 0], [6, 1.2, 6]),
      frustum('steel', [4, -1, 4], [1.4, 1.4], [0.5, 0.5], 15),
    ],
    [box('olive', [0, 1.5, 0], [7, 6, 7])],
  ],
  'poi-dam': [
    'Dam',
    [
      frustum('concrete', [0, -10, 0], [100, 34], [100, 12], 70),
      box('concrete', [0, 61, 0], [104, 3, 14]),
      box('dark', [0, 20, -14], [12, 30, 4]),
    ],
    [frustum('concrete', [0, -10, 0], [100, 34], [100, 12], 74)],
  ],
  'poi-lighthouse': [
    'Lighthouse',
    [
      cyl('white', [0, -2, 0], [0, 12, 0], 3.4, 8, 3),
      cyl('red', [0, 12, 0], [0, 20, 0], 3, 8, 2.6),
      cyl('white', [0, 20, 0], [0, 28, 0], 2.6, 8, 2.3),
      box('glass', [0, 29.5, 0], [4, 3, 4]),
      frustum('red', [0, 31, 0], [4.6, 4.6], [0.6, 0.6], 3),
      box('white', [7, 1, 0], [7, 5, 6]),
    ],
    [cyl('white', [0, -2, 0], [0, 32, 0], 3.4, 6, 2.2)],
  ],
  'poi-observatory': [
    'Observatory',
    [
      box('white', [0, 3, 0], [16, 9, 12], 0, 0.5),
      cyl('white', [-5, 6, 0], [-5, 10, 0], 6, 8),
      blob('white', [-5, 10, 0], [6, 6, 6], 1, true),
    ],
    [box('white', [0, 3, 0], [16, 9, 12]), blob('white', [-5, 8, 0], [6, 6, 6], 0, true)],
  ],
  'poi-quarry': [
    'Quarry',
    [
      box('concrete', [0, -1, 0], [60, 3, 50]),
      box('dark', [0, 1.5, -18], [52, 4, 8]),
      box('dark', [0, 4.5, -26], [52, 4, 6]),
      box('rust', [24, 1.5, 18], [10, 5, 6], 15),
      frustum('steel', [-20, -1, 14], [2, 2], [0.6, 0.6], 17),
    ],
    [box('concrete', [0, 0, 0], [60, 5, 50])],
  ],
  'poi-oil-field': [
    'Oil field',
    [
      frustum('steel', [-10, -1, -8], [4, 4], [1, 1], 23),
      frustum('steel', [12, -1, 6], [4, 4], [1, 1], 21),
      cyl('white', [0, -1, 10], [0, 7, 10], 5, 8),
      cyl('white', [12, -1, -10], [12, 6, -10], 4, 8),
      box('rust', [-2, 0.5, -4], [8, 3, 4]),
    ],
    [
      cyl('white', [0, -1, 10], [0, 7, 10], 5, 6),
      frustum('steel', [-10, -1, -8], [4, 4], [1, 1], 23),
    ],
  ],
  'poi-pylon': [
    'Power pylon',
    [
      frustum('steel', [0, -1, 0], [6, 6], [1.6, 1.6], 35),
      box('steel', [0, 28, 0], [1.2, 1.2, 16]),
    ],
    [
      frustum('steel', [0, -1, 0], [6, 6], [1.6, 1.6], 35),
      box('steel', [0, 28, 0], [1.2, 1.2, 16]),
    ],
  ],
};

for (const [id, [name, near, far]] of Object.entries(KIT)) {
  for (const [suffix, parts, label] of [
    ['', near, name],
    ['-lod', far, `${name} (far)`],
  ]) {
    const spec = { name: label, class: 'building', groups: G, parts };
    writeFileSync(join(OUT, `${id}${suffix}.json`), JSON.stringify(spec, null, 2) + '\n');
  }
}
console.log(`wrote ${Object.keys(KIT).length * 2} point-of-interest specs`);
