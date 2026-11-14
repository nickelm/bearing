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
  const grading = airfieldGrading(infra, height, n);
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
  ff.setTerrain({ infra, grading, height, n, airbases: campaign.infrastructure });
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
    // Pause with the key, hold, resume with the button.
    key('Escape');
    const paused = ff.state;
    const t2 = ff.gameTime;
    const clock = globe.weatherState.clock.value;
    for (let i = 0; i < 10; i++) frame();
    const held = ff.gameTime === t2 && globe.weatherState.clock.value === clock;
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
