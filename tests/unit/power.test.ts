import { describe, expect, it } from "vitest";
import { MAX_SPEED, MIN_POWER } from "../../src/core/constants.ts";
import { isValidShot, shotFromAim } from "../../src/core/physics.ts";
import { MIN_DRAG, dragFromPower, powerFromDrag } from "../../src/client/power.ts";

describe("power curve", () => {
  it("puts the lower 70% of the drag exactly where the old 760 top speed had it", () => {
    for (const d of [0.06, 0.2, 0.5, 0.7]) {
      expect(powerFromDrag(d) * MAX_SPEED).toBeCloseTo(760 * d, 9);
    }
  });

  it("reaches the full 1025 at a full drag and never beyond", () => {
    expect(MAX_SPEED).toBe(1025);
    expect(powerFromDrag(1)).toBeCloseTo(1, 12);
    expect(powerFromDrag(3)).toBe(powerFromDrag(1));
    expect(powerFromDrag(-1)).toBe(0);
  });

  it("only ever grows, and keeps its slope at the knee (no kink)", () => {
    let prev = -1;
    for (let i = 0; i <= 1000; i++) {
      const p = powerFromDrag(i / 1000);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
    const e = 1e-6;
    const below = (powerFromDrag(0.7) - powerFromDrag(0.7 - e)) / e;
    const above = (powerFromDrag(0.7 + e) - powerFromDrag(0.7)) / e;
    expect(above).toBeCloseTo(below, 3);
  });

  it("inverts cleanly", () => {
    for (const d of [0.06, 0.3, 0.7, 0.75, 0.9, 1]) expect(dragFromPower(powerFromDrag(d))).toBeCloseTo(d, 9);
  });

  it("keeps the softest putt a legal shot for the room server", () => {
    const softest = shotFromAim(0, powerFromDrag(MIN_DRAG));
    expect(isValidShot(softest)).toBe(true);
    // MIN_POWER is the old smallest stroke (45.6 units a second) as a fraction of the new top speed.
    expect(powerFromDrag(MIN_DRAG)).toBeCloseTo(MIN_POWER, 3);
  });
});
