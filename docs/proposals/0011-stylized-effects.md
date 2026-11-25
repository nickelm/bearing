# Proposal 0011: Stylized Effects

Bearing is a cartoony browser game; the values and systems here serve gameplay (README.md, What Bearing Is; CLAUDE.md rule 22).

*Drafted 2026-11-21. Status: accepted. Affects `docs/visual-style.md`, `docs/proposals/0004-helicopters.md`, `docs/proposals/0009-settlements-and-cities.md`, `docs/roadmap.md`, and `CLAUDE.md`.*

*Proposal 0013 (decision 331) adds the infantry's uses of the effects system: muzzle flashes and tracers of squads in contact, the dust of a soldier landing after a blast, and the small toon puff in which the dead vanish.*

## Goals

Smoke, fire, and explosions in Bearing are stylized in the manner of Townscaper: **solid, round, toon-shaded puffs** that swell, rise, drift with the wind, darken, and shrink away. One effects system serves every source, from missile trails to chimneys, and it stays cheap enough for thousands of puffs. Contrails and wingtip vortices stay as thin ribbons.

Effects also carry gameplay information: a SAM launch should be visible as a thick white column from the ground, and burning targets should mark where the war has been.

## The Puff

### Rendering Technique

Each puff is a camera-facing quad that the fragment shader renders as a **sphere impostor**:

- The shader intersects the view ray with a sphere inside the quad, computes the surface normal and depth, and writes depth, so puffs intersect each other and the scene correctly.
- **Toon shading:** a three-band ramp (highlight, midtone, shadow) lit by the sun, plus a thin rim light. Colors come from the puff's color-over-life curve, tinted by the zone's light.
- **Dithered fade:** puffs fade by ordered dithering instead of alpha blending. No sorting, little overdraw, and the fade fits the stylized look.
- **Shape variation:** a slight per-puff squash and a low-frequency bump on the radius keep clusters from looking like perfect marbles.

A puff costs two triangles regardless of screen size.

### Simulation

A WebGPU compute pass updates all puffs on the GPU: position, velocity, radius, age, and color. Forces are buoyancy, drag, wind from the weather model, and a little turbulence. Each puff follows curves over its life for **radius** (fast swell, slow growth, shrink at the end), **color** (for example white to light gray, or orange to dark gray), and **rise rate**.

### Budget

- Up to 20,000 live puffs.
- Compute update under 0.5 ms; rendering under 1.0 ms with 10,000 puffs on screen.
- Beyond a distance threshold, emitters reduce spawn rate and increase puff size, so distant columns keep their shape with fewer puffs.

## Ribbons

Contrails and wingtip vortices are **thin ribbons**: camera-facing strips along the recorded path, fading with age. Contrails appear above a contrail altitude set by weather. Wingtip vortices appear at high load factors and in humid air.

## Emitters

Every source is an emitter preset:

| Preset | Look | Lifetime |
|---|---|---|
| Solid rocket motor | Dense white puffs in a continuous trail, with a bright motor core | 30–60 s |
| Reduced-smoke motor | Short, thin trail of small puffs | 5–10 s |
| SAM launch | Large white column at the launcher, then a thick trail | 60 s |
| Aircraft damaged | Gray to black trail with orange flicker | While damaged |
| Aircraft on fire | Dense black trail with fire puffs at the source | Until impact |
| Air burst | Quick orange-yellow ball becoming a dark gray cluster | 10–20 s |
| Bomb impact | Brown dirt plume, fireball, debris, scorch decal | 20–40 s |
| Fuel or ammunition fire | Rolling fireball, then a tall black column | Minutes to hours |
| Burning target | Steady black or gray column leaning with the wind | While burning |
| Ship hit | White water column and fire plume | 30 s plus fire |
| Chimney | Gray puffs drifting downwind | Continuous |
| Cooling tower | Large white steam puffs | Continuous |
| Rotor downwash | Low, brown or white puffs spreading from the helicopter | While hovering |
| Flare | Bright point shedding small white puffs | 5–8 s |
| Waterfall mist | Soft white puffs at the foot of falls | Continuous |

Missile trail presets are set per weapon in its specification, so a missile's motor type decides how visible its launch and flight are.

## Explosions

Explosions combine five layers, scaled by size:

1. **Flash:** a brief bright sphere and a short-lived point light.
2. **Fireball:** emissive puffs that swell quickly and shift from yellow to orange to red.
3. **Smoke:** a puff cluster that takes over as the fireball cools.
4. **Debris:** a few flat-shaded chunks on ballistic paths, some trailing small smoke puffs.
5. **Ground effects:** a shockwave ring for large blasts and a scorch decal on impact.

Point lights from flashes are capped at a small number per frame, with the oldest dropped first.

## Integration

- **Event interface.** The game engine emits events (launch, hit, explosion, fire started, fire extinguished); the renderer spawns effects from them. Effects are cosmetic and never feed back into game state.
- **Long-lived columns** derive from damage states (proposal 0009 and the game layer's target states), so a burning depot keeps smoking when the camera returns.
- **Existing effects.** City plumes from proposal 0009 and rotor downwash from proposal 0004 move to this system.
- **Visibility to the game.** Smoke does not block line of sight in this proposal. Obscuration by smoke is a later idea for the game layer.

## Style Rules

- Puffs are round, solid, and toon-shaded; no soft photographic smoke textures.
- Fire is emissive, in saturated yellow, orange, and red; smoke goes from white or light gray (motors, steam) through mid gray (burning buildings) to near black (fuel fires).
- Silhouettes matter: a trail must read as a chain of balls against sky and terrain.
- Explosions are punchy and short; columns are tall and slow.

These rules go into `docs/visual-style.md` Part I under *Effects*.

## Verification Criteria

| Check | Criterion |
|---|---|
| Budget | In a stress scene (50 missiles in flight, 20 explosions, 30 burning columns), compute under 0.5 ms and rendering under 1.0 ms at 10,000 visible puffs, on the reference laptop or a documented equivalent |
| Correctness | No sorting artifacts; puffs intersect terrain, aircraft, and each other correctly |
| Readability | SAM launch columns are distinguishable from 20 km in screenshots |
| Persistence | Burning targets keep smoking after the camera leaves and returns |
| Ribbons | Contrails form only above the contrail altitude; vortices only above a load factor threshold |
| Integration | City plumes and rotor downwash use the shared system |
