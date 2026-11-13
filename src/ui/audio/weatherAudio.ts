/**
 * The weather's sound: thunder (thunder.ts) and the ambience of rain and
 * wind (ambience.ts), behind one small object the app holds.
 *
 *     const audio = new WeatherAudio();
 *     audio.attach();                         // starts on the first key or pointer event
 *     scene.lightning.onThunder = (e) => audio.thunder(e);
 *     // each frame:
 *     audio.update({ rain, snow, dust, wind });
 *     // on pause and resume, and from the menu:
 *     audio.suspend(); audio.resume(); audio.volume = 0.6; audio.muted = true;
 *
 * A browser lets an AudioContext sound only after a user gesture, so nothing
 * is created before `start()` is called from one (`attach` listens for the
 * first key or pointer event and calls it). Until then, and wherever there
 * is no AudioContext at all (Node: tests and previews), every method does
 * nothing and nothing throws. Thunder that would arrive before the audio has
 * started is dropped, not queued: a storm heard a minute late is worse than
 * one not heard.
 *
 * The thunder's delay is real time: the sound of a strike 5 km away arrives
 * 14.6 s after the flash on the context's clock, which stops while the
 * context is suspended, so a paused game holds its thunder back.
 */
import { Ambience } from './ambience';
import type { AmbienceLevels } from './ambience';
import { playThunder, sequence, thunderSound } from './thunder';
import type { ThunderNoise, ThunderStrike } from './thunder';

/** Thunders that may sound at once; a further one replaces nothing and is dropped unless louder. */
export const MAX_THUNDERS = 6;
/** Length of the noise loops (s). */
const NOISE_SECONDS = 4;

export interface WeatherAudioOptions {
  /** Creates the context (tests pass a stub); default: the browser's AudioContext, if there is one. */
  createContext?: () => AudioContext | null;
  /** Master volume 0..1 (default 0.8). */
  volume?: number;
}

/** Fills a buffer with white or brown noise from a fixed sequence, ending where it begins. */
export function fillNoise(data: Float32Array, kind: 'white' | 'brown', seed = 1): void {
  const next = sequence(seed);
  let level = 0;
  for (let i = 0; i < data.length; i++) {
    const white = next() * 2 - 1;
    if (kind === 'white') {
      data[i] = white * 0.7;
    } else {
      // A leaky integrator: −6 dB per octave above a few tens of hertz.
      level = (level + 0.02 * white) / 1.02;
      data[i] = level * 3.5;
    }
  }
  // Cross-fade the end into the beginning, so the loop has no click.
  const blend = Math.min(2048, data.length >> 2);
  for (let i = 0; i < blend; i++) {
    const t = i / blend;
    const j = data.length - blend + i;
    data[j] = data[j]! * (1 - t) + data[i]! * t;
  }
}

function defaultContext(): AudioContext | null {
  const scope = globalThis as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  return Constructor ? new Constructor() : null;
}

export class WeatherAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: ThunderNoise | null = null;
  private ambience: Ambience | null = null;
  /** The context's end times and loudness of the thunders sounding or on their way. */
  private thunders: { end: number; gain: number }[] = [];
  private level: number;
  private mute = false;
  private paused = false;
  private failed = false;
  private readonly createContext: () => AudioContext | null;

  constructor(options: WeatherAudioOptions = {}) {
    this.createContext = options.createContext ?? defaultContext;
    this.level = Math.min(1, Math.max(0, options.volume ?? 0.8));
  }

  /** True once the audio has started (a context exists). */
  get started(): boolean {
    return this.context !== null;
  }

  /** Master volume 0..1. */
  get volume(): number {
    return this.level;
  }

  set volume(value: number) {
    this.level = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    this.applyVolume();
  }

  /** Silences everything without stopping it. */
  get muted(): boolean {
    return this.mute;
  }

  set muted(on: boolean) {
    this.mute = on;
    this.applyVolume();
  }

  private applyVolume(): void {
    if (!this.context || !this.master) return;
    this.master.gain.setTargetAtTime(this.mute ? 0 : this.level, this.context.currentTime, 0.03);
  }

  /**
   * Starts the audio on the first key or pointer event on `target` (default:
   * the window). Returns a function that stops listening. Does nothing where
   * there is no window.
   */
  attach(target?: EventTarget): () => void {
    const t = target ?? (typeof window !== 'undefined' ? window : null);
    if (!t) return () => {};
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const detach = () => {
      for (const e of events) t.removeEventListener(e, onGesture);
    };
    const onGesture = () => {
      // A context that could not start is not tried again on every key.
      if (this.start() || this.failed) detach();
    };
    for (const e of events) t.addEventListener(e, onGesture, { passive: true });
    return detach;
  }

  /**
   * Creates the context, or resumes it; call from a user gesture. Returns
   * whether the audio is started. Never throws.
   */
  start(): boolean {
    if (this.context) {
      if (!this.paused && this.context.state === 'suspended')
        void this.settle(this.context.resume());
      return true;
    }
    if (this.failed) return false;
    try {
      const context = this.createContext();
      if (!context) {
        this.failed = true;
        return false;
      }
      const master = context.createGain();
      master.gain.value = this.mute ? 0 : this.level;
      master.connect(context.destination);
      const length = Math.round(NOISE_SECONDS * context.sampleRate);
      const white = context.createBuffer(1, length, context.sampleRate);
      const brown = context.createBuffer(1, length, context.sampleRate);
      fillNoise(white.getChannelData(0), 'white', 11);
      fillNoise(brown.getChannelData(0), 'brown', 23);
      this.noise = { white, brown };
      this.ambience = new Ambience(context, master, this.noise);
      this.context = context;
      this.master = master;
      if (this.paused) void this.settle(context.suspend());
      else if (context.state === 'suspended') void this.settle(context.resume());
      return true;
    } catch (error) {
      console.warn('Audio is unavailable.', error);
      this.failed = true;
      this.context = null;
      return false;
    }
  }

  /** A promise from the context, with its rejection swallowed (a closed or blocked context). */
  private settle(promise: Promise<void> | undefined): Promise<void> {
    return Promise.resolve(promise).catch(() => {});
  }

  /** Pauses all sound, thunder on its way included (the game is paused). */
  suspend(): void {
    this.paused = true;
    if (this.context?.state === 'running') void this.settle(this.context.suspend());
  }

  /** Carries on after `suspend`. */
  resume(): void {
    this.paused = false;
    if (this.context?.state === 'suspended') void this.settle(this.context.resume());
  }

  /** Sets the ambience for the weather at the camera; call every frame or so. */
  update(levels: AmbienceLevels): void {
    this.ambience?.set(levels);
  }

  /** Schedules the thunder of a strike: it sounds after the sound's travel time. */
  thunder(strike: ThunderStrike): void {
    const context = this.context;
    if (!context || !this.master || !this.noise) return;
    const sound = thunderSound(strike);
    if (!sound) return;
    const now = context.currentTime;
    this.thunders = this.thunders.filter((t) => t.end > now);
    if (this.thunders.length >= MAX_THUNDERS && this.thunders.every((t) => t.gain >= sound.gain)) {
      return;
    }
    try {
      const end = playThunder(context, this.master, this.noise, sound, now + sound.delay);
      this.thunders.push({ end, gain: sound.gain });
    } catch (error) {
      console.warn('Thunder could not be played.', error);
    }
  }

  /** Stops everything and closes the context. */
  dispose(): void {
    this.ambience?.dispose();
    this.ambience = null;
    this.master?.disconnect();
    this.master = null;
    if (this.context) void this.settle(this.context.close());
    this.context = null;
    this.noise = null;
    this.thunders = [];
  }
}
