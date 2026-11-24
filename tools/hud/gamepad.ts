/**
 * Free Flight by gamepad in a browser without WebGPU (Proposal 0014): the real `FreeFlight`
 * class, as tools/hud/session.ts runs it, with a synthetic standard gamepad behind
 * `navigator.getGamepads()`, so the app's own polling, connect prompt, toasts, menu
 * navigation, bindings screen and flight inputs all run as they do with a real pad.
 *
 * The pad stays hidden until its first button press, as browsers do. The page then picks an
 * airbase and flies from the start screen with the D-pad and ✕, takes off on the sticks (the
 * throttle as a rate, the afterburner by a held push, ✕ for the gear), looks around with L1,
 * pauses with Options, walks the pause menu into the bindings screen and back, turns the
 * display focus on and off, and pulls the pad out.
 *
 *   npm run dev, then: node tools/gamepad.session.mjs [http://localhost:5173]
 *
 * Findings go to `window.result` (`failures` lists what did not hold); the title turns "ready".
 */

/** The synthetic pad, as the Gamepad API shows it. */
const pad = {
  id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
  index: 0,
  connected: true,
  mapping: 'standard',
  timestamp: 0,
  axes: [0, 0, 0, 0],
  buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })),
  vibrationActuator: {
    effects: [] as unknown[],
    playEffect(type: string, params: unknown) {
      this.effects.push([type, params]);
      return Promise.resolve('complete');
    },
  },
};
let plugged = false;
Object.defineProperty(navigator, 'getGamepads', {
  value: () => (plugged ? [pad, null, null, null] : [null, null, null, null]),
  configurable: true,
});

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
  const { generateCampaignWorld } = await import('../../src/worldgen/campaignWorld');
  const { DEFAULT_PLANET_PARAMS } = await import('../../src/worldgen/params');
  const { syntheticSource } = await import('../../tests/helpers/weatherWorld');
  const { AB_GATE } = await import('../../src/sim/flight/controlLaws');
  const { gamepads } = await import('../../src/ui/input/gamepad');
  const { inputLayer } = await import('../../src/ui/input/layer');
  const { menuActive } = await import('../../src/ui/input/menuNav');

  const R = DEFAULT_PLANET_PARAMS.radius;
  const canvas = document.createElement('canvas');
  document.getElementById('app')!.append(canvas);
  const renderer = new WebGPURenderer({ canvas, antialias: true, reversedDepthBuffer: true });
  const globe = new GlobeScene(renderer, { radius: R, grid: new CubeGrid(16), input: false });
  const campaign = generateCampaignWorld({ ...DEFAULT_PLANET_PARAMS, seed: '1983' });
  const infra = new InfraScene(campaign.graph, campaign.infrastructure, R);
  const n = 64;
  const height = new Float32Array(6 * n * n).fill(200);
  const edits = airfieldGrading(infra, height, n);
  const orbit = DEFAULT_PLANET_PARAMS;
  const calendar = defaultCampaignStart(new Vec3d(0, 0.6, 0.8), orbit);
  const climate = buildWeatherClimate(syntheticSource(), new WeatherGrid(), R);
  globe.weather.setGround(climate.ground.slice());
  globe.planetOrbit = orbit;
  globe.calendar = calendar;
  history.replaceState(null, '', '?mode=freeflight&weather=clear&tod=12&traffic=off');
  const url = parseFreeFlightUrl(new URLSearchParams(location.search), '1983');
  const strategic = { orbit: { lat: 0, lon: 0, targetAltitude: 0 }, onGroundPick: null as unknown };
  const ff = new FreeFlight(
    {
      canvas,
      globe,
      strategic: strategic as never,
      radius: R,
      orbit,
      calendar: () => calendar,
      setView: () => {},
      loadSeed: () => {},
      exit: () => log('exit called'),
      status: () => 'gamepad session',
      sound: null,
      weatherChanged: () => {},
    } as never,
    url,
  );
  ff.setStrategic(campaign);
  ff.setClimate({ seed: String(campaign.seed), radius: R, orbit, calendar, climate });
  ff.setTerrain({ infra, edits, height, n, airbases: campaign.infrastructure });

  const src = gamepads();
  const layer = inputLayer();
  const messages: string[] = [];
  const message = ff.hud.message.bind(ff.hud);
  ff.hud.message = (t: string | string[], s?: number, w?: boolean) => {
    messages.push(...(Array.isArray(t) ? t : [t]));
    message(t, s, w);
  };
  /** One frame as main.ts runs it, the pad polled first (the app polls on its own rAF loop). */
  const frame = (dt = 1 / 60) => {
    src.poll();
    ff.frame(dt, dt * 1000);
    globe.gameTime = ff.state !== 'menu' ? ff.gameTime : 0;
    sunDirection(globe.gameTime, orbit, calendar, globe.sun);
    if (ff.state !== 'menu') {
      // The scene steps its chase camera when it renders; this page never renders.
      globe.chase.update(dt);
      ff.drawHud(globe.camera);
    }
  };
  const frames = (k: number) => {
    for (let i = 0; i < k; i++) frame();
  };
  const button = (i: number, on: boolean) => {
    pad.buttons[i] = { pressed: on, touched: on, value: on ? 1 : 0 };
  };
  const tap = (i: number) => {
    button(i, true);
    frame();
    button(i, false);
    frame();
  };
  const active = () => document.activeElement as HTMLElement | null;
  const statusText = () =>
    (ff.menu.el.querySelector('.pad-status') as HTMLElement | null)?.textContent ?? '';
  const toastText = () =>
    (document.querySelector('.pad-toast') as HTMLElement | null)?.textContent ?? '';

  frames(10);
  // Hidden until a button is pressed: the prompt asks for one.
  check(statusText().includes('press any button'), `prompt before the pad: "${statusText()}"`);
  plugged = true;
  button(0, true);
  frame();
  button(0, false);
  frame();
  check(src.anyConnected, 'the pad connects on its first press');
  check(statusText().includes('Wireless Controller'), `status names the pad: "${statusText()}"`);
  check(toastText().includes('connected'), `toast on connect: "${toastText()}"`);
  log(`connected: ${statusText()}`);

  // The start screen by D-pad: down until an airbase row has the focus, ✕ selects, ✕ flies.
  check(menuActive(), 'the start screen has the pad');
  for (let i = 0; i < 40 && !(active() instanceof HTMLTableRowElement); i++) tap(13);
  check(
    active() instanceof HTMLTableRowElement,
    `D-pad reaches an airbase row (at ${active()?.tagName})`,
  );
  check(active()?.classList.contains('pad-focus') === true, 'the focus ring shows');
  tap(0);
  check(active()?.classList.contains('selected') === true, '✕ selects the row');
  for (let i = 0; i < 100 && ff.state === 'menu'; i++) {
    tap(0);
    frames(5);
  }
  check(ff.state === 'flying', `✕ on the selected row flies (state ${ff.state})`);
  const m = ff.flight.model!;
  check(layer.aircraftClass === 'fixed', 'the jet profile resolves');

  // Takeoff: throttle up (the parking brake comes off), hold at military for the afterburner.
  const c = ff.input.controls;
  check(c.parkingBrake, 'parking brake set on the runway');
  pad.axes[1] = -1;
  frames(200);
  check(!c.parkingBrake, 'the throttle push releases the parking brake');
  check(ff.input.padOwns && !ff.input.mouseAimFlies, 'the pad has the controls (decision 368)');
  check(
    messages.some((m) => m.includes('mouse is off')),
    'the HUD says the mouse is off',
  );
  check(
    c.throttle >= AB_GATE,
    `a held push passes into afterburner (lever ${c.throttle.toFixed(2)})`,
  );
  pad.axes[1] = 0;
  const lever = c.throttle;
  frames(30);
  check(c.throttle === lever, 'the lever holds when the stick is let go');
  for (let i = 0; i < 3600 && m.telemetry.cas < 150 * KNOT; i++) frame();
  pad.axes[3] = 0.7;
  for (let i = 0; i < 600 && m.onGround; i++) frame();
  pad.axes[3] = 0.25;
  frames(120);
  pad.axes[3] = 0;
  check(!m.onGround && m.crashed === null, `airborne by the right stick (crashed: ${m.crashed})`);
  tap(0);
  check(!c.gearDown, '✕ raises the gear');
  frames(60);
  log(
    `after takeoff: ${Math.round(m.telemetry.cas / KNOT)} kt, ${Math.round(m.telemetry.altitude)} m`,
  );

  // Free look: L1 held and the right stick; the jet's view springs back on release.
  button(4, true);
  pad.axes[2] = 1;
  frames(20);
  check(
    ff.input.lookHeld && Math.abs(globe.chase.lookYaw) > 0.2,
    `L1 + right stick looks (yaw ${globe.chase.lookYaw.toFixed(2)})`,
  );
  check(c.roll === 0, 'the stick is let go while looking');
  button(4, false);
  pad.axes[2] = 0;
  frames(60);
  check(
    Math.abs(globe.chase.lookYaw) < 0.05,
    `the view springs back (yaw ${globe.chase.lookYaw.toFixed(3)}, lookHeld ${ff.input.lookHeld}, messages ${messages.slice(-3).join(' | ')})`,
  );

  // Options pauses; the pause menu by D-pad; the bindings screen and back.
  tap(9);
  check(ff.state === 'paused' && menuActive(), 'Options pauses and the pause menu has the pad');
  for (let i = 0; i < 20 && !(active()?.textContent ?? '').includes('Controls'); i++) tap(13);
  check(
    (active()?.textContent ?? '').includes('Controls'),
    `D-pad reaches Controls (at "${active()?.textContent}")`,
  );
  tap(0);
  const screen = document.querySelector('.pad-bindings') as HTMLElement | null;
  check(!!screen && !screen.hidden, 'the bindings screen opens');
  check((screen?.textContent ?? '').includes('Wireless Controller'), 'it shows the pad');
  check((screen?.textContent ?? '').includes('Throttle'), 'it lists the axes');
  tap(5);
  check(
    (screen?.querySelector('.ff-primary')?.textContent ?? '') === 'Joystick',
    'R1 switches the device tab',
  );
  tap(4);
  tap(1);
  check(
    screen?.hidden === true && ff.state === 'paused',
    '○ closes the bindings screen, the pause menu stays',
  );
  tap(9);
  check(ff.state === 'flying', 'Options resumes');

  // Display focus: L1 + Share; the D-pad walks the bezel; ○ leaves.
  frames(30);
  button(4, true);
  tap(8);
  button(4, false);
  frame();
  check(menuActive(), 'L1 + Share turns the display focus on');
  check(
    !!active()?.closest('.dsp-root'),
    `the focus is on a display button (${active()?.className})`,
  );
  const gearBefore = c.gearDown;
  tap(0);
  check(c.gearDown === gearBefore, '✕ presses the display, not the gear');
  tap(1);
  check(!menuActive(), '○ leaves the display focus');
  // The D-pad's master mode by hand.
  const mode = ff.displays.avionics.masterMode;
  tap(12);
  frames(2);
  check(
    ff.displays.avionics.masterMode !== mode || ff.displays.avionics.manual,
    'D-pad ↑ steps the master mode',
  );

  // Pulled out: everything it held lets go, the toast says so.
  button(7, true);
  frame();
  check(ff.input.trigger, 'R2 holds the trigger');
  plugged = false;
  frame();
  check(!ff.input.trigger, 'a disconnect lets go of the trigger');
  check(toastText().includes('disconnected'), `toast on disconnect: "${toastText()}"`);
  check(m.crashed === null, 'no crash');
  result.messages = messages;
  result.rumble = pad.vibrationActuator.effects.length;
}

main()
  .catch((e) => (result.errors as string[]).push(`main: ${String(e)} ${(e as Error).stack ?? ''}`))
  .finally(() => (document.title = 'ready'));

export {};
