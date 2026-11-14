/**
 * Draws Free Flight's cards (src/ui/flight/) over a render from
 * tools/freeflight.preview.ts, to judge their legibility over rain, fog and
 * night without WebGPU: `cards.html?card=pause|menu&shot=<name>&weather=<preset>`
 * loads tools/out/freeflight-<name>.png behind the pause menu or the start
 * screen, with the weather chosen as in the app.
 */
import { PauseMenu } from '../../src/ui/flight/flightCards';
import { DEFAULT_OPTIONS, FreeFlightMenu } from '../../src/ui/flight/freeFlightMenu';
import type { FreeFlightOptions } from '../../src/ui/flight/freeFlightMenu';
import { WEATHER_PRESETS } from '../../src/sim/weather/presets';
import type { WeatherPreset } from '../../src/sim/weather/presets';

async function main(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const name = query.get('shot') ?? 'runway';
  const img = document.getElementById('shot') as HTMLImageElement;
  img.src = `../out/freeflight-${name}.png`;
  await img.decode();
  const asked = query.get('weather') as WeatherPreset | null;
  const options: FreeFlightOptions = {
    ...DEFAULT_OPTIONS,
    weather: asked && WEATHER_PRESETS.includes(asked) ? asked : DEFAULT_OPTIONS.weather,
  };
  const nothing = () => {};
  if (query.get('card') === 'menu') {
    const menu = new FreeFlightMenu(
      { seed: nothing, select: nothing, fly: nothing, exit: nothing },
      options,
    );
    menu.setSeed('1983');
    menu.setStatus('World 1983: cached (2.1 s)');
    menu.setBases([
      {
        id: 4,
        name: 'Mirer Air Base',
        side: 'alliance',
        kind: 'main',
        region: 'Mirer Plain',
        runwayLength: 2700,
        designators: '10/28',
      },
      {
        id: 9,
        name: 'Tolvo Air Base',
        side: 'pact',
        kind: 'forward',
        region: 'Tolvo Hills',
        runwayLength: 2400,
        designators: '04/22',
      },
    ]);
    menu.select(4);
    menu.setReady(true);
    menu.visible = true;
  } else {
    const pause = new PauseMenu(
      options,
      {
        resume: nothing,
        restart: nothing,
        changeBase: nothing,
        exit: nothing,
        optionsChanged: nothing,
      },
      { volume: 0.8, muted: false },
    );
    pause.visible = true;
  }
  document.title = 'ready';
}

void main();
