/** Rotorcraft test fixtures: the two H1 types' flight blocks and a flat world. */
import scoutJson from '../../src/render/common/models/specs/alliance-scout-helo.json';
import utilityJson from '../../src/render/common/models/specs/alliance-utility-helo.json';
import { parseRotorcraftSpec } from '../../src/sim/flight/rotor/rotorSpec';
import type { RotorcraftSpec } from '../../src/sim/flight/rotor/rotorSpec';
import { RotorcraftModel } from '../../src/sim/flight/rotor/rotorcraftModel';
import { RADIUS } from './flight';

export function scoutSpec(): RotorcraftSpec {
  return parseRotorcraftSpec((scoutJson as { flight: unknown }).flight, 'alliance-scout-helo');
}

export function utilitySpec(): RotorcraftSpec {
  return parseRotorcraftSpec((utilityJson as { flight: unknown }).flight, 'alliance-utility-helo');
}

export function scout(): RotorcraftModel {
  return new RotorcraftModel(scoutSpec(), RADIUS);
}

export function utility(): RotorcraftModel {
  return new RotorcraftModel(utilitySpec(), RADIUS);
}
