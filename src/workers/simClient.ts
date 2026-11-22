/**
 * Main-thread side of the simulation worker (decision 67): starts the sim for
 * a world, forwards clock controls, keeps the latest snapshot and the two
 * weather frames that bracket the clock, and extrapolates a smooth display
 * time between snapshots.
 */
import type { CampaignCalendar, OrbitParams } from '../core/calendar';
import type { GameTime } from '../core/units';
import type { GroundPicture } from '../sim/ground/war';
import type { Mission } from '../sim/air/mission';
import type { CampaignInput } from '../sim/command/campaignInput';
import type { HostState } from '../sim/host';
import type { CampaignInputEvent } from '../sim/eventLog';
import { climateBuffers } from '../sim/weather/climate';
import type { WeatherClimate } from '../sim/weather/climate';
import { WeatherView } from '../sim/weather/frame';
import { WeatherGrid } from '../sim/weather/grid';
import { PING_STREAM, SnapshotField } from './protocol';
import type { FromSimWorker, SnapshotMessage, ToSimWorker } from './protocol';
import { rng } from '../core/rng';

/** How far the display clock may run ahead of the last snapshot (real seconds). */
const MAX_EXTRAPOLATION = 0.1;
/** How close a snapshot's time must be to a seek's target to count as its answer (game s). */
const SEEK_TOLERANCE = 1e-3;

export interface FlaggedNotice {
  events: { time: GameTime; label: string; mission?: number }[];
  /** True if auto-slowdown dropped the rate to 1×. */
  slowed: boolean;
}

export class SimClient {
  private readonly worker: Worker;
  private session = 0;
  private snapshotTime = 0;
  private receivedAt = 0;
  private lastDisplay = 0;
  private expectedPong = -1;
  /** The time of a seek the worker has not answered yet. */
  private seekTarget: GameTime | null = null;
  private nextRequest = 0;
  private readonly pendingStates = new Map<
    number,
    (r: { state: HostState; hash: string }) => void
  >();
  /** Weather frames bracketing the sim clock. */
  readonly weather = new WeatherView(new WeatherGrid());
  /** Game seconds per real second, as last reported by the worker. */
  rate = 0;
  /** Latest snapshot header (see SnapshotField), or null before the first. */
  header: Float64Array | null = null;
  /** Determinism hash reported after the last init or seek. */
  hash = '';
  /** True once a world's simulation is running. */
  started = false;
  /** Live missions of both sides from the last update (decision 48: the view filters by side). */
  missions: Mission[] = [];
  /** The ground war's front lines and units from the last update that carried them (R2.3). */
  ground: GroundPicture | null = null;
  onGround?: () => void;
  /** Damage to target sites and road edges (decision 301), from the last update that carried it. */
  damage: { sites: Map<number, number>; roads: Map<number, number> } = {
    sites: new Map(),
    roads: new Map(),
  };
  onDamage?: () => void;
  /** Called when the weather frames change. */
  onWeather: (() => void) | null = null;
  /** Called when the mission list changes. */
  onMissions: (() => void) | null = null;
  /**
   * Called when the worker has answered the latest `seek`: the display time jumped when the
   * seek was sent, and only now does `weather` hold the frames of the new time (`onWeather`
   * has run for them).
   */
  onSeeked: (() => void) | null = null;
  onFlagged: ((n: FlaggedNotice) => void) | null = null;
  onStatus: ((status: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromSimWorker>) => this.receive(e.data);
    this.worker.onerror = (e) => {
      this.onStatus?.('error');
      console.error('Sim worker error', e);
    };
  }

  /** Checks that the worker bundles and that seeded streams agree across contexts. */
  ping(seed: string): void {
    this.expectedPong = rng(seed, PING_STREAM).nextUint32();
    this.onStatus?.('pending');
    this.send({ type: 'ping', seed });
  }

  /** Starts the simulation of a world at campaign start, paused at `rate` 0 unless given. */
  init(
    seed: string,
    radius: number,
    orbit: OrbitParams,
    calendar: CampaignCalendar,
    climate: WeatherClimate,
    campaign: CampaignInput | null = null,
    ground: { height: Float32Array; n: number } | null = null,
  ): void {
    this.session++;
    this.seekTarget = null;
    this.weather.clear();
    this.missions = [];
    this.ground = null;
    this.onMissions?.();
    this.snapshotTime = this.lastDisplay = 0;
    this.receivedAt = performance.now();
    this.started = true;
    const heights = ground ? ground.height.slice() : null;
    this.send(
      {
        type: 'init',
        session: this.session,
        seed,
        radius,
        orbit,
        calendar,
        climate,
        campaign,
        // A copy, transferred: the main thread keeps its world's heights.
        ground: heights && ground ? { height: heights, n: ground.n } : null,
      },
      [...climateBuffers(climate), ...(heights ? [heights.buffer] : [])],
    );
    // The worker starts paused; keep the player's chosen rate.
    this.send({ type: 'setRate', rate: this.rate });
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.send({ type: 'setRate', rate });
  }

  seek(time: GameTime): void {
    this.lastDisplay = Math.max(0, time);
    this.snapshotTime = this.lastDisplay;
    this.seekTarget = this.lastDisplay;
    this.receivedAt = performance.now();
    this.send({ type: 'seek', time: Math.max(0, time) });
  }

  alarm(at: GameTime, label: string): void {
    this.send({ type: 'alarm', at, label });
  }

  setAutoSlowdown(enabled: boolean): void {
    this.send({ type: 'autoSlowdown', enabled });
  }

  /** A player input to the campaign (R1.4): logged and applied in the worker. */
  input(input: CampaignInputEvent): void {
    this.send({ type: 'input', input });
  }

  /** The whole campaign state and its hash (R1.2), as the worker holds it now. */
  saveState(): Promise<{ state: HostState; hash: string }> {
    const request = this.nextRequest++;
    return new Promise((resolve) => {
      this.pendingStates.set(request, resolve);
      this.send({ type: 'saveState', request });
    });
  }

  /**
   * Hands the worker the global world's ground (R1.6): the height grid (copied and
   * transferred) and the sited airfields. Ignored before `init`.
   */
  setTerrain(
    height: Float32Array,
    n: number,
    fields: readonly { point: readonly number[]; heading: number; runwayLength: number }[],
  ): void {
    if (!this.started) return;
    const copy = height.slice();
    this.send(
      {
        type: 'terrain',
        height: copy,
        n,
        fields: fields.map((f) => ({
          point: [f.point[0]!, f.point[1]!, f.point[2]!],
          heading: f.heading,
          runwayLength: f.runwayLength,
        })),
      },
      [copy.buffer],
    );
  }

  /** Replaces the campaign with a saved state; the next snapshot carries its hash. */
  loadState(state: HostState): void {
    this.send({ type: 'loadState', state });
  }

  /** Game time to display at real time `nowMs`: the sim clock, extrapolated smoothly. */
  displayTime(nowMs: number): GameTime {
    const ahead = Math.min((nowMs - this.receivedAt) / 1000, MAX_EXTRAPOLATION) * this.rate;
    const t = Math.max(this.lastDisplay, this.snapshotTime + Math.max(0, ahead));
    this.lastDisplay = t;
    return t;
  }

  private send(msg: ToSimWorker, transfer: Transferable[] = []): void {
    this.worker.postMessage(msg, transfer);
  }

  private receive(msg: FromSimWorker): void {
    switch (msg.type) {
      case 'pong': {
        const ok = msg.value === this.expectedPong;
        this.onStatus?.(ok ? 'ok (deterministic)' : 'MISMATCH');
        if (!ok) console.error('Sim worker RNG mismatch', msg.value, this.expectedPong);
        break;
      }
      case 'snapshot':
        if (msg.session === this.session) this.snapshot(msg);
        break;
      case 'state': {
        const done = this.pendingStates.get(msg.request);
        this.pendingStates.delete(msg.request);
        if (msg.session === this.session) done?.({ state: msg.state, hash: msg.hash });
        break;
      }
      case 'error':
        if (msg.session === this.session) {
          this.onStatus?.('error (see console)');
          console.error('Simulation error:', msg.message);
        }
        break;
    }
  }

  private snapshot(msg: SnapshotMessage): void {
    this.header = msg.header;
    this.snapshotTime = msg.header[SnapshotField.Time]!;
    this.rate = msg.header[SnapshotField.Rate]!;
    this.receivedAt = performance.now();
    // A flagged stop or a seek can put the sim clock behind the extrapolated display.
    if (msg.slowed || msg.hash !== undefined) this.lastDisplay = this.snapshotTime;
    if (msg.hash !== undefined) this.hash = msg.hash;
    for (const f of msg.weather) this.weather.add(f);
    if (msg.weather.length > 0) this.onWeather?.();
    // A seek is answered by a snapshot with a hash at the seek's time (a rate change has a
    // hash too, at the time the sim had then).
    if (
      this.seekTarget !== null &&
      msg.hash !== undefined &&
      Math.abs(this.snapshotTime - this.seekTarget) <= SEEK_TOLERANCE
    ) {
      this.seekTarget = null;
      this.onSeeked?.();
    }
    if (msg.flagged.length > 0) this.onFlagged?.({ events: msg.flagged, slowed: msg.slowed });
    if (msg.missions) {
      this.missions = msg.missions;
      this.onMissions?.();
    }
    if (msg.ground) {
      this.ground = msg.ground;
      this.onGround?.();
    }
    if (msg.damage) {
      this.damage = { sites: new Map(msg.damage.sites), roads: new Map(msg.damage.roads) };
      this.onDamage?.();
    }
  }
}
