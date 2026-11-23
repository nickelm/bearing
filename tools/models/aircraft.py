# Generates the geometry of the AI-only aircraft of the demo's orders (roadmap R2.7): the
# E-5, KC-40, F-25, Vo-37, Ra-44, Ra-60, Ve-28 and Ve-18. Each model's parts, groups,
# emissives, rotors and chase-camera rig are written into its bundle in
# src/data/models/aircraft/; the bundle's other blocks (air war, avionics) stay as they are.
# Run from the repository's root, then format:
#   python3 tools/models/aircraft.py [ids…]
#   npx prettier --write src/data/models/aircraft/*.json
#
# Frame (spec.ts): meters, +x forward, +y up, +z to starboard. Fixed-wing models stand on
# their gear with the fuselage's axis at y = 0 (the gear's parts move on the `gear` channel,
# so the flying model leaves them out); helicopters stand on the ground at y = 0.
import json, math, sys

T = math.tan
R = math.radians


class Model:
    def __init__(self):
        self.parts = []
        self.emissives = []
        self.rotors = []

    def add(self, **p):
        self.parts.append(p)

    def loft(self, group, stations, sides=8):
        self.add(type='loft', group=group, sides=sides,
                 stations=[dict(x=s[0], y=s[1], w=s[2], h=s[3], **({'square': s[4]} if len(s) > 4 else {}))
                           for s in stations])

    def wing(self, group, root, rc, tc, span, sweep, thickness=0.08, dihedral=0, mirror=True,
             vertical=False):
        p = dict(type='wing', group=group, root=root, rootChord=rc, tipChord=tc, span=span,
                 sweep=sweep, thickness=thickness)
        if dihedral:
            p['dihedral'] = dihedral
        if mirror:
            p['mirror'] = True
        if vertical:
            p['vertical'] = True
        self.parts.append(p)

    def cyl(self, group, a, b, r, r2=None, sides=8, mirror=False, **k):
        p = dict(type='cylinder', group=group, to=b, radius=r, sides=sides, **k)
        p['from'] = a
        if r2 is not None:
            p['radius2'] = r2
        if mirror:
            p['mirror'] = True
        self.parts.append(p)

    def box(self, group, c, s, mirror=False, **k):
        p = dict(type='box', group=group, center=c, size=s, **k)
        if mirror:
            p['mirror'] = True
        self.parts.append(p)

    def blob(self, group, c, r, detail=0, half=False, mirror=False):
        p = dict(type='blob', group=group, center=c, radius=r, detail=detail)
        if half:
            p['half'] = True
        if mirror:
            p['mirror'] = True
        self.parts.append(p)

    def leg(self, x, z, top, bottom, tire, width=0.25, mirror=False, back=1, strut=0.12):
        """A gear leg from `top` down to the tire's axle, swinging up on the gear channel."""
        hinge = [[x, top, z - 0.4], [x, top, z + 0.4]]
        anim = dict(channel='gear', hinge=hinge, angle=100 * back)
        self.cyl('gear', [x, top, z], [x, bottom, z], strut, sides=6, mirror=mirror, anim=anim)
        self.cyl('tire', [x, bottom, z - width / 2], [x, bottom, z + width / 2], tire, sides=8,
                 mirror=mirror, anim=anim)

    def light(self, kind, at):
        self.emissives.append(dict(kind=kind, at=at))

    def tip_lights(self, x, y, z, tail):
        self.light('nav-red', [x, y, -z])
        self.light('nav-green', [x, y, z])
        self.light('nav-white', tail)


def jet_rig(distance, height):
    return dict(kind='fast-jet', distance=distance, height=height,
                groundDistance=round(distance * 0.75, 1), groundHeight=round(height * 0.65, 1),
                rotation=3.0 if distance < 30 else 2.5, stretch=2 if distance < 30 else 1.5,
                stretchPerAccel=0.25 if distance < 30 else 0.4, fovDeg=50)


# ---- The 707 family: E-5 (E-3) and KC-40 (KC-135) ----

def airliner(m, length, engines_big):
    """A four-engined, swept, low-winged jet transport about 2 m in fuselage radius."""
    h = length / 2
    r = 1.9
    m.loft('body', [
        (h, 0.1, 0, 0),
        (h - 0.9, 0.05, 0.9, 0.85),
        (h - 2.6, 0.1, 1.6, 1.7),
        (h - 6, 0.15, r, r * 1.03),
        (-h + 13, 0, r, r * 1.03),
        (-h + 7.5, 0.45, 1.35, 1.35),
        (-h + 3, 0.95, 0.6, 0.6),
        (-h, 1.25, 0.15, 0.15),
    ])
    # The cockpit's windows: a dark band over the nose.
    m.loft('canopy', [(h - 1.9, 0.6, 1.15, 0.5, 0.4), (h - 2.6, 0.95, 1.55, 0.6, 0.4),
                      (h - 3.4, 1.05, 1.7, 0.55, 0.4)], sides=6)
    # Wing: low, swept 35°, with a little dihedral; its root's leading edge 4 m forward of mid.
    root_x, root_y, root_z, span, rc = 4.5, -1.15, 1.7, 20.3, 9.6
    m.wing('body', [root_x, root_y, root_z], rc, 2.3, span, 35, thickness=0.1, dihedral=7)
    m.box('body', [root_x - 4.2, -1.25, 0], [8.4, 0.7, 3.6], bevel=0.3)
    for z in (7.4, 14.3):
        le = root_x - (z - root_z) * T(R(35))
        y = root_y + (z - root_z) * T(R(7))
        nr = 0.95 if engines_big else 0.72
        m.cyl('body', [le + 2.4, y - 1.55, z], [le - 2.2, y - 1.45, z], nr, nr * 0.72, mirror=True)
        m.cyl('intake', [le + 2.45, y - 1.55, z], [le + 2.5, y - 1.55, z], nr * 0.85, sides=8,
              mirror=True)
        m.cyl('nozzle', [le - 2.2, y - 1.45, z], [le - 2.7, y - 1.4, z], nr * 0.7, nr * 0.55,
              mirror=True)
        m.box('body', [le - 0.6, y - 0.75, z], [3.0, 1.1, 0.25], mirror=True)
    # Tails.
    m.wing('body', [-h + 8.6, 1.5, 0], 8.4, 2.8, 7.6, 35, thickness=0.09, mirror=False,
           vertical=True)
    m.wing('body', [-h + 6.0, 0.8, 0.6], 5.0, 1.6, 6.6, 35, thickness=0.08, dihedral=7)
    tip = root_z + span
    m.tip_lights(root_x - span * T(R(35)) - 1.6, root_y + span * T(R(7)), tip - 0.1,
                 [-h + 0.2, 1.25, 0])
    m.light('beacon', [2, r + 0.05, 0])
    m.light('beacon', [2, -r - 0.05, 0])
    # Gear: a nose leg and two four-wheel bogies (one wide tire each, drawn).
    m.leg(h - 5.5, 0, -1.6, -3.1, 0.5, width=0.5, back=-1)
    m.leg(-1.5, 3.1, -1.4, -2.95, 0.65, width=0.7, mirror=True)
    return h


def e5():
    m = Model()
    h = airliner(m, 46.6, engines_big=False)
    # The rotodome on two struts over the rear fuselage: 9.1 m across, 1.8 m deep.
    m.wing('body', [-5.2, 1.8, 0.55], 3.0, 2.2, 3.0, 25, thickness=0.12, vertical=True,
           dihedral=-8)
    cx, cy = -7.6, 5.6
    m.cyl('dome', [cx, cy - 0.9, 0], [cx, cy, 0], 4.0, 4.55, sides=8)
    m.cyl('dome', [cx, cy, 0], [cx, cy + 0.9, 0], 4.55, 4.0, sides=8)
    m.cyl('band', [cx, cy - 0.05, 0], [cx, cy + 0.05, 0], 4.6, 4.6, sides=8)
    groups = {'body': 'camo', 'canopy': 'canopy', 'intake': 'intake', 'nozzle': 'nozzle',
              'dome': '#9AA1A8', 'band': '#3E4348', 'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    return m, groups, jet_rig(80, 16)


def kc40():
    m = Model()
    h = airliner(m, 41.5, engines_big=True)
    # The flying boom under the tail, stowed, with its ruddevators.
    m.cyl('body', [-h + 5.5, -1.0, 0], [-h - 3.5, -2.6, 0], 0.22, 0.14, sides=6)
    m.wing('body', [-h + 0.2, -1.9, 0.15], 0.9, 0.5, 0.9, 20, thickness=0.06, dihedral=-30)
    m.box('canopy', [-h + 6.4, -1.6, 0], [1.4, 0.4, 1.2])
    groups = {'body': 'camo', 'canopy': 'canopy', 'intake': 'intake', 'nozzle': 'nozzle',
              'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    return m, groups, jet_rig(72, 15)


# ---- F-25 (F-15) ----

def f25():
    m = Model()
    m.loft('body', [
        (9.6, 0.25, 0, 0),
        (8.6, 0.25, 0.32, 0.32),
        (7.0, 0.3, 0.55, 0.55),
        (5.4, 0.4, 0.68, 0.72),
        (3.6, 0.35, 1.0, 0.6, 0.5),
        (0, 0.3, 1.25, 0.5, 0.7),
        (-4.5, 0.3, 1.15, 0.45, 0.7),
        (-7.0, 0.3, 0.6, 0.3, 0.5),
    ])
    # Intakes: square boxes either side of the cockpit, raked.
    m.box('body', [2.4, -0.05, 1.35], [4.8, 1.2, 1.0], bevel=0.12, mirror=True)
    m.box('intake', [4.82, 0.0, 1.35], [0.05, 1.05, 0.9], mirror=True)
    # Engines and nozzles side by side.
    m.cyl('body', [0, 0.15, 0.62], [-7.6, 0.2, 0.62], 0.62, 0.55, mirror=True)
    m.cyl('nozzle', [-7.6, 0.2, 0.62], [-8.4, 0.2, 0.62], 0.55, 0.48, mirror=True)
    m.blob('canopy', [5.0, 1.05, 0], [1.9, 0.55, 0.5], detail=1, half=True)
    # A big, low-swept wing; stabilators; two vertical tails canted out a little.
    m.wing('body', [1.6, 0.35, 1.8], 5.6, 1.6, 4.7, 45, thickness=0.05)
    m.wing('body', [-5.2, 0.2, 1.4], 3.0, 1.2, 2.9, 45, thickness=0.05)
    m.wing('body', [-4.0, 0.7, 1.1], 3.2, 1.3, 3.0, 36, thickness=0.05, vertical=True,
           dihedral=-2)
    m.tip_lights(-2.5, 0.35, 6.4, [-7.2, 3.6, 1.2])
    m.light('beacon', [-1, 0.85, 0])
    m.leg(5.3, 0, -0.25, -1.75, 0.3, width=0.22, back=-1)
    m.leg(-0.6, 1.3, -0.3, -1.68, 0.37, width=0.28, mirror=True)
    groups = {'body': 'camo', 'canopy': 'canopy', 'intake': 'intake', 'nozzle': 'nozzle',
              'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    m.emissives.insert(0, dict(kind='afterburner', at=[-8.45, 0.2, 0.62], mirror=True))
    return m, groups, jet_rig(21, 4.4)


# ---- Vo-37 (Su-24) ----

def vo37():
    m = Model()
    m.loft('body', [
        (11.2, 0.3, 0, 0),
        (10.0, 0.3, 0.55, 0.55),
        (8.2, 0.35, 0.9, 0.85),
        (6.4, 0.45, 1.15, 0.95, 0.4),
        (3.0, 0.35, 1.55, 0.85, 0.7),
        (-3.0, 0.3, 1.5, 0.8, 0.7),
        (-7.0, 0.35, 1.2, 0.65, 0.6),
        (-9.6, 0.5, 0.95, 0.5, 0.5),
    ])
    # Side-by-side cockpit: a wide, low canopy.
    m.blob('canopy', [6.3, 1.25, 0], [1.6, 0.5, 0.85], detail=1, half=True)
    # Intakes beside the cockpit, splitter plates.
    m.box('body', [2.6, 0.2, 1.55], [4.2, 1.1, 0.9], bevel=0.1, mirror=True)
    m.box('intake', [4.72, 0.2, 1.55], [0.05, 1.0, 0.8], mirror=True)
    m.cyl('nozzle', [-9.6, 0.25, 0.6], [-10.3, 0.25, 0.6], 0.52, 0.46, mirror=True)
    # The glove and the wings at mid sweep (45°), as cruising.
    m.wing('body', [3.4, 0.55, 1.9], 3.6, 2.6, 1.3, 70, thickness=0.06)
    m.wing('body', [0.6, 0.55, 3.0], 3.1, 1.3, 6.2, 45, thickness=0.05, dihedral=-2)
    # One tall fin, two ventral fins, stabilators.
    m.wing('body', [-4.6, 1.0, 0], 4.6, 1.6, 4.2, 48, thickness=0.05, mirror=False,
           vertical=True)
    m.wing('body', [-6.6, -0.2, 0.7], 1.4, 0.8, 0.8, 40, thickness=0.05, vertical=True,
           dihedral=150)
    m.wing('body', [-7.0, 0.4, 1.0], 3.2, 1.4, 3.2, 45, thickness=0.05, dihedral=-4)
    m.tip_lights(-6.3, 0.35, 8.8, [-9.8, 4.6, 0])
    m.light('beacon', [-1, 1.05, 0])
    m.leg(6.6, 0, -0.4, -1.85, 0.32, width=0.24, back=-1)
    m.leg(-1.2, 1.6, -0.5, -1.8, 0.42, width=0.34, mirror=True)
    groups = {'body': 'camo', 'canopy': 'canopy', 'intake': 'intake', 'nozzle': 'nozzle',
              'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    m.emissives.insert(0, dict(kind='afterburner', at=[-10.35, 0.25, 0.6], mirror=True))
    return m, groups, jet_rig(24, 5)


# ---- Ra-44 (An-12) and Ra-60 (A-50) ----

def ra44():
    m = Model()
    m.loft('body', [
        (16.6, -0.2, 0, 0),
        (16.0, -0.25, 0.9, 0.8),
        (14.6, -0.1, 1.55, 1.45),
        (12.0, 0.1, 1.85, 1.9, 0.3),
        (-3.0, 0.1, 1.85, 1.95, 0.35),
        (-9.0, 0.9, 1.3, 1.25, 0.3),
        (-14.5, 1.6, 0.6, 0.6),
        (-16.6, 1.7, 0.45, 0.5),
    ])
    # The glazed nose, the cockpit's windows and the tail gunner's glazing.
    m.loft('canopy', [(16.5, -0.25, 0.4, 0.35), (15.6, -0.15, 1.0, 0.85),
                      (15.1, -0.1, 1.2, 1.0)], sides=6)
    m.loft('canopy', [(13.8, 1.1, 1.0, 0.45, 0.4), (12.8, 1.4, 1.35, 0.5, 0.4),
                      (12.0, 1.45, 1.4, 0.45, 0.4)], sides=6)
    m.blob('canopy', [-16.7, 1.7, 0], [0.9, 0.55, 0.55])
    # High, straight wing with four turboprops.
    m.box('body', [1.0, 1.95, 0], [5.0, 0.5, 3.4], bevel=0.2)
    m.wing('body', [3.4, 2.0, 1.6], 4.8, 2.2, 17.0, 6, thickness=0.11, dihedral=-1.5)
    for z, hub in ((5.4, 6.3), (10.2, 5.9)):
        y = 2.0 - (z - 1.6) * T(R(1.5))
        m.cyl('body', [hub - 0.3, y - 0.3, z], [-2.2, y - 0.1, z], 0.62, 0.42, mirror=True)
        m.blob('nozzle', [hub - 0.2, y - 0.3, z], [0.55, 0.42, 0.42], mirror=True)
        m.rotors.append(dict(hub=[hub, y - 0.3, -z], axis=[1, 0, 0], radius=2.25, blades=4,
                             chord=0.3, direction=1, group='prop'))
        m.rotors.append(dict(hub=[hub, y - 0.3, z], axis=[1, 0, 0], radius=2.25, blades=4,
                             chord=0.3, direction=1, group='prop'))
    m.wing('body', [-9.4, 2.4, 0], 6.4, 2.4, 6.4, 32, thickness=0.09, mirror=False,
           vertical=True)
    m.wing('body', [-12.0, 1.8, 0.5], 4.0, 1.9, 6.0, 10, thickness=0.08, dihedral=4)
    # Landing gear sponsons.
    m.box('body', [-0.4, -1.4, 1.75], [5.6, 1.2, 0.9], bevel=0.25, mirror=True)
    m.tip_lights(1.6, 1.6, 18.5, [-16.8, 2.2, 0])
    m.light('beacon', [-2, 2.3, 0])
    m.light('beacon', [-2, -1.95, 0])
    m.leg(12.5, 0, -1.6, -2.85, 0.5, width=0.4, back=-1)
    m.leg(-0.4, 1.75, -1.9, -2.7, 0.65, width=0.5, mirror=True)
    groups = {'body': 'camo', 'canopy': 'canopy', 'nozzle': 'nozzle', 'prop': '#34373A',
              'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    return m, groups, jet_rig(72, 14)


def ra60():
    m = Model()
    h = 23.5
    m.loft('body', [
        (h, -0.6, 0, 0),
        (h - 0.6, -0.65, 0.8, 0.7),
        (h - 2.2, -0.35, 1.7, 1.6),
        (h - 5.0, 0, 2.2, 2.3, 0.3),
        (-6.0, 0, 2.25, 2.35, 0.35),
        (-13.0, 1.0, 1.5, 1.5, 0.3),
        (-19.5, 1.9, 0.75, 0.75),
        (-h, 2.2, 0.35, 0.4),
    ])
    m.loft('canopy', [(h - 1.6, 0.7, 1.0, 0.45, 0.4), (h - 2.6, 1.15, 1.6, 0.55, 0.4),
                      (h - 3.4, 1.25, 1.75, 0.5, 0.4)], sides=6)
    # The navigator's glazed chin.
    m.blob('canopy', [h - 1.0, -0.9, 0], [1.0, 0.55, 0.75])
    # High wing swept 25°, four jets on pylons.
    m.box('body', [1.5, 2.3, 0], [6.4, 0.6, 4.0], bevel=0.25)
    m.wing('body', [5.0, 2.4, 1.9], 7.6, 2.4, 23.0, 25, thickness=0.1, dihedral=-3)
    for z in (6.6, 12.6):
        le = 5.0 - (z - 1.9) * T(R(25))
        y = 2.4 - (z - 1.9) * T(R(3))
        m.cyl('body', [le + 2.4, y - 1.55, z], [le - 2.6, y - 1.45, z], 0.85, 0.62, mirror=True)
        m.cyl('intake', [le + 2.45, y - 1.55, z], [le + 2.5, y - 1.55, z], 0.75, mirror=True)
        m.cyl('nozzle', [le - 2.6, y - 1.45, z], [le - 3.1, y - 1.4, z], 0.6, 0.48, mirror=True)
        m.box('body', [le - 0.4, y - 0.7, z], [3.0, 1.0, 0.25], mirror=True)
    # The T-tail.
    m.wing('body', [-14.5, 2.6, 0], 6.4, 4.2, 6.8, 38, thickness=0.09, mirror=False,
           vertical=True)
    m.wing('body', [-19.6, 9.3, 0.3], 4.6, 2.0, 8.6, 30, thickness=0.08, dihedral=-4)
    # Gear sponsons, the rotodome on two struts.
    m.box('body', [-1.0, -1.8, 2.15], [9.0, 1.4, 1.1], bevel=0.3, mirror=True)
    m.wing('body', [-6.0, 2.3, 0.6], 3.2, 2.4, 2.2, 25, thickness=0.12, vertical=True,
           dihedral=-8)
    cx, cy = -8.2, 5.2
    m.cyl('dome', [cx, cy - 0.95, 0], [cx, cy, 0], 4.3, 5.25, sides=8)
    m.cyl('dome', [cx, cy, 0], [cx, cy + 0.95, 0], 5.25, 4.3, sides=8)
    m.cyl('band', [cx, cy - 0.05, 0], [cx, cy + 0.05, 0], 5.3, 5.3, sides=8)
    m.tip_lights(-6.6, 1.2, 24.8, [-h - 0.1, 2.2, 0])
    m.light('beacon', [-2, 2.95, 0])
    m.light('beacon', [-2, -2.5, 0])
    m.leg(h - 5.0, 0, -2.0, -3.3, 0.55, width=0.5, back=-1)
    m.leg(-1.0, 2.15, -2.3, -3.2, 0.7, width=0.6, mirror=True)
    groups = {'body': 'camo', 'canopy': 'canopy', 'intake': 'intake', 'nozzle': 'nozzle',
              'dome': '#9AA1A8', 'band': '#3E4348', 'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    return m, groups, jet_rig(84, 18)


# ---- Ve-28 (Mi-24) and Ve-18 (Mi-8) ----

def ve28():
    m = Model()
    # A slim, armored fuselage with stepped tandem cockpits, standing on its gear at y = 0.
    m.loft('body', [
        (8.6, 1.05, 0, 0),
        (8.2, 1.05, 0.35, 0.35),
        (7.2, 1.2, 0.7, 0.6, 0.4),
        (5.6, 1.45, 0.85, 0.8, 0.5),
        (3.4, 1.65, 1.05, 1.0, 0.6),
        (-0.8, 1.75, 1.05, 1.0, 0.6),
        (-3.6, 2.0, 0.55, 0.55, 0.4),
        (-9.6, 2.5, 0.3, 0.35),
    ])
    m.blob('canopy', [7.0, 1.55, 0], [1.1, 0.5, 0.55], detail=1, half=True)
    m.blob('canopy', [5.2, 2.05, 0], [1.3, 0.6, 0.65], detail=1, half=True)
    # The engines' cowl over the cabin, exhausts out the sides.
    m.box('body', [1.2, 2.95, 0], [4.6, 0.55, 1.5], bevel=0.2)
    m.cyl('nozzle', [-1.0, 2.9, 0.55], [-1.9, 2.75, 1.0], 0.28, sides=6, mirror=True)
    m.cyl('rotor', [0.2, 3.2, 0], [0.2, 3.75, 0], 0.2, sides=6)
    # Stub wings with anhedral, pylons and rocket pods.
    m.wing('body', [1.6, 1.7, 1.0], 1.9, 1.2, 2.3, 10, thickness=0.1, dihedral=-12)
    for z, dz in ((2.0, 0.0), (2.9, 0.18)):
        m.cyl('store', [2.2, 1.0 - dz, z], [0.6, 1.0 - dz, z], 0.25, sides=6, mirror=True)
    # Tail boom, fin canted, stabilizers.
    m.wing('body', [-8.4, 2.4, 0], 1.6, 0.9, 1.9, 40, thickness=0.12, mirror=False,
           vertical=True, dihedral=-10)
    m.wing('body', [-7.0, 2.3, 0.2], 1.1, 0.7, 1.4, 10, thickness=0.08)
    # Retractable gear drawn down (the AI's helicopter keeps it down).
    m.cyl('gear', [6.2, 1.0, 0], [6.3, 0.27, 0], 0.07, sides=4)
    m.cyl('tire', [6.3, 0.27, -0.12], [6.3, 0.27, 0.12], 0.27, sides=8)
    m.cyl('gear', [0.8, 1.25, 1.0], [0.6, 0.35, 1.25], 0.08, sides=4, mirror=True)
    m.cyl('tire', [0.6, 0.35, 1.13], [0.6, 0.35, 1.4], 0.35, sides=8, mirror=True)
    m.rotors.append(dict(hub=[0.2, 3.85, 0], radius=8.6, blades=5, chord=0.58, direction=-1,
                         group='rotor'))
    m.rotors.append(dict(hub=[-9.3, 3.2, -0.5], axis=[0, 0, -1], radius=1.95, blades=3,
                         chord=0.3, direction=1, group='rotor'))
    m.light('nav-red', [1.4, 1.35, -3.3])
    m.light('nav-green', [1.4, 1.35, 3.3])
    m.light('nav-white', [-9.7, 2.5, 0])
    m.light('beacon', [-0.5, 2.75, 0])
    groups = {'body': 'camo', 'canopy': 'canopy', 'nozzle': 'nozzle', 'rotor': '#34373A',
              'store': 'steel', 'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    return m, groups, dict(kind='helicopter')


def ve18():
    m = Model()
    # A rounded pod with a blunt glazed nose, a slim tail boom, clamshell doors aft.
    m.loft('body', [
        (7.4, 1.6, 0, 0),
        (7.2, 1.55, 0.6, 0.55, 0.3),
        (6.4, 1.5, 1.05, 0.95, 0.5),
        (4.6, 1.65, 1.2, 1.15, 0.7),
        (-1.4, 1.7, 1.2, 1.2, 0.75),
        (-4.4, 1.95, 0.85, 0.85, 0.6),
        (-5.2, 2.35, 0.35, 0.4),
        (-11.6, 2.75, 0.25, 0.3),
    ])
    m.loft('canopy', [(7.35, 1.65, 0.45, 0.35, 0.3), (6.9, 1.95, 0.95, 0.55, 0.4),
                      (6.2, 2.15, 1.1, 0.5, 0.5)], sides=6)
    # Round cabin windows.
    for x in (3.4, 2.2, 1.0, -0.2):
        m.box('canopy', [x, 2.0, 1.2], [0.45, 0.45, 0.04], mirror=True)
    m.box('body', [2.4, 3.15, 0], [5.4, 0.7, 1.5], bevel=0.3)
    m.cyl('intake', [5.1, 3.15, 0.45], [5.15, 3.15, 0.45], 0.3, sides=6, mirror=True)
    m.cyl('nozzle', [0.0, 3.1, 0.6], [-0.8, 3.0, 1.0], 0.3, sides=6, mirror=True)
    m.cyl('rotor', [1.8, 3.5, 0], [1.8, 4.1, 0], 0.22, sides=6)
    # External fuel tanks along the sides.
    m.cyl('body', [3.6, 0.95, 1.45], [0.4, 0.95, 1.45], 0.42, sides=6, mirror=True)
    m.wing('body', [-10.4, 2.7, 0], 1.6, 0.9, 1.9, 40, thickness=0.12, mirror=False,
           vertical=True, dihedral=-10)
    m.wing('body', [-9.0, 2.6, 0.2], 1.0, 0.7, 1.3, 10, thickness=0.08)
    # Fixed tricycle gear.
    m.cyl('gear', [5.8, 0.9, 0.35], [5.8, 0.27, 0.35], 0.07, sides=4, mirror=True)
    m.cyl('tire', [5.8, 0.27, 0.25], [5.8, 0.27, 0.5], 0.27, sides=8, mirror=True)
    m.cyl('gear', [-0.8, 0.9, 1.0], [-0.9, 0.36, 1.6], 0.08, sides=4, mirror=True)
    m.cyl('tire', [-0.9, 0.36, 1.48], [-0.9, 0.36, 1.75], 0.36, sides=8, mirror=True)
    m.rotors.append(dict(hub=[1.8, 4.2, 0], radius=10.6, blades=5, chord=0.52, direction=-1,
                         group='rotor'))
    m.rotors.append(dict(hub=[-11.4, 3.5, -0.45], axis=[0, 0, -1], radius=1.95, blades=3,
                         chord=0.3, direction=1, group='rotor'))
    m.light('nav-red', [4.0, 1.9, -1.25])
    m.light('nav-green', [4.0, 1.9, 1.25])
    m.light('nav-white', [-11.7, 2.75, 0])
    m.light('beacon', [1.0, 3.55, 0])
    m.light('beacon', [1.0, 0.45, 0])
    groups = {'body': 'camo', 'canopy': 'canopy', 'intake': 'intake', 'nozzle': 'nozzle',
              'rotor': '#34373A', 'gear': '#B8BCBE', 'tire': '#2B2C2E'}
    return m, groups, dict(kind='helicopter')


MODELS = dict(e5=e5, kc40=kc40, f25=f25, vo37=vo37, ra44=ra44, ra60=ra60, ve28=ve28, ve18=ve18)
# Schemes: the palette's Pact tactical for strike aircraft and helicopters (visual style).
SCHEMES = dict(vo37='pact-tactical', ve28='pact-tactical', ve18='pact-tactical')


def write(id_):
    path = f'src/data/models/aircraft/{id_}.json'
    b = json.load(open(path))
    m, groups, rig = MODELS[id_]()
    out = {}
    for k in ('name', 'class', 'scheme'):
        out[k] = b[k]
    if id_ in SCHEMES:
        out['scheme'] = SCHEMES[id_]
    out['groups'] = groups
    out['parts'] = m.parts
    if m.rotors:
        out['rotors'] = m.rotors
    out['emissives'] = m.emissives
    out['rig'] = rig
    for k, v in b.items():
        if k not in out and k not in ('parts', 'groups', 'rotors', 'emissives', 'rig'):
            out[k] = v
    open(path, 'w').write(json.dumps(out, indent=2, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    for id_ in sys.argv[1:] or MODELS:
        write(id_)
