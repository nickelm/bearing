/**
 * The display system's controller for a flown aircraft (decision 199): holds
 * the avionics state (in Free Flight, which has no simulation worker; in the
 * campaign it will live with the aircraft in the simulation) and the display
 * state, runs the master modes' triggers, and turns commands from clicks, hot
 * keys and (later) the crew into new states. Formats and the strip are pure
 * functions of the snapshot it is given; the view only draws.
 *
 * Hot keys (decision 193: keys for what a pilot needs without looking; the
 * bezel buttons work by mouse): 1–4 expand or collapse the left MFD, the right
 * MFD, the messages and the threat display; M steps the master mode by hand and
 * back to automatic; F is the dogfight override; K acknowledges the master
 * caution. The flight inputs' tables do not use these keys (a test checks).
 */
import { applyCommand, autoMode, initialAvionics } from '../../sim/avionics/avionics';
import type { AvionicsState, MasterMode, ModeInputs } from '../../sim/avionics/avionics';
import type { SlotId } from '../../sim/avionics/profiles';
import { DisplaysView } from './draw/displaysView';
import { displayModel } from './formats';
import type { ControlsAction, DisplayCommand, DisplayModel, DisplayState } from './model';
import { applyPreset, applyUi, initialDisplayState, recordEdit } from './presets';
import type { PresetEdits } from './presets';
import type { AircraftSnapshot } from './snapshot';
import { cautionIds, stripModel } from './strip';
import { DISPLAY_BINDINGS } from './bindings';
import type { DisplayHotAction } from './bindings';

const SLOT_KEYS: Partial<Record<DisplayHotAction, SlotId>> = {
  slotLeft: 'leftMfd',
  slotRight: 'rightMfd',
  slotMessages: 'messages',
  slotThreat: 'threat',
};

/** The master modes M steps through by hand, per aircraft kind; after the last, automatic. */
const MANUAL_MODES: Record<'jet' | 'helicopter', MasterMode[]> = {
  jet: ['navigation', 'approach', 'air-to-air', 'air-to-ground'],
  helicopter: ['navigation', 'hover', 'air-to-ground'],
};

export class DisplaySystem {
  avionics: AvionicsState;
  display: DisplayState | null = null;
  /** Commands for the flight controls (gear, brakes, hover hold, the mouse). */
  onControls: ((a: ControlsAction) => void) | null = null;
  /** Keys act only while flying. */
  enabled = false;
  /** The displays' scale (0.75–1.5), from the options (decision 200). */
  uiScale = 1;
  /** The player's edits to the master modes' presets, kept per viewer (decision 200). */
  edits: PresetEdits = loadEdits();
  readonly view: DisplaysView;
  private last: AircraftSnapshot | null = null;
  private readonly keyAction = new Map<string, DisplayHotAction>();
  private readonly detach: () => void;

  constructor(parent?: HTMLElement) {
    this.avionics = initialAvionics(true);
    this.view = new DisplaysView(parent);
    this.view.onCommand = (c) => this.command(c);
    for (const [a, codes] of Object.entries(DISPLAY_BINDINGS) as [DisplayHotAction, string[]][])
      for (const c of codes) this.keyAction.set(c, a);
    const kd = (e: KeyboardEvent) => {
      const a = this.keyAction.get(e.code);
      if (!a || !this.enabled || e.repeat || e.ctrlKey || e.altKey || e.metaKey) return;
      e.preventDefault();
      this.hot(a);
    };
    window.addEventListener('keydown', kd);
    this.detach = () => window.removeEventListener('keydown', kd);
  }

  /** Starts a sortie: fresh avionics and display state. */
  reset(onGround: boolean): void {
    this.avionics = initialAvionics(onGround);
    this.display = null;
    this.last = null;
  }

  /** Advances the master mode's triggers; returns whether the mode changed. */
  triggers(i: ModeInputs): boolean {
    const before = this.avionics.masterMode;
    this.avionics = autoMode(this.avionics, i);
    return before !== this.avionics.masterMode;
  }

  /** Builds the models from `snap` (whose `avionics` is replaced by this system's) and draws them. */
  update(snap: AircraftSnapshot, width?: number, height?: number): void {
    const s = { ...snap, avionics: this.avionics };
    if (!this.display) this.display = initialDisplayState(s, this.edits);
    if (this.display.uiScale !== this.uiScale)
      this.display = { ...this.display, uiScale: this.uiScale };
    else if (this.last && this.last.avionics.masterMode !== s.avionics.masterMode)
      this.display = applyPreset(this.display, s, this.edits);
    this.last = s;
    const models: Partial<Record<SlotId, DisplayModel | null>> = {};
    for (const id of ['leftMfd', 'rightMfd', 'messages', 'threat'] as const)
      models[id] = displayModel(s, this.display, id);
    this.view.draw(models, this.display, stripModel(s), s.profile.skin, width, height);
  }

  /** Applies a command from a click, a key or (later) the crew. */
  command(c: DisplayCommand): void {
    if (c.to === 'controls') {
      this.onControls?.(c.action);
      return;
    }
    if (c.to === 'avionics') {
      const before = this.avionics.masterMode;
      this.avionics = applyCommand(this.avionics, c.command);
      if (this.last && this.display && before !== this.avionics.masterMode)
        this.display = applyPreset(
          this.display,
          { ...this.last, avionics: this.avionics },
          this.edits,
        );
      this.redraw();
      return;
    }
    if (this.display && this.last) {
      this.display = applyUi(this.display, this.last, c.command);
      // A format chosen or a slot opened or closed edits the mode's preset (decision 200).
      if (c.command.type !== 'pin') {
        this.edits = recordEdit(
          this.edits,
          this.avionics.masterMode,
          c.command.slot,
          this.display.slots[c.command.slot],
        );
        saveEdits(this.edits);
      }
    }
    this.redraw();
  }

  private redraw(): void {
    if (this.last) this.update(this.last);
  }

  /** A hot key's action. */
  hot(a: DisplayHotAction): void {
    const slot = SLOT_KEYS[a];
    if (slot) return this.command({ to: 'ui', command: { type: 'toggle-slot', slot } });
    if (a === 'dogfight') return this.command({ to: 'avionics', command: { type: 'dogfight' } });
    if (a === 'masterCaution') {
      if (!this.last) return;
      const ids = cautionIds(stripModel({ ...this.last, avionics: this.avionics }));
      return this.command({ to: 'avionics', command: { type: 'acknowledge', ids } });
    }
    // M: the next mode by hand, and after the last back to the triggers.
    const list = MANUAL_MODES[this.last?.kind ?? 'jet'];
    if (!this.avionics.manual) {
      return this.command({ to: 'avionics', command: { type: 'master-mode', mode: list[0]! } });
    }
    const i = list.indexOf(this.avionics.masterMode);
    if (i < 0 || i === list.length - 1)
      this.command({ to: 'avionics', command: { type: 'auto-mode' } });
    else this.command({ to: 'avionics', command: { type: 'master-mode', mode: list[i + 1]! } });
  }

  set visible(v: boolean) {
    this.view.visible = v;
  }

  dispose(): void {
    this.detach();
    this.view.dispose();
  }
}

const EDITS_KEY = 'bearing.displays.presets';

/** The saved preset edits; none where storage is blocked or empty (a private window). */
function loadEdits(): PresetEdits {
  try {
    const raw = globalThis.localStorage?.getItem(EDITS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === 'object' ? (v as PresetEdits) : {};
  } catch {
    return {};
  }
}

function saveEdits(e: PresetEdits): void {
  try {
    globalThis.localStorage?.setItem(EDITS_KEY, JSON.stringify(e));
  } catch {
    /* storage blocked: the edits last for this visit */
  }
}

/** Forgets the saved preset edits (the pause menu's reset). */
export function clearPresetEdits(system: DisplaySystem): void {
  system.edits = {};
  saveEdits({});
}
