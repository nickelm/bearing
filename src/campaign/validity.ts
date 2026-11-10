/**
 * The validity check (design, pipeline step 7; decision 46): the only reason
 * a world is rejected. A world is valid when at least one theater other than
 * the strategic theater is above its fit threshold and each side's territory
 * holds at least MIN_AIRBASES_PER_SIDE candidate airbase sites.
 */
import type { Cast } from './cast';
import type { Detection } from './theaters';

export const MIN_AIRBASES_PER_SIDE = 15;

export interface Validity {
  valid: boolean;
  /** Why the world failed; empty when valid. */
  reasons: string[];
}

export function checkValidity(detection: Detection, cast: Cast): Validity {
  const reasons: string[] = [];
  if (!detection.selected.some((t) => t.kind !== 'strategic')) {
    reasons.push('no theater above its fit threshold');
  }
  for (const side of ['alliance', 'pact'] as const) {
    if (cast.airbases[side] < MIN_AIRBASES_PER_SIDE) {
      reasons.push(`${side}: ${cast.airbases[side]} airbase sites (need ${MIN_AIRBASES_PER_SIDE})`);
    }
  }
  return { valid: reasons.length === 0, reasons };
}
