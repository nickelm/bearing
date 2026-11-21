/**
 * Draws the Free Flight HUD (src/ui/flight/hud.ts) over a render from
 * tools/freeflight.preview.ts: `composite.html?shot=<name>` loads
 * tools/out/freeflight-<name>.png and .json and draws the HUD with the
 * frame's camera, so the screenshot shows the real HUD code over the real
 * render. tools/freeflight.screens.mjs drives it in headless Chromium.
 * `composite.html?hover=<case>` draws the helicopter layout instead (hover.ts).
 * `&slots=1` adds the display slots' layout over either (slots.ts; `&scale=` sets the
 * UI scale).
 */
import { Hud, matrixProjector } from '../../src/ui/flight/hud';
import type { HudFrame } from '../../src/ui/flight/hud';

interface Shot {
  width: number;
  height: number;
  frame: HudFrame;
  messages: string[][];
  view: number[];
  projection: number[];
}

async function main(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const hover = query.get('hover');
  if (hover !== null) {
    // The helicopter layout over a stand-in scene (hover.ts); no render needed.
    const { drawHover } = await import('./hover');
    await drawHover(hover);
    await slots(query);
    if (query.get('displays')) {
      const { drawDisplays } = await import('./displays');
      await drawDisplays(query);
    }
    document.title = 'ready';
    return;
  }
  const name = query.get('shot') ?? 'runway';
  const shot = (await (await fetch(`../out/freeflight-${name}.json`)).json()) as Shot;
  const img = document.getElementById('shot') as HTMLImageElement;
  img.src = `../out/freeflight-${name}.png`;
  await img.decode();
  const hud = new Hud();
  hud.show(true);
  // `&panels=1`: the HUD as the displays and the strip leave it (decision 199); with
  // `&displays=<mode>` the displays are drawn over the render too (check 7 with the full HUD).
  const panels = query.get('panels') === '1' || query.has('displays');
  if (panels) shot.frame.panels = true;
  // `&acm=1`: the radar's air combat mode cone about the boresight (decision 223).
  if (query.get('acm') === '1') shot.frame.acmCone = (10 * Math.PI) / 180;
  // `&seeker=1|lock`: the IR missile's seeker circle (decision 297), searching about the
  // boresight or locked on a point 3 km out a little off it.
  const seeker = query.get('seeker');
  if (seeker) {
    const b = shot.frame.boresight;
    shot.frame.seeker = {
      dir: b,
      point: seeker === 'lock' ? [b[0] * 3000 + 60, b[1] * 3000 + 40, b[2] * 3000] : null,
      cone: (2.5 * Math.PI) / 180,
      tracking: seeker === 'lock',
      label: 'SRM 3',
      armed: true,
    };
  }
  // `&gun=1`: the gun pipper (decision 295) a little below the boresight, 610 m out.
  if (query.get('gun') === '1') {
    const b = shot.frame.boresight;
    shot.frame.gun = {
      point: [b[0] * 610, b[1] * 610 - 12, b[2] * 610],
      rounds: 486,
      armed: query.get('safe') !== '1',
    };
  } else for (const m of shot.messages) hud.message(m, 600);
  hud.draw(
    shot.frame,
    matrixProjector(shot.view, shot.projection, window.innerWidth, window.innerHeight),
  );
  await slots(query);
  if (query.get('displays')) {
    const { drawDisplays } = await import('./displays');
    await drawDisplays(query);
  }
  document.title = 'ready';
}

async function slots(query: URLSearchParams): Promise<void> {
  if (!query.get('slots')) return;
  const { drawSlots } = await import('./slots');
  drawSlots(Number(query.get('scale') ?? 1));
}

void main();
