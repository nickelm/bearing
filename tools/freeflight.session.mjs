/**
 * Runs a Free Flight session in headless Chromium without WebGPU (tools/hud/session.html:
 * the real FreeFlight class, its start screen, pause menu and cards, every weather preset)
 * and fails if anything it checks did not hold, a page error occurred or a console error
 * was logged. With the dev server up (npm run dev):
 *
 *   node tools/freeflight.session.mjs [http://localhost:5173]
 *
 * Env: HEADED=1 runs a headed browser (needs an X server, e.g. `xvfb-run`, and xdotool) and
 * moves the real pointer, so the jet's mouse checks run; VERBOSE=1 prints everything the page found; SHOT=<file.png> saves the start screen
 * as the session leaves it. Playwright is no dependency of the repo (as for
 * freeflight.screens.mjs): tools/browser/launch.mjs says where it is looked for. The page
 * generates the campaign world on the main thread, so a run takes about half a minute.
 *
 * This page has no WebGPU and draws nothing; tools/browser.smoke.mjs runs the app itself.
 */
import { execSync } from 'node:child_process';
import { loadPlaywright } from './browser/launch.mjs';

const { chromium } = loadPlaywright();
const base = process.argv[2] ?? 'http://localhost:5173';

// HEADED=1 under an X server with xdotool: real mouse motion under pointer lock, which
// Playwright's own mouse cannot produce (its movementX is 0 there; decision 195).
const headed = process.env.HEADED === '1';
let xdotool = false;
if (headed) {
  try {
    execSync('xdotool version', { stdio: 'ignore' });
    xdotool = true;
  } catch {
    console.log('HEADED=1 without xdotool: the real-mouse checks are skipped');
  }
}
const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
if (xdotool) await page.addInitScript(() => (window.realMouse = true));
const problems = [];
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') {
    const at = m.location()?.url;
    // A headed browser asks for the site's icon, which the tool pages do not have.
    if (at?.endsWith('/favicon.ico')) return;
    problems.push(`console error: ${m.text().slice(0, 300)}${at ? ` (${at})` : ''}`);
  }
});
await page.goto(`${base}/tools/hud/session.html`);
// The page asks for real key presses (pointer lock needs a user's gesture; decision 193).
for (;;) {
  await page.waitForFunction(() => ['ready', 'press'].includes(document.title), null, {
    timeout: 300_000,
  });
  if ((await page.title()) === 'ready') break;
  const what = await page.evaluate(() => window.pressNow);
  if (what.startsWith('mouse:')) {
    const [dx, dy] = what.slice(6).split(',').map(Number);
    // Small steps, as a hand moves a mouse.
    for (let i = 0; i < 10; i++) {
      if (xdotool) execSync(`xdotool mousemove_relative -- ${dx / 10} ${dy / 10}`);
      else await page.mouse.move(640 + (dx * (i + 1)) / 10, 360 + (dy * (i + 1)) / 10);
      await page.waitForTimeout(20);
    }
  } else await page.keyboard.press(what);
  await page.waitForTimeout(150);
  await page.evaluate(() => (document.title = 'pressed'));
}
const result = await page.evaluate(() => window.result);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await browser.close();

if (process.env.VERBOSE) console.log(JSON.stringify(result, null, 1));
for (const [preset, r] of Object.entries(result.perPreset ?? {})) {
  const f = r.first;
  console.log(
    `${preset.padEnd(10)} cover ${f.cover} vis ${f.visibility} m rain ${f.rain} snow ${f.snow} ` +
      `dust ${f.dust} storm ${f.storm} wet ${f.wetness} | wind on the aircraft ${r.wind} m/s, ` +
      `land ${r.temperatureShift} °C`,
  );
}
for (const [preset, r] of Object.entries(result.rolls ?? {})) {
  console.log(
    `${preset.padEnd(10)} takeoff roll with free pedals: ${r.knots} kt after ${r.seconds} s in ` +
      `${r.wind} m/s of wind, wheels on ${r.surfaces.join(', ')}${r.crashed ? `, ${r.crashed}` : ''}`,
  );
}
problems.push(
  ...result.errors.map((e) => `error: ${e}`),
  ...result.failures.map((f) => `failed: ${f}`),
);
for (const p of problems) console.error(p);
console.log(problems.length ? `${problems.length} problem(s)` : 'Free Flight session: ok');
process.exit(problems.length ? 1 : 0);
