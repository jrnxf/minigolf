import { describe, expect, it } from "vitest";
import { MAX_TICKS } from "../../src/core/constants.ts";
import { HOLES } from "../../src/core/holes.ts";
import { shotFromAim, simulateShot } from "../../src/core/physics.ts";
import { MIN_DRAG, powerFromDrag } from "../../src/client/power.ts";

// A fixed sweep of tee shots, through the real drag curve: every angle step
// (ANGLES around the circle) at every drag step (DRAGS from the shortest
// stroke to a full pull). Deterministic, so the rates never wobble.
const ANGLES = 1440;
const DRAGS = 40;

function aceRate(hole: (typeof HOLES)[number]): { hits: number; percent: number; stalled: number } {
  let hits = 0;
  let stalled = 0;
  for (let a = 0; a < ANGLES; a++) {
    for (let p = 0; p < DRAGS; p++) {
      const drag = MIN_DRAG + ((1 - MIN_DRAG) * p) / (DRAGS - 1);
      const shot = shotFromAim((a / ANGLES) * Math.PI * 2, powerFromDrag(drag));
      const r = simulateShot(hole, hole.tee, shot, { trace: false });
      if (r.sunk) hits += 1;
      if (r.ticks >= MAX_TICKS) stalled += 1;
    }
  }
  return { hits, percent: (hits / (ANGLES * DRAGS)) * 100, stalled };
}

describe("hole-in-one rates", () => {
  // Easy holes land about 1-2% of tee shots, the hard ones far rarer, none at zero or above 2%.
  it.each(HOLES.map((h) => [h.name, h] as const))("%s stays between 0.005% and 2%", (_name, hole) => {
    const { hits, percent, stalled } = aceRate(hole);
    // A ball that never settles makes the player watch a 30 second stroke. Volcano's hilltop
    // balances two in 57,600 shots; a strong sideways slope used to stall a fifth of them.
    expect(stalled / (ANGLES * DRAGS)).toBeLessThan(0.0001);
    expect(hits).toBeGreaterThan(0);
    expect(percent).toBeGreaterThanOrEqual(0.005);
    expect(percent).toBeLessThanOrEqual(2);
  });
});
