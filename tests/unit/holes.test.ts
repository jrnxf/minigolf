import { describe, expect, it } from "vitest";
import { COURSE_PAR, HOLES } from "../../src/core/holes.ts";
import { findShot } from "../../src/core/solver.ts";

const NAMES = [
  "The Gate",
  "Dogleg",
  "The Ramp",
  "Pinball",
  "Switchback",
  "Volcano",
  "Bank Shot",
  "Sand Alley",
  "Crosswind",
  "Diamond",
  "Hairpin",
  "Pinwheel",
  "Twin Peaks",
  "Ricochet Row",
  "Keyhole",
  "Slide",
  "Bunker Blast",
  "Bank Vault",
];

describe("the course", () => {
  it("has the 18 holes in order", () => {
    expect(HOLES.map((h) => h.name)).toEqual(NAMES);
    expect(COURSE_PAR).toBe(HOLES.reduce((s, h) => s + h.par, 0));
  });

  // The solver tries 180 angles x 16 powers from the tee; a hole it cannot ace
  // has no one-stroke line at the new top power.
  it.each(HOLES.map((h) => [h.name, h] as const))("%s has a hole-in-one line", (_name, hole) => {
    const found = findShot(hole, hole.tee);
    expect(found.sunk).toBe(true);
  });
});
