/**
 * Runs the real app in Chromium with WebGPU and fails on what only a browser shows: page
 * errors, console errors, WebGPU validation errors, a lost device, a post-processing stage
 * that gave up, a pause that does not hold, sound that does not start. The previews under
 * tools/ draw the same scenes on Node's Dawn; this is the app itself, with its frame loop,
 * canvas, menus, keys and audio. With the production build served:
 *
 *   npm run build && npm run preview          (http://localhost:4173/bearing/)
 *   node tools/browser.smoke.mjs [url of the app]
 *
 * It flies Free Flight from the start screen through six scenes (fair at golden hour, a
 * thunderstorm, snow, fog at sunrise, a moonlit night, a dust storm), changing weather and
 * time of day in the pause menu, and checks each scene's weather on screen, the pause, the
 * keys and the sound; takes off with the keyboard; then opens the campaign's simulation
 * view, overrides the weather in the debug panel, goes to the map and back, and pauses with
 * the time controls. Each scene is saved as a PNG, with the scene's state beside it in
 * smoke.json. Exit code 1 if anything failed.
 *
 * Env:
 *   MODE     gpu, lavapipe or swiftshader (tools/browser/launch.mjs; default by machine).
 *            Without a GPU use lavapipe: SwiftShader cannot run the app.
 *   OUT      directory for the pictures (default tools/out/browser)
 *   SEED     world seed (1983); BASE airbase id (default: the first in the list)
 *   WORLD    a world written by tools/browser.world.preview.ts, as its path without the
 *            extension (tools/out/browser/world-1983): it is put into the browser's world
 *            cache before the app loads, which spares a machine without a GPU the global pass
 *   ONLY     comma list of parts to run: flight, takeoff, helicopter, campaign (default all)
 *   HELO     the helicopter the helicopter part flies: scout (default) or utility
 *   SCENES   comma list of the flight's scenes: fair, storm, snow, fog, night, dust
 *   ALIGN    1 runs the alignment stage (decision 184); by default the run passes align=0
 *            in software modes, where its level-6 tiles take about a second each
 *   SCALE    render scale for the pictures: 100% (default), 75%, 50%, 35%, or auto
 *   W, H     viewport (640 × 360)
 *   SLOW     factor on every timeout (default 1 with a GPU, 8 without)
 *   FLASH    seconds to wait for a lightning flash in the storm (default 20, times SLOW;
 *            0 skips it; no flash is no failure)
 *   HEADED=1 shows the browser; PROFILE its profile directory (the generated world is
 *            cached there); ARGS more Chromium switches; VERBOSE=1 prints the console.
 *
 * The world is generated in the browser on the first run and cached in the profile. On
 * lavapipe the global pass takes 14 minutes (WORLD puts the world there in 7 seconds), a
 * frame takes about 0.4 s at 640 × 360 and the run four and a half minutes. The `gpu` mode
 * is the same script on Chromium's own adapter; it has not been run yet (the sessions that
 * wrote this had no GPU), so expect to adjust it on its first run there.
 *
 * The pictures are read back through the WebGPU device and hold the scene and the HUD, not
 * the HTML. The `-page` pictures are the browser's own screenshots: the HTML over the
 * scene, or over an empty canvas in lavapipe mode (launch.mjs says why).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultMode, launch } from './browser/launch.mjs';
import {
  button,
  capture,
  captureFlash,
  choose,
  gui,
  importWorld,
  probe,
  state,
} from './browser/page.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const env = (k, d) => process.env[k] ?? d;
const app = (process.argv[2] ?? 'http://localhost:4173/bearing/').replace(/\/?$/, '/');
const mode = defaultMode();
const out = env('OUT', join(here, 'out', 'browser'));
const seed = env('SEED', '1983');
const parts = env('ONLY', 'flight,takeoff,helicopter,campaign').split(',');
const scale = env('SCALE', '100%');
const slow = Number(env('SLOW', mode === 'gpu' ? '1' : '8'));
// The app does not start on a software adapter unasked (webgpuSupport.ts): these modes ask.
const software =
  (mode === 'gpu' ? '' : '&software') +
  (process.env.ALIGN === '1' || (mode === 'gpu' && process.env.ALIGN !== '0') ? '' : '&align=0');
const flashSeconds = Number(env('FLASH', '20'));
const verbose = env('VERBOSE', '') === '1';
mkdirSync(out, { recursive: true });

/** The flight's scenes: weather preset, time of day, and what must show. */
const SCENES = {
  fair: { weather: 'fair', tod: 17.25, expect: (s) => s.rain === 0 && s.snow === 0 },
  storm: {
    weather: 'storm',
    tod: 17.25,
    expect: (s) => s.rain > 0.5 && s.storm > 0.3 && s.wetness > 0.9 && s.particles.rain > 0,
  },
  snow: { weather: 'snow', tod: 11, expect: (s) => s.snow > 0.2 && s.particles.snow > 0 },
  fog: { weather: 'fog', tod: 6.5, expect: (s) => s.fogPerKm > 5 },
  night: { weather: 'fair', tod: 0.5, expect: (s) => s.sunElevation < -18 },
  dust: { weather: 'duststorm', tod: 12, expect: (s) => s.dust > 0.5 && s.particles.dust > 0 },
};
const scenes = env('SCENES', Object.keys(SCENES).join(',')).split(',');

const problems = [];
const results = {};
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s`;
const log = (...a) => console.log(stamp(), ...a);
const fail = (what) => {
  problems.push(what);
  console.error(stamp(), 'FAILED:', what);
};
const check = (ok, what) => {
  if (!ok) fail(what);
  return ok;
};

if (mode === 'swiftshader' && env('FORCE', '') !== '1') {
  console.error(
    'SwiftShader cannot run the app: the terrain never arrives and the GPU process grows by ' +
      '50 MB a second until the kernel kills it (tools/browser/launch.mjs). Use MODE=lavapipe ' +
      '(apt-get install -y mesa-vulkan-drivers), or FORCE=1 to see it happen.',
  );
  process.exit(2);
}
const { context, page } = await launch({
  mode,
  width: Number(env('W', '640')),
  height: Number(env('H', '360')),
});
log(`Chromium with WebGPU on ${mode}; pictures in ${out}`);

/** What the app's own code reports when an effect gives up without throwing. */
const GAVE_UP =
  /Post-processing (failed|is unavailable)|volumetric source failed|Audio is unavailable|Thunder could not be played|Label fonts failed/;
page.on('console', (m) => {
  const text = m.text();
  if (verbose) console.log(stamp(), `[${m.type()}]`, text.slice(0, 400));
  else if (/^WebGPU adapter/.test(text)) log(text);
  // The browser asks for /favicon.ico on its own; the app has none to give at the site's root.
  if (m.type() === 'error' && !/favicon\.ico/.test(m.location().url ?? '')) {
    fail(`console error: ${text.slice(0, 400)}`);
  } else if (m.type() === 'warning' && GAVE_UP.test(text)) {
    fail(`console warning: ${text.slice(0, 400)}`);
  }
});
page.on('pageerror', (e) => fail(`page error: ${String(e.stack ?? e).slice(0, 600)}`));
page.on('crash', () => fail('the page crashed'));
// A world generated by Node (tools/browser.world.preview.ts) spares the browser the global pass.
if (process.env.WORLD) log(await importWorld(page, app, process.env.WORLD));
await page.addInitScript(probe);

const seconds = (s) => s * 1000 * slow;
/** Waits until `predicate` (a function in the page) holds. */
const until = (predicate, timeoutSeconds, arg) =>
  page.waitForFunction(predicate, arg, { timeout: seconds(timeoutSeconds), polling: 250 });
/**
 * Opens the app. In `gpu` mode a browser that hands out its software adapter gets the app's
 * notice, which waits for "Start anyway": say so (HEADED=1 often gets the real adapter)
 * instead of running into a timeout.
 */
const open = async (query) => {
  await page.goto(`${app}?${query}&dev${software}`, { timeout: seconds(60) });
  await until(
    () => window.bearing !== undefined || document.getElementById('fatal')?.hidden === false,
    60,
  );
  const stopped = await page.evaluate(() => {
    const fatal = document.getElementById('fatal');
    return fatal && !fatal.hidden ? (fatal.querySelector('h1')?.textContent ?? 'an error') : null;
  });
  if (stopped) throw new Error(`the app did not start: "${stopped}" (MODE=${mode})`);
};
/** Lets the app draw `count` more frames. */
const frames = async (count) => {
  const from = await page.evaluate(() => window.__probe.frames);
  await until(([f, n]) => window.__probe.frames >= f + n, 60, [from, count]);
};
/** Waits for the terrain around the camera, then for the picture to settle. */
const settled = async () => {
  await until(() => {
    const t = window.bearing.globe.terrain.stats;
    return t.pending === 0 && t.drawn > 5;
  }, 120);
  await frames(20);
};
/** Saves the frame on screen and the scene's state under `name`; returns the state. */
const picture = async (name) => {
  const shot = await capture(page, seconds(30));
  writeFileSync(join(out, `${name}.png`), shot.png);
  const s = await state(page);
  results[name] = { ...s, picture: shot.size, mean: shot.mean };
  check(
    shot.alphaMin === 255,
    `${name}: the canvas is not opaque (alpha down to ${shot.alphaMin})`,
  );
  log(
    `${name}: ${shot.size}, ${s.frameMs} ms a frame, scale ${s.scale}, ${s.quality}, ` +
      `${s.passes} passes, sun ${s.sunElevation.toFixed(1)}°`,
  );
  return s;
};
const pageShot = (name) =>
  page.screenshot({ path: join(out, `${name}-page.png`), timeout: seconds(30) });
/** The probe's record of the device: errors and loss fail the run where they happen. */
const deviceHealthy = async (where) => {
  const d = await page.evaluate(() => ({
    errors: window.__probe.gpuErrors.slice(0, 3),
    lost: window.__probe.lost,
  }));
  check(d.lost === null, `${where}: the WebGPU device was lost (${d.lost})`);
  check(d.errors.length === 0, `${where}: WebGPU errors: ${d.errors.join(' | ').slice(0, 600)}`);
};
const fixScale = async () => {
  if (scale !== 'auto') await gui(page, 'Render scale', scale);
};

/** Free Flight, from the start screen through the scenes. */
async function flight() {
  await open(`mode=freeflight&seed=${seed}`);
  // The start screen: the bases are listed once the coarse pass is done, "Fly" is enabled
  // once the terrain is (the global pass, or the cached world).
  await until(() => document.querySelectorAll('.ff-bases tbody tr').length > 0, 240);
  const base = await page.evaluate(
    (wanted) => {
      const rows = [...document.querySelectorAll('.ff-bases tbody tr')];
      const row = rows.find((r) => r.dataset.id === wanted) ?? rows[0];
      row.click();
      return `${row.cells[0].textContent} (id ${row.dataset.id})`;
    },
    env('BASE', ''),
  );
  log(`start screen: ${base}; waiting for the terrain`);
  await until(() => !document.querySelector('.ff-fly').disabled, 900);
  await pageShot('flight-start');
  const first = SCENES[scenes[0]];
  await choose(page, '.ff-menu .ff-weather', first.weather);
  await choose(page, '.ff-menu .ff-tod', first.tod);
  await button(page, 'Fly');
  await until(() => window.bearing?.freeFlight.state === 'flying', 120);
  await page.evaluate(() => window.__probe.countThunder());
  await fixScale();

  for (const [i, name] of scenes.entries()) {
    const scene = SCENES[name];
    if (i > 0) {
      // Through the pause menu: the weather changes at once, the time of day with a restart.
      await page.keyboard.press('Escape');
      await until(() => window.bearing.freeFlight.state === 'paused', 30);
      await choose(page, '.ff-card .ff-weather', scene.weather);
      await choose(page, '.ff-card .ff-tod', scene.tod);
      await button(page, 'Restart on the runway');
      await until(() => window.bearing.freeFlight.state === 'flying', 30);
    }
    await settled();
    const s = await picture(`flight-${name}`);
    check(
      scene.expect(s),
      `flight-${name}: the scene does not show its weather: ${JSON.stringify(s)}`,
    );
    check(
      s.passes >= 10,
      `flight-${name}: the post-processing pipeline is not drawing (${s.passes} passes)`,
    );
    await deviceHealthy(`flight-${name}`);
    if (name === 'storm') await storm();
  }
}

/** In the thunderstorm: the pause, the keys, the sound and the lightning. */
async function storm() {
  // Pause with the key: clocks, particles and clouds stand while the menu shows.
  await page.keyboard.press('Escape');
  await until(() => window.bearing.freeFlight.state === 'paused', 30);
  await frames(3);
  const a = await state(page);
  // The first of two captures; the second tells how much of the picture differs from it.
  await capture(page, seconds(30));
  await pageShot('flight-paused');
  await frames(10);
  const b = await state(page);
  const after = await capture(page, seconds(30));
  check(a.paused && b.clock === a.clock && b.gameTime === a.gameTime, 'pause: the clocks run on');
  check(
    after.changed < 0.002,
    `pause: the picture moves while paused (${(after.changed * 100).toFixed(1)}% of the pixels)`,
  );
  check(b.audio !== null, 'sound: no AudioContext after a key press');
  check(b.audio?.state !== 'running', 'sound: it plays on while paused');
  // Another weather from the pause menu shows at once, and the first comes back.
  await choose(page, '.ff-card .ff-weather', 'snow');
  await frames(5);
  const snow = await state(page);
  check(snow.snow > 0.2 && snow.rain === 0, 'pause menu: the weather does not change at once');
  await choose(page, '.ff-card .ff-weather', 'storm');
  await frames(5);
  // Esc closes the menu it opened.
  await page.keyboard.press('Escape');
  await until(() => window.bearing.freeFlight.state === 'flying', 30).catch(() =>
    fail('pause: Esc does not close the pause menu'),
  );
  await until(() => window.bearing.audio.context?.state === 'running', 30).catch(() => {});
  await frames(10);
  const s = await state(page);
  results['flight-storm-sound'] = s.audio;
  const gains = s.audio
    ? [s.audio.master, s.audio.rain, s.audio.wind, s.audio.dust, ...Object.values(s.audio.target)]
    : [];
  check(s.audio?.state === 'running', `sound: the context is ${s.audio?.state} while flying`);
  check(gains.length > 0 && gains.every(Number.isFinite), `sound: a gain is not finite: ${gains}`);
  check(s.audio?.master > 0 && s.audio?.target.rain > 0, 'sound: silent in the rain');
  check(s.clock > b.clock, 'pause: the weather stands still after resuming');
  if (flashSeconds > 0) {
    const flash = await captureFlash(page, seconds(flashSeconds));
    if (flash) writeFileSync(join(out, 'flight-flash.png'), flash.png);
    const heard = (await state(page)).thunder;
    log(
      flash ? `lightning: a flash of ${flash.flash.toFixed(2)}` : 'lightning: no flash came',
      `(${heard} thunder so far)`,
    );
  }
}

/** A takeoff with the keyboard, on a clear day in its wind, without touching the pedals. */
async function takeoff() {
  if (!(await page.evaluate(() => Boolean(window.bearing?.freeFlight)))) {
    await open(`mode=freeflight&seed=${seed}`);
    await until(() => document.querySelectorAll('.ff-bases tbody tr').length > 0, 240);
    await page.evaluate(() => document.querySelector('.ff-bases tbody tr').click());
    await until(() => !document.querySelector('.ff-fly').disabled, 900);
    await button(page, 'Fly');
    await until(() => window.bearing?.freeFlight.state === 'flying', 120);
    await fixScale();
  }
  await page.keyboard.press('Escape');
  await until(() => window.bearing.freeFlight.state === 'paused', 30);
  await choose(page, '.ff-card .ff-weather', 'clear');
  await choose(page, '.ff-card .ff-tod', 10);
  // With the wind on, as a player starts: the laws hold the track of the roll against the
  // crosswind while the pedals are free (controlLaws.ts, trackHold).
  await page.evaluate(() => {
    const wind = document.querySelector('.ff-card .ff-wind');
    if (!wind.checked) wind.click();
  });
  await button(page, 'Restart on the runway');
  await until(() => window.bearing.freeFlight.state === 'flying', 30);
  await settled();
  const model = () => {
    const m = window.bearing.freeFlight.flight.model;
    const c = window.bearing.freeFlight.input.controls;
    return {
      knots: Math.round(m.telemetry.cas / 0.5144),
      height: Math.round(m.telemetry.radarAltitude),
      onGround: m.onGround,
      throttle: +c.throttle.toFixed(2),
      parkingBrake: c.parkingBrake,
      crashed: m.crashed,
    };
  };
  // P releases the parking brake; Shift runs the throttle to the military detent, and a
  // second press past it into the afterburner.
  await page.keyboard.press('KeyP');
  for (let press = 0; press < 2; press++) {
    const from = (await page.evaluate(model)).throttle;
    await page.keyboard.down('ShiftLeft');
    await until(
      (t) => {
        const c = window.bearing.freeFlight.input.controls.throttle;
        return c > t && (c >= 0.99 || window.__probe.frames % 8 === 0);
      },
      30,
      from,
    ).catch(() => {});
    await frames(12);
    await page.keyboard.up('ShiftLeft');
    await frames(2);
  }
  const rolling = await page.evaluate(model);
  check(
    !rolling.parkingBrake && rolling.throttle > 0.7,
    `takeoff: the keys do not reach the aircraft: ${JSON.stringify(rolling)}`,
  );
  // Rotate at 150 knots and hold the stick until the wheels leave the ground.
  await until(() => window.bearing.freeFlight.flight.model.telemetry.cas > 77, 120).catch(() => {});
  const surfaces = await page.evaluate(() =>
    window.bearing.freeFlight.flight.model.wheels.filter((w) => w.load > 0).map((w) => w.surface),
  );
  check(
    surfaces.length > 0 && surfaces.every((x) => x === 'runway'),
    `takeoff: left the runway on the roll (wheels on ${surfaces.join(', ')})`,
  );
  await page.keyboard.down('KeyS');
  await until(() => {
    const m = window.bearing.freeFlight.flight.model;
    return m.crashed || m.telemetry.radarAltitude > 15;
  }, 60).catch(() => {});
  await page.keyboard.up('KeyS');
  await page.keyboard.press('KeyG');
  await frames(10);
  const airborne = await page.evaluate(model);
  check(
    !airborne.crashed && !airborne.onGround,
    `takeoff: not airborne: ${JSON.stringify(airborne)}`,
  );
  await picture('flight-airborne');
  results['flight-airborne'].aircraft = airborne;
  log(`takeoff: ${airborne.knots} kt, ${airborne.height} m up`);
  await deviceHealthy('takeoff');
}

/**
 * A helicopter (track H1): from the ground beside the runway, W to climb, a hover that holds,
 * a pedal turn, forward flight from the mouse (nudged: headless Chromium does not lock the
 * pointer), back to a hover, and S to land.
 */
async function helicopter() {
  const which = env('HELO', 'scout');
  await open(`mode=freeflight&seed=${seed}&aircraft=${which}&weather=clear&tod=10&spawn=runway`);
  await until(() => document.querySelectorAll('.ff-bases tbody tr').length > 0, 240);
  await page.evaluate(() => document.querySelector('.ff-bases tbody tr').click());
  await until(() => !document.querySelector('.ff-fly').disabled, 900);
  await button(page, 'Fly');
  await until(() => window.bearing?.freeFlight.state === 'flying', 120);
  await fixScale();
  await settled();
  const helo = () => {
    const ff = window.bearing.freeFlight;
    const m = ff.flight.helo;
    if (!m) return null;
    const t = m.telemetry;
    return {
      height: +t.radarAltitude.toFixed(1),
      knots: Math.round(t.groundSpeed / 0.5144),
      heading: Math.round((t.heading * 180) / Math.PI),
      pitch: +((t.pitch * 180) / Math.PI).toFixed(1),
      bank: +((t.bank * 180) / Math.PI).toFixed(1),
      rpm: +t.rotorSpeed.toFixed(3),
      torque: +t.torque.toFixed(2),
      onGround: m.onGround,
      crashed: m.crashed,
    };
  };
  const start = await page.evaluate(helo);
  check(
    start !== null && start.onGround && !start.crashed,
    `helicopter: not on the ground at the start: ${JSON.stringify(start)}`,
  );
  await picture('helo-ground');
  // W: climb until about 15 m, then let go: the altitude holds and the hover holds.
  await page.keyboard.down('KeyW');
  await until(() => {
    const m = window.bearing.freeFlight.flight.helo;
    return m.crashed || m.telemetry.radarAltitude > 15;
  }, 120).catch(() => {});
  await page.keyboard.up('KeyW');
  await frames(40);
  const hover = await page.evaluate(helo);
  check(
    hover &&
      !hover.crashed &&
      !hover.onGround &&
      hover.height > 8 &&
      Math.abs(hover.rpm - 1) < 0.06,
    `helicopter: no hover after the climb: ${JSON.stringify(hover)}`,
  );
  await picture('helo-hover');
  // Q: a pedal turn to the left.
  await page.keyboard.down('KeyQ');
  await frames(25);
  await page.keyboard.up('KeyQ');
  await frames(10);
  const turned = await page.evaluate(helo);
  check(
    turned && Math.abs(((turned.heading - hover.heading + 540) % 360) - 180) > 10,
    `helicopter: the pedals do not turn it: ${JSON.stringify([hover, turned])}`,
  );
  // The mouse forward: nose down, forward flight.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.bearing.freeFlight.heloInput.nudge(0, -6));
    await frames(1);
  }
  await frames(60);
  const forward = await page.evaluate(helo);
  check(
    forward && forward.knots > 10 && !forward.crashed,
    `helicopter: no forward flight: ${JSON.stringify(forward)}`,
  );
  await picture('helo-forward');
  // Back to a hover: the mouse back, then S to land.
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.bearing.freeFlight.heloInput.nudge(0, 6));
    await frames(1);
  }
  await frames(60);
  await page.keyboard.down('KeyS');
  await until(() => {
    const m = window.bearing.freeFlight.flight.helo;
    return m.crashed || (m.onGround && m.telemetry.groundSpeed < 3);
  }, 240).catch(() => {});
  await frames(30);
  await page.keyboard.up('KeyS');
  const landed = await page.evaluate(helo);
  check(
    landed && landed.onGround && !landed.crashed,
    `helicopter: no landing: ${JSON.stringify(landed)}`,
  );
  await picture('helo-landed');
  results['helo-landed'].helicopter = { start, hover, turned, forward, landed };
  log(
    `helicopter: hover at ${hover.height} m, ${forward.knots} kt forward, landed ${landed.onGround}`,
  );
  await deviceHealthy('helicopter');
}

/** The campaign: the simulation view, a weather override, the map and back, the time controls. */
async function campaign() {
  await open(`seed=${seed}`);
  await until(() => window.bearing?.globe.terrainReady === true, 900);
  await page.evaluate(() => window.__probe.countThunder());
  await fixScale();
  await settled();
  const live = await picture('campaign-live');
  check(
    live.passes >= 10,
    `campaign: the post-processing pipeline is not drawing (${live.passes} passes)`,
  );
  // The campaign starts paused; the weather override of the debug panel shows all the same.
  await gui(page, 'Weather', 'storm');
  await frames(20);
  const stormy = await picture('campaign-storm');
  check(
    stormy.rain > 0.5 && stormy.particles.rain > 0,
    `campaign: no storm on screen: ${JSON.stringify(stormy)}`,
  );
  // Run the clock (key 1 is 1×): the first key starts the sound.
  await page.keyboard.press('Digit1');
  await until(() => window.bearing.audio.context?.state === 'running', 30).catch(() => {});
  await frames(15);
  const running = await state(page);
  check(
    !running.paused && running.clock > stormy.clock,
    'campaign: the weather does not move at 1×',
  );
  check(
    running.audio?.state === 'running' && running.audio.target.rain > 0,
    `campaign: no rain to hear: ${JSON.stringify(running.audio)}`,
  );
  // To the map: the simulation view's targets are released, and the map has no weather sound.
  await gui(page, 'View', 'strategic');
  await frames(30);
  const map = await picture('campaign-map');
  check(
    map.audio.target.rain === 0 && map.audio.target.wind === 0,
    `campaign: the weather is heard over the map: ${JSON.stringify(map.audio)}`,
  );
  await deviceHealthy('campaign map');
  // And back: the pipeline allocates again and the effects start over.
  await gui(page, 'View', 'simulation');
  await frames(5);
  await settled();
  const back = await picture('campaign-back');
  check(
    back.passes >= 10 && back.rain > 0.5,
    `campaign: the storm is gone after the map: ${JSON.stringify(back)}`,
  );
  // Space pauses and runs the clock.
  await page.keyboard.press('Space');
  await frames(5);
  const held = await state(page);
  await frames(10);
  const still = await state(page);
  check(held.paused && still.clock === held.clock, 'campaign: Space does not hold the weather');
  await page.keyboard.press('Space');
  await frames(10);
  check((await state(page)).clock > still.clock, 'campaign: Space does not run the clock again');
  await pageShot('campaign');
  await deviceHealthy('campaign');
}

try {
  if (parts.includes('flight')) await flight();
  if (parts.includes('takeoff')) await takeoff();
  if (parts.includes('helicopter')) await helicopter();
  if (parts.includes('campaign')) await campaign();
} catch (e) {
  fail(`the run stopped: ${String(e.stack ?? e).slice(0, 800)}`);
  await page.screenshot({ path: join(out, 'stopped-page.png'), timeout: 30_000 }).catch(() => {});
}
writeFileSync(
  join(out, 'smoke.json'),
  JSON.stringify({ mode, app, seed, problems, results }, null, 1),
);
await context.close().catch(() => {});
console.log(
  problems.length
    ? `${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`
    : `Browser smoke test: ok (${Object.keys(results).length} scenes, ${stamp().trim()})`,
);
process.exit(problems.length ? 1 : 0);
