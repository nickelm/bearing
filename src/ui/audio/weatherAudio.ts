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
 *     audio.audition();                       // the volume slider, heard while paused
 *     // on a cut (another view, weather, flight or time):
 *     audio.cancelThunder();
 *
 * A browser lets an AudioContext sound only after a user gesture, so nothing
 * is created before `start()` is called from one (`attach` listens for keys,
 * pointers and clicks and calls it). Which event counts as a gesture differs:
 * a key or a mouse button going down does, a finger only when it lifts. So
 * `attach` keeps listening until the context has run, and the first gesture
 * that can start it does so even while the audio is suspended (it is
 * suspended again at once): a context that has run once may be resumed later
 * from the frame loop. Until then, and wherever there is no AudioContext at
 * all (Node: tests and previews), every method does nothing and nothing
 * throws. Thunder that would arrive before the audio has started is dropped,
 * not queued: a storm heard a minute late is worse than one not heard.
 *
 * Everything goes through one master gain (`volume`, `muted`) and a limiter,
 * so a near strike over a downpour does not clip.
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
/** How long a suspended context runs for an audition (s), and the least time between tones (s). */
const AUDITION_SECONDS = 1.2;
const AUDITION_GAP = 0.12;
/** Time constant with which cancelled thunder fades (s). */
const CANCEL_FADE = 0.08;

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
  private limiter: DynamicsCompressorNode | null = null;
  private noise: ThunderNoise | null = null;
  private ambience: Ambience | null = null;
  /** The thunders sounding or on their way: end time (context), loudness, and their own gain. */
  private thunders: { end: number; gain: number; bus: GainNode }[] = [];
  private level: number;
  private mute = false;
  private paused = false;
  private failed = false;
  /** Whether the context has been running at some time: it may then be resumed without a gesture. */
  private ran = false;
  /** Context time until which an audition keeps a suspended context running, and of its last tone. */
  private auditionUntil = -Infinity;
  private auditionTone = -Infinity;
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
   * Starts the audio on a key, pointer or click event on `target` (default:
   * the window), and listens until the context runs: a finger going down is
   * no gesture to a browser, the same finger lifting is. Returns a function
   * that stops listening. Does nothing where there is no window.
   */
  attach(target?: EventTarget): () => void {
    const t = target ?? (typeof window !== 'undefined' ? window : null);
    if (!t) return () => {};
    const events = ['keydown', 'pointerdown', 'pointerup', 'touchend', 'click'];
    const detach = () => {
      for (const e of events) t.removeEventListener(e, onGesture);
    };
    const onGesture = () => {
      this.start();
      // Done once the context has run. One that could not be made is not tried again.
      if (this.failed || this.ran || this.context?.state === 'running') detach();
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
      // Suspended on purpose it stays so, unless it has never run: then this gesture may be
      // the one that can start it at all.
      if (this.context.state === 'suspended' && (!this.paused || !this.ran)) this.run(this.context);
      else if (this.context.state === 'running') this.ran = true;
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
      // A near strike over a downpour sums to more than full scale: a limiter holds the peaks
      // down, where the output would clip them.
      if (typeof context.createDynamicsCompressor === 'function') {
        const limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -8;
        limiter.knee.value = 8;
        limiter.ratio.value = 12;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.25;
        master.connect(limiter);
        limiter.connect(context.destination);
        this.limiter = limiter;
      } else {
        master.connect(context.destination);
      }
      const length = Math.round(NOISE_SECONDS * context.sampleRate);
      const white = context.createBuffer(1, length, context.sampleRate);
      const brown = context.createBuffer(1, length, context.sampleRate);
      fillNoise(white.getChannelData(0), 'white', 11);
      fillNoise(brown.getChannelData(0), 'brown', 23);
      this.noise = { white, brown };
      this.ambience = new Ambience(context, master, this.noise);
      this.context = context;
      this.master = master;
      if (context.state === 'suspended') this.run(context);
      else if (this.paused) void this.settle(context.suspend());
      else this.ran = true;
      return true;
    } catch (error) {
      console.warn('Audio is unavailable.', error);
      this.failed = true;
      this.context = null;
      return false;
    }
  }

  /**
   * Resumes the context from a gesture. Once it runs it has run; if the audio is suspended
   * meanwhile (the game is paused, or was when the gesture came), it is suspended again.
   */
  private run(context: AudioContext): void {
    void this.settle(context.resume()).then(() => {
      if (this.context !== context || context.state !== 'running') return;
      this.ran = true;
      if (this.paused && context.currentTime >= this.auditionUntil) {
        void this.settle(context.suspend());
      }
    });
  }

  /** A promise from the context, with its rejection swallowed (a closed or blocked context). */
  private settle(promise: Promise<void> | undefined): Promise<void> {
    return Promise.resolve(promise).catch(() => {});
  }

  /** Pauses all sound, thunder on its way included (the game is paused). */
  suspend(): void {
    this.paused = true;
    if (this.context?.state === 'running') {
      this.ran = true;
      void this.settle(this.context.suspend());
    }
  }

  /** Carries on after `suspend`. */
  resume(): void {
    this.paused = false;
    this.auditionUntil = -Infinity;
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
      // Its own gain, so that it can be taken back while it is on its way.
      const bus = context.createGain();
      bus.gain.value = 1;
      bus.connect(this.master);
      const end = playThunder(context, bus, this.noise, sound, now + sound.delay);
      this.thunders.push({ end, gain: sound.gain, bus });
    } catch (error) {
      console.warn('Thunder could not be played.', error);
    }
  }

  /**
   * Silences the thunder that sounds or is on its way: after a cut (the map, another
   * weather, a new flight, a jump of the clock) the strikes it belongs to are gone, and a
   * strike 25 km away would still roll in over a minute later.
   */
  cancelThunder(): void {
    const context = this.context;
    if (!context) return;
    for (const t of this.thunders) {
      t.bus.gain.setTargetAtTime(0, context.currentTime, CANCEL_FADE);
    }
    this.thunders = [];
  }

  /**
   * Lets the present volume be heard: a short soft tone, and, while the audio is suspended
   * (the pause menu's volume slider), the ambience for a moment.
   */
  audition(): void {
    const context = this.context;
    if (!context || !this.master) return;
    const now = context.currentTime;
    try {
      if (now - this.auditionTone >= AUDITION_GAP) {
        this.auditionTone = now;
        const tone = context.createOscillator();
        tone.type = 'sine';
        tone.frequency.value = 660;
        const shape = context.createGain();
        shape.gain.value = 0;
        shape.gain.setValueAtTime(0, now);
        shape.gain.linearRampToValueAtTime(0.2, now + 0.008);
        shape.gain.setTargetAtTime(0, now + 0.03, 0.05);
        tone.connect(shape);
        shape.connect(this.master);
        tone.start(now);
        tone.stop(now + 0.4);
      }
    } catch (error) {
      console.warn('The volume could not be played.', error);
    }
    if (!this.paused) return;
    this.auditionUntil = now + AUDITION_SECONDS;
    if (context.state === 'suspended') void this.settle(context.resume());
    setTimeout(
      () => {
        // Still paused, and no later audition has taken over: silence again.
        if (this.context !== context || !this.paused) return;
        if (context.currentTime < this.auditionUntil - 0.05) return;
        if (context.state === 'running') void this.settle(context.suspend());
      },
      AUDITION_SECONDS * 1000 + 30,
    );
  }

  /** Stops everything and closes the context. */
  dispose(): void {
    this.ambience?.dispose();
    this.ambience = null;
    this.master?.disconnect();
    this.master = null;
    this.limiter?.disconnect();
    this.limiter = null;
    if (this.context) void this.settle(this.context.close());
    this.context = null;
    this.noise = null;
    this.thunders = [];
    this.ran = false;
  }
}
