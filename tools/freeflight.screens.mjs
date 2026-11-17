/**
 * Free Flight screenshots for the report (decision 134): draws the HUD over each
 * render from tools/freeflight.preview.ts in headless Chromium (Canvas 2D needs
 * no WebGPU) and saves docs/reports/screens/<shot>.png. Run the preview first,
 * then, with the dev server up (npm run dev):
 *
 *   node tools/freeflight.screens.mjs [http://localhost:5173]
 *
 * Env: SHOTS (comma list of shot names; a preview run with OUT=-storm wrote the
 * shots "runway-storm" and so on; default: the five of a plain run; "hover-hover",
 * "hover-hazard", "hover-sink", "hover-transition" and "hover-snow" draw the helicopter HUD over a
 * stand-in scene at 1280 × 720 (SIZE=<w>x<h> for another) and need no render), SLOTS=1 (adds
 * the display slots' layout over each shot, saved as <shot>-slots.png; SCALE sets the UI
 * scale; decision 195), OUT_DIR (where
 * the screenshots go; default docs/reports/screens). Playwright is no dependency of the
 * repo: tools/browser/launch.mjs says where it is looked for.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlaywright } from './browser/launch.mjs';

const { chromium } = loadPlaywright();
const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? 'http://localhost:5173';
const out = process.env.OUT_DIR ?? join(here, '..', 'docs', 'reports', 'screens');
mkdirSync(out, { recursive: true });
const shots = process.env.SHOTS
  ? process.env.SHOTS.split(',').filter(Boolean)
  : ['runway', 'rotation', 'climb', 'approach', 'touchdown'];

const browser = await chromium.launch();
for (const shot of shots) {
  // hover-<case>: the helicopter HUD over a stand-in scene (tools/hud/hover.ts), no render needed.
  const hover = shot.startsWith('hover-') ? shot.slice('hover-'.length) : null;
  const [sw, sh] = (process.env.SIZE ?? '1280x720').split('x').map(Number);
  let size = { width: sw || 1280, height: sh || 720 };
  if (!hover) {
    try {
      size = JSON.parse(readFileSync(join(here, 'out', `freeflight-${shot}.json`), 'utf8'));
    } catch {
      console.log(`${shot}: no render (run tools/freeflight.preview.ts)`);
      continue;
    }
  }
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
  });
  const slots = process.env.SLOTS === '1' ? `&slots=1&scale=${process.env.SCALE ?? 1}` : '';
  await page.goto(
    `${base}/tools/hud/composite.html?${hover ? `hover=${hover}` : `shot=${shot}`}${slots}`,
  );
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60_000 });
  const file = join(
    out,
    `${shot}${slots ? '-slots' : ''}${process.env.SIZE ? `-${process.env.SIZE}` : ''}.png`,
  );
  await page.screenshot({ path: file });
  console.log(`${shot} → ${file}`);
  await page.close();
}
await browser.close();
