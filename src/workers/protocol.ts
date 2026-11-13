/**
 * Messages between the main thread and the simulation worker (decision 67).
 * Bulk data crosses as transferred ArrayBuffers, never shared memory
 * (decision 40): the climate input on init, and every snapshot and weather
 * frame on the way back.
 */
import type { CampaignCalendar, OrbitParams } from '../core/calendar';
import type { GameTime } from '../core/units';
import type { Mission } from '../sim/air/mission';
import type { CampaignInput } from '../sim/command/campaignInput';
import type { WeatherClimate } from '../sim/weather/climate';

export interface PingMessage {
  type: 'ping';
  seed: string;
}

/** Starts (or restarts) the simulation for a world at campaign start, paused. */
export interface InitMessage {
  type: 'init';
  /** Session id: every later message from the worker carries it, so stale ones can be dropped. */
  session: number;
  /** World seed (the one that passed the validity check). */
  seed: string;
  radius: number;
  orbit: OrbitParams;
  calendar: CampaignCalendar;
  climate: WeatherClimate;
  /** The campaign for the air war (C2); null runs the weather alone. */
  campaign: CampaignInput | null;
}

export interface SetRateMessage {
  type: 'setRate';
  /** Game seconds per real second (one of TIME_RATES). */
  rate: number;
}

/** Jumps to a game time; backward replays from campaign start. */
export interface SeekMessage {
  type: 'seek';
  time: GameTime;
}

export interface AlarmMessage {
  type: 'alarm';
  at: GameTime;
  label: string;
}

export interface AutoSlowdownMessage {
  type: 'autoSlowdown';
  enabled: boolean;
}

export type ToSimWorker =
  PingMessage | InitMessage | SetRateMessage | SeekMessage | AlarmMessage | AutoSlowdownMessage;

export interface PongMessage {
  type: 'pong';
  /** First value of rng(seed, PING_STREAM), so the main thread can confirm cross-context determinism. */
  value: number;
}

/** Layout of a snapshot header (Float64Array). */
export const SnapshotField = {
  Time: 0,
  Rate: 1,
  Events: 2,
  Ticks: 3,
  Pending: 4,
  WeatherSystems: 5,
  /** Real milliseconds the last step took in the worker. */
  StepMs: 6,
  /** Live missions (planned or flying), and aircraft in the air per side. */
  Missions: 7,
  AirborneAlliance: 8,
  AirbornePact: 9,
} as const;
export const SNAPSHOT_FIELDS = 10;

/**
 * State snapshot, sent after every worker step that changed anything. The
 * header is a transferred Float64Array (see SnapshotField). Weather frames
 * ride along when the hour bracket changes: the earlier and later hour, each
 * a transferred Float32Array of channel planes (sim/weather/frame.ts).
 */
export interface SnapshotMessage {
  type: 'snapshot';
  session: number;
  header: Float64Array;
  weather: { hour: number; data: Float32Array }[];
  /** Flagged events that ran in this step, and whether auto-slowdown changed the rate. */
  flagged: { time: GameTime; label: string }[];
  slowed: boolean;
  /** Determinism hash of the whole state (only after a seek, or when asked). */
  hash?: string;
  /**
   * Every live mission, sent when the set changes (a planning tick, a
   * completion) and after init or seek. Routes are analytic, so the main
   * thread computes positions and phases for any display time itself.
   */
  missions?: Mission[];
}

export interface SimErrorMessage {
  type: 'error';
  session: number;
  message: string;
}

export type FromSimWorker = PongMessage | SnapshotMessage | SimErrorMessage;

export const PING_STREAM = 'worker-ping';
