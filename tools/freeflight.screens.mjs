/**
 * Free Flight screenshots for the report (decision 134): draws the HUD over each
 * render from tools/freeflight.preview.ts in headless Chromium (Canvas 2D needs
 * no WebGPU) and saves docs/reports/screens/<shot>.png. Run the preview first,
 * then, with the dev server up (npm run dev):
 *
 *   node tools/freeflight.screens.mjs [http://localhost:5173]
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] ?? 'http://localhost:5173';
const out = join(here, '..', 'docs', 'reports', 'screens');
mkdirSync(out, { recursive: true });
const shots = ['runway', 'rotation', 'climb', 'approach', 'touchdown'];

const browser = await chromium.launch();
for (const shot of shots) {
  let size;
  try {
    size = JSON.parse(readFileSync(join(here, 'out', `freeflight-${shot}.json`), 'utf8'));
  } catch {
    console.log(`${shot}: no render (run tools/freeflight.preview.ts)`);
    continue;
  }
  const page = await browser.newPage({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
  });
  await page.goto(`${base}/tools/hud/composite.html?shot=${shot}`);
  await page.waitForFunction(() => document.title === 'ready', null, { timeout: 60_000 });
  const file = join(out, `${shot}.png`);
  await page.screenshot({ path: file });
  console.log(`${shot} → ${file}`);
  await page.close();
}
await browser.close();
