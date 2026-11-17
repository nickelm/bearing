/**
 * Master modes' display presets (Proposal 0006, decision 199): what each mode
 * asks of every slot, after the proposal's table. A preset names formats in
 * order of preference; the first the aircraft has and that is built wins, and
 * a slot with none is collapsed (a used slot) or hidden (an unused one).
 * Pinned slots keep their format and state. Slots never move: a preset changes
 * only a slot's format and state.
 */
import type { MasterMode } from '../../sim/avionics/avionics';
import type { FormatId, SlotId } from '../../sim/avionics/profiles';
import { MAP_RANGES_NM, slotFormats } from './formats';
import type { DisplayState, SlotDisplayState } from './model';
import type { AircraftSnapshot } from './snapshot';

type Want = { formats: FormatId[]; expanded: boolean };

const MAP: FormatId[] = ['moving-map', 'engines'];

export const PRESETS: Record<MasterMode, Partial<Record<SlotId, Want>>> = {
  ground: {
    leftMfd: { formats: MAP, expanded: true },
    rightMfd: { formats: [], expanded: false },
    threat: { formats: ['threat'], expanded: false },
  },
  navigation: {
    leftMfd: { formats: MAP, expanded: true },
    rightMfd: { formats: [], expanded: false },
    threat: { formats: ['threat'], expanded: true },
  },
  'air-to-air': {
    leftMfd: { formats: MAP, expanded: true },
    rightMfd: { formats: ['radar-aa'], expanded: true },
    threat: { formats: ['threat'], expanded: true },
  },
  dogfight: {
    leftMfd: { formats: MAP, expanded: false },
    rightMfd: { formats: ['radar-aa'], expanded: false },
    threat: { formats: ['threat'], expanded: true },
  },
  'air-to-ground': {
    leftMfd: { formats: ['stores', 'moving-map'], expanded: true },
    rightMfd: { formats: ['targeting-pod', 'radar-ag'], expanded: true },
    threat: { formats: ['threat'], expanded: true },
  },
  approach: {
    leftMfd: { formats: MAP, expanded: true },
    rightMfd: { formats: [], expanded: false },
    threat: { formats: ['threat'], expanded: false },
  },
  hover: {
    leftMfd: { formats: MAP, expanded: true },
    rightMfd: { formats: ['hook-camera', 'targeting-pod'], expanded: true },
    threat: { formats: ['threat'], expanded: true },
  },
};

const SLOTS: SlotId[] = ['leftMfd', 'rightMfd', 'threat', 'messages', 'strip'];

/** A fresh display state: every slot unpinned, then the mode's preset. */
export function initialDisplayState(s: AircraftSnapshot, edits: PresetEdits = {}): DisplayState {
  const slots = {} as Record<SlotId, SlotDisplayState>;
  for (const id of SLOTS) slots[id] = { format: null, state: 'hidden', pinned: false };
  return applyPreset({ slots, uiScale: 1, map: { range: 2, northUp: false } }, s, edits);
}

/**
 * The player's edits to the presets (decision 200): per master mode and slot, the
 * format and whether it is expanded. An edit applies to every aircraft where the
 * format exists; elsewhere the preset's own choice stands.
 */
export type PresetEdits = Partial<
  Record<MasterMode, Partial<Record<SlotId, { format: FormatId; expanded: boolean }>>>
>;

/** Applies the snapshot's master mode's preset, and the player's edits, to every unpinned slot. */
export function applyPreset(
  d: DisplayState,
  s: AircraftSnapshot,
  edits: PresetEdits = {},
): DisplayState {
  const preset = PRESETS[s.avionics.masterMode];
  const mine = edits[s.avionics.masterMode] ?? {};
  const slots = { ...d.slots };
  for (const id of SLOTS) {
    const cur = slots[id];
    if (cur.pinned) continue;
    if (id === 'strip') {
      slots[id] = { format: null, state: 'expanded', pinned: false };
      continue;
    }
    const allowed = slotFormats(s, id);
    const taken = id === 'rightMfd' ? slots.leftMfd.format : null;
    const edit = mine[id];
    if (edit && allowed.includes(edit.format) && edit.format !== taken) {
      slots[id] = {
        format: edit.format,
        state: edit.expanded ? 'expanded' : 'collapsed',
        pinned: false,
      };
      continue;
    }
    if (id === 'messages') {
      slots[id] = {
        format: allowed[0] ?? null,
        state: allowed.length ? 'expanded' : 'hidden',
        pinned: false,
      };
      continue;
    }
    // A slot that could only repeat its neighbor's format stays hidden.
    if (allowed.filter((f) => f !== taken).length === 0) {
      slots[id] = { format: null, state: 'hidden', pinned: false };
      continue;
    }
    const want = preset[id];
    const pick = want?.formats.find((f) => allowed.includes(f) && f !== taken) ?? null;
    slots[id] = {
      format: pick ?? cur.format ?? allowed.find((f) => f !== taken) ?? allowed[0]!,
      state: pick && want?.expanded ? 'expanded' : 'collapsed',
      pinned: false,
    };
  }
  return { ...d, slots };
}

/** Records a slot's format and state as the player's edit of the mode's preset. */
export function recordEdit(
  edits: PresetEdits,
  mode: MasterMode,
  slot: SlotId,
  st: SlotDisplayState,
): PresetEdits {
  if (!st.format || st.state === 'hidden' || slot === 'strip') return edits;
  return {
    ...edits,
    [mode]: { ...edits[mode], [slot]: { format: st.format, expanded: st.state === 'expanded' } },
  };
}

/** Applies a UI command; `null` for commands that are not the UI's. */
export function applyUi(
  d: DisplayState,
  s: AircraftSnapshot,
  c: import('./model').UiCommand,
): DisplayState {
  const slots = { ...d.slots };
  const cur = slots[c.slot];
  switch (c.type) {
    case 'select-format':
      if (!slotFormats(s, c.slot).includes(c.format)) return d;
      slots[c.slot] = { ...cur, format: c.format, state: 'expanded' };
      break;
    case 'toggle-slot':
      if (cur.state === 'hidden' || !cur.format) return d;
      slots[c.slot] = { ...cur, state: cur.state === 'expanded' ? 'collapsed' : 'expanded' };
      break;
    case 'pin':
      slots[c.slot] = { ...cur, pinned: c.pinned };
      break;
    case 'map-range': {
      const range = Math.max(0, Math.min(MAP_RANGES_NM.length - 1, d.map.range + c.delta));
      return { ...d, map: { ...d.map, range } };
    }
    case 'map-orient':
      return { ...d, map: { ...d.map, northUp: !d.map.northUp } };
  }
  return { ...d, slots };
}
