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
 *   ONLY     comma list of parts to run: flight, takeoff, helicopter, campaign, follow (default
 *            all but follow, which runs the war to each demo type's flights; FOLLOW lists them,
 *            e.g. FOLLOW=csar for a rescue at full fidelity, R2.9)
 *   TRAFFIC  1: Free Flight with its traffic and ground radars (decision 218)
 *   GPU_TIMING 1: GPU pass timings per view from timestamp queries (R1.1; a real GPU)
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
const traffic = env('TRAFFIC', '') === '1' ? '&traffic=on' : '';
// GPU pass timings per view (R1.1): needs timestamp queries, so a real GPU (MODE=gpu).
const gpuTime = env('GPU_TIMING', '') === '1' ? '&gputime=1' : '';
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
  await page.goto(`${app}?${query}&dev${software}${gpuTime}`, { timeout: seconds(60) });
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
  await open(`mode=freeflight&seed=${seed}${traffic}`);
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
    await open(`mode=freeflight&seed=${seed}${traffic}`);
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
      // One decimal: rounded to whole knots, 10.4 kt read as 10 and failed `> 10` (2026-11-19).
      knots: +(t.groundSpeed / 0.5144).toFixed(1),
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
  // The mouse forward: nose down, forward flight. Wait for the speed, not for a count of
  // frames: 70 frames were over ten seconds of flight on lavapipe and under two on a GPU,
  // too short to pass 10 kt from a hover (the first MODE=gpu run, 2026-11-19).
  for (let i = 0; i < 10; i++) {
    await page.evaluate(() => window.bearing.freeFlight.heloInput.nudge(0, -6));
    await frames(1);
  }
  await frames(60);
  await until(() => {
    const m = window.bearing.freeFlight.flight.helo;
    return m.crashed || m.telemetry.groundSpeed > 11 * 0.5144; // a margin over the check's 10 kt
  }, 30).catch(() => {});
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
  await open(`seed=${seed}&view=simulation`);
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

/** The demo's mission types that `follow` follows, in order. */
const FOLLOW_TYPES = env('FOLLOW', 'cap,interdiction,cas,airlift').split(',');

/**
 * Follow (R2.4): the war runs at 64× until a flight of each demo type is in the air, then
 * Follow from mission search (the first) or the app's handle (the rest) cuts behind it. Each
 * picture must show the HUD, the chase camera above the ground and the aircraft in front of
 * it; Escape returns to the map with the mission selected. Check 10 (LOW) follows a flight on a
 * low-level leg (decision 253), waiting at most LOW_WAIT s, and samples the camera's height above
 * the drawn ground; check 7's pictures are the HUD against the day's sky, snow and night.
 */
async function followPart() {
  // The war runs while the simulation view's observer shows; the map visits stay short. On
  // lavapipe the map's GPU process grows by about 1 GB every 10–20 s (decision 252) and the
  // kernel kills it after three minutes or so.
  await open(`seed=${seed}&view=simulation`);
  await until(() => window.bearing?.globe.terrainReady === true, 900);
  log('follow: the terrain is ready');
  await until(() => window.bearing.sim.started === true, 900);
  /**
   * Seeks the war `hours` ahead (at most 11) through the debug panel's local time: the sim
   * jumps there headless. Returns the local hour reached.
   */
  const seekAhead = async (hours) => {
    const r = await page.evaluate((ahead) => {
      const c = [...document.querySelectorAll('.lil-gui .lil-controller')].find(
        (x) => x.querySelector('.lil-name')?.textContent === 'Local time (h)',
      );
      const input = c?.querySelector('input');
      if (!input) return 'no "Local time (h)" control';
      const h = (Number(input.value) + ahead) % 24;
      input.value = String(h);
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new Event('change'));
      input.dispatchEvent(new Event('blur'));
      return h;
    }, hours);
    if (typeof r !== 'number') throw new Error(r);
    await frames(5);
    return r;
  };
  // Into the day's war at once: the campaign starts paused and its first flights are hours away,
  // and on lavapipe the GPU process lasts about three minutes (decision 252).
  const hour = await seekAhead(Number(env('FOLLOW_AHEAD', '4')));
  log(`follow: the war at ${hour.toFixed(1)} h local`);
  await fixScale();
  /** Waits (at 64×) for a flight of `type` between climb-out and approach; returns its id. */
  const airborne = async (type) => {
    await page.evaluate(() => window.bearing.sim.setRate(64));
    const handle = await until(
      (t) => {
        const b = window.bearing;
        const now = b.sim.displayTime(performance.now());
        const flying = ['climb-out', 'ingress', 'fence-in', 'on-target', 'egress'];
        const m = b.sim.missions.find((x) => {
          if (x.type !== t || x.aircraft <= 0) return false;
          let phase = 'planned';
          for (const e of x.timeline) if (e.time <= now) phase = e.phase;
          // Ten game minutes left in the phase window, so the follow does not end at once.
          const end = x.timeline.find((e) => e.phase === 'approach')?.time ?? Infinity;
          return flying.includes(phase) && end - now > 900;
        });
        return m ? m.id : null;
      },
      900,
      type,
    );
    const id = await handle.jsonValue();
    log(`follow: ${type} mission ${id} is in the air`);
    return id;
  };
  /** The followed view's state: the camera's height, the aircraft's place in the view, the HUD. */
  const followState = () =>
    page.evaluate(() => {
      const b = window.bearing;
      const g = b.globe;
      const ch = g.chase;
      const to = ch.target.pos.clone().sub(ch.eye);
      const d = to.length();
      const off = Math.acos(Math.max(-1, Math.min(1, to.dot(ch.forward) / (d || 1))));
      const hud = document.querySelector('.ff-hud');
      return {
        active: b.follow?.active ?? false,
        mission: b.follow?.missionId ?? null,
        // At full fidelity: a jet flight or a helicopter flight such as a rescue (R2.9).
        full: b.follow?.fullFidelity ?? null,
        view: b.view(),
        camera: g.cameraMode,
        height: Math.round(ch.height * 10) / 10,
        distance: Math.round(d),
        offAxisDeg: Math.round(((off * 180) / Math.PI) * 10) / 10,
        hud: hud !== null && !hud.hidden,
        displays: document.querySelectorAll('.mfd, .display, [class*="slot"]').length,
        title: document.querySelector('.follow-title')?.textContent ?? '',
        rate: b.sim.rate,
        // Promoted battalions, vehicles and wrecks near the camera (R2.8).
        units: b.groundUnits ? { ...b.groundUnits.stats } : null,
      };
    });
  const leave = async (id) => {
    await page.keyboard.press('Escape');
    await frames(10);
    const back = await page.evaluate(() => ({
      view: window.bearing.view(),
      active: window.bearing.follow.active,
      selected: window.bearing.strategic.airSelected,
      camera: window.bearing.globe.cameraMode,
    }));
    check(
      back.view === 'strategic' && !back.active && back.camera !== 'chase',
      `follow: Escape did not return to the map: ${JSON.stringify(back)}`,
    );
    check(
      back.selected === `mission:${id}`,
      `follow: the map is not on the followed flight: ${JSON.stringify(back)}`,
    );
    await pageShot(`follow-return`);
    // Back to the observer while the war runs on (see above).
    await gui(page, 'View', 'simulation');
    await frames(3);
  };
  for (const [i, type] of FOLLOW_TYPES.entries()) {
    const id = await airborne(type);
    if (i === 0) {
      // Mission search (M) on the map, then the Follow button on this flight's row.
      await page.evaluate(() => window.bearing.sim.setRate(0));
      await gui(page, 'View', 'strategic');
      await frames(3);
      await page.keyboard.press('KeyM');
      await frames(5);
      const pressed = await page.evaluate((mid) => {
        const rows = [...document.querySelectorAll('.mission-search .rows li')];
        for (const li of rows) {
          const title = li.querySelector('.title')?.textContent ?? '';
          const m = window.bearing.sim.missions.find((x) => x.id === mid);
          if (!m || !title.startsWith(m.callsign)) continue;
          const b = li.querySelector('button.follow');
          if (!b) return 'no Follow button on its row';
          b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
          return 'ok';
        }
        return `no row for mission ${mid} among ${rows.length}`;
      }, id);
      check(pressed === 'ok', `follow: mission search: ${pressed}`);
    } else {
      const ok = await page.evaluate((mid) => window.bearing.followMission(mid), id);
      check(ok, `follow: mission ${id} (${type}) could not be followed`);
    }
    await frames(5);
    await settled();
    await frames(Math.round(60 / Math.max(1, slow / 4)));
    const s = await followState();
    log(
      `follow ${type}: ${s.title}; camera ${s.height} m up, ${s.distance} m back, ${s.offAxisDeg}° off axis; full fidelity ${s.full}; ground units ${JSON.stringify(s.units)}`,
    );
    check(
      s.active && s.view === 'simulation' && s.camera === 'chase',
      `follow ${type}: not following: ${JSON.stringify(s)}`,
    );
    check(s.hud, `follow ${type}: no HUD`);
    check(s.rate === 1, `follow ${type}: the clock is not at 1× (${s.rate})`);
    check(s.height > 0.5, `follow ${type}: the camera is in the ground (${s.height} m)`);
    check(
      s.offAxisDeg < 25,
      `follow ${type}: the aircraft is not in front of the camera (${s.offAxisDeg}°)`,
    );
    await picture(`follow-${type}`);
    await pageShot(`follow-${type}`);
    results[`follow-${type}`].follow = s;
    if (type === 'cas') {
      // Check 7: the HUD against snow.
      await gui(page, 'Weather', 'snow');
      await frames(20);
      await picture('check7-snow');
      await gui(page, 'Weather', 'live');
    }
    await leave(id);
    await deviceHealthy(`follow ${type}`);
  }
  if (env('LOW', '1') === '1') {
    // Check 10: a flight on a low-level leg (a penetrator on interdiction, a low strike;
    // decision 253) with two minutes of it left, followed for a minute of frames; the camera
    // must stay above the ground. The terrain floor lifts low legs over the ground (decision
    // 240), so the leg's regime finds them, not its height above sea level.
    await page.evaluate(() => window.bearing.sim.setRate(64));
    // Low legs are short (six to nine game minutes, 5–8 s at 64×) and fly on deep strikes and
    // reconnaissance; on seed 4 the first comes a few game hours in. Say what it waits for.
    const findLow = () =>
      page.evaluate(() => {
        const b = window.bearing;
        const now = b.sim.displayTime(performance.now());
        let next = Infinity;
        for (const x of b.sim.missions) {
          if (x.aircraft <= 0) continue;
          const segs = x.route.segments;
          let i = segs.findIndex((g) => g.t0 <= now && now < g.t1);
          if (i >= 0 && segs[i].regime === 'lowLevel') {
            while (i + 1 < segs.length && segs[i + 1].regime === 'lowLevel') i++;
            if (segs[i].t1 - now > 120) return { id: x.id, now, next: now };
          }
          for (const g of segs)
            if (g.regime === 'lowLevel' && g.t0 > now) next = Math.min(next, g.t0);
        }
        return { id: null, now, next };
      });
    const waitS = Number(env('LOW_WAIT', '600'));
    const t0 = Date.now();
    let low = null;
    let lastLog = 0;
    let clock = 64;
    while (low === null && Date.now() - t0 < seconds(waitS)) {
      const r = await findLow();
      low = r.id;
      if (low === null && Date.now() - lastLog > 20_000) {
        lastLog = Date.now();
        const hours = (r.now / 3600).toFixed(1);
        log(
          `check 10: waiting for a low-level leg at T+${hours} h` +
            (Number.isFinite(r.next)
              ? `; the next starts at T+${(r.next / 3600).toFixed(1)} h`
              : '; none among the flights planned yet'),
        );
      }
      // Near a low leg the clock slows to 4×: at 64× a six-minute leg passes in five seconds.
      const rate = low === null && r.next - r.now < 900 ? 4 : 64;
      if (rate !== clock) {
        clock = rate;
        await page.evaluate((x) => window.bearing.sim.setRate(x), rate);
      }
      if (low === null) await new Promise((res) => setTimeout(res, 250));
    }
    if (low === null) {
      fail('check 10: no flight on a low-level leg within LOW_WAIT seconds at 64×');
      return;
    }
    check(
      await page.evaluate((mid) => window.bearing.followMission(mid), low),
      `check 10: mission ${low} could not be followed`,
    );
    await frames(5);
    await settled();
    let least = Infinity;
    let highest = 0;
    for (let k = 0; k < 30; k++) {
      await frames(2);
      const st = await followState();
      least = Math.min(least, st.height);
      highest = Math.max(highest, st.height);
    }
    const s = await followState();
    log(`check 10: ${s.title}; camera ${least}–${highest} m above the ground`);
    check(least > 0.5, `check 10: the camera touched the ground (${least} m)`);
    await picture('check10-low');
    results['check10-low'].leastHeight = least;
    await leave(low);
  }
  if (env('NIGHT', '1') === '1') {
    // Check 7 at night: the clock jumps to local night over the map (the debug panel's local
    // time seeks the war forward), then the first CAP in the air is followed.
    const now = await page.evaluate(() => Number(window.__probe.guiGet('Local time (h)')));
    let ahead = (23.5 - now + 24) % 24;
    while (ahead > 0.01) {
      const step = Math.min(11, ahead);
      await seekAhead(step);
      ahead -= step;
    }
    const id = await airborne('cap');
    check(
      await page.evaluate((mid) => window.bearing.followMission(mid), id),
      'check 7: no CAP to follow at night',
    );
    await frames(5);
    await settled();
    const s = await picture('check7-night');
    log(`check 7 at night: sun ${s.sunElevation}°`);
    check(s.sunElevation < -6, `check 7: not night at the flight (sun ${s.sunElevation}°)`);
    await leave(id);
  }
}

try {
  if (parts.includes('follow')) await followPart();
  if (parts.includes('flight')) await flight();
  if (parts.includes('takeoff')) await takeoff();
  if (parts.includes('helicopter')) await helicopter();
  if (parts.includes('campaign')) await campaign();
} catch (e) {
  fail(`the run stopped: ${String(e.stack ?? e).slice(0, 800)}`);
  await page.screenshot({ path: join(out, 'stopped-page.png'), timeout: 30_000 }).catch(() => {});
}
// The last page's GPU timings per view, when asked for (GPU_TIMING=1).
const gpuTiming = gpuTime
  ? await page.evaluate(() => window.bearing?.gpuTiming?.views ?? null).catch(() => null)
  : null;
if (gpuTiming) console.log(`GPU timings per view: ${JSON.stringify(gpuTiming)}`);
writeFileSync(
  join(out, 'smoke.json'),
  JSON.stringify({ mode, app, seed, problems, results, gpuTiming }, null, 1),
);
await context.close().catch(() => {});
console.log(
  problems.length
    ? `${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`
    : `Browser smoke test: ok (${Object.keys(results).length} scenes, ${stamp().trim()})`,
);
process.exit(problems.length ? 1 : 0);
