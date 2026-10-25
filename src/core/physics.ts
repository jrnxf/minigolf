// Deterministic ball physics. The step uses only + - * / and Math.sqrt on
// plain numbers, with a fixed timestep, so the room server and every phone
// get the same path from the same shot. No Math.exp, Math.hypot or trig in
// here: those may round differently between JavaScript engines.

import {
  BALL_R,
  BUMPER_E,
  CUP_R,
  CUP_SLOPE_PULL,
  CUP_SLOPE_SPEED,
  CUP_SLOPE_W,
  DECEL,
  DRAG_GRASS,
  DRAG_SAND,
  H,
  MAX_SPEED,
  MAX_TICKS,
  MIN_POWER,
  SAND_FACTOR,
  SINK_SPEED,
  STOP_SPEED,
  SUBSTEPS,
  WALL_E,
} from "./constants.ts";
import type { Hole, Point, Rect, Segment } from "./holes.ts";

/** A stroke: the ball's starting velocity in whole course units per second. */
export interface Shot {
  vx: number;
  vy: number;
}

export type ShotEventKind = "wall" | "bumper" | "lip" | "sink";

export interface ShotEvent {
  tick: number;
  kind: ShotEventKind;
  /** Impact speed for wall and bumper hits. */
  v: number;
}

export interface ShotResult {
  end: Point;
  sunk: boolean;
  /** Ticks until the ball came to rest or dropped. */
  ticks: number;
  /** Ball position after every tick, flattened as x0, y0, x1, y1, ... (start included). */
  trace: number[];
  events: ShotEvent[];
}

interface SimBall {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** True from a lip-out until the ball is clear of the cup again. */
  lipped: boolean;
}

function inRect(p: Point, r: Rect): boolean {
  return p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h;
}

export function inSand(hole: Hole, p: Point): boolean {
  return hole.sand.some((r) => inRect(p, r));
}

function collideSegment(ball: SimBall, s: Segment): number {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1;
  const dy = y2 - y1;
  let t = ((ball.x - x1) * dx + (ball.y - y1) * dy) / (dx * dx + dy * dy);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  return bounce(ball, px, py, BALL_R, WALL_E);
}

function bounce(ball: SimBall, px: number, py: number, min: number, e: number): number {
  let nx = ball.x - px;
  let ny = ball.y - py;
  const d = Math.sqrt(nx * nx + ny * ny);
  if (d >= min || d === 0) return 0;
  nx /= d;
  ny /= d;
  ball.x = px + nx * min;
  ball.y = py + ny * min;
  const vn = ball.vx * nx + ball.vy * ny;
  if (vn >= 0) return 0;
  ball.vx -= (1 + e) * vn * nx;
  ball.vy -= (1 + e) * vn * ny;
  return -vn;
}

type StepOutcome = "roll" | "stop" | "sink";

function substep(ball: SimBall, hole: Hole, hit: (kind: ShotEventKind, v: number) => void): StepOutcome {
  const sandy = inSand(hole, ball);
  const decel = sandy ? DECEL * SAND_FACTOR : DECEL;

  // Tilted ground: slopes push one way, mounds push away from (or toward) their middle.
  let ax = 0;
  let ay = 0;
  for (const s of hole.slopes) {
    if (inRect(ball, s)) {
      ax += s.ax;
      ay += s.ay;
    }
  }
  for (const m of hole.mounds) {
    const dx = ball.x - m.x;
    const dy = ball.y - m.y;
    if (dx * dx + dy * dy < m.r * m.r) {
      ax += (dx * m.strength) / m.r;
      ay += (dy * m.strength) / m.r;
    }
  }
  // A ball can only rest where friction beats the tilt.
  const steep = ax * ax + ay * ay > decel * decel;
  ball.vx += ax * H;
  ball.vy += ay * H;

  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy);
  const slowed = speed - decel * H;
  const next = (slowed > 0 ? slowed : 0) * (sandy ? DRAG_SAND : DRAG_GRASS);
  if (next < STOP_SPEED && !steep) {
    ball.vx = 0;
    ball.vy = 0;
    return "stop";
  }
  if (speed > 0) {
    ball.vx *= next / speed;
    ball.vy *= next / speed;
  }
  ball.x += ball.vx * H;
  ball.y += ball.vy * H;

  for (const s of hole.walls) {
    const v = collideSegment(ball, s);
    if (v) hit("wall", v);
  }
  for (const b of hole.bumpers) {
    const v = bounce(ball, b.x, b.y, BALL_R + b.r, BUMPER_E);
    if (v) hit("bumper", v);
  }

  const cx = hole.cup.x - ball.x;
  const cy = hole.cup.y - ball.y;
  const dc = Math.sqrt(cx * cx + cy * cy);
  if (dc < CUP_R) {
    if (ball.lipped) return "roll";
    if (next < SINK_SPEED) {
      ball.x = hole.cup.x;
      ball.y = hole.cup.y;
      ball.vx = 0;
      ball.vy = 0;
      return "sink";
    }
    // Too hot: the lip grabs it, takes some pace and throws it off line.
    ball.lipped = true;
    ball.vx = ball.vx * 0.8 + cx * 6;
    ball.vy = ball.vy * 0.8 + cy * 6;
    hit("lip", next);
  } else {
    if (dc > CUP_R + 2) ball.lipped = false;
    if (dc < CUP_R + CUP_SLOPE_W && next < CUP_SLOPE_SPEED) {
      // Gentle break into the cup so a near miss at walking pace still drops.
      ball.vx += (cx / dc) * CUP_SLOPE_PULL * H;
      ball.vy += (cy / dc) * CUP_SLOPE_PULL * H;
    }
  }
  return "roll";
}

export interface SimulateOptions {
  /** Record the per-tick path for animation. Off on the server. */
  trace?: boolean;
  /** Stop after this much travel (course units). Used for the aim preview. */
  maxDistance?: number;
}

/** Plays one shot from `from` until the ball rests, drops, or the time cap hits. */
export function simulateShot(hole: Hole, from: Point, shot: Shot, opts: SimulateOptions = {}): ShotResult {
  const ball: SimBall = { x: from.x, y: from.y, vx: shot.vx, vy: shot.vy, lipped: false };
  const trace: number[] = opts.trace === false ? [] : [ball.x, ball.y];
  const events: ShotEvent[] = [];
  const maxDistance = opts.maxDistance ?? Infinity;
  let tick = 0;
  let travelled = 0;
  let outcome: StepOutcome = "roll";
  const hit = (kind: ShotEventKind, v: number) => {
    const last = events[events.length - 1];
    // One sound per tick is plenty; keep the stronger impact.
    if (last && last.tick === tick && last.kind === kind) last.v = Math.max(last.v, v);
    else events.push({ tick, kind, v });
  };

  while (outcome === "roll" && tick < MAX_TICKS && travelled < maxDistance) {
    tick += 1;
    const px = ball.x;
    const py = ball.y;
    for (let i = 0; i < SUBSTEPS && outcome === "roll"; i++) outcome = substep(ball, hole, hit);
    if (opts.trace !== false) trace.push(ball.x, ball.y);
    const mx = ball.x - px;
    const my = ball.y - py;
    travelled += Math.sqrt(mx * mx + my * my);
  }
  if (outcome === "sink") events.push({ tick, kind: "sink", v: 0 });
  return { end: { x: ball.x, y: ball.y }, sunk: outcome === "sink", ticks: tick, trace, events };
}

/** Turns an aim (direction in radians, power 0..1) into a whole-unit shot. */
export function shotFromAim(angle: number, power: number): Shot {
  const p = Math.max(0, Math.min(1, power)) * MAX_SPEED;
  return { vx: Math.round(Math.cos(angle) * p), vy: Math.round(Math.sin(angle) * p) };
}

export function shotSpeed(shot: Shot): number {
  return Math.sqrt(shot.vx * shot.vx + shot.vy * shot.vy);
}

/** True for a shot a player could really make: whole numbers within the power range. */
export function isValidShot(shot: unknown): shot is Shot {
  if (typeof shot !== "object" || shot === null) return false;
  const { vx, vy } = shot as Record<string, unknown>;
  if (!Number.isInteger(vx) || !Number.isInteger(vy)) return false;
  const speed = shotSpeed(shot as Shot);
  return speed >= MIN_POWER * MAX_SPEED - 1 && speed <= MAX_SPEED + 1;
}

/** The predicted path for the aim preview, cut off at `length` course units. */
export function previewPath(hole: Hole, from: Point, shot: Shot, length: number): number[] {
  return simulateShot(hole, from, shot, { maxDistance: length }).trace;
}
