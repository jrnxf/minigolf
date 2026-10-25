// A brute-force shot finder. Tests use it to prove every hole is playable
// and to play whole games the way a decent player would.

import { BALL_R, COURSE_H, COURSE_W, MIN_POWER } from "./constants.ts";
import type { Hole, Point } from "./holes.ts";
import { shotFromAim, simulateShot, type Shot } from "./physics.ts";

export interface FoundShot {
  shot: Shot;
  angle: number;
  power: number;
  sunk: boolean;
  /** Walking distance from where the ball stops to the cup (0 when it drops). */
  miss: number;
}

const CELL = 5;
const COLS = COURSE_W / CELL + 1;
const ROWS = COURSE_H / CELL + 1;

function insidePolygon(p: Point, poly: Hole["outline"]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentDistance(p: Point, [x1, y1, x2, y2]: readonly number[]): number {
  const dx = x2! - x1!;
  const dy = y2! - y1!;
  const t = Math.max(0, Math.min(1, ((p.x - x1!) * dx + (p.y - y1!) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p.x - (x1! + t * dx), p.y - (y1! + t * dy));
}

function open(hole: Hole, p: Point): boolean {
  if (!insidePolygon(p, hole.outline)) return false;
  if (hole.blocks.some((b) => p.x > b.x && p.x < b.x + b.w && p.y > b.y && p.y < b.y + b.h)) return false;
  if (hole.walls.some((w) => segmentDistance(p, w) < BALL_R)) return false;
  return !hole.bumpers.some((b) => Math.hypot(p.x - b.x, p.y - b.y) < b.r + BALL_R);
}

const fields = new WeakMap<Hole, Float64Array>();

/** Shortest walking distance to the cup from every grid cell, around walls and bumpers. */
function distanceField(hole: Hole): Float64Array {
  const cached = fields.get(hole);
  if (cached) return cached;
  const d = new Float64Array(COLS * ROWS).fill(Infinity);
  const free = new Uint8Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) free[r * COLS + c] = open(hole, { x: c * CELL, y: r * CELL }) ? 1 : 0;
  }
  const start = Math.round(hole.cup.y / CELL) * COLS + Math.round(hole.cup.x / CELL);
  d[start] = 0;
  const queue = [start];
  const steps = [
    [1, 0, 1],
    [-1, 0, 1],
    [0, 1, 1],
    [0, -1, 1],
    [1, 1, Math.SQRT2],
    [1, -1, Math.SQRT2],
    [-1, 1, Math.SQRT2],
    [-1, -1, Math.SQRT2],
  ] as const;
  // Small grid, so a plain relaxing queue is quick enough.
  while (queue.length) {
    const i = queue.shift()!;
    const r = Math.floor(i / COLS);
    const c = i % COLS;
    for (const [dc, dr, cost] of steps) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      if (!free[j]) continue;
      const nd = d[i]! + cost * CELL;
      if (nd < d[j]!) {
        d[j] = nd;
        queue.push(j);
      }
    }
  }
  fields.set(hole, d);
  return d;
}

/** Walking distance from a point to the cup. */
export function pathDistance(hole: Hole, p: Point): number {
  const d = distanceField(hole);
  const c0 = Math.round(p.x / CELL);
  const r0 = Math.round(p.y / CELL);
  let best = Infinity;
  for (let r = r0 - 2; r <= r0 + 2; r++) {
    for (let c = c0 - 2; c <= c0 + 2; c++) {
      if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
      best = Math.min(best, d[r * COLS + c]! + Math.hypot(p.x - c * CELL, p.y - r * CELL));
    }
  }
  return best;
}

/**
 * Tries a fan of angles and powers and returns a shot that drops if one
 * exists, otherwise the one that leaves the ball the shortest walk from the
 * cup. Among dropping shots it prefers one whose neighbours also drop, so
 * small input rounding does not turn it into a miss.
 */
export function findShot(hole: Hole, from: Point, angles = 180, powers = 16): FoundShot {
  const grid: FoundShot[][] = [];
  for (let a = 0; a < angles; a++) {
    const angle = (a / angles) * Math.PI * 2;
    const row: FoundShot[] = [];
    for (let p = 0; p < powers; p++) {
      const power = MIN_POWER + ((1 - MIN_POWER) * (p + 1)) / powers;
      const shot = shotFromAim(angle, power);
      const r = simulateShot(hole, from, shot, { trace: false });
      row.push({ shot, angle, power, sunk: r.sunk, miss: r.sunk ? 0 : pathDistance(hole, r.end) });
    }
    grid.push(row);
  }
  let best: FoundShot | null = null;
  let bestScore = Infinity;
  for (let a = 0; a < angles; a++) {
    for (let p = 0; p < powers; p++) {
      const f = grid[a]![p]!;
      if (f.sunk) {
        const stable = grid[(a + angles - 1) % angles]![p]!.sunk || grid[(a + 1) % angles]![p]!.sunk;
        const score = (stable ? 0 : 1) + f.power * 0.1;
        if (score < bestScore) {
          best = f;
          bestScore = score;
        }
      } else if (!best || (!best.sunk && f.miss < best.miss)) {
        best = f;
      }
    }
  }
  return best!;
}
