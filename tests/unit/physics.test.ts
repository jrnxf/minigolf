import { describe, expect, it } from "vitest";
import { BALL_R, MAX_SPEED, MAX_TICKS } from "../../src/core/constants.ts";
import { HOLES, type Hole, type Point } from "../../src/core/holes.ts";
import {
  inSand,
  isValidShot,
  previewPath,
  shotFromAim,
  simulateShot,
  type Shot,
} from "../../src/core/physics.ts";
import { findShot, pathDistance } from "../../src/core/solver.ts";

const [gate, dogleg, ramp, , switchback, volcano] = HOLES as [Hole, Hole, Hole, Hole, Hole, Hole];

function insideOutline(hole: Hole, p: Point): boolean {
  let inside = false;
  const poly = hole.outline;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A small seeded random generator so the fuzz tests are repeatable. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe("simulateShot", () => {
  it("is deterministic: the same shot gives the same path", () => {
    const shot = { vx: -310, vy: -655 };
    const a = simulateShot(dogleg, dogleg.tee, shot);
    const b = simulateShot(dogleg, dogleg.tee, shot);
    expect(b.trace).toEqual(a.trace);
    expect(b.events).toEqual(a.events);
  });

  it("matches the recorded result for a fixed shot (changing physics breaks online play)", () => {
    const r = simulateShot(dogleg, dogleg.tee, { vx: -310, vy: -655 }, { trace: false });
    expect(r.ticks).toBe(GOLDEN.ticks);
    expect(r.end.x).toBe(GOLDEN.x);
    expect(r.end.y).toBe(GOLDEN.y);
  });

  it("bounces off a wall with some energy lost", () => {
    // Straight down from the tee into the bottom wall.
    const r = simulateShot(gate, gate.tee, { vx: 0, vy: 400 });
    expect(r.events[0]?.kind).toBe("wall");
    expect(r.end.y).toBeLessThan(gate.tee.y);
    expect(r.end.x).toBe(gate.tee.x);
  });

  it("bounces off bumpers harder than walls", () => {
    // The bumper sits right on the line from the tee to the cup.
    const r = simulateShot(gate, gate.tee, { vx: 0, vy: -700 });
    expect(r.events.some((e) => e.kind === "bumper")).toBe(true);
    expect(r.sunk).toBe(false);
  });

  it("slows the ball in sand", () => {
    const from = { x: 75, y: 400 };
    const shot = { vx: 0, vy: -260 };
    const withSand = simulateShot(dogleg, from, shot, { trace: false });
    const noSand = simulateShot({ ...dogleg, sand: [] }, from, shot, { trace: false });
    expect(inSand(dogleg, { x: 75, y: 280 })).toBe(true);
    expect(withSand.end.y).toBeGreaterThan(noSand.end.y + 20);
  });

  it("rolls a ball back down a slope it cannot climb", () => {
    const r = simulateShot(ramp, ramp.tee, { vx: 0, vy: -330 }, { trace: false });
    // It reaches the ramp but ends below it.
    expect(r.end.y).toBeGreaterThan(290);
  });

  it("never lets a ball rest on a slope steeper than friction", () => {
    const from = { x: 150, y: 240 };
    const r = simulateShot(ramp, from, { vx: 0, vy: -46 }, { trace: false });
    expect(r.end.y).toBeGreaterThan(290);
    expect(r.ticks).toBeLessThan(MAX_TICKS);
  });

  it("drops a ball at a sensible pace", () => {
    const r = simulateShot(volcano, volcano.tee, { vx: 0, vy: -600 });
    expect(r.sunk).toBe(true);
    expect(r.end).toEqual(volcano.cup);
    expect(r.events.at(-1)?.kind).toBe("sink");
  });

  it("lips out a ball that is too fast", () => {
    const hole = { ...gate, bumpers: [], blocks: [], walls: gate.walls.slice(0, 4) };
    const r = simulateShot(hole, { x: 150, y: 300 }, { vx: 0, vy: -MAX_SPEED });
    const lip = r.events.find((e) => e.kind === "lip");
    expect(lip).toBeDefined();
    // It flies on past the cup; it may only drop later, after coming back off the wall.
    const wall = r.events.find((e) => e.kind === "wall");
    expect(wall!.tick).toBeGreaterThan(lip!.tick);
    if (r.sunk) expect(r.events.at(-1)!.tick).toBeGreaterThan(wall!.tick);
  });

  it("lets a slow near miss fall in", () => {
    const hole = { ...gate, bumpers: [] };
    const from = { x: gate.cup.x + 16, y: gate.cup.y + 40 };
    const r = simulateShot(hole, from, { vx: 0, vy: -125 });
    expect(r.sunk).toBe(true);
  });

  it("keeps every ball inside the course and always comes to rest", () => {
    const rand = rng(7);
    for (const hole of HOLES) {
      for (let i = 0; i < 60; i++) {
        const shot = shotFromAim(rand() * Math.PI * 2, 0.1 + rand() * 0.9);
        const r = simulateShot(hole, hole.tee, shot, { trace: false });
        expect(r.ticks, `${hole.name} ${JSON.stringify(shot)}`).toBeLessThan(MAX_TICKS);
        expect(insideOutline(hole, r.end), `${hole.name} ${JSON.stringify(shot)}`).toBe(true);
        for (const b of hole.blocks) {
          const inBlock = r.end.x > b.x && r.end.x < b.x + b.w && r.end.y > b.y && r.end.y < b.y + b.h;
          expect(inBlock, hole.name).toBe(false);
        }
      }
    }
  });
});

describe("shots", () => {
  it("turns an aim into whole units", () => {
    expect(shotFromAim(-Math.PI / 2, 0.5)).toEqual({ vx: 0, vy: -380 });
    expect(shotFromAim(0, 2)).toEqual({ vx: MAX_SPEED, vy: 0 });
  });

  it("accepts only shots a player could make", () => {
    expect(isValidShot({ vx: 0, vy: -380 })).toBe(true);
    expect(isValidShot({ vx: 0, vy: -1 })).toBe(false);
    expect(isValidShot({ vx: 0, vy: -2000 })).toBe(false);
    expect(isValidShot({ vx: 0.5, vy: -300 })).toBe(false);
    expect(isValidShot({ vx: "1", vy: -300 })).toBe(false);
    expect(isValidShot(null)).toBe(false);
  });

  it("previews a path that follows bounces but stops at the given length", () => {
    const shot: Shot = { vx: 0, vy: 400 };
    const pts = previewPath(gate, gate.tee, shot, 120);
    let len = 0;
    for (let i = 2; i < pts.length; i += 2)
      len += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!);
    expect(len).toBeGreaterThanOrEqual(120);
    expect(len).toBeLessThan(140);
    // It went down, hit the wall and came back up.
    const ys = pts.filter((_, i) => i % 2 === 1);
    expect(Math.max(...ys)).toBeGreaterThan(gate.tee.y + 30);
    expect(ys.at(-1)!).toBeLessThan(Math.max(...ys));
  });
});

describe("holes", () => {
  it("has six holes with par 2 to 4", () => {
    expect(HOLES).toHaveLength(6);
    for (const h of HOLES) expect(h.par).toBeGreaterThanOrEqual(2);
    for (const h of HOLES) expect(h.par).toBeLessThanOrEqual(4);
  });

  it("puts tee and cup inside the course, clear of walls", () => {
    for (const h of HOLES) {
      for (const p of [h.tee, h.cup]) {
        expect(insideOutline(h, p), h.name).toBe(true);
        expect(pathDistance(h, p), h.name).toBeLessThan(Infinity);
        for (const b of h.bumpers)
          expect(Math.hypot(p.x - b.x, p.y - b.y), h.name).toBeGreaterThan(b.r + BALL_R);
      }
    }
  });

  it("can be finished within par by a good player", () => {
    for (const h of HOLES) {
      let pos: Point = h.tee;
      let strokes = 0;
      let sunk = false;
      while (!sunk && strokes < h.par) {
        const r = simulateShot(h, pos, findShot(h, pos).shot, { trace: false });
        strokes += 1;
        sunk = r.sunk;
        pos = r.end;
      }
      expect(sunk, `${h.name} in ${h.par}`).toBe(true);
    }
  });

  it("makes the switchback walk around its walls", () => {
    expect(pathDistance(switchback, switchback.tee)).toBeGreaterThan(
      Math.hypot(switchback.tee.x - switchback.cup.x, switchback.tee.y - switchback.cup.y) * 1.4,
    );
  });
});

const GOLDEN = { ticks: 203, x: 122.8035975291326, y: 56.59030390281977 };
