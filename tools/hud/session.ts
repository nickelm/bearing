/**
 * A Free Flight session without WebGPU: the real `FreeFlight` class with its
 * start screen, pause menu and cards in a browser's DOM, on a real
 * `GlobeScene` whose renderer is never initialized and never draws. Nothing
 * else runs this class outside the app (the previews fly through its parts),
 * so this is where its wiring is checked: every weather preset from the start
 * screen through flying, pause and back; the pause menu's weather, wind and
 * sound; a restart, an air start, a crash and its card; and that no flight
 * leaves an event listener behind.
 *
 * The world is the coarse pass of seed 1983 (its airbases) over flat ground,
 * with a synthetic climate (tests/helpers/weatherWorld.ts). Around each frame
 * the page does what main.ts does, without drawing.
 *
 *   npm run dev, then: node tools/freeflight.session.mjs [http://localhost:5173]
 *
 * The page puts its findings in `window.result` (`failures` lists what did
 * not hold) and sets the title to "ready".
 */
type Entry = { target: EventTarget; type: string; listener: unknown };
const live: Entry[] = [];
const add = EventTarget.prototype.addEventListener;
const remove = EventTarget.prototype.removeEventListener;
EventTarget.prototype.addEventListener = function (type: string, listener: never, options?: never) {
  if (
    listener &&
    !live.some((e) => e.target === this && e.type === type && e.listener === listener)
  )
    live.push({ target: this, type, listener });
  return add.call(this, type, listener, options);
};
EventTarget.prototype.removeEventListener = function (
  type: string,
  listener: never,
  options?: never,
) {
  const i = live.findIndex((e) => e.target === this && e.type === type && e.listener === listener);
  if (i >= 0) live.splice(i, 1);
  return remove.call(this, type, listener, options);
};
const kind = (t: EventTarget) =>
  t === window
    ? 'window'
    : t === document
      ? 'document'
      : t instanceof HTMLCanvasElement
        ? 'canvas'
        : t instanceof Element
          ? 'element'
          : 'other';
const listeners = () => {
  const counts: Record<string, number> = {};
  for (const e of live) {
    if (kind(e.target) === 'element') continue;
    const k = `${kind(e.target)}:${e.type}`;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
};

const result: Record<string, unknown> = {
  steps: [] as string[],
  errors: [] as string[],
  failures: [] as string[],
};
(window as unknown as { result: unknown }).result = result;
const log = (s: string) => (result.steps as string[]).push(s);
const check = (ok: boolean, what: string) => {
  if (!ok) (result.failures as string[]).push(what);
};
window.addEventListener('error', (e) => (result.errors as string[]).push(String(e.message)));

async function main(): Promise<void> {
  const { WebGPURenderer } = await import('three/webgpu');
  const { defaultCampaignStart, sunDirection } = await import('../../src/core/calendar');
  const { CubeGrid } = await import('../../src/core/cubeGrid');
  const { KNOT } = await import('../../src/core/units');
  const { Vec3d } = await import('../../src/core/vec3d');
  const { FreeFlight, parseFreeFlightUrl } = await import('../../src/freeflight/freeFlight');
  const { GlobeScene } = await import('../../src/render/sim/globeScene');
  const { airfieldGrading } = await import('../../src/render/sim/infra/airfieldGrading');
  const { InfraScene } = await import('../../src/render/sim/infra/infraScene');
  const { buildWeatherClimate } = await import('../../src/sim/weather/climate');
  const { WeatherGrid } = await import('../../src/sim/weather/grid');
  const { WEATHER_PRESETS } = await import('../../src/sim/weather/presets');
  const { generateCampaignWorld } = await import('../../src/worldgen/campaignWorld');
  const { DEFAULT_PLANET_PARAMS } = await import('../../src/worldgen/params');
  const { syntheticSource } = await import('../../tests/helpers/weatherWorld');
  const { WeatherAudio } = await import('../../src/ui/audio/weatherAudio');

  const R = DEFAULT_PLANET_PARAMS.radius;
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.append(canvas);
  let renderer: InstanceType<typeof WebGPURenderer>;
  try {
    renderer = new WebGPURenderer({ canvas, antialias: true, reversedDepthBuffer: true });
  } catch (e) {
    log(`renderer: ${String(e)}`);
    throw e;
  }
  const globe = new GlobeScene(renderer, { radius: R, grid: new CubeGrid(16), input: false });
  log(
    `GlobeScene built; pipeline ${globe.pipeline ? 'yes' : 'no'}, precipitation ${globe.precipitation ? 'yes' : 'no'}`,
  );
  let resets = 0;
  const reset = globe.resetAtmosphere.bind(globe);
  globe.resetAtmosphere = () => {
    resets++;
    reset();
  };

  const t0 = performance.now();
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: '1983' });
  log(
    `campaign world in ${Math.round(performance.now() - t0)} ms, ${campaign.infrastructure.airbases.length} airbases`,
  );
  const infra = new InfraScene(campaign.graph, campaign.infrastructure, R);
  const n = 64;
  const height = new Float32Array(6 * n * n).fill(200);
  const edits = airfieldGrading(infra, height, n);
  const orbit = DEFAULT_PLANET_PARAMS;
  const calendar = defaultCampaignStart(new Vec3d(0, 0.6, 0.8), orbit);
  const climate = buildWeatherClimate(syntheticSource(), new WeatherGrid(), R);
  globe.weather.setGround(climate.ground.slice());
  globe.lightning.seed = String(campaign.seed);
  globe.planetOrbit = orbit;
  globe.calendar = calendar;

  const audio = new WeatherAudio();
  audio.attach();
  let view: string = 'simulation';
  const views: string[] = [];
  let weatherChanged = 0;
  history.replaceState(null, '', '?mode=freeflight&weather=rain&tod=17');
  const url = parseFreeFlightUrl(new URLSearchParams(location.search), '1983');
  const strategic = { orbit: { lat: 0, lon: 0, targetAltitude: 0 }, onGroundPick: null as unknown };
  const before = listeners();
  const ff = new FreeFlight(
    {
      canvas,
      globe,
      strategic: strategic as never,
      radius: R,
      orbit,
      calendar: () => calendar,
      setView: (v) => {
        if (v !== view) views.push(v);
        if (v === 'simulation' && view !== 'simulation') globe.resetAtmosphere();
        if (v === 'strategic') globe.pipeline?.release();
        view = v;
      },
      loadSeed: () => {},
      exit: () => log('exit called'),
      status: () => 'smoke',
      sound: audio,
      weatherChanged: () => weatherChanged++,
    },
    url,
  );
  ff.setStrategic(campaign);
  ff.setClimate({ seed: String(campaign.seed), radius: R, orbit, calendar, climate });
  ff.setTerrain({ infra, edits, height, n, airbases: campaign.infrastructure });
  const base = listeners();
  result.listenersAfterConstruct = base;
  result.listenersAddedByConstruct = Object.fromEntries(
    Object.entries(base).filter(([k, v]) => v !== (before[k] ?? 0)),
  );

  /** What main.ts does around a frame, without drawing. */
  const here = new Vec3d();
  const frame = (dt = 1 / 60) => {
    ff.frame(dt, dt * 1000);
    const flying = ff.state !== 'menu';
    globe.gameTime = flying ? ff.gameTime : 0;
    globe.paused = ff.state === 'paused';
    sunDirection(globe.gameTime, orbit, calendar, globe.sun);
    const weather = ff.weatherView;
    globe.weatherView = weather?.ready ? weather : null;
    if (flying) {
      here.copy(globe.chase.target.pos);
      globe.weatherState.update(
        globe.weatherView,
        here,
        here.length() - R,
        globe.gameTime,
        globe.paused ? 0 : dt,
      );
      ff.drawHud(globe.camera);
    }
  };
  const menuEl = ff.menu.el;
  const q = <T extends Element>(root: Element, s: string) => root.querySelector(s) as T;
  const click = (root: Element, text: string) => {
    const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.includes(text));
    if (!b) throw new Error(`no button "${text}"`);
    b.click();
  };
  const key = (code: string) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  };
  /**
   * A real key press from the tool (Playwright), for what browsers grant only to a user's
   * gesture: pointer lock (decision 193). The page asks by its title; the tool answers.
   */
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const press = async (code: string) => {
    (window as unknown as { pressNow: string }).pressNow = code;
    document.title = 'press';
    while (document.title !== 'pressed') await sleep(20);
    document.title = 'session';
  };
  /**
   * Real mouse motion (px) from the tool, which only a headed browser under an X server
   * delivers under pointer lock (`HEADED=1`, xdotool; decision 195); elsewhere `realMouse`
   * is false and the motion checks are skipped.
   */
  const realMouse = (window as unknown as { realMouse?: boolean }).realMouse === true;
  const moveMouse = async (dx: number, dy: number) => {
    await press(`mouse:${dx},${dy}`);
    for (let i = 0; i < 5; i++) frame();
  };
  /** Frames until the capture is `want` (a refused grab is retried for up to 4 s). */
  const captureSettles = async (want: boolean) => {
    for (let i = 0; i < 50 && ff.capture.captured !== want; i++) {
      await sleep(100);
      frame();
    }
    return ff.capture.captured === want;
  };
  const choose = (root: Element, preset: string) => {
    const select = q<HTMLSelectElement>(root, 'select.ff-weather');
    select.value = preset;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  for (let i = 0; i < 30; i++) frame();
  log(
    `menu: state ${ff.state}, view ${view}, weatherView ${ff.weatherView === null ? 'null' : 'set'}, weather select ${q<HTMLSelectElement>(menuEl, 'select.ff-weather').value}, wind ${q<HTMLInputElement>(menuEl, '.ff-wind').checked}`,
  );
  const baseId = campaign.infrastructure.airbases[0]!.id;
  ff.menu.select(baseId);

  const perPreset: Record<string, unknown> = {};
  for (const preset of WEATHER_PRESETS) {
    choose(menuEl, preset);
    for (let i = 0; i < 5; i++) frame();
    const r0 = resets;
    click(menuEl, 'Fly');
    if ((ff.state as string) !== 'flying')
      throw new Error(`not flying after Fly (${preset}): ${ff.state}`);
    frame();
    const m = ff.flight.model!;
    const report = ff.weatherView!.report(m.pos, ff.gameTime);
    const first = {
      rain: +globe.weatherState.rain.value.toFixed(2),
      snow: +globe.weatherState.snow.value.toFixed(2),
      dust: +globe.weatherState.dust.value.toFixed(2),
      storm: +globe.weatherState.storm.value.toFixed(2),
      wetness: +globe.weatherState.wetness.value.toFixed(2),
      cover: +report.cloudCover.toFixed(2),
      visibility: Math.round(report.visibility),
    };
    const t1 = ff.gameTime;
    for (let i = 0; i < 100; i++) frame();
    const advanced = ff.gameTime - t1;
    // Pause with the key, hold, resume with the key; pause again, resume with the button.
    key('Escape');
    const paused = ff.state;
    const t2 = ff.gameTime;
    const clock = globe.weatherState.clock.value;
    for (let i = 0; i < 10; i++) frame();
    const held = ff.gameTime === t2 && globe.weatherState.clock.value === clock;
    key('Escape');
    const resumedByKey = ff.state;
    key('Escape');
    const pausedAgain = ff.state;
    click(ff.pause.el, 'Resume');
    const resumed = ff.state;
    for (let i = 0; i < 10; i++) frame();
    // Back to the start screen.
    key('Escape');
    click(ff.pause.el, 'Change airbase');
    frame();
    check(first.wetness === Math.min(1, +(2.5 * first.rain).toFixed(2)), `${preset}: wet at once`);
    check(Math.abs(advanced - 100 / 60) < 0.02, `${preset}: 100 frames fly 1.67 s`);
    check(paused === 'paused' && held && resumed === 'flying', `${preset}: pause holds the clocks`);
    check(
      resumedByKey === 'flying' && pausedAgain === 'paused',
      `${preset}: Esc closes the pause menu and opens it again`,
    );
    check(ff.state === 'menu' && view === 'strategic', `${preset}: back on the start screen`);
    check(ff.weatherView === null, `${preset}: no weather on the start screen`);
    check(m.crashed === null, `${preset}: no crash on the runway`);
    check(location.search.includes(`weather=${preset}`), `${preset}: in the URL`);
    perPreset[preset] = {
      first,
      resetsAtStart: resets - r0,
      advanced: +advanced.toFixed(3),
      paused,
      held,
      resumed,
      backInMenu: ff.state === 'menu' && view === 'strategic' && ff.weatherView === null,
      temperatureShift: +ff.temperatureShift.toFixed(1),
      wind: +m.wind.length().toFixed(1),
      url: location.search,
      crashed: m.crashed,
    };
  }
  result.perPreset = perPreset;
  const firstOf = (p: string) => (perPreset[p] as { first: Record<string, number> }).first;
  check(firstOf('clear').cover === 0, 'clear: no cloud');
  check(firstOf('rain').rain > 0.4 && firstOf('drizzle').rain < 0.3, 'rain and drizzle differ');
  check(
    firstOf('storm').storm > 0.5 && firstOf('storm').rain > 0.8,
    'storm: thunder and a skyfall',
  );
  check(firstOf('snow').snow > 0.2 && firstOf('blizzard').snow > firstOf('snow').snow, 'snow');
  check(firstOf('fog').visibility < 1000, 'fog: under a kilometer');
  check(firstOf('duststorm').dust > 0.5, 'dust storm: dust');

  // A takeoff roll in the wind with the pedals let go: the laws hold the track (controlLaws.ts,
  // trackHold), so the aircraft is on the pavement at 160 kt in a light wind and in a gale.
  const rolls: Record<string, unknown> = {};
  for (const preset of ['clear', 'storm', 'blizzard'] as const) {
    choose(menuEl, preset);
    click(menuEl, 'Fly');
    frame();
    const m = ff.flight.model!;
    const c = ff.input.controls;
    c.parkingBrake = false;
    c.throttle = 1;
    const seconds = ff.advance(40, () => m.crashed !== null || m.telemetry.cas > 160 * KNOT);
    const surfaces = m.wheels.filter((w) => w.load > 0).map((w) => w.surface);
    rolls[preset] = {
      seconds: +seconds.toFixed(1),
      knots: Math.round(m.telemetry.cas / KNOT),
      wind: +m.wind.length().toFixed(1),
      surfaces,
      crashed: m.crashed,
    };
    check(
      m.crashed === null && surfaces.length === 3 && surfaces.every((x) => x === 'runway'),
      `${preset}: on the runway at 160 kt with the pedals free`,
    );
    key('Escape');
    click(ff.pause.el, 'Change airbase');
    frame();
  }
  result.rolls = rolls;
  log(`takeoff rolls with free pedals: ${JSON.stringify(rolls)}`);

  // The pause menu: weather at once, wind, sound; restart; the start screen shows the same.
  choose(menuEl, 'fair');
  click(menuEl, 'Fly');
  for (let i = 0; i < 20; i++) frame();
  key('Escape');
  const r1 = resets;
  const wc = weatherChanged;
  choose(ff.pause.el, 'storm');
  frame();
  const windBox = q<HTMLInputElement>(ff.pause.el, '.ff-wind');
  windBox.checked = false;
  windBox.dispatchEvent(new Event('change', { bubbles: true }));
  const volume = q<HTMLInputElement>(ff.pause.el, '.ff-volume');
  volume.value = '0.3';
  volume.dispatchEvent(new Event('input', { bubbles: true }));
  const mute = q<HTMLInputElement>(ff.pause.el, '.ff-mute');
  mute.checked = true;
  mute.dispatchEvent(new Event('change', { bubbles: true }));
  result.pauseMenu = {
    preset: ff.weatherPreset,
    storm: +globe.weatherState.storm.value.toFixed(2),
    wetness: +globe.weatherState.wetness.value.toFixed(2),
    resets: resets - r1,
    weatherChanged: weatherChanged - wc,
    url: location.search,
    volume: audio.volume,
    muted: audio.muted,
    state: ff.state,
  };
  check(
    ff.weatherPreset === 'storm' && resets - r1 === 1,
    'pause menu: the weather applies at once',
  );
  check(
    globe.weatherState.storm.value > 0.5 && globe.weatherState.wetness.value === 1,
    'pause menu: storm and wet ground',
  );
  check(weatherChanged - wc === 1, 'pause menu: the app hears of the weather');
  check(location.search.includes('wind=off'), 'pause menu: wind off in the URL');
  check(audio.volume === 0.3 && audio.muted, 'pause menu: volume and mute reach the sound');
  click(ff.pause.el, 'Restart on the runway');
  for (let i = 0; i < 20; i++) frame();
  const stillAir = ff.flight.model!.wind.length();
  key('Escape');
  click(ff.pause.el, 'Air start');
  for (let i = 0; i < 20; i++) frame();
  result.restart = {
    state: ff.state,
    stillAir,
    altitude: Math.round(ff.flight.model!.telemetry.altitude),
  };
  check(stillAir === 0, 'wind off: still air on the aircraft');
  check(
    (ff.state as string) === 'flying' && ff.flight.model!.telemetry.altitude > 2500,
    'air start',
  );

  // A crash: straight down from the air start; the card comes two seconds later.
  const m = ff.flight.model!;
  const down = m.pos.clone().normalize().scale(-250);
  for (let i = 0; i < 2000 && !m.crashed; i++) {
    m.vel.copy(down);
    frame();
  }
  const crashed = m.crashed;
  await new Promise((r) => setTimeout(r, 2300));
  for (let i = 0; i < 30; i++) frame();
  result.crash = { crashed, state: ff.state, summaryVisible: ff.summary.visible };
  check(
    crashed !== null && (ff.state as string) === 'summary' && ff.summary.visible,
    'crash: the card',
  );
  click(ff.summary.el, 'Change airbase');
  frame();
  result.afterCrash = {
    state: ff.state,
    view,
    menuWeather: q<HTMLSelectElement>(menuEl, 'select.ff-weather').value,
    menuWind: q<HTMLInputElement>(menuEl, '.ff-wind').checked,
    weatherView: ff.weatherView === null ? 'null' : 'set',
  };
  check(
    q<HTMLSelectElement>(menuEl, 'select.ff-weather').value === 'storm' &&
      !q<HTMLInputElement>(menuEl, '.ff-wind').checked,
    'the start screen shows what the pause menu changed',
  );
  // And off again from the start screen: what the pause menu changed is what flies.
  click(menuEl, 'Fly');
  for (let i = 0; i < 20; i++) frame();
  result.again = {
    state: ff.state,
    preset: ff.weatherPreset,
    wind: ff.flight.model!.wind.length(),
    url: location.search,
  };
  check(ff.weatherPreset === 'storm' && ff.flight.model!.wind.length() === 0, 'flies with them');
  key('Escape');
  click(ff.pause.el, 'Change airbase');
  frame();

  // Helicopters (track H1): each from the ground beside the runway, W to climb, the hover, the
  // HUD, the mouse and pedals, pause and resume; then the Kestrel again.
  const hold = (code: string, frames: number) => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
    for (let i = 0; i < frames; i++) frame();
    window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
  };
  const aircraft = q<HTMLSelectElement>(menuEl, 'select.ff-aircraft');
  const helicopters: Record<string, unknown> = {};
  result.helicopters = helicopters;
  for (const choice of ['scout', 'utility']) {
    aircraft.value = choice;
    aircraft.dispatchEvent(new Event('change', { bubbles: true }));
    click(menuEl, 'Fly');
    for (let i = 0; i < 10; i++) frame();
    const h = ff.flight.helo;
    check(h !== null && ff.flight.model === null, `${choice}: a helicopter flies`);
    if (!h) continue;
    const onGround = h.onGround;
    hold('KeyW', 240);
    const climbed = h.telemetry.radarAltitude;
    for (let i = 0; i < 300; i++) frame();
    const hovering = h.telemetry.radarAltitude;
    for (let i = 0; i < 20; i++) {
      ff.heloInput.nudge(0, -8);
      frame();
    }
    for (let i = 0; i < 240; i++) frame();
    const forward = h.telemetry.groundSpeed;
    hold('KeyE', 60);
    key('Escape');
    const paused = ff.state;
    key('Escape');
    const resumed = ff.state;
    for (let i = 0; i < 20; i++) frame();
    helicopters[choice] = {
      onGround,
      climbed: +climbed.toFixed(1),
      hovering: +hovering.toFixed(1),
      forward: +forward.toFixed(1),
      rpm: +h.telemetry.rotorSpeed.toFixed(3),
      crashed: h.crashed,
      paused,
      resumed,
      url: location.search,
    };
    check(onGround && !h.crashed, `${choice}: starts on the ground, no crash`);
    check(climbed > 3 && hovering > 3, `${choice}: W climbs and the altitude holds`);
    check(forward > 3, `${choice}: the mouse flies it forward`);
    check(paused === 'paused' && resumed === 'flying', `${choice}: pause and resume`);
    check(location.search.includes(`aircraft=${choice}`), `${choice}: in the URL`);
    if (choice === 'utility') await press('shot:session-utility-hover');
    if (choice === 'scout') {
      // Tab captures the mouse and frees it, without pausing (decision 193).
      await press('Tab');
      const grabbed = (await captureSettles(true)) && ff.heloInput.locked;
      await press('Tab');
      const freed = (await captureSettles(false)) && !ff.heloInput.locked;
      helicopters.capture = { grabbed, freed, state: ff.state };
      check(
        grabbed && freed && ff.state === 'flying',
        `${choice}: Tab captures and frees the mouse`,
      );
    }
    key('Escape');
    click(ff.pause.el, 'Change airbase');
    frame();
  }
  aircraft.value = 'kestrel';
  aircraft.dispatchEvent(new Event('change', { bubbles: true }));
  click(menuEl, 'Fly');
  for (let i = 0; i < 20; i++) frame();
  check(
    ff.flight.model !== null && ff.flight.helo === null && ff.state === 'flying',
    'the Kestrel after the helicopters',
  );
  await press('shot:session-kestrel');
  // The displays and the strip (decision 199): shown in flight, a strip item works the
  // control it shows, and 1 collapses and expands the left display.
  {
    for (let i = 0; i < 12; i++) frame();
    const root = document.querySelector<HTMLElement>('.dsp-root');
    const slots = [...document.querySelectorAll<HTMLElement>('.dsp-slot')];
    const open = slots.filter((el) => !el.classList.contains('dsp-closed')).length;
    const items = [...document.querySelectorAll('.dsp-item')].map((e) => e.textContent ?? '');
    const pb0 = ff.input.controls.parkingBrake;
    document.querySelector<HTMLElement>('.dsp-item[data-cmd="item-park"]')?.click();
    const strip = ff.input.controls.parkingBrake !== pb0;
    if (strip) key('KeyP');
    const left = slots[0]!;
    // The wheel over the map steps its range (decision 202).
    const range0 = ff.displays.display?.map.range ?? -1;
    left.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
    const wheel = (ff.displays.display?.map.range ?? -1) === range0 + 1;
    left.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
    check(wheel, 'displays: the wheel over the map steps its range');
    key('Digit1');
    const collapsed = left.classList.contains('dsp-closed');
    key('Digit1');
    const expanded = !left.classList.contains('dsp-closed');
    result.displays = { shown: !!root && !root.hidden, open, items, strip, collapsed, expanded };
    // On the ground the preset collapses the threat display (Proposal 0006's table).
    check(!!root && !root.hidden && open === 2, 'displays: shown on the ground (left, messages)');
    check(
      items.includes('PARK BRK') && items.includes('GEAR DN'),
      'displays: the strip shows the brake and the gear',
    );
    check(strip, "displays: the strip's PARK BRK works the brake");
    check(collapsed && expanded, 'displays: 1 collapses and expands the left display');
  }
  // The jet's two mouse modes (decisions 193, 195, 198): mouse aim flies toward the ring and
  // holds it while the mouse is free; direct makes the captured mouse's offset from the
  // center the stick, a held key wins on its axis, and freeing the mouse centers it. A lock
  // the browser drops by itself (Escape, focus) pauses.
  {
    const first = ff.input.mode;
    await press('Tab');
    const grabbed = await captureSettles(true);
    let aimFollows: boolean | null = null;
    if (realMouse) {
      await moveMouse(120, -60);
      aimFollows = ff.input.cursor.x > 0.05 && ff.input.cursor.y > 0.05;
    }
    await press('Tab');
    const freed = await captureSettles(false);
    const heldAim = { ...ff.input.cursor };
    if (realMouse) await moveMouse(200, 0);
    const aimHolds = ff.input.cursor.x === heldAim.x && ff.input.cursor.y === heldAim.y;
    const flyingAfterTab = ff.state;
    await press('KeyN');
    const direct = (await captureSettles(true)) && ff.input.mode === 'direct';
    const centered = ff.input.cursor.x === 0 && ff.input.cursor.y === 0;
    const inUrl = location.search.includes('control=direct');
    let stickFollows: boolean | null = null;
    let forwardPushes: boolean | null = null;
    if (realMouse) {
      await moveMouse(220, 0);
      stickFollows = ff.input.controls.roll > 0.2;
      await moveMouse(0, -150);
      forwardPushes = ff.input.controls.pitch < -0.1;
    }
    // A held key wins on its axis.
    const p0 = ff.input.controls.pitch;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS', key: 's', bubbles: true }));
    for (let i = 0; i < 40; i++) frame();
    const keyWins = ff.input.controls.pitch > p0 + 0.6;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyS', key: 's', bubbles: true }));
    await press('Tab');
    const freeCenters = (await captureSettles(false)) && ff.input.cursor.x === 0;
    await press('KeyN');
    const backToAim = (await captureSettles(true)) && ff.input.mode === 'mouse-aim';
    document.exitPointerLock();
    await captureSettles(false);
    const pausedByLoss = ff.state;
    // An Escape right after the loss is the one that freed the mouse: it must not resume.
    key('Escape');
    const heldPaused = ff.state;
    click(ff.pause.el, 'Resume');
    result.capture = {
      realMouse,
      first,
      grabbed,
      aimFollows,
      freed,
      aimHolds,
      flyingAfterTab,
      direct,
      centered,
      inUrl,
      stickFollows,
      forwardPushes,
      keyWins,
      freeCenters,
      backToAim,
      pausedByLoss,
      heldPaused,
    };
    check(first === 'mouse-aim', 'Kestrel: mouse aim by default');
    check(
      grabbed && freed && flyingAfterTab === 'flying',
      'Kestrel: Tab captures and frees the mouse',
    );
    check(aimHolds, 'Kestrel: the aim point holds while the mouse is free');
    check(direct && centered && inUrl, 'Kestrel: N switches to direct, centered, in the URL');
    check(keyWins, 'Kestrel: in direct mode a held stick key wins');
    check(freeCenters, 'Kestrel: freeing the mouse in direct mode centers the stick');
    check(backToAim, 'Kestrel: N switches back to mouse aim');
    if (realMouse) {
      check(aimFollows === true, 'Kestrel: the real mouse moves the aim point');
      check(stickFollows === true, 'Kestrel: the real mouse moves the direct stick');
      check(forwardPushes === true, 'Kestrel: mouse forward pushes the direct stick');
    }
    check(
      pausedByLoss === 'paused' && heldPaused === 'paused' && (ff.state as string) === 'flying',
      'Kestrel: a lock lost to the browser pauses, and its Escape does not resume',
    );
  }
  // A takeoff with the mouse in mouse aim (decision 217): on the runway with the mouse
  // captured, raising the ring rotates the jet, and the flight director climbs away with it.
  {
    key('Escape');
    click(ff.pause.el, 'Restart on the runway');
    for (let i = 0; i < 20; i++) frame();
    if ((ff.state as string) !== 'flying') click(ff.pause.el, 'Resume');
    ff.input.mode = 'mouse-aim';
    await press('Tab');
    await captureSettles(true);
    const m = ff.flight.model!;
    key('KeyP');
    ff.input.controls.throttle = 0.99;
    for (let i = 0; i < 4000 && m.telemetry.cas < 80; i++) frame();
    const rollKnots = Math.round(m.telemetry.cas / 0.5144);
    ff.input.moveCursor(0, -180, innerWidth, innerHeight);
    // This page draws nothing, so the chase camera (whose rest view mouse aim reads) is
    // updated here as the scene's render does.
    const fly = () => {
      frame();
      globe.chase.update(1 / 60);
    };
    for (let i = 0; i < 120; i++) fly();
    const trace: number[][] = [];
    for (let i = 0; i < 1500 && m.telemetry.radarAltitude < 30 && !m.crashed; i++) {
      fly();
      if (i % 15 === 0)
        trace.push([
          Math.round(m.telemetry.radarAltitude * 10) / 10,
          Math.round((m.telemetry.pitch * 180) / Math.PI),
          Math.round(m.telemetry.cas / 0.5144),
          m.onGround ? 1 : 0,
          Math.round(ff.input.controls.pitch * 100) / 100,
        ]);
    }
    (result as Record<string, unknown>).takeoffTrace = trace;
    const off = m.telemetry.radarAltitude;
    for (let i = 0; i < 600; i++) fly();
    const later = m.telemetry.radarAltitude;
    result.mouseTakeoff = {
      rollKnots,
      off: Math.round(off),
      later: Math.round(later),
      crashed: m.crashed,
    };
    check(
      off >= 30 && later > off && !m.crashed && !m.onGround,
      `Kestrel: the mouse takes off in mouse aim (${JSON.stringify(result.mouseTakeoff)})`,
    );
    await press('Tab');
    await captureSettles(false);
  }
  // The right button's free look and V reach the camera (decision 198); how it eases back is
  // tested in tests/freeFlightView.test.ts, since this page draws nothing.
  {
    const chase = globe.chase;
    const canvas = document.querySelector('canvas')!;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { button: 2, bubbles: true }));
    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 40, movementY: 0 }));
      frame();
    }
    const held = chase.lookHeld;
    window.dispatchEvent(new PointerEvent('pointerup', { button: 2, bubbles: true }));
    frame();
    const turned = Math.abs(chase.lookYaw) > 0.05 && !chase.lookHeld;
    const sticky = chase.stickyLook;
    key('KeyV');
    const recentering = (chase as unknown as { recentering: boolean }).recentering;
    chase.resetView();
    result.look = { held, turned, sticky, recentering };
    check(held && turned && sticky, 'Kestrel: the right button looks around, sticky');
    check(recentering, 'Kestrel: V recenters the look');
  }
  // The mouse's up and down inverted per mode (decisions 196, 198): I in flight, the pause
  // menu's box.
  {
    key('KeyI');
    const byKey = ff.input.invertAim && location.search.includes('invert=aim');
    let forwardLowers: boolean | null = null;
    if (realMouse) {
      await press('Tab');
      await captureSettles(true);
      const y0 = ff.input.cursor.y;
      await moveMouse(0, -80);
      forwardLowers = ff.input.cursor.y < y0 - 0.05;
      await press('Tab');
      await captureSettles(false);
    }
    key('Escape');
    const box = q<HTMLInputElement>(ff.pause.el, '.ff-invert');
    const shown = box.checked;
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const byBox = !ff.input.invertAim && !location.search.includes('invert');
    click(ff.pause.el, 'Resume');
    result.invert = { byKey, forwardLowers, shown, byBox };
    check(byKey, 'Kestrel: I inverts the mouse, and the URL keeps it');
    check(shown && byBox, "Kestrel: the pause menu's box shows and switches the inversion");
    if (realMouse) check(forwardLowers === true, 'Kestrel: inverted, mouse forward lowers the aim');
  }
  // Traffic and the sensors (decision 218): the pause menu's box, then an air start; the
  // datalink shows the circling aircraft, the threat warning hears the ground radars, and
  // L locks the nearest hostile the radar sees, with a box on the HUD.
  {
    key('Escape');
    const box = q<HTMLInputElement>(ff.pause.el, '.ff-traffic');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    const inUrl = location.search.includes('traffic=on');
    click(ff.pause.el, 'Air start');
    for (let i = 0; i < 30; i++) frame();
    if ((ff.state as string) !== 'flying') click(ff.pause.el, 'Resume');
    type Snap = {
      contacts: { id: string; source: string; side: string | null }[];
      threats: unknown[];
    };
    const internals = ff as unknown as {
      sensorSnap: Snap | null;
      trafficViews: Map<string, { group: { visible: boolean } }>;
      hudTarget(m: unknown, eye: unknown): { label: string } | null;
    };
    let locked: string | null = null;
    let boxed: string | null = null;
    let lockable = false;
    for (let i = 0; i < 1200 && !locked; i++) {
      frame();
      if (i % 30 !== 0) continue;
      lockable = (internals.sensorSnap?.contacts ?? []).some(
        (c) => c.source === 'radar' && c.side !== 'alliance',
      );
      if (!lockable) continue;
      key('KeyL');
      for (let k = 0; k < 12; k++) frame();
      locked = ff.displays.avionics.radar.lock;
      boxed = internals.hudTarget(ff.flight.model, globe.chase.eye)?.label ?? null;
    }
    const snapNow = internals.sensorSnap;
    const datalink = (snapNow?.contacts ?? []).filter((c) => c.source === 'datalink').length;
    const views = [...internals.trafficViews.values()].filter((v) => v.group.visible).length;
    result.traffic = {
      inUrl,
      views,
      contacts: snapNow?.contacts.length ?? 0,
      datalink,
      threats: snapNow?.threats.length ?? 0,
      lockable,
      locked,
      boxed,
    };
    check(inUrl, 'traffic: the pause menu turns it on, in the URL');
    check(views === 4, 'traffic: four aircraft drawn');
    check((snapNow?.contacts.length ?? 0) >= 2, 'traffic: the sensors show the circling aircraft');
    check((snapNow?.threats.length ?? 0) >= 1, 'traffic: the threat warning hears a radar');
    if (lockable)
      check(locked !== null && boxed !== null, 'traffic: L locks a contact, boxed on the HUD');
    key('Escape');
    const off = q<HTMLInputElement>(ff.pause.el, '.ff-traffic');
    off.checked = false;
    off.dispatchEvent(new Event('change', { bubbles: true }));
    click(ff.pause.el, 'Resume');
  }
  key('Escape');
  click(ff.pause.el, 'Change airbase');
  frame();

  const end = listeners();
  result.listenersAtEnd = end;
  result.listenerGrowth = Object.fromEntries(
    Object.entries(end)
      .filter(([k, v]) => v !== (base[k] ?? 0))
      .map(([k, v]) => [k, v - (base[k] ?? 0)]),
  );
  // The sound's own gesture listeners go once it has started; nothing may be added.
  check(
    Object.values(result.listenerGrowth as Record<string, number>).every((d) => d <= 0),
    'no listener left behind by a flight',
  );
  result.views = views.length;
  result.resetsTotal = resets;
  audio.dispose();
  globe.dispose();
  log('disposed');
}

main()
  .catch((e: unknown) => {
    (result.errors as string[]).push(e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  })
  .finally(() => (document.title = 'ready'));
