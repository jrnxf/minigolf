import { describe, expect, it } from "vitest";
import { COURSE_H, COURSE_W } from "../../src/core/constants.ts";
import { HOLES } from "../../src/core/holes.ts";
import { OBL, bake, groundAt, type BakeResult } from "../../src/client/bake.ts";

const RES = 1.5;
const byName = (name: string) => HOLES.find((h) => h.name === name)!;

const bakeHole = (name: string) =>
  bake({ hole: byName(name), x0: 0, y0: 0, wU: COURSE_W, hU: COURSE_H + 16, res: RES });

/** The colour a ground point shows in the baked picture. */
function colorAt(b: BakeResult, x: number, y: number): [number, number, number] {
  const i = Math.round((x - b.x0) * b.res);
  const j = Math.round((y - b.y0 - groundAt(b, x, y) * OBL) * b.res) + b.Mg;
  const p = (j * b.W + i) * 4;
  return [b.pixels[p]!, b.pixels[p + 1]!, b.pixels[p + 2]!];
}

/** Mean colour of a ring of points, so one chip of paint or grain does not decide. */
function meanColor(b: BakeResult, points: [number, number][]): [number, number, number] {
  const sum = [0, 0, 0];
  for (const [x, y] of points) colorAt(b, x, y).forEach((v, c) => (sum[c]! += v));
  return sum.map((v) => v / points.length) as [number, number, number];
}

const around = (cx: number, cy: number, r: number): [number, number][] =>
  Array.from({ length: 12 }, (_, k) => [
    cx + (Math.cos(k) * r * ((k % 3) + 1)) / 3,
    cy + (Math.sin(k) * r * ((k % 4) + 1)) / 4,
  ]);

describe("the baked course look", () => {
  const volcano = bakeHole("Volcano");
  const alley = bakeHole("Sand Alley");

  it("is deterministic", () => {
    const again = bakeHole("Sand Alley");
    expect(Buffer.from(again.pixels).equals(Buffer.from(alley.pixels))).toBe(true);
  });

  it("covers the whole picture with opaque pixels", () => {
    for (const b of [volcano, alley]) {
      expect(b.pixels.length).toBe(b.W * (b.H + b.Mg) * 4);
      for (let p = 3; p < b.pixels.length; p += 4 * 997) expect(b.pixels[p]).toBe(255);
    }
  });

  it("paints green carpet on the course, not velvet-bright and not flat", () => {
    const [r, g, b] = meanColor(alley, around(150, 400, 30));
    expect(g).toBeGreaterThan(r + 30);
    expect(g).toBeGreaterThan(b + 40);
    expect(g).toBeGreaterThan(70);
    expect(g).toBeLessThan(200);
    // The loop weave shows as spread between neighbouring samples.
    const greens = around(150, 400, 30).map(([x, y]) => colorAt(alley, x, y)[1]);
    expect(Math.max(...greens) - Math.min(...greens)).toBeGreaterThan(12);
  });

  it("paints sand pale and warm inside the trap", () => {
    // Sand Alley's upper pocket is x 144-210, y 180-250.
    const [r, g, b] = meanColor(alley, around(177, 215, 22));
    expect(r).toBeGreaterThan(170);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b + 25);
  });

  it("paints red timber on the rails with the course-facing edge in black rubber", () => {
    // The outer rail of the lane is x 90 +/- 9; its course-facing face is a dark strip.
    const rail = meanColor(alley, around(84, 250, 3));
    expect(rail[0]).toBeGreaterThan(rail[1] * 1.6);
    expect(rail[0]).toBeGreaterThan(110);
    const strip = colorAt(alley, 91, 250);
    expect(strip[0]).toBeLessThan(80);
  });

  it("digs the cup dark with a pale rim", () => {
    const cup = byName("Sand Alley").cup;
    const hole = colorAt(alley, cup.x + 3, cup.y + 3);
    expect(Math.max(...hole)).toBeLessThan(70);
    // The rim is a ring about a unit wide: its brightest sample is pale.
    const rim = Array.from({ length: 24 }, (_, k) =>
      Math.min(...colorAt(alley, cup.x + Math.cos(k * 0.26) * 10.3, cup.y + Math.sin(k * 0.26) * 10.3)),
    );
    expect(Math.max(...rim)).toBeGreaterThan(110);
  });

  it("surrounds the course with brown bark mulch", () => {
    const [r, g, b] = meanColor(alley, around(40, 250, 25));
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    expect(r).toBeLessThan(170);
  });

  it("raises the volcano as a steep cone with a red carpet crater around the cup", () => {
    const cup = byName("Volcano").cup;
    const foot = groundAt(volcano, 150, 150 + 63);
    const slope = groundAt(volcano, 150, 150 + 32);
    const lip = groundAt(volcano, 150, 150 + 21);
    const dish = groundAt(volcano, 150, 150 + 8);
    expect(foot).toBeLessThan(2);
    expect(slope).toBeGreaterThan(12);
    expect(lip).toBeGreaterThan(slope);
    expect(lip).toBeGreaterThan(dish);
    const [r, g] = meanColor(volcano, around(cup.x, cup.y + 17, 3));
    expect(r).toBeGreaterThan(g * 1.4);
  });

  it("shades the cone's far side darker than its near side (the sun is up and left)", () => {
    const lum = (c: number[]) => c[0]! * 0.3 + c[1]! * 0.6 + c[2]! * 0.1;
    const lit = lum(meanColor(volcano, around(150 - 36, 150 - 12, 5)));
    const shaded = lum(meanColor(volcano, around(150 + 40, 150 + 28, 5)));
    expect(lit).toBeGreaterThan(shaded + 15);
  });

  it("keeps the course in 3D: posts and walls rise above the ground", () => {
    const post = byName("Sand Alley").bumpers[0]!;
    expect(groundAt(alley, post.x, post.y)).toBeLessThan(0.5); // ground, not the post top
    const lane = bakeHole("The Gate");
    // The wall block casts a shadow to its lower right, darker than open carpet.
    const lum = (c: number[]) => c[0]! * 0.3 + c[1]! * 0.6 + c[2]! * 0.1;
    expect(lum(colorAt(lane, 100, 275))).toBeLessThan(lum(colorAt(lane, 100, 330)) - 10);
  });
});
