# Bearing

Bearing is a browser-based late-Cold-War air war set on a procedurally generated, Earth-like planet about 1,000 km in radius. Fictional NATO and Warsaw Pact analogues fight a continuous war with fighters, bombers, helicopters and convoys over a moving ground front. You watch from orbit, accelerate time and drop into any airborne unit.

The project is at the tech-demo stage. See [docs/design.md](docs/design.md) for the design, [TODO.md](TODO.md) for progress and [docs/decisions.md](docs/decisions.md) for the architecture decision log.

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
