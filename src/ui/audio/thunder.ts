/**
 * Thunder, synthesized: no sound files (static hosting, decision 40).
 *
 * A strike's sound is made of filtered noise:
 *
 * - a **rumble**: brown noise through a low-pass filter, shaped by an
 *   envelope of several overlapping swells that die away, which is what the
 *   echoes of a channel kilometers long sound like;
 * - a **crack** for a strike within about 4 km: a few very short bursts of
 *   band-passed white noise at the start, sharpest for a strike to the ground.
 *
 * Distance does three things. The sound arrives `distance / 343 m/s` after
 * the flash; it is quieter (`thunderSound` gives the gain: full nearby, a
 * fifth at 5 km, nothing from 25 km); and it is duller and longer, because
 * air takes the high frequencies first and the far end of the channel is
 * heard later: the low-pass falls from about 2 kHz to little over 100 Hz.
 *
 * `thunderSound` and `thunderEnvelope` are pure, so tests can check them;
 * `playThunder` builds the audio graph for one strike.
 */
import type { Meters, Seconds } from '../../core/units';
import { KM } from '../../core/units';

/** Speed of sound in air (m/s). */
export const SPEED_OF_SOUND = 343;
/** Thunder is not heard from farther than this (m). */
export const THUNDER_RANGE: Meters = 25 * KM;
/** A crack is heard within this distance (m). */
export const CRACK_RANGE: Meters = 4 * KM;
/** Samples per second of a rumble's envelope curve. */
export const ENVELOPE_RATE = 50;

/** A strike as the audio hears of it (weather/lightning.ts `ThunderEvent`). */
export interface ThunderStrike {
  /** From the listener to the discharge (m). */
  distance: Meters;
  /** Strength 0..1. */
  energy: number;
  /** Game time of the strike; only varies the sound. */
  time?: number;
  /** A strike to the ground: a sharper crack. */
  ground?: boolean;
}

/** One swell of a rumble. */
export interface Swell {
  /** Start after the sound's arrival (s). */
  at: Seconds;
  /** Peak 0..1. */
  gain: number;
  /** Time to the peak, and time in which it then falls to 1/e (s). */
  rise: Seconds;
  decay: Seconds;
}

/** What a strike sounds like at the listener. */
export interface ThunderSound {
  /** Seconds after the flash at which the sound arrives. */
  delay: Seconds;
  /** Loudness of the rumble 0..1. */
  gain: number;
  /** Cutoff of the rumble's low-pass filter (Hz). */
  cutoff: number;
  /** Length of the rumble (s). */
  duration: Seconds;
  swells: Swell[];
  /** Loudness of the crack 0..1 (0 for none), its center frequency (Hz) and its bursts' start times (s). */
  crack: number;
  crackFrequency: number;
  bursts: Seconds[];
}

/** A repeatable sequence of uniform numbers in [0, 1) (thunder has no need of real chance). */
export function sequence(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The sound of a strike, or null if it is too far or too weak to hear. */
export function thunderSound(strike: ThunderStrike): ThunderSound | null {
  const distance = Math.max(0, strike.distance);
  if (!(distance < THUNDER_RANGE) || !(strike.energy > 0)) return null;
  const energy = Math.min(1, strike.energy);
  // Spreading and the air's absorption, then silence toward the limit of hearing.
  const gain =
    Math.pow(energy, 0.7) *
    (1500 / (1500 + distance)) *
    (1 - smooth(0.6, 1, distance / THUNDER_RANGE));
  if (gain < 0.004) return null;
  const next = sequence(Math.round((strike.time ?? 0) * 1000) ^ Math.round(distance * 7));
  const duration = Math.min(14, 3.5 + distance / 2500 + 3 * energy);
  const far = Math.min(1, distance / (8 * KM));
  const count = 3 + Math.floor(next() * 4);
  const swells: Swell[] = [];
  for (let k = 0; k < count; k++) {
    // The first swell comes with the sound's arrival; the others roll in behind it.
    const at = k === 0 ? 0 : next() * 0.65 * duration;
    swells.push({
      at,
      gain: (k === 0 ? 1 : 0.35 + 0.65 * next()) / (1 + (2.2 * at) / duration),
      // A near strike hits at once; a far one swells.
      rise: 0.02 + far * (0.25 + 0.5 * next()),
      decay: 0.5 + 1.1 * next() + 0.6 * far,
    });
  }
  swells.sort((a, b) => a.at - b.at);
  const near = Math.max(0, 1 - distance / CRACK_RANGE);
  const crack = gain * Math.pow(near, 1.5) * (strike.ground === false ? 0.5 : 1);
  const bursts: Seconds[] = [];
  if (crack > 0) {
    let at = 0;
    const tears = 2 + Math.floor(next() * 3);
    for (let k = 0; k < tears; k++) {
      bursts.push(at);
      at += 0.03 + 0.08 * next();
    }
  }
  return {
    delay: distance / SPEED_OF_SOUND,
    gain,
    cutoff: 110 + 2100 * Math.exp(-distance / 3000),
    duration,
    swells,
    crack,
    crackFrequency: 2400 + 1600 * next(),
    bursts,
  };
}

/**
 * A rumble's loudness over its duration, 0..1, sampled ENVELOPE_RATE times a
 * second: the loudest of its swells at each moment, faded to silence over
 * the last fifth.
 */
export function thunderEnvelope(sound: ThunderSound): Float32Array {
  const n = Math.max(2, Math.ceil(sound.duration * ENVELOPE_RATE) + 1);
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / ENVELOPE_RATE;
    let level = 0;
    for (const s of sound.swells) {
      const u = t - s.at;
      if (u < 0) continue;
      const shape = u < s.rise ? u / s.rise : Math.exp(-(u - s.rise) / s.decay);
      level = Math.max(level, s.gain * shape);
    }
    curve[i] = level * (1 - smooth(0.8, 1, t / sound.duration));
  }
  curve[n - 1] = 0;
  return curve;
}

/** The noise a thunder is made from. */
export interface ThunderNoise {
  white: AudioBuffer;
  brown: AudioBuffer;
}

/**
 * Builds the graph of one thunder and starts it at `when` (the context's
 * time at which the sound arrives). Returns the context's time at which it
 * has ended; the nodes stop themselves then.
 */
export function playThunder(
  context: BaseAudioContext,
  destination: AudioNode,
  noise: ThunderNoise,
  sound: ThunderSound,
  when: number,
): number {
  const next = sequence(Math.round(sound.delay * 1e4) + sound.swells.length);
  const end = when + sound.duration;

  const rumble = context.createBufferSource();
  rumble.buffer = noise.brown;
  rumble.loop = true;
  const lowpass = context.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = sound.cutoff;
  lowpass.Q.value = 0.6;
  const level = context.createGain();
  level.gain.value = 0;
  const curve = thunderEnvelope(sound);
  // Brown noise is quiet in what a low-pass leaves of it: the gain makes up for that.
  for (let i = 0; i < curve.length; i++) curve[i] = curve[i]! * sound.gain * 3;
  level.gain.setValueCurveAtTime(curve, when, sound.duration);
  rumble.connect(lowpass);
  lowpass.connect(level);
  level.connect(destination);
  rumble.start(when, next() * Math.max(0, noise.brown.duration - 0.1));
  rumble.stop(end + 0.05);

  if (sound.crack > 0) {
    const tear = context.createBufferSource();
    tear.buffer = noise.white;
    tear.loop = true;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = sound.crackFrequency;
    band.Q.value = 0.7;
    const snap = context.createGain();
    snap.gain.value = 0;
    snap.gain.setValueAtTime(0, when);
    for (const at of sound.bursts) {
      // Each burst: up in a few milliseconds, gone in a few tens.
      const t = when + at;
      snap.gain.setTargetAtTime(sound.crack * 1.4, t, 0.002);
      snap.gain.setTargetAtTime(0, t + 0.012, 0.02 + 0.03 * next());
    }
    const last = when + (sound.bursts[sound.bursts.length - 1] ?? 0);
    tear.connect(band);
    band.connect(snap);
    snap.connect(destination);
    tear.start(when, next() * Math.max(0, noise.white.duration - 0.1));
    tear.stop(last + 0.6);
  }
  return end;
}
