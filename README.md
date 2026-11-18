# Bearing

Bearing is a browser-based late-Cold-War air war set on a procedurally generated, Earth-like planet about 1,000 km in radius. Fictional NATO and Warsaw Pact analogues are to fight a continuous war with fighters, bombers, helicopters and convoys over a moving ground front, and the player drops into any airborne unit of their side.

Today the world, both views, the air war's analytic flights on the map and the Free Flight sandbox exist; the war does not yet resolve, and the player cannot yet join a mission. See [docs/roadmap.md](docs/roadmap.md) for what comes next, [docs/status/audit-2026-11-18.md](docs/status/audit-2026-11-18.md) for the state of every feature, [docs/design.md](docs/design.md) for the design, [TODO.md](TODO.md) for current tasks and [docs/decisions.md](docs/decisions.md) for the architecture decision log.

**Live build:** <https://nickelm.github.io/bearing/>. Forks deploy to `https://<user>.github.io/bearing/`. It needs a WebGPU browser.

## Requirements

- Node.js 22.12 or later, with npm.
- A desktop browser with **WebGPU**: a current Chrome, Edge, Firefox or Safari. Bearing needs GPU compute and has no WebGL fallback.

## Commands

```sh
npm install          # install dependencies
npm run dev          # start the dev server (http://localhost:5173)
npm test             # run unit tests once (npm run test:watch to watch)
npm run typecheck    # TypeScript type check
npm run lint         # ESLint, including the layering and determinism rules
npm run format       # format with Prettier
npm run check        # typecheck + lint + test
npm run build        # type check and production build into dist/
npm run preview      # serve the production build (http://localhost:4173/bearing/)
npm run maps         # render world map PNGs to tools/out/ (SEED, RES, MODES env vars)
```

Append `?seed=<number or text>` to the URL to open a specific world. `&res=` sets the tectonic grid (64–512 cells per face edge) and `&gres=` the global grid (512, 1024 or 2048; default 1024). A world generated once with the same parameters loads from the browser's IndexedDB cache.

GPU tests (`tests/gpu/`) run the WGSL kernels on your GPU through Dawn's Node bindings, and they skip when no GPU adapter is available. The offline previews in `tools/` render terrain and tiles without a browser:

```sh
npx vitest run --config vitest.tools.config.ts tools/terrain.preview.ts   # eroded globe, rivers, biomes
npx vitest run --config vitest.tools.config.ts tools/tiles.preview.ts     # a mosaic of detail tiles
npx vitest run --config vitest.tools.config.ts tools/bench.preview.ts     # global-grid benchmark
```

## Free Flight

Free Flight is a sandbox: pick a seed and an airbase, take off in the F-21 Kestrel (the F-16 analogue) or one of two helicopters (the MH-14 Wren and the UH-68), fly anywhere, and land at the same or another airbase. There is no war and there are no weapons (decision 134); optional scripted traffic and ground radars feed the radar and the threat warning (decision 218).

- **Open it** from the debug GUI (**Free Flight (fly from an airbase)…**), or with a URL such as `http://localhost:5173/?mode=freeflight&seed=1`. The start screen lists the world's airbases with their side, region and runway; click one in the list or on the map, choose the options and press **Fly** (or double-click a base). Generating a new world takes a while the first time; the **Fly** button waits for the terrain.
- **URL parameters** for fast iteration: `base=<id>` spawns at once when the world is ready, `tod=<hours>` sets the local time (default 17, late afternoon), `spawn=runway|air` (default `runway`; `air` starts at 3,000 m and 300 kt along the runway), `fuel=unlimited|limited` (default unlimited), `aircraft=kestrel|scout|utility`, `weather=<preset>|live` (presets in `src/sim/weather/presets.ts`), `wind=off`, `control=aim|direct` (the jet's mouse mode; default `aim`), `invert=aim,stick,helo`, `traffic=on|off`, `fps=on|off`, `ui=<scale>`, `micro=on` (micro-facets), `autopilot` lets the scripted test pilot fly a circuit, and `dev` shows the debug GUI. `src/freeflight/url.ts` lists them all.
- **On the runway** the engine idles and the parking brake is set. Release it (P), go to full throttle (Shift until the military detent, release, Shift again for afterburner), at about 150 kt hold the stick back (S) until about 9° of pitch and let go (with the gear down the stick commands pitch rate, 5°/s on the runway, and the attitude holds), and raise the gear (G); the stick then commands g. After touchdown, let go of the stick and the nose comes down onto the nosewheel. To land, lower the gear below 300 kt, fly the approach at 13° angle of attack (the angle-of-attack bracket on the flight path marker centers; decision 208) on the 3° glide path (the landing aid's needles), and brake (Space) once the nosewheel is down.

| Input                            | Action                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| W / S (or ↑ / ↓)                 | Stick forward / back (pitch)                                    |
| A / D (or ← / →)                 | Roll left / right                                               |
| Q / E                            | Rudder; nosewheel steering on the ground                        |
| Shift / Ctrl, = / −, mouse wheel | Throttle; stops at idle, military and the afterburner gate      |
| G                                | Landing gear up / down                                          |
| B                                | Speedbrake                                                      |
| Space (hold)                     | Wheel brakes                                                    |
| P                                | Parking brake                                                   |
| Tab                              | Capture or free the mouse (cursor mode for the displays)        |
| N                                | Mouse aim (default) or direct control (mouse as stick)          |
| I                                | Invert the mouse's up and down                                  |
| Right drag, or hold C            | Free look; it stays where it is left                            |
| V, or middle click               | Recenter the view                                               |
| 1 / 2 / 3 / 4                    | Toggle the left display, right display, messages, threat        |
| M / F                            | Master mode by hand / dogfight                                  |
| K                                | Acknowledge the master caution                                  |
| L / U                            | Radar lock / break lock                                         |
| H                                | Help with every binding                                         |
| F3                               | Flight-model debug panel                                        |
| Esc                              | Pause menu: resume, restart, air start, change airbase, options |

The bindings live in one table, `FLIGHT_BINDINGS` in `src/ui/flight/flightInput.ts`. A gamepad or flight stick's first axes drive the stick (basic support). Ctrl+W closes a browser tab; the page asks before leaving while you fly.

Offline checks without a browser:

```sh
npx vitest run tests/flightModel.test.ts tests/freeFlight.test.ts           # flight model and the headless circuit
npx vitest run --config vitest.tools.config.ts tools/flight.preview.ts     # the Kestrel's performance figures
npx vitest run --config vitest.tools.config.ts tools/freeflight.preview.ts # chase-view renders (Dawn)
node tools/freeflight.screens.mjs                                          # HUD over the renders (needs npm run dev)
```

## Deployment

Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml). It runs the type check and tests, builds, and publishes `dist/` to GitHub Pages. Production builds use the base path `/bearing/`, so the site is served at `https://<user>.github.io/bearing/`.

Before the first deploy, set the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions**. Until then the deploy job fails.

The site is fully static, with no custom headers, so the app never relies on `SharedArrayBuffer` or cross-origin isolation (decision 40).

## Controls

| Input                        | Action                                  |
| ---------------------------- | --------------------------------------- |
| Left drag                    | Move over the ground                    |
| Right drag (or Shift + drag) | Up and down: tilt; left and right: turn |
| Mouse wheel                  | Zoom (altitude)                         |
| W / A / S / D                | Fly forward, left, back, right          |
| Q / E                        | Turn left, right                        |
| R / F                        | Climb, descend                          |

The camera stays at least 500 m above the terrain under it.
