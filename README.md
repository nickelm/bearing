# Bearing

Bearing is a browser-based late-Cold-War air war set on a procedurally generated, Earth-like planet about 1,000 km in radius. Fictional NATO and Warsaw Pact analogues fight a continuous war with fighters, bombers, helicopters and convoys over a moving ground front. You watch from orbit, accelerate time and drop into any airborne unit.

The project is at the tech-demo stage. See [docs/design.md](docs/design.md) for the design, [TODO.md](TODO.md) for progress and [docs/decisions.md](docs/decisions.md) for the architecture decision log.

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
npm run preview      # serve the production build
```

Append `?seed=<number or text>` to the URL to open a specific world.
