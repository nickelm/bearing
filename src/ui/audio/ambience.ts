/**
 * Weather ambience, synthesized from two loops of noise (no sound files,
 * decision 40): rain and wind that follow the weather at the camera.
 *
 * - **Rain** is two bands. The patter of drizzle is a thin band of white
 *   noise high up (single drops on surfaces); as the rain grows, a broad
 *   low roar comes in under it and takes over, and the patter's band moves
 *   down: a downpour is a wall of sound.
 * - **Wind** is band-passed noise whose loudness and pitch rise with the wind
 *   speed, from about 6 m/s, and which two slow oscillators make gust. Snow
 *   and dust make no sound of their own, but a blizzard and a dust storm are
 *   windy, and blowing sand adds a high hiss.
 *
 * `ambienceMix` is the pure part: the gains and filter frequencies for a set
 * of levels. `Ambience` holds the graph and eases its parameters toward the
 * mix, so nothing clicks when the weather changes.
 */
import type { MetersPerSecond, Seconds } from '../../core/units';

/** The weather at the listener. */
export interface AmbienceLevels {
  /** Rain intensity 0..1 (weatherState.ts scale), where the camera is. */
  rain: number;
  /** Snowfall intensity 0..1. */
  snow: number;
  /** Dust in the air 0..1. */
  dust: number;
  /** Wind speed (m/s). */
  wind: MetersPerSecond;
}

/** Gains (0..1) and filter frequencies (Hz) of the ambience for a set of levels. */
export interface AmbienceMix {
  patter: number;
  patterFrequency: number;
  roar: number;
  roarCutoff: number;
  wind: number;
  windFrequency: number;
  hiss: number;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The ambience for a set of levels: silence in calm, dry air. */
export function ambienceMix(levels: AmbienceLevels): AmbienceMix {
  const rain = Math.min(1, Math.max(0, levels.rain));
  const dust = Math.min(1, Math.max(0, levels.dust));
  const wind = Math.max(0, levels.wind);
  const blow = smooth(6, 30, wind);
  return {
    patter: 0.05 * smooth(0, 0.25, rain) + 0.07 * rain,
    patterFrequency: 4200 - 2200 * rain,
    roar: 0.55 * Math.pow(rain, 2.2),
    roarCutoff: 500 + 1300 * rain,
    wind: 0.42 * blow,
    windFrequency: 170 + 16 * Math.min(40, wind),
    hiss: 0.07 * dust * smooth(6, 20, wind),
  };
}

/** Time constant with which the graph follows the mix (s). */
const EASE: Seconds = 0.4;

export class Ambience {
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly oscillators: OscillatorNode[] = [];
  private readonly patter: GainNode;
  private readonly patterBand: BiquadFilterNode;
  private readonly roar: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly wind: GainNode;
  private readonly windBand: BiquadFilterNode;
  private readonly hiss: GainNode;

  constructor(
    private readonly context: BaseAudioContext,
    destination: AudioNode,
    noise: { white: AudioBuffer; brown: AudioBuffer },
  ) {
    const loop = (buffer: AudioBuffer, offset: number) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.start(0, offset);
      this.sources.push(source);
      return source;
    };
    const chain = (source: AudioNode, type: BiquadFilterType, frequency: number, q: number) => {
      const filter = context.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = context.createGain();
      gain.gain.value = 0;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      return { filter, gain };
    };
    const white = loop(noise.white, 0);
    // A second reading of the same loop, so that the bands do not move together.
    const white2 = loop(noise.white, noise.white.duration * 0.37);
    const brown = loop(noise.brown, 0);
    const brown2 = loop(noise.brown, noise.brown.duration * 0.53);
    ({ filter: this.patterBand, gain: this.patter } = chain(white, 'bandpass', 4000, 0.6));
    ({ filter: this.roarFilter, gain: this.roar } = chain(brown, 'lowpass', 900, 0.5));
    ({ filter: this.windBand, gain: this.wind } = chain(brown2, 'bandpass', 250, 1.1));
    ({ gain: this.hiss } = chain(white2, 'highpass', 4500, 0.5));

    // Gusts: two slow oscillators swell the wind by up to half its level.
    const gust = context.createGain();
    gust.gain.value = 1;
    this.wind.disconnect();
    this.wind.connect(gust);
    gust.connect(destination);
    for (const [frequency, depth] of [
      [0.13, 0.3],
      [0.31, 0.2],
    ] as const) {
      const oscillator = context.createOscillator();
      oscillator.frequency.value = frequency;
      const amount = context.createGain();
      amount.gain.value = depth;
      oscillator.connect(amount);
      amount.connect(gust.gain);
      oscillator.start();
      this.oscillators.push(oscillator);
    }
  }

  /** Eases the graph toward the ambience of the levels. */
  set(levels: AmbienceLevels): void {
    const mix = ambienceMix(levels);
    const now = this.context.currentTime;
    const ease = (param: AudioParam, value: number) => param.setTargetAtTime(value, now, EASE);
    ease(this.patter.gain, mix.patter);
    ease(this.patterBand.frequency, mix.patterFrequency);
    ease(this.roar.gain, mix.roar);
    ease(this.roarFilter.frequency, mix.roarCutoff);
    ease(this.wind.gain, mix.wind);
    ease(this.windBand.frequency, mix.windFrequency);
    ease(this.hiss.gain, mix.hiss);
  }

  dispose(): void {
    for (const s of this.sources) s.stop();
    for (const o of this.oscillators) o.stop();
    for (const node of [this.patter, this.roar, this.wind, this.hiss]) node.disconnect();
  }
}
