/**
 * Display models (Proposal 0006, decisions 189 and 199): what a display shows,
 * as plain data. A format is a pure function from the aircraft snapshot and
 * the display state to a `DisplayModel`; nothing here touches the DOM, a canvas
 * or three.js, so tests compare models, and a second window or a tablet (P6)
 * can draw the same ones. Input from anywhere returns as `DisplayCommand`s.
 *
 * Screen coordinates run 0..1 across the screen, x right and y down.
 */
import type { AvionicsCommand } from '../../sim/avionics/avionics';
import type { FormatId, SlotId } from '../../sim/avionics/profiles';

export type { FormatId, SlotId };

export type SlotState = 'expanded' | 'collapsed' | 'hidden';

export interface SlotDisplayState {
  format: FormatId | null;
  state: SlotState;
  /** A pinned slot keeps its format and state in every master mode. */
  pinned: boolean;
}

export interface DisplayState {
  slots: Record<SlotId, SlotDisplayState>;
  uiScale: number;
  /** The moving map's range (an index into MAP_RANGES_NM) and orientation (decision 201). */
  map: { range: number; northUp: boolean };
}

/** Commands to the flight controls the strip's items toggle (gear, brakes), by the inputs' action names. */
export type ControlsAction = 'gear' | 'speedbrake' | 'parkingBrake' | 'hoverHold' | 'mouseCapture';

export type UiCommand =
  | { type: 'select-format'; slot: SlotId; format: FormatId }
  | { type: 'toggle-slot'; slot: SlotId }
  | { type: 'pin'; slot: SlotId; pinned: boolean }
  | { type: 'map-range'; slot: SlotId; delta: 1 | -1 }
  | { type: 'map-orient'; slot: SlotId };

export type DisplayCommand =
  | { to: 'avionics'; command: AvionicsCommand }
  | { to: 'ui'; command: UiCommand }
  | { to: 'controls'; action: ControlsAction };

export type Tone = 'normal' | 'dim' | 'caution' | 'warning';

export type ScreenItem =
  | {
      kind: 'text';
      x: number;
      y: number;
      text: string;
      size: 'small' | 'normal' | 'large';
      align: 'left' | 'center' | 'right';
      tone: Tone;
    }
  | { kind: 'line'; points: [number, number][]; tone: Tone; width?: number }
  | { kind: 'arc'; x: number; y: number; r: number; tone: Tone; dashed?: boolean }
  /**
   * The moving map's picture (decision 201): the strategic view's rendering around
   * (`lat`, `lon`), `halfExtent` m from the screen's center to its edges, turned by
   * `rotation` (rad, clockwise: the track in track-up). The view supplies the picture.
   */
  | {
      kind: 'map';
      lat: number;
      lon: number;
      halfExtent: number;
      rotation: number;
      /** The planet's radius (m), to place the aircraft on a picture drawn a moment ago. */
      radius: number;
    }
  /** A log of lines, wrapped to the screen's width and stacked up from the bottom, newest last. */
  | { kind: 'log'; lines: { text: string; tone: Tone }[] }
  /** A bar of `fill` (0..1) in a frame, filling up (vertical) or right. */
  | {
      kind: 'bar';
      x: number;
      y: number;
      w: number;
      h: number;
      fill: number;
      vertical: boolean;
      tone: Tone;
    };

export interface BezelButton {
  label: string;
  /** Shown highlighted (the format shown, a mode that is on). */
  active: boolean;
  command: DisplayCommand | null;
}

/** Bezel buttons per large display: five a side, numbered clockwise from the top left. */
export const BEZEL_BUTTONS = 20;
/** Small displays have the top row only. */
export const SMALL_BUTTONS = 5;

export interface DisplayModel {
  slot: SlotId;
  format: FormatId;
  /** The format's short name, on the bezel's top edge. */
  title: string;
  /** Who works the format: the player, or a crewmate's role (P5). */
  owner: string | null;
  /** Buttons by position (`BEZEL_BUTTONS` or `SMALL_BUTTONS`); null leaves a position blank. */
  buttons: (BezelButton | null)[];
  items: ScreenItem[];
  /** An alert brought this format forward: the bezel is highlighted. */
  alert: boolean;
}

export type StripLevel = 'normal' | 'caution' | 'warning';

export interface StripItem {
  id: string;
  label: string;
  level: StripLevel;
  /** Unacknowledged cautions and warnings flash (warnings) or glow (cautions). */
  fresh: boolean;
  command: DisplayCommand | null;
}

export interface StripGauge {
  id: 'torque' | 'rotor' | 'margin';
  label: string;
  /** 0..1 of the gauge's range, the value's text and its level. */
  fill: number;
  text: string;
  level: StripLevel;
}

export interface StripModel {
  items: StripItem[];
  /** The master caution: lit while any caution or warning is unacknowledged. */
  masterCaution: boolean;
  gauges: StripGauge[];
  /** The master mode, dim at the strip's end. */
  mode: string;
}
