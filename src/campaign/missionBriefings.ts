/**
 * Briefing templates of the mission plug-ins (rule 16; roadmap R2.1): a
 * mission's briefing as a short paragraph with named places, written from the
 * flight's point of view. Pure functions of the mission's briefing input, so
 * the worker and the main thread write the same text.
 *
 * The four demo types have their own templates; the provisional types (R4.2)
 * share a plain one.
 */
import type { BriefingInput, BriefingTemplate } from '../sim/command/missions/plugin';

const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

function count(n: number): string {
  return NUMBERS[n] ?? String(n);
}

/** "two A-15 Buzzards", "one C-150 Hercules". */
function flight(b: BriefingInput): string {
  const name = b.aircraft === 1 ? b.aircraftName : `${b.aircraftName}s`;
  return `${count(b.aircraft)} ${name}`;
}

function minutes(s: number | undefined): string {
  const m = Math.round((s ?? 0) / 60);
  return m >= 90 && m % 30 === 0 ? `${m / 60} hours` : `${m} minutes`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function opening(b: BriefingInput): string {
  return `${b.callsign}, ${flight(b)} of the ${b.unit} from ${b.base}.`;
}

function near(b: BriefingInput): string {
  return b.places.town ? ` near ${b.places.town}` : '';
}

function at(b: BriefingInput): string {
  return b.when ? ` at ${b.when}` : '';
}

export const capBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Combat air patrol: take station over ${b.places.target}${near(b)} in ${b.places.theater}` +
  `${at(b)} and hold it for ${minutes(b.stationTime)}. Engage enemy aircraft that cross toward the station; ` +
  `you are relieved when the next flight checks in.`;

export const interdictionBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Interdiction: strike ${b.places.target}${near(b)}, ${b.places.theater}` +
  `${b.when ? `, time on target ${b.when}` : ''}. It carries the enemy's supply to the front` +
  `${b.places.front ? ` on ${b.places.front}` : ''}; put it out of use. ` +
  `${b.stores ? `${capitalize(b.stores)}. ` : ''}One pass, then egress home.`;

export const casBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Close air support ${b.places.corridor ? `at ${b.places.corridor}` : 'on the front'}` +
  `${b.places.front ? ` on ${b.places.front}` : ''}${near(b)}. Check in with the ground controller` +
  `${at(b)} and stay ${minutes(b.stationTime)} on call against enemy armor and artillery; ` +
  `keep clear of friendly troops on the line.`;

export const airliftBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Airlift: carry fuel and munitions to ${b.places.target} in ${b.places.theater}` +
  `${b.when ? `, landing at ${b.when}` : ''}. Unload, take on wounded and return.`;

/** The provisional types' briefing until their own (R4.2). */
export const csarBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Combat search and rescue: ${b.places.target}${near(b)}, ${b.places.theater}` +
  `${b.when ? `; be over them at ${b.when}` : ''}. Fly in low, find a landing zone clear of trees ` +
  `and slopes, land, take the crew aboard and bring them home. The escort and the cover hold ` +
  `over the pickup while you are on the ground.`;

export const rescueEscortBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Rescue escort: ${b.need}. Fly with the rescue to ${b.places.target}${near(b)} ` +
  `and circle the pickup low for ${minutes(b.stationTime)}; keep the enemy's heads down ` +
  `while the helicopter is on the ground.`;

export const rescapBriefing: BriefingTemplate = (b) =>
  `${opening(b)} Rescue cover: ${b.need}. Hold over ${b.places.target}${near(b)}${at(b)} ` +
  `for ${minutes(b.stationTime)}, before the helicopters arrive until they leave. Find the ` +
  `survivor, keep enemy troops away from them and call threats to the rescue.`;

export const plainBriefing: BriefingTemplate = (b) =>
  `${opening(b)} ${capitalize(b.need)}${at(b)}.`;
