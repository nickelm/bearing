import { describe, expect, it, vi } from 'vitest';
import { KM } from '../src/core/units';
import { ambienceMix } from '../src/ui/audio/ambience';
import {
  CRACK_RANGE,
  ENVELOPE_RATE,
  SPEED_OF_SOUND,
  THUNDER_RANGE,
  thunderEnvelope,
  thunderSound,
} from '../src/ui/audio/thunder';
import { fillNoise, MAX_THUNDERS, WeatherAudio } from '../src/ui/audio/weatherAudio';

/** An AudioParam that records what was scheduled on it. */
class StubParam {
  value = 0;
  readonly calls: { method: string; args: unknown[] }[] = [];
  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
    return this;
  }
  setValueAtTime(...a: unknown[]) {
    return this.record('setValueAtTime', a);
  }
  setTargetAtTime(...a: unknown[]) {
    return this.record('setTargetAtTime', a);
  }
  linearRampToValueAtTime(...a: unknown[]) {
    return this.record('linearRampToValueAtTime', a);
  }
  setValueCurveAtTime(...a: unknown[]) {
    return this.record('setValueCurveAtTime', a);
  }
  /** The last value a call aimed at. */
  get target(): number {
    const last = this.calls[this.calls.length - 1];
    return last ? (last.args[0] as number) : this.value;
  }
}

class StubNode {
  readonly outputs: unknown[] = [];
  constructor(readonly kind: string) {}
  connect(to: unknown) {
    this.outputs.push(to);
    return to;
  }
  disconnect() {
    this.outputs.length = 0;
  }
}

class StubSource extends StubNode {
  buffer: unknown = null;
  loop = false;
  started: number[] | null = null;
  stopped: number | null = null;
  start(when = 0, offset = 0) {
    this.started = [when, offset];
  }
  stop(when = 0) {
    this.stopped = when;
  }
}

class StubGain extends StubNode {
  readonly gain = new StubParam();
}

class StubFilter extends StubNode {
  type = 'lowpass';
  readonly frequency = new StubParam();
  readonly Q = new StubParam();
}

class StubOscillator extends StubSource {
  readonly frequency = new StubParam();
}

/** The parts of an AudioContext the weather's audio uses. */
class StubContext {
  currentTime = 10;
  sampleRate = 8000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly destination = new StubNode('destination');
  readonly sources: StubSource[] = [];
  readonly gains: StubGain[] = [];
  readonly filters: StubFilter[] = [];
  readonly oscillators: StubOscillator[] = [];
  createGain() {
    const g = new StubGain('gain');
    this.gains.push(g);
    return g;
  }
  createBiquadFilter() {
    const f = new StubFilter('filter');
    this.filters.push(f);
    return f;
  }
  createBufferSource() {
    const s = new StubSource('source');
    this.sources.push(s);
    return s;
  }
  createOscillator() {
    const o = new StubOscillator('oscillator');
    this.oscillators.push(o);
    return o;
  }
  createBuffer(_channels: number, length: number, sampleRate: number) {
    const data = new Float32Array(length);
    return { duration: length / sampleRate, length, getChannelData: () => data };
  }
  resume() {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend() {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close() {
    this.state = 'closed';
    return Promise.resolve();
  }
}

function started(): { audio: WeatherAudio; context: StubContext } {
  const context = new StubContext();
  const audio = new WeatherAudio({ createContext: () => context as unknown as AudioContext });
  expect(audio.start()).toBe(true);
  return { audio, context };
}

describe('thunderSound', () => {
  it('arrives after the sound has traveled, quieter and duller with distance', () => {
    const near = thunderSound({ distance: 600, energy: 1, ground: true })!;
    const mid = thunderSound({ distance: 6 * KM, energy: 1, ground: true })!;
    const far = thunderSound({ distance: 18 * KM, energy: 1, ground: true })!;
    expect(near.delay).toBeCloseTo(600 / SPEED_OF_SOUND, 6);
    expect(far.delay).toBeCloseTo((18 * KM) / SPEED_OF_SOUND, 6);
    expect(near.gain).toBeGreaterThan(2 * mid.gain);
    expect(mid.gain).toBeGreaterThan(2 * far.gain);
    expect(near.gain).toBeLessThanOrEqual(1);
    expect(near.cutoff).toBeGreaterThan(1500);
    expect(mid.cutoff).toBeLessThan(near.cutoff / 3);
    expect(far.cutoff).toBeLessThan(150);
    expect(far.duration).toBeGreaterThan(near.duration);
    // A sharp crack only from near, sharper from a strike to the ground.
    expect(near.crack).toBeGreaterThan(0.3);
    expect(near.bursts.length).toBeGreaterThanOrEqual(2);
    expect(near.bursts[0]).toBe(0);
    expect(mid.crack).toBe(0);
    expect(mid.bursts).toEqual([]);
    expect(thunderSound({ distance: CRACK_RANGE, energy: 1 })!.crack).toBe(0);
    const inCloud = thunderSound({ distance: 600, energy: 1, ground: false })!;
    expect(inCloud.crack).toBeCloseTo(near.crack / 2, 6);
    // A near strike hits at once; a far one swells.
    expect(near.swells[0]!.rise).toBeLessThan(0.1);
    expect(far.swells[0]!.rise).toBeGreaterThan(0.2);
  });

  it('is inaudible beyond about 25 km and for a strike of no energy', () => {
    expect(thunderSound({ distance: THUNDER_RANGE, energy: 1 })).toBeNull();
    expect(thunderSound({ distance: 40 * KM, energy: 1 })).toBeNull();
    expect(thunderSound({ distance: 1000, energy: 0 })).toBeNull();
    expect(thunderSound({ distance: Number.NaN, energy: 1 })).toBeNull();
    expect(thunderSound({ distance: 22 * KM, energy: 1 })?.gain ?? 0).toBeLessThan(0.02);
    // Stronger strikes are louder; the same strike always sounds the same.
    const weak = thunderSound({ distance: 3000, energy: 0.3, time: 5 })!;
    const strong = thunderSound({ distance: 3000, energy: 1, time: 5 })!;
    expect(strong.gain).toBeGreaterThan(weak.gain);
    expect(thunderSound({ distance: 3000, energy: 1, time: 5 })).toEqual(strong);
    expect(thunderSound({ distance: 3000, energy: 1, time: 6 })).not.toEqual(strong);
  });

  it('rolls: an envelope of several swells that ends in silence', () => {
    for (const distance of [300, 2500, 9000, 20_000]) {
      const sound = thunderSound({ distance, energy: 0.8, time: distance })!;
      expect(sound.swells.length).toBeGreaterThanOrEqual(3);
      const curve = thunderEnvelope(sound);
      expect(curve.length).toBe(Math.ceil(sound.duration * ENVELOPE_RATE) + 1);
      expect(curve[0]).toBe(0);
      expect(curve[curve.length - 1]).toBe(0);
      let peak = 0;
      let rises = 0;
      for (let i = 0; i < curve.length; i++) {
        expect(curve[i]).toBeGreaterThanOrEqual(0);
        expect(curve[i]).toBeLessThanOrEqual(1);
        peak = Math.max(peak, curve[i]!);
        if (i > 1 && curve[i]! > curve[i - 1]! && curve[i - 1]! <= curve[i - 2]!) rises++;
      }
      expect(peak).toBeGreaterThan(0.6);
      // It swells more than once.
      expect(rises).toBeGreaterThanOrEqual(2);
      // The loudest part comes early, the tail is quiet.
      const tail = curve.subarray(Math.floor(curve.length * 0.9));
      expect(Math.max(...tail)).toBeLessThan(0.35 * peak);
    }
  });
});

describe('ambienceMix', () => {
  it('is silent in calm, dry air', () => {
    const mix = ambienceMix({ rain: 0, snow: 0, dust: 0, wind: 2 });
    expect(mix.patter + mix.roar + mix.wind + mix.hiss).toBe(0);
  });

  it('goes from the patter of drizzle to the roar of a downpour', () => {
    const drizzle = ambienceMix({ rain: 0.2, snow: 0, dust: 0, wind: 0 });
    const rain = ambienceMix({ rain: 0.56, snow: 0, dust: 0, wind: 0 });
    const skyfall = ambienceMix({ rain: 1, snow: 0, dust: 0, wind: 0 });
    // Drizzle is mostly patter, high up; a downpour mostly roar, and louder by far.
    expect(drizzle.patter).toBeGreaterThan(3 * drizzle.roar);
    expect(skyfall.roar).toBeGreaterThan(3 * skyfall.patter);
    expect(rain.roar).toBeGreaterThan(drizzle.roar);
    expect(skyfall.roar).toBeGreaterThan(2.5 * rain.roar);
    expect(skyfall.patterFrequency).toBeLessThan(drizzle.patterFrequency);
    expect(skyfall.roarCutoff).toBeGreaterThan(drizzle.roarCutoff);
    const total = (m: typeof rain) => m.patter + m.roar;
    expect(total(drizzle)).toBeLessThan(total(rain));
    expect(total(rain)).toBeLessThan(total(skyfall));
    expect(total(skyfall)).toBeLessThan(1);
  });

  it('blows in storms, blizzards and dust', () => {
    const calm = ambienceMix({ rain: 0, snow: 0.5, dust: 0, wind: 3 });
    const gale = ambienceMix({ rain: 0, snow: 0.5, dust: 0, wind: 22 });
    expect(calm.wind).toBe(0);
    expect(gale.wind).toBeGreaterThan(0.2);
    expect(gale.windFrequency).toBeGreaterThan(calm.windFrequency);
    expect(gale.hiss).toBe(0);
    // Blowing sand hisses; dust hanging in still air does not.
    expect(ambienceMix({ rain: 0, snow: 0, dust: 0.9, wind: 22 }).hiss).toBeGreaterThan(0.04);
    expect(ambienceMix({ rain: 0, snow: 0, dust: 0.9, wind: 2 }).hiss).toBe(0);
  });
});

describe('WeatherAudio', () => {
  it('does nothing and never throws where there is no AudioContext', () => {
    // Node has none: the default factory finds nothing.
    const audio = new WeatherAudio();
    expect(audio.start()).toBe(false);
    expect(audio.started).toBe(false);
    audio.update({ rain: 1, snow: 0, dust: 0, wind: 20 });
    audio.thunder({ distance: 1000, energy: 1 });
    audio.suspend();
    audio.resume();
    audio.volume = 0.3;
    audio.muted = true;
    expect(audio.volume).toBe(0.3);
    expect(audio.attach()).toBeTypeOf('function');
    audio.dispose();
    // A factory that throws (a browser that refuses) is survived too, and not retried.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const broken = new WeatherAudio({
      createContext: () => {
        calls++;
        throw new Error('blocked');
      },
    });
    expect(broken.start()).toBe(false);
    expect(broken.start()).toBe(false);
    expect(calls).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('starts only on a user gesture', () => {
    const context = new StubContext();
    let created = 0;
    const audio = new WeatherAudio({
      createContext: () => {
        created++;
        return context as unknown as AudioContext;
      },
    });
    const target = new EventTarget();
    const detach = audio.attach(target);
    // Before any gesture: no context, and thunder is dropped, not queued.
    audio.thunder({ distance: 1000, energy: 1 });
    audio.update({ rain: 1, snow: 0, dust: 0, wind: 0 });
    expect(created).toBe(0);
    expect(audio.started).toBe(false);
    target.dispatchEvent(new Event('keydown'));
    expect(created).toBe(1);
    expect(audio.started).toBe(true);
    expect(context.state).toBe('running');
    // Only thunder since the start sounds: the ambience's four loops and nothing else so far.
    expect(context.sources.length).toBe(4);
    // Further gestures create nothing.
    target.dispatchEvent(new Event('pointerdown'));
    expect(created).toBe(1);
    detach();
    audio.dispose();
    expect(context.state).toBe('closed');
  });

  it('schedules thunder after the travel time, through a low-pass that falls with distance', () => {
    const { audio, context } = started();
    const before = context.sources.length;
    audio.thunder({ distance: 6 * KM, energy: 1, ground: true, time: 100 });
    // A distant strike: one rumble, no crack.
    expect(context.sources.length).toBe(before + 1);
    const rumble = context.sources[before]!;
    const arrival = context.currentTime + (6 * KM) / SPEED_OF_SOUND;
    expect(rumble.started![0]).toBeCloseTo(arrival, 6);
    expect(rumble.loop).toBe(true);
    expect(rumble.stopped).toBeGreaterThan(arrival + 3);
    const lowpass = rumble.outputs[0] as StubFilter;
    expect(lowpass.type).toBe('lowpass');
    const farCutoff = lowpass.frequency.value;
    const level = lowpass.outputs[0] as StubGain;
    const curve = level.gain.calls.find((c) => c.method === 'setValueCurveAtTime')!;
    expect(curve.args[1]).toBeCloseTo(arrival, 6);
    const farPeak = Math.max(...(curve.args[0] as Float32Array));
    // It ends up in the master gain, which feeds the destination.
    const master = level.outputs[0] as StubGain;
    expect(master.outputs).toContain(context.destination);

    // A near strike: a crack as well, at once almost, brighter and louder.
    audio.thunder({ distance: 500, energy: 1, ground: true, time: 101 });
    expect(context.sources.length).toBe(before + 3);
    const nearRumble = context.sources[before + 1]!;
    const crack = context.sources[before + 2]!;
    expect(nearRumble.started![0]).toBeCloseTo(context.currentTime + 500 / SPEED_OF_SOUND, 6);
    expect(crack.started![0]).toBeCloseTo(nearRumble.started![0]!, 6);
    const nearLowpass = nearRumble.outputs[0] as StubFilter;
    expect(nearLowpass.frequency.value).toBeGreaterThan(3 * farCutoff);
    const nearCurve = (nearLowpass.outputs[0] as StubGain).gain.calls.find(
      (c) => c.method === 'setValueCurveAtTime',
    )!;
    expect(Math.max(...(nearCurve.args[0] as Float32Array))).toBeGreaterThan(3 * farPeak);
    expect((crack.outputs[0] as StubFilter).type).toBe('bandpass');

    // Beyond hearing: nothing is created.
    audio.thunder({ distance: 30 * KM, energy: 1 });
    expect(context.sources.length).toBe(before + 3);
    audio.dispose();
  });

  it('limits the thunders sounding at once', () => {
    const { audio, context } = started();
    const before = context.sources.length;
    for (let k = 0; k < MAX_THUNDERS + 5; k++) {
      audio.thunder({ distance: 8 * KM, energy: 0.5, time: k });
    }
    expect(context.sources.length).toBe(before + MAX_THUNDERS);
    // A louder one still gets through; once the others have ended, so does any.
    audio.thunder({ distance: 5 * KM, energy: 1, time: 50 });
    expect(context.sources.length).toBe(before + MAX_THUNDERS + 1);
    context.currentTime += 120;
    audio.thunder({ distance: 8 * KM, energy: 0.5, time: 60 });
    expect(context.sources.length).toBe(before + MAX_THUNDERS + 2);
    audio.dispose();
  });

  it('follows the weather with the ambience', () => {
    const { audio, context } = started();
    // Master first, then patter, roar, wind and hiss, then the gusts.
    const [master, patter, roar, wind, hiss] = context.gains;
    expect(master!.gain.value).toBeCloseTo(0.8, 6);
    for (const g of [patter!, roar!, wind!, hiss!]) expect(g.gain.value).toBe(0);
    expect(context.sources.every((s) => s.loop && s.started !== null)).toBe(true);
    expect(context.oscillators.length).toBe(2);

    audio.update({ rain: 0.2, snow: 0, dust: 0, wind: 0 });
    const drizzle = { patter: patter!.gain.target, roar: roar!.gain.target };
    audio.update({ rain: 1, snow: 0, dust: 0, wind: 25 });
    expect(roar!.gain.target).toBeGreaterThan(10 * drizzle.roar);
    expect(patter!.gain.target).toBeGreaterThan(drizzle.patter);
    expect(wind!.gain.target).toBeGreaterThan(0.2);
    expect(hiss!.gain.target).toBe(0);
    // Changes are eased, never set in a step.
    expect(roar!.gain.calls.every((c) => c.method === 'setTargetAtTime')).toBe(true);
    audio.update({ rain: 0, snow: 0, dust: 0, wind: 0 });
    for (const g of [patter!, roar!, wind!, hiss!]) expect(g.gain.target).toBe(0);
    audio.dispose();
    expect(context.sources.every((s) => s.stopped !== null)).toBe(true);
  });

  it('has a master volume, a mute switch, and suspends and resumes', () => {
    const { audio, context } = started();
    const master = context.gains[0]!;
    audio.volume = 0.4;
    expect(master.gain.target).toBeCloseTo(0.4, 6);
    audio.volume = 7;
    expect(audio.volume).toBe(1);
    audio.volume = Number.NaN;
    expect(audio.volume).toBe(0);
    audio.volume = 0.5;
    audio.muted = true;
    expect(master.gain.target).toBe(0);
    expect(audio.volume).toBe(0.5);
    audio.muted = false;
    expect(master.gain.target).toBeCloseTo(0.5, 6);

    expect(context.state).toBe('running');
    audio.suspend();
    expect(context.state).toBe('suspended');
    // A gesture while paused does not start the sound again.
    expect(audio.start()).toBe(true);
    expect(context.state).toBe('suspended');
    audio.resume();
    expect(context.state).toBe('running');
    audio.dispose();

    // Suspended before the first gesture: the context starts suspended.
    const later = new StubContext();
    later.state = 'running';
    const paused = new WeatherAudio({ createContext: () => later as unknown as AudioContext });
    paused.suspend();
    paused.start();
    expect(later.state).toBe('suspended');
  });
});

describe('fillNoise', () => {
  it('fills a loop of bounded noise that is the same every time', () => {
    for (const kind of ['white', 'brown'] as const) {
      const a = new Float32Array(16_000);
      const b = new Float32Array(16_000);
      fillNoise(a, kind, 3);
      fillNoise(b, kind, 3);
      expect(b).toEqual(a);
      let peak = 0;
      let power = 0;
      for (const x of a) {
        peak = Math.max(peak, Math.abs(x));
        power += x * x;
      }
      expect(peak).toBeLessThanOrEqual(1);
      expect(Math.sqrt(power / a.length)).toBeGreaterThan(0.05);
      // The loop closes: its end runs into its beginning.
      expect(Math.abs(a[a.length - 1]! - a[0]!)).toBeLessThan(0.6);
    }
    // Brown noise is low: neighboring samples are close.
    const brown = new Float32Array(16_000);
    fillNoise(brown, 'brown');
    let step = 0;
    for (let i = 1; i < brown.length; i++)
      step = Math.max(step, Math.abs(brown[i]! - brown[i - 1]!));
    expect(step).toBeLessThan(0.1);
  });
});
