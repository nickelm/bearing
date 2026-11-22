# Stylized Effects: Metrics

_2026-11-22, branch `feature/stylized-effects`, Proposal 0011, decisions 320–327._

## Where These Numbers Come From

This session ran in a cloud container without a GPU. Every frame was drawn by three's `WebGPURenderer` on Dawn over **lavapipe**, Mesa's software Vulkan driver, on 4 CPU cores. Lavapipe times measure the CPU, not a GPU, so they cannot check the proposal's budget. They show counts, the shape of the cost, and whether the work scales. The owner's GPU gives the real figures: open `effects.html?gputime`, press *stress test*, wait a few seconds, then press *Measure* (see the last section).

Chromium's WebGPU could not be used here. The device was lost at startup under lavapipe and under SwiftShader, for the existing model viewer as well as the sandbox (decision 327). All screenshots therefore come from the Dawn renders of the same sandbox scene (`tools/effects.preview.ts`).

## Checks Against the Proposal

| Check | Criterion | Result here | State |
|---|---|---|---|
| Budget | Stress scene: compute < 0.5 ms, rendering < 1.0 ms at 10,000 visible puffs | Stress scene built (50 missiles, 20 explosions, 30 columns): 17,447 puffs alive, pool high water 17,447, governor at 0.44, no puff evicted, 2 compute dispatches and 1 puff draw call a frame. No GPU timings: lavapipe only | **Open:** owner's GPU |
| Correctness | No sorting artifacts; puffs intersect terrain, aircraft and each other | No sorting by construction: opaque, depth-writing impostors with a dither fade. The renders show puffs cut by the ground (downwash, impact, depot) and by each other (columns, impact cluster). `tests/gpu/effectsScene.test.ts` draws them in the GlobeScene without GPU errors | Met (by design and in renders; not yet against an aircraft model) |
| Readability | SAM launch columns distinguishable from 20 km | `effects-sam-20km.png`: the trail reads as a white line from the ground to the missile at 20 km, held by the minimum puff size of about one pixel | Met in the render |
| Persistence | Burning targets keep smoking after the camera leaves and returns | Columns are state (`setColumns`), and a cut keeps them (`effectsScene.test.ts`). An emitter out of range sheds nothing and refills its whole column when the camera returns (`tests/effects.test.ts`) | Met in tests |
| Ribbons | Contrails only above the contrail altitude; vortices only above a load-factor threshold | `contrailForms` and `vortexForms` tested (8.5 km at 15 °C; 6 g dry, 3.5 g saturated); rendered in `effects-contrails.png` and `effects-vortex.png` | Met; not yet called by the game (TODO) |
| Integration | City plumes and rotor downwash use the shared system | Both moved, and their old meshes are gone. Weapons' impacts, wreck strikes and missile trails also go through it | Met |

## Lavapipe Timings (960 × 540, Post-Processing On)

The stress scene at 3 s, median of 10 interleaved frames (`PERF=10`):

| Measure | ms |
|---|---|
| Frame with effects | 66.4 |
| Frame without effects (group hidden) | 43.5 |
| Effects' share of the frame | 22.9 |
| A step without drawing: emitters, CPU pool, spawn and update kernels | 1.2 |

The 23 ms share is the CPU rasterizing about 17,000 impostors whose fragments each trace two ray–sphere hits and evaluate `PlanetLighting.at`. On a GPU this pass is fill-bound; expect it to scale with the screen area the puffs cover more than with their count. The 1.2 ms step includes the CPU work: the emitters, the free list's reclaim scan over 20,000 slots, and staging. The compute kernels are a few hundred ALU operations per puff.

## Counts

| Item | Count |
|---|---|
| Puff pool | 20,000 slots, 6 vec4 buffers (1.9 MB) |
| Spawns per frame, at most | 4,096 |
| Puff looks | 22 |
| Sources | 12 emitter presets and 3 blast-only presets (air burst, bomb impact, ship hit): the proposal's 15; a fuel fire is both |
| Draw calls per frame | 1 (puffs) + 3 (debris, scorch, rings) + 1 (ribbons) |
| Compute dispatches per frame | 1 (update), plus 1 (spawn) when puffs are born |
| Flash lights | at most 4 |
| Debris chunks, ground marks | at most 256 and 128 |
| Ribbon points | at most 8,192 |

## Screenshots

`docs/reports/screens/effects/` (Dawn on lavapipe, 960 × 540, the game's post-processing):

| File | Shows |
|---|---|
| `effects-sam.png` | SAM launch from 900 m at 2.5 s: the white column at the launcher and the trail climbing away |
| `effects-sam-20km.png` | The same launch from 20 km at 8 s, 20° field of view |
| `effects-airburst.png` | A 39 kg air burst at 0.08, 0.5, 1.5 and 5 s: flash, fireball, dark gray cluster |
| `effects-impact.png` | A 230 kg bomb's impact at 0.06, 0.4, 1.2, 3, 8 and 20 s: flash, fireball, dirt plume, debris, smoke, scorch |
| `effects-depot.png` | A burning fuel depot and a burning target 3 s after they started, prewarmed to full height |
| `effects-contrails.png` | A contrail pass at 10 km |
| `effects-vortex.png` | Wingtip vortices in a 7 g turn |
| `effects-chimneys.png` | A row of four stacks and a cooling tower |
| `effects-downwash.png` | A hovering helicopter's dust |
| `effects-missiles.png` | Solid and reduced-smoke missile trails, a burning and a damaged aircraft, flares |
| `effects-night.png` | A 900 kg bomb and a fuel fire at night: the flash lights the ground |
| `effects-stress.png` | The stress scene |

## For the Owner: Measuring the Budget

```powershell
npm run dev
# then open http://localhost:5173/effects.html?gputime in Chrome
```

Press *stress test*, wait three seconds, then press *Measure*. The panel shows `GPU compute … ms` (the budget is 0.5 ms) and `puffs' share … ms`, the median render-time difference between frames drawn with and without the effects (the budget is 1.0 ms). Read *puffs* in the same panel to see how many are alive; the proposal's figure is 10,000 on screen. The overview station puts most of the stress scene in view.

For Chromium screenshots on the GPU:

```powershell
npm run build; npm run preview
# in another shell:
$env:PLAYWRIGHT_DIR = "C:\Users\nikla\playwright"; $env:MODE = "gpu"; node tools/effects.screens.mjs
```
