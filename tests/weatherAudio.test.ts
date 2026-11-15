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

class StubCompressor extends StubNode {
  readonly threshold = new StubParam();
  readonly knee = new StubParam();
  readonly ratio = new StubParam();
  readonly attack = new StubParam();
  readonly release = new StubParam();
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
  readonly compressors: StubCompressor[] = [];
  createDynamicsCompressor() {
    const c = new StubCompressor('compressor');
    this.compressors.push(c);
    return c;
  }
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
    // It ends up, through a gain of its own, in the master gain, which feeds the destination
    // through the limiter.
    const bus = level.outputs[0] as StubGain;
    expect(bus.gain.value).toBe(1);
    const master = bus.outputs[0] as StubGain;
    expect(master).toBe(context.gains[0]);
    const limiter = context.compressors[0]!;
    expect(master.outputs).toEqual([limiter]);
    expect(limiter.outputs).toEqual([context.destination]);
    expect(limiter.threshold.value).toBeLessThan(0);
    expect(limiter.ratio.value).toBeGreaterThan(4);

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

  it('takes back the thunder that is on its way', () => {
    const { audio, context } = started();
    const before = context.sources.length;
    // A strike 22 km away: its thunder is due 64 s from now. Then the view is cut.
    audio.thunder({ distance: 22 * KM, energy: 1, time: 1 });
    audio.thunder({ distance: 9 * KM, energy: 1, time: 2 });
    const buses = [before, before + 1].map((i) => {
      const lowpass = context.sources[i]!.outputs[0] as StubFilter;
      return (lowpass.outputs[0] as StubGain).outputs[0] as StubGain;
    });
    expect(context.sources[before]!.started![0]).toBeGreaterThan(context.currentTime + 60);
    for (const bus of buses) expect(bus.gain.calls).toEqual([]);
    audio.cancelThunder();
    for (const bus of buses) {
      const fade = bus.gain.calls[bus.gain.calls.length - 1]!;
      expect(fade.method).toBe('setTargetAtTime');
      expect(fade.args[0]).toBe(0);
      expect(fade.args[1]).toBe(context.currentTime);
      expect(fade.args[2]).toBeLessThan(0.2);
    }
    // Thunder after the cut sounds as ever, and the cancelled ones no longer count.
    for (let k = 0; k < MAX_THUNDERS; k++)
      audio.thunder({ distance: 8 * KM, energy: 0.5, time: k });
    expect(context.sources.length).toBe(before + 2 + MAX_THUNDERS);
    const fresh = context.sources[before + 2]!.outputs[0] as StubFilter;
    expect(((fresh.outputs[0] as StubGain).outputs[0] as StubGain).gain.calls).toEqual([]);
    audio.cancelThunder();
    audio.dispose();
    // Without a context: nothing, and nothing throws.
    new WeatherAudio().cancelThunder();
  });

  it('keeps listening until the context runs: a finger going down is no gesture', async () => {
    // A browser that starts audio only inside a user activation: a key or a mouse button
    // going down, a finger lifting (pointerup, touchend, click), not a finger going down.
    const context = new StubContext();
    let activation = false;
    context.resume = () => {
      if (activation) context.state = 'running';
      return Promise.resolve();
    };
    const audio = new WeatherAudio({ createContext: () => context as unknown as AudioContext });
    const target = new EventTarget();
    const removed: string[] = [];
    const remove = target.removeEventListener.bind(target);
    target.removeEventListener = (type: string, ...rest: [EventListener]) => {
      removed.push(type);
      remove(type, ...rest);
    };
    audio.attach(target);
    // The finger touches: the context is made, cannot run yet, and the listeners stay.
    target.dispatchEvent(new Event('pointerdown'));
    await Promise.resolve();
    expect(audio.started).toBe(true);
    expect(context.state).toBe('suspended');
    expect(removed).toEqual([]);
    // It lifts: that is the gesture.
    activation = true;
    target.dispatchEvent(new Event('pointerup'));
    expect(context.state).toBe('running');
    expect(removed).toContain('pointerup');
    expect(removed).toContain('touchend');
    expect(removed).toContain('click');
    expect(removed).toContain('keydown');
    audio.dispose();
  });

  it('starts from the first gesture even while paused, and is silent again at once', async () => {
    // The campaign starts paused. A context that has never run cannot be resumed later from
    // the frame loop in a browser that asks for a gesture: the gesture runs it once.
    const context = new StubContext();
    const audio = new WeatherAudio({ createContext: () => context as unknown as AudioContext });
    const target = new EventTarget();
    audio.attach(target);
    audio.suspend();
    let resumed = 0;
    const resume = context.resume.bind(context);
    context.resume = () => {
      resumed++;
      return resume();
    };
    target.dispatchEvent(new Event('click'));
    expect(resumed).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(context.state).toBe('suspended');
    // Having run, it is not started again by gestures while paused, and resumes when asked.
    target.dispatchEvent(new Event('keydown'));
    audio.start();
    expect(resumed).toBe(1);
    expect(context.state).toBe('suspended');
    audio.resume();
    expect(context.state).toBe('running');
    audio.dispose();
  });

  it('starts from a lifting finger also after the frame loop has paused it', async () => {
    // A touch device with the campaign paused, as it starts: the finger going down makes the
    // context, which cannot run yet; the next frame finds the game paused and suspends the
    // audio; then the finger lifts. That gesture must run the context once, paused or not, or
    // no later resume from the frame loop can start it.
    const context = new StubContext();
    let gesture = false;
    let hasRun = false;
    context.resume = () => {
      // Outside a gesture a browser resumes only a context that has run before.
      if (gesture || hasRun) {
        context.state = 'running';
        hasRun = true;
      }
      return Promise.resolve();
    };
    const audio = new WeatherAudio({ createContext: () => context as unknown as AudioContext });
    const target = new EventTarget();
    audio.attach(target);
    target.dispatchEvent(new Event('pointerdown'));
    expect(audio.started).toBe(true);
    expect(context.state).toBe('suspended');
    audio.suspend();
    gesture = true;
    target.dispatchEvent(new Event('pointerup'));
    gesture = false;
    expect(hasRun).toBe(true);
    // Paused still: silent again at once.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(context.state).toBe('suspended');
    // The game runs on: the frame loop resumes the audio, outside any gesture.
    audio.resume();
    expect(context.state).toBe('running');
    audio.dispose();
  });

  it('lets the volume be heard, also while paused', async () => {
    vi.useFakeTimers();
    try {
      const { audio, context } = started();
      const master = context.gains[0]!;
      audio.volume = 0.3;
      // Running: a short tone through the master gain, and no more than one at a time.
      audio.audition();
      audio.audition();
      expect(context.oscillators.filter((o) => o.frequency.value === 660).length).toBe(1);
      const tone = context.oscillators.find((o) => o.frequency.value === 660)!;
      expect(tone.started![0]).toBe(context.currentTime);
      expect(tone.stopped).toBeLessThan(context.currentTime + 1);
      const shape = tone.outputs[0] as StubGain;
      expect(shape.outputs).toEqual([master]);
      expect(master.gain.target).toBeCloseTo(0.3, 6);
      expect(context.state).toBe('running');
      // Paused: the context runs for a moment, so the tone and the rain are heard at the new
      // volume, and is suspended again.
      audio.suspend();
      expect(context.state).toBe('suspended');
      context.currentTime += 1;
      audio.volume = 0.6;
      audio.audition();
      expect(context.state).toBe('running');
      expect(context.oscillators.filter((o) => o.frequency.value === 660).length).toBe(2);
      // The slider moves on: the moment is counted from the last move.
      context.currentTime += 0.8;
      vi.advanceTimersByTime(800);
      audio.audition();
      context.currentTime += 0.8;
      vi.advanceTimersByTime(800);
      expect(context.state).toBe('running');
      context.currentTime += 0.5;
      vi.advanceTimersByTime(500);
      expect(context.state).toBe('suspended');
      // Resumed in the middle of it: the timer leaves the running context alone.
      audio.audition();
      audio.resume();
      context.currentTime += 2;
      vi.advanceTimersByTime(2000);
      expect(context.state).toBe('running');
      audio.dispose();
      new WeatherAudio().audition();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends the moment of sound while paused also where the context is slow to start', async () => {
    // The moment is counted on the context's clock, and that clock stands until the context
    // runs. A context that took a third of a second to resume (a wireless output, a sleeping
    // audio device) was found short of its time when the timer came, and then ran on through
    // the whole pause: rain, wind and the thunder on its way under the pause menu.
    vi.useFakeTimers();
    try {
      const { audio, context } = started();
      audio.suspend();
      expect(context.state).toBe('suspended');
      context.resume = () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            context.state = 'running';
            resolve();
          }, 300);
        });
      /** Lets `seconds` pass on the wall clock, and on the context's while it runs. */
      const pass = async (seconds: number) => {
        for (let t = 0; t < seconds - 1e-9; t += 0.05) {
          await vi.advanceTimersByTimeAsync(50);
          if (context.state === 'running') context.currentTime += 0.05;
        }
      };
      audio.audition();
      await pass(0.4);
      expect(context.state).toBe('running');
      // Heard for about a second from when it started, then silent again, and it stays so.
      await pass(0.7);
      expect(context.state).toBe('running');
      await pass(0.6);
      expect(context.state).toBe('suspended');
      await pass(5);
      expect(context.state).toBe('suspended');
      // A move of the slider near the end of the moment still extends it.
      audio.audition();
      await pass(1.5);
      audio.audition();
      await pass(0.6);
      expect(context.state).toBe('running');
      await pass(1.2);
      expect(context.state).toBe('suspended');
      // Unpaused meanwhile: the timer leaves the running context alone.
      audio.audition();
      await pass(0.5);
      audio.resume();
      await pass(3);
      expect(context.state).toBe('running');
      audio.dispose();
      await pass(3);
    } finally {
      vi.useRealTimers();
    }
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
    // Steady weather schedules nothing more, however often it is reported.
    const scheduled = roar!.gain.calls.length + wind!.gain.calls.length;
    for (let i = 0; i < 100; i++) audio.update({ rain: 1, snow: 0, dust: 0, wind: 25 });
    expect(roar!.gain.calls.length + wind!.gain.calls.length).toBe(scheduled);
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

    // A context without a compressor (an old browser): the master feeds the destination itself.
    const plain = new StubContext();
    (plain as { createDynamicsCompressor?: unknown }).createDynamicsCompressor = undefined;
    const bare = new WeatherAudio({ createContext: () => plain as unknown as AudioContext });
    expect(bare.start()).toBe(true);
    expect(plain.gains[0]!.outputs).toEqual([plain.destination]);
    bare.dispose();

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
