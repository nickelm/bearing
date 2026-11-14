import { describe, expect, it } from 'vitest';
import { latLonToDirection } from '../src/core/coords';
import { DEG, HOUR } from '../src/core/units';
import { Vec3d } from '../src/core/vec3d';
import { WeatherView } from '../src/sim/weather/frame';
import { WeatherGrid } from '../src/sim/weather/grid';
import { StandaloneWeather } from '../src/sim/weather/standalone';
import { weatherLine } from '../src/ui/weatherLine';
import { syntheticConfig } from './helpers/weatherWorld';

describe('the weather line', () => {
  const here = latLonToDirection(20 * DEG, 30 * DEG, new Vec3d());
  const t = 30.5 * HOUR;
  const line = (preset: ConstructorParameters<typeof StandaloneWeather>[1]) =>
    weatherLine(new StandaloneWeather(syntheticConfig(), preset).view(t), here, t);

  it('says nothing without weather', () => {
    expect(weatherLine(null, here, t)).toBe('weather —');
    expect(weatherLine(new WeatherView(new WeatherGrid()), here, t)).toBe('weather —');
  });

  it('gives cover, ceiling, visibility, wind and temperature', () => {
    expect(line('clear')).toMatch(
      /^cloud 0%, no ceiling, vis 60 km, wind \d{3}° \d+ m\/s, -?\d+ °C$/,
    );
    expect(line('overcast')).toMatch(/^cloud \d+%, ceiling \d+0 m, vis \d+ km, wind /);
    expect(line('fog')).toMatch(/vis 0\.2 km/);
  });

  it('names rain and snow with their rate', () => {
    expect(line('rain')).toMatch(/, rain \d+\.\d mm\/h$/);
    expect(line('drizzle')).toMatch(/, rain 0\.\d mm\/h$/);
    expect(line('snow')).toMatch(/, snow \d+\.\d mm\/h$/);
    expect(line('blizzard')).toMatch(/, snow \d+\.\d mm\/h$/);
  });

  it('names thunderstorms and dust', () => {
    expect(line('storm')).toMatch(/, thunderstorm \d+\.\d mm\/h$/);
    expect(line('storm')).not.toMatch(/rain/);
    expect(line('duststorm')).toMatch(/, dust storm$/);
    expect(line('fair')).not.toMatch(/thunderstorm|dust/);
  });
});
