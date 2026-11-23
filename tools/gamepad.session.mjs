/**
 * Runs Free Flight by a synthetic gamepad in headless Chromium without WebGPU
 * (tools/hud/gamepad.html; Proposal 0014) and fails if anything it checks did not hold, a
 * page error occurred or a console error was logged. With the dev server up (npm run dev):
 *
 *   node tools/gamepad.session.mjs [http://localhost:5173]
 *
 * Env: VERBOSE=1 prints every step and HUD message; SHOT=<file.png> saves the page at the end.
 * Playwright is no dependency of the repo: tools/browser/launch.mjs says where it is looked for.
 */
import { loadPlaywright } from './browser/launch.mjs';

const { chromium } = loadPlaywright();
const base = process.argv[2] ?? 'http://localhost:5173';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.location()?.url?.endsWith('/favicon.ico'))
    problems.push(`console error: ${m.text().slice(0, 300)}`);
});
await page.goto(`${base}/tools/hud/gamepad.html`);
await page.waitForFunction(() => document.title === 'ready', null, { timeout: 300_000 });
const result = await page.evaluate(() => window.result);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();

if (process.env.VERBOSE) console.log(JSON.stringify(result, null, 1));
for (const s of result.steps) console.log(s);
problems.push(
  ...result.errors.map((e) => `error: ${e}`),
  ...result.failures.map((f) => `failed: ${f}`),
);
for (const p of problems) console.error(p);
console.log(problems.length ? `${problems.length} problem(s)` : 'Gamepad session: ok');
process.exit(problems.length ? 1 : 0);
