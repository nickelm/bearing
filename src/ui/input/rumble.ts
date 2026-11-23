/**
 * Rumble (Proposal 0014, decision 367): what a flown aircraft feels through a gamepad that
 * can vibrate. Pulses for events (a hit taken or scored, touchdown) and a continuous feel
 * for the gun firing and the stall buffet, refreshed in short effects so it stops at once
 * when the cause does. Off when the profile says so or no pad can rumble.
 */
import { gamepads } from './gamepad';
import type { GamepadSource } from './gamepad';
import { inputLayer } from './layer';

/** The length of one continuous effect (ms); refreshed before it ends. */
const SLICE_MS = 120;

export type RumblePulse = 'touchdown' | 'hard-touchdown' | 'hit' | 'splash' | 'launch';

const PULSES: Record<RumblePulse, [strong: number, weak: number, ms: number]> = {
  touchdown: [0.35, 0.2, 140],
  'hard-touchdown': [0.9, 0.6, 350],
  hit: [0.8, 0.4, 250],
  splash: [0.2, 0.5, 200],
  launch: [0.3, 0.5, 180],
};

export class Rumble {
  private next = 0;
  private busyUntil = 0;

  constructor(
    private readonly source: GamepadSource = gamepads(),
    private readonly enabled: () => boolean = () => {
      const l = inputLayer();
      return l.profile('gamepad').options.rumble;
    },
  ) {}

  /** A one-off effect. */
  pulse(kind: RumblePulse, nowMs = performance.now()): void {
    if (!this.enabled()) return;
    const [s, w, ms] = PULSES[kind];
    if (this.source.rumble(s, w, ms)) this.busyUntil = nowMs + ms;
  }

  /**
   * The continuous feel each frame: the gun firing, and the buffet (0..1) near the stall.
   * Does nothing while a pulse plays.
   */
  frame(gun: boolean, buffet: number, nowMs = performance.now()): void {
    if (!this.enabled() || nowMs < this.busyUntil || nowMs < this.next) return;
    const b = Math.max(0, Math.min(1, buffet));
    if (!gun && b < 0.05) return;
    const strong = Math.max(gun ? 0.25 : 0, b * 0.6);
    const weak = Math.max(gun ? 0.7 : 0, b * 0.3);
    if (this.source.rumble(strong, weak, SLICE_MS)) this.next = nowMs + SLICE_MS * 0.8;
  }
}

/** Buffet from the angle of attack: none below `onset`, full at `full` (rad). */
export function buffetFromAlpha(alpha: number, onset: number, full: number): number {
  const t = (alpha - onset) / Math.max(1e-6, full - onset);
  return Math.max(0, Math.min(1, t));
}
