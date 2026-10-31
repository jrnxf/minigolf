// The drag-to-power curve. It lives in the input layer only: a stroke still
// travels as a whole-number velocity, so the physics and the room server
// never see it.

import { MAX_SPEED } from "../core/constants.ts";

/** Shortest drag (as a fraction of the full drag) that counts as a stroke. */
export const MIN_DRAG = 0.06;

/** The top speed before the power boost; the lower part of the drag still uses it. */
const BASE_SPEED = 760;
/** Up to this fraction of the drag, speed grows linearly exactly as it always did. */
const KNEE = 0.7;
const KNEE_SPEED = BASE_SPEED * KNEE;
const TAIL = 1 - KNEE;
/** Curvature of the last stretch: it starts at the base slope and ends at MAX_SPEED. */
const BOOST = (MAX_SPEED - KNEE_SPEED - BASE_SPEED * TAIL) / (TAIL * TAIL);

/** Power (0..1 of MAX_SPEED) for a drag fraction (0..1 of the full drag). */
export function powerFromDrag(drag: number): number {
  const d = Math.max(0, Math.min(1, drag));
  if (d <= KNEE) return (BASE_SPEED * d) / MAX_SPEED;
  const t = d - KNEE;
  return (KNEE_SPEED + BASE_SPEED * t + BOOST * t * t) / MAX_SPEED;
}

/** The drag fraction that produces `power`; the inverse of powerFromDrag. */
export function dragFromPower(power: number): number {
  const speed = Math.max(0, Math.min(1, power)) * MAX_SPEED;
  if (speed <= KNEE_SPEED) return speed / BASE_SPEED;
  // Solve BOOST * t^2 + BASE_SPEED * t - (speed - KNEE_SPEED) = 0 for t.
  const c = speed - KNEE_SPEED;
  const t = (-BASE_SPEED + Math.sqrt(BASE_SPEED * BASE_SPEED + 4 * BOOST * c)) / (2 * BOOST);
  return KNEE + t;
}
