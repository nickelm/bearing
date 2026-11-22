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
  /**
   * The moving map's range (an index into MAP_RANGES_NM), orientation (decision 201) and
   * mode: the strategic chart, elevation tints, or terrain against the aircraft's altitude
   * (decision 227).
   */
  map: { range: number; northUp: boolean; mode: MapMode; depressed?: boolean };
}

/** Commands to the flight controls the strip's items toggle (gear, brakes), by the inputs' action names. */
export type ControlsAction =
  | 'gear'
  | 'speedbrake'
  | 'parkingBrake'
  | 'hoverHold'
  | 'mouseCapture'
  /** Drops the drop tanks (decision 287): the stores format's button, the J key. */
  | 'jettisonTanks';

export type UiCommand =
  | { type: 'select-format'; slot: SlotId; format: FormatId }
  | { type: 'toggle-slot'; slot: SlotId }
  | { type: 'pin'; slot: SlotId; pinned: boolean }
  | { type: 'map-range'; slot: SlotId; delta: 1 | -1 }
  | { type: 'map-orient'; slot: SlotId }
  | { type: 'map-mode'; slot: SlotId }
  /** The own ship centered or low on the map (decision 310). */
  | { type: 'map-depress'; slot: SlotId };

export type MapMode = 'chart' | 'elevation' | 'relative';

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
  /**
   * A polyline. Over the map (decision 305) a line may carry its own color (CSS) instead
   * of the tone's, a pale casing under it, a dash, or be a filled shape (a front's teeth).
   */
  | {
      kind: 'line';
      points: [number, number][];
      tone: Tone;
      width?: number;
      color?: string;
      casing?: string;
      dashed?: boolean;
      fill?: boolean;
    }
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
      /** Where the aircraft sits down the screen (0.5 centered; decision 310). */
      centerY?: number;
    }
  /** A log of lines, wrapped to the screen's width and stacked up from the bottom, newest last. */
  | { kind: 'log'; lines: { text: string; tone: Tone }[] }
  /**
   * A spot on the screen a click works (decision 223): within `r` of (`x`, `y`) it issues
   * `command`, as the designation cursor does on a real display. Drawn as nothing.
   */
  | { kind: 'hit'; x: number; y: number; r: number; command: DisplayCommand }
  /**
   * A raster of `cols` × `rows` intensities 0..255 (row 0 at the bottom) filling the
   * rectangle, in the phosphor color: the ground map (decision 226).
   */
  | {
      kind: 'raster';
      x: number;
      y: number;
      w: number;
      h: number;
      cols: number;
      rows: number;
      values: number[];
      /** Colors 0xRRGGBB per cell instead of the phosphor's intensities (the elevation map). */
      colors?: number[];
    }
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
  /**
   * The slot is pinned. The frame, not the format, carries the pin and the minimize
   * control: icons in the bezel's top corners (decision 222).
   */
  pinned: boolean;
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
