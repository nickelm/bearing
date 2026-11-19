"""
Generates the ground cover kit's model specs (decision 172): grass tufts, flower
tufts, tussocks, reeds, bushes, boulders, a slab and pebbles, as JSON specs in
src/data/models/cover-*.json. Blades are three-sided cylinders
tapering to a point, laid out round each tuft from a fixed pattern, so the specs
are reproducible: run `python3 tools/models/cover.py`, then `npx prettier --write
"src/data/models/cover-*.json"`, after editing this file.
"""
import json, math, os
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'render', 'common', 'models', 'specs')
def r(x): return round(x, 3)

def blades(n, h0, h1, lean, base, groups, seed, ring=0.06, phase=0.0):
    parts = []
    for k in range(n):
        a = phase + 2 * math.pi * (k + 0.37 * ((k * 7 + seed) % 3) / 3) / n
        t = ((k * 5 + seed * 3) % n) / max(1, n - 1)
        h = h0 + (h1 - h0) * t
        rx, rz = ring * math.cos(a), ring * math.sin(a)
        tx, tz = rx + lean * h * math.cos(a), rz + lean * h * math.sin(a)
        parts.append({"type": "cylinder", "group": groups[k % len(groups)],
                      "from": [r(rx), -0.04, r(rz)], "to": [r(tx), r(h), r(tz)],
                      "radius": base, "radius2": 0, "sides": 3, "caps": False})
    return parts

def write(id, name, groups, parts, scheme=None):
    spec = {"name": name, "class": "cover", "groups": groups, "parts": parts}
    if scheme: spec = {"name": name, "class": "cover", "scheme": scheme, "groups": groups, "parts": parts}
    with open(os.path.join(OUT, id + '.json'), 'w') as f:
        json.dump(spec, f, indent=2); f.write('\n')

# Grass tuft: seven fat blades, 0.3-0.55 m, leaning out.
write('cover-tuft', 'Grass tuft', {"dark": "grass-dark", "mid": "grass", "light": "grass-light"},
      blades(7, 0.3, 0.5, 0.5, 0.1, ["mid", "light", "dark"], 1))
# Dry tuft: savanna and scrub.
write('cover-tuft-dry', 'Dry grass tuft', {"mid": "grass-dry", "light": "grass-dry-light"},
      blades(7, 0.28, 0.46, 0.55, 0.1, ["mid", "light"], 2))
# Tussock: a fountain of eight wide blades round a low core.
write('cover-tussock', 'Tussock', {"dark": "grass-dark", "mid": "grass-dry", "light": "grass-dry-light"},
      [{"type": "blob", "group": "dark", "center": [0, 0.02, 0], "radius": [0.38, 0.3, 0.36], "half": True, "jitter": 0.2, "seed": 5}]
      + blades(8, 0.5, 0.72, 0.65, 0.13, ["mid", "light"], 3, ring=0.14))
# Flower tufts: five blades and two or three flat heads, muted colors (decision 169).
for cid, col, seed in [('cream', 'flower-cream', 4), ('yellow', 'flower-yellow', 5), ('violet', 'flower-violet', 6)]:
    heads = []
    for k, (x, y, z) in enumerate([(0.08, 0.2, 0.03), (-0.06, 0.17, -0.07), (-0.02, 0.23, 0.08)][: 2 if cid == 'violet' else 3]):
        heads.append({"type": "cylinder", "group": "flower", "from": [x, y, z], "to": [x, y + 0.035, z],
                      "radius": 0.085, "sides": 3})
    write('cover-flowers-' + cid, 'Flower tuft (%s)' % cid, {"dark": "grass-dark", "mid": "grass", "flower": col},
          blades(5, 0.26, 0.38, 0.5, 0.09, ["mid", "dark"], seed) + heads)
# Reed clump: nine tall blades, two cattails.
reeds = blades(8, 0.85, 1.3, 0.2, 0.09, ["mid", "light"], 7, ring=0.1)
for (x, z, y) in [(0.05, 0.08, 1.0), (-0.09, -0.02, 1.12)]:
    reeds.append({"type": "cylinder", "group": "head", "from": [x, y, z], "to": [x + 0.02, y + 0.24, z],
                  "radius": 0.07, "sides": 3})
write('cover-reeds', 'Reed clump', {"mid": "reed", "light": "grass-light", "head": "reed-head"}, reeds)
# Bushes: two lumpy domes and a low lobe.
for bid, name, g in [('bush', 'Bush', {"dark": "leaf-dark", "mid": "leaf", "light": "leaf-light"}),
                     ('bush-dry', 'Dry bush', {"dark": "leaf-dry", "mid": "grass-dry", "light": "leaf-dry"})]:
    write('cover-' + bid, name, g, [
        {"type": "blob", "group": "mid", "center": [0, -0.05, 0], "radius": [0.75, 1.05, 0.7], "half": True, "jitter": 0.12, "seed": 21},
        {"type": "blob", "group": "light", "center": [0.35, 0.3, -0.25], "radius": [0.45, 0.6, 0.42], "half": True, "jitter": 0.12, "seed": 22},
        {"type": "blob", "group": "dark", "center": [-0.45, -0.05, 0.3], "radius": [0.45, 0.6, 0.4], "half": True, "jitter": 0.12, "seed": 23},
    ])
# Boulders: jittered, flattened icosahedra, sunk a little; per-face rock shades.
write('cover-boulder-small', 'Boulder (small)', {"rock": "camo"},
      [{"type": "blob", "group": "rock", "center": [0, 0.12, 0], "radius": [0.42, 0.27, 0.36], "jitter": 0.38, "seed": 31}], 'rock')
write('cover-boulder', 'Boulder', {"rock": "camo"},
      [{"type": "blob", "group": "rock", "center": [0, 0.35, 0], "radius": [1.0, 0.65, 0.85], "jitter": 0.38, "seed": 32}], 'rock')
write('cover-boulder-large', 'Boulder (large)', {"rock": "camo"},
      [{"type": "blob", "group": "rock", "center": [0, 0.55, 0], "radius": [1.7, 1.05, 1.4], "jitter": 0.38, "seed": 33},
       {"type": "blob", "group": "rock", "center": [1.2, 0.35, 0.6], "radius": [0.85, 0.55, 0.7], "jitter": 0.38, "seed": 34}], 'rock')
write('cover-boulder-lichen', 'Boulder with lichen', {"rock": "camo"},
      [{"type": "blob", "group": "rock", "center": [0, 0.35, 0], "radius": [1.05, 0.62, 0.9], "jitter": 0.38, "seed": 35}], 'rock-lichen')
# Slab: two stacked strata of sandstone, the upper set back.
write('cover-slab', 'Sandstone slab', {"rock": "camo"},
      [{"type": "box", "group": "rock", "center": [0, 0.25, 0], "size": [2.6, 0.7, 1.8], "yaw": 8},
       {"type": "box", "group": "rock", "center": [-0.25, 0.8, 0.1], "size": [1.8, 0.5, 1.3], "yaw": -6}], 'sandstone')
# Pebbles: three low four-sided stones.
write('cover-pebbles', 'Pebbles', {"rock": "camo"},
      [{"type": "frustum", "group": "rock", "center": [0, -0.02, 0], "base": [0.22, 0.18], "top": [0.1, 0.08], "height": 0.12, "yaw": 20},
       {"type": "frustum", "group": "rock", "center": [0.24, -0.02, 0.12], "base": [0.16, 0.14], "top": [0.07, 0.06], "height": 0.09, "yaw": 65},
       {"type": "frustum", "group": "rock", "center": [-0.18, -0.02, 0.2], "base": [0.14, 0.12], "top": [0.05, 0.05], "height": 0.08, "yaw": -30}], 'rock')
print('ok')
