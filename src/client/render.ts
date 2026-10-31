// Canvas renderer. The course (carpet, rails, posts, sand, volcano) is baked
// once per hole and screen size into a picture, off the main thread, and the
// next hole is baked ahead during play. Each frame blits that picture and draws
// what moves on top: the flag, aim preview, balls and the power ring.

import { BALL_R, COURSE_H, COURSE_W, CUP_R } from "../core/constants.ts";
import { HOLES, type Hole, type Point } from "../core/holes.ts";
import { OBL, SUN, bake, groundAt, type BakeRequest, type BakeResult } from "./bake.ts";

/** Ball colours: orange for the first seat, blue for the second. */
export const PLAYER_COLORS = ["#ff8a1f", "#3b8cff"] as const;

const AIM_COLOR = "#ffffff";
const HALO = "rgba(20,14,10,0.55)";
/** Flag cloth: light, mid and shadow. */
const FLAG = ["#ffd23f", "#ffe878", "#c9a10f"] as const;
const FLAG_INK = "#1d1a10";
const FLOOR_FALLBACK = "#3e8f4e";
const MULCH_FALLBACK = "#5b3d28";
const RAIL_FALLBACK = "#b8402e";
/** Baked pictures kept: this hole, the next one and a couple of spares. */
const CACHE_SIZE = 4;
/** How long a freshly baked course fades in over the plain fallback, in ms. */
const FADE_MS = 220;

export interface BallSprite {
  x: number;
  y: number;
  color: string;
  /** The ball whose turn it is draws brighter. */
  active: boolean;
  /** 0 on the green, 1 fully dropped into the cup. */
  sink: number;
}

export interface AimSprite {
  /** Predicted path as flattened x, y pairs in course units. */
  path: number[];
  /** Where the predicted path bounces. */
  bounces: Point[];
  color: string;
  /** The other player's aim, seen from this phone. */
  ghost: boolean;
}

export interface Joystick {
  /** Touch start and current finger, in CSS pixels on the canvas. */
  x: number;
  y: number;
  cx: number;
  cy: number;
  power: number;
  color: string;
}

export interface Scene {
  hole: Hole;
  balls: BallSprite[];
  trail: { points: Point[]; color: string } | null;
  aim: AimSprite | null;
  joystick: Joystick | null;
}

type Ground = Pick<BakeResult, "ground" | "W" | "H" | "res" | "x0" | "y0">;

interface Entry {
  ground: Ground;
  /** Raw baked pixels until the device-sized picture is made, then dropped. */
  pixels: Uint8ClampedArray<ArrayBuffer> | null;
  Mg: number;
  layer: HTMLCanvasElement | null;
  used: number;
}

/** Runs bakes in a worker, or on the main thread where workers are unavailable. */
class Baker {
  private worker: Worker | null = null;
  private broken = false;
  private seq = 0;
  private waiting = new Map<number, { req: BakeRequest; resolve: (r: BakeResult) => void }>();

  run(req: BakeRequest): Promise<BakeResult> {
    const worker = this.broken ? null : this.start();
    if (!worker) return new Promise((resolve) => setTimeout(() => resolve(bake(req)), 0));
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.waiting.set(id, { req, resolve });
      worker.postMessage({ id, req });
    });
  }

  private start(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(new URL("./bake.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<{ id: number; result: BakeResult }>) => {
        this.waiting.get(e.data.id)?.resolve(e.data.result);
        this.waiting.delete(e.data.id);
      };
      worker.onerror = () => this.fail();
      this.worker = worker;
    } catch {
      this.broken = true;
    }
    return this.worker;
  }

  /** The worker died: bake what is still waiting here instead. */
  private fail() {
    this.broken = true;
    this.worker?.terminate();
    this.worker = null;
    const orphans = [...this.waiting.values()];
    this.waiting.clear();
    for (const { req, resolve } of orphans) setTimeout(() => resolve(bake(req)), 0);
  }
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private baker = new Baker();
  private cache = new Map<string, Entry>();
  private inflight = false;
  private current: { hole: Hole; key: string } | null = null;
  /** When the current course started waiting for its bake, or fading in. */
  private waitSince = 0;
  private fadeSince = 0;
  /** Course-to-screen transform in CSS pixels. */
  s = 1;
  ox = 0;
  oy = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;
  /** Milliseconds the last bake took, and its sample count, for the dev console. */
  lastBake = { ms: 0, samples: 0 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /** Fits the course to the canvas. Call when the canvas changes size. */
  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    const pad = 8;
    this.s = Math.min((r.width - pad * 2) / COURSE_W, (r.height - pad * 2 - 8) / COURSE_H);
    this.ox = (r.width - COURSE_W * this.s) / 2;
    this.oy = (r.height - COURSE_H * this.s) / 2 + 4;
    if (!(this.s > 0.05)) this.w = 0;
    this.current = null;
  }

  /** True once the course on screen is the baked picture (not the plain stand-in). */
  get baked(): boolean {
    return !!this.current && this.cache.has(this.current.key);
  }

  toCourse(sx: number, sy: number): Point {
    return { x: (sx - this.ox) / this.s, y: (sy - this.oy) / this.s };
  }

  private keyFor(hole: Hole) {
    return `${hole.name}|${this.canvas.width}x${this.canvas.height}`;
  }

  private requestFor(hole: Hole): BakeRequest {
    const res = Math.min(3, Math.max(1.5, this.s * this.dpr * 0.72));
    return {
      hole: {
        outline: hole.outline,
        rails: hole.rails,
        slopes: hole.slopes,
        mounds: hole.mounds,
        sand: hole.sand,
        blocks: hole.blocks,
        bumpers: hole.bumpers,
        tee: hole.tee,
        cup: hole.cup,
      },
      x0: -this.ox / this.s,
      y0: -this.oy / this.s,
      wU: this.w / this.s,
      hU: this.h / this.s + 16,
      res,
    };
  }

  /** Bakes one picture at a time: the hole on screen first, then the next hole. */
  private pump() {
    if (this.inflight || !this.current) return;
    const here = this.current.hole;
    const next = HOLES[HOLES.findIndex((h) => h.name === here.name) + 1];
    const want = [here, next].find((h) => h && !this.cache.has(this.keyFor(h)));
    if (!want) return;
    const key = this.keyFor(want);
    const req = this.requestFor(want);
    const t0 = performance.now();
    this.inflight = true;
    void this.baker.run(req).then((r) => {
      this.inflight = false;
      this.lastBake = { ms: performance.now() - t0, samples: r.W * r.H };
      this.cache.set(key, {
        ground: r,
        pixels: r.pixels,
        Mg: r.Mg,
        layer: null,
        used: performance.now(),
      });
      this.evict();
      this.pump();
    });
  }

  private evict() {
    const keep = this.current?.key;
    while (this.cache.size > CACHE_SIZE) {
      let oldest: string | null = null;
      for (const [k, e] of this.cache) {
        if (k !== keep && (oldest === null || e.used < this.cache.get(oldest)!.used)) oldest = k;
      }
      if (oldest === null) break;
      this.cache.delete(oldest);
    }
  }

  /** The baked picture resampled once to device pixels, so each frame is a 1:1 blit. */
  private layerOf(e: Entry): HTMLCanvasElement {
    if (e.layer) return e.layer;
    const { W, H, res, x0, y0 } = e.ground;
    const src = document.createElement("canvas");
    src.width = W;
    src.height = H + e.Mg;
    src.getContext("2d")!.putImageData(new ImageData(e.pixels!, W, H + e.Mg), 0, 0);
    const layer = document.createElement("canvas");
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const l = layer.getContext("2d")!;
    l.setTransform(this.dpr * this.s, 0, 0, this.dpr * this.s, this.dpr * this.ox, this.dpr * this.oy);
    l.imageSmoothingEnabled = true;
    l.imageSmoothingQuality = "high";
    l.drawImage(src, x0, y0 - e.Mg / res, W / res, (H + e.Mg) / res);
    e.layer = layer;
    e.pixels = null;
    return layer;
  }

  private entry(): Entry | undefined {
    return this.current ? this.cache.get(this.current.key) : undefined;
  }

  private ground(x: number, y: number): number {
    const e = this.entry();
    return e ? groundAt(e.ground, x, y) : 0;
  }

  /** Where a point on the ground appears on screen: raised ground rises. */
  private lift(x: number, y: number): number {
    return y - this.ground(x, y) * OBL;
  }

  draw(scene: Scene, t: number): void {
    const { ctx, dpr } = this;
    if (!this.w) this.resize();
    if (!this.w) return;
    const now = performance.now();
    const key = this.keyFor(scene.hole);
    if (this.current?.key !== key) {
      this.current = { hole: scene.hole, key };
      this.waitSince = 0;
      this.fadeSince = 0;
      this.pump();
    }
    const entry = this.entry();
    if (entry) entry.used = now;
    else this.waitSince ||= now;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let fade = 1;
    if (entry && this.waitSince) {
      // The bake took a moment: fade it in over the stand-in rather than pop.
      this.fadeSince = now;
      this.waitSince = 0;
    }
    if (entry && this.fadeSince) {
      fade = Math.min(1, (now - this.fadeSince) / FADE_MS);
      if (fade >= 1) this.fadeSince = 0;
    }
    if (!entry || fade < 1) this.drawStandIn(scene.hole);
    if (entry) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = fade;
      ctx.drawImage(this.layerOf(entry), 0, 0);
      ctx.globalAlpha = 1;
    }

    this.toCourseSpace(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    this.drawFlag(scene.hole, t);
    if (scene.aim) this.drawAim(scene.aim);
    if (scene.trail) this.drawTrail(scene.trail.points, scene.trail.color);
    for (const ball of scene.balls) this.drawBall(ball, t);
    if (scene.joystick) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawJoystick(ctx, scene.joystick);
    }
  }

  private toCourseSpace(ctx: CanvasRenderingContext2D) {
    const { dpr, s, ox, oy } = this;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
  }

  /** Flat colours shown for the moment a course takes to bake. */
  private drawStandIn(hole: Hole) {
    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MULCH_FALLBACK;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.toCourseSpace(ctx);
    ctx.beginPath();
    hole.outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = FLOOR_FALLBACK;
    ctx.fill();
    ctx.lineJoin = "round";
    ctx.lineWidth = 7;
    ctx.strokeStyle = RAIL_FALLBACK;
    ctx.stroke();
  }

  /** The sun's direction on the ground, for cast shadows. */
  private sun(): [number, number] {
    return [-SUN[0] / SUN[2], -SUN[1] / SUN[2]];
  }

  private drawFlag(hole: Hole, t: number) {
    const { ctx } = this;
    const c = hole.cup;
    const cy = this.lift(c.x, c.y);
    const [sx, sy] = this.sun();
    const H = 34;
    const wave = Math.sin(t * 2.4);
    ctx.save();
    // Pole shadow across the ground.
    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(c.x, cy);
    ctx.lineTo(c.x + sx * H * 0.9, cy + sy * H * 0.9);
    ctx.stroke();
    ctx.fillStyle = "rgba(0,0,0,0.16)";
    ctx.beginPath();
    const fx = c.x + sx * H * 0.9;
    const fy = cy + sy * H * 0.9;
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx + sx * -8 + 14, fy + sy * -8 + 4 + wave);
    ctx.lineTo(c.x + sx * H * 0.6, cy + sy * H * 0.6);
    ctx.fill();
    // Pole with a lit edge.
    const top = cy - H;
    ctx.strokeStyle = "#d8d8d8";
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(c.x, cy + 2);
    ctx.lineTo(c.x, top);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(c.x - 0.5, cy);
    ctx.lineTo(c.x - 0.5, top);
    ctx.stroke();
    // Cloth: a quad with a fold shade, numbered with the hole.
    const tipY = top + 7 + wave * 1.6;
    const midX = c.x + 10;
    const g = ctx.createLinearGradient(c.x, 0, c.x + 20, 0);
    g.addColorStop(0, FLAG[0]);
    g.addColorStop(0.5 + wave * 0.12, FLAG[1]);
    g.addColorStop(1, FLAG[2]);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(c.x, top);
    ctx.quadraticCurveTo(midX, top - 1 + wave * 1.5, c.x + 20, tipY);
    ctx.quadraticCurveTo(midX, top + 13 + wave, c.x, top + 13);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = FLAG_INK;
    ctx.font = "800 9px ui-rounded, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(HOLES.findIndex((h) => h.name === hole.name) + 1), c.x + 8, top + 6.6 + wave * 0.5);
    ctx.fillStyle = "#f4f4f4";
    ctx.beginPath();
    ctx.arc(c.x, top - 0.5, 1.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** The preview: a dotted line with a dark halo, so it reads on carpet, sand and mulch alike. */
  private drawAim(aim: AimSprite) {
    const { ctx } = this;
    const pts = aim.path;
    const n = pts.length / 2;
    if (n < 2) return;
    const lifted = new Array<number>(n * 2);
    for (let i = 0; i < n; i++) {
      lifted[i * 2] = pts[i * 2]!;
      lifted[i * 2 + 1] = this.lift(pts[i * 2]!, pts[i * 2 + 1]!);
    }
    const base = aim.ghost ? 0.6 : 1;
    ctx.save();
    ctx.setLineDash([0.1, 7]);
    const chunks = 6;
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass ? AIM_COLOR : HALO;
      ctx.lineWidth = pass ? 3 : 5.2;
      for (let c = 0; c < chunks; c++) {
        const from = Math.floor((c / chunks) * (n - 1));
        const to = Math.floor(((c + 1) / chunks) * (n - 1));
        ctx.globalAlpha = base * (1 - (c / chunks) * 0.75);
        ctx.beginPath();
        ctx.moveTo(lifted[from * 2]!, lifted[from * 2 + 1]!);
        for (let i = from + 1; i <= to; i++) ctx.lineTo(lifted[i * 2]!, lifted[i * 2 + 1]!);
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    // Bounce markers.
    for (const b of aim.bounces) {
      const y = this.lift(b.x, b.y);
      ctx.globalAlpha = base * 0.95;
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = HALO;
      ctx.beginPath();
      ctx.arc(b.x, y, 4.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = AIM_COLOR;
      ctx.beginPath();
      ctx.arc(b.x, y, 4.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Where the preview ends.
    ctx.globalAlpha = base * 0.7;
    ctx.fillStyle = AIM_COLOR;
    ctx.strokeStyle = HALO;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(lifted[(n - 1) * 2]!, lifted[(n - 1) * 2 + 1]!, 2.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private drawTrail(points: Point[], color: string) {
    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = color;
    points.forEach((p, i) => {
      const k = (i + 1) / points.length;
      ctx.globalAlpha = k * 0.3;
      ctx.beginPath();
      ctx.arc(p.x, this.lift(p.x, p.y), BALL_R * k * 0.8, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  private drawBall(ball: BallSprite, t: number) {
    if (ball.sink >= 1) return;
    const { ctx } = this;
    const g = this.ground(ball.x, ball.y);
    const sink = ball.sink;
    const r = BALL_R * (1 + g * 0.006) * (1 - sink * 0.35);
    const gy = ball.y - (g - sink * 9) * OBL; // ground contact point on screen
    const cy = gy - r * OBL * 0.9 * (1 - sink); // the centre sits up off the ground
    const [sx, sy] = this.sun();
    ctx.save();
    if (sink > 0) {
      ctx.beginPath();
      ctx.ellipse(ball.x, this.lift(ball.x, ball.y), CUP_R, CUP_R * 0.95, 0, 0, Math.PI * 2);
      ctx.clip();
    }
    // Whose turn it is: a pale ring on the ground that breathes.
    if (ball.active && sink === 0) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 + Math.sin(t * 4) * 0.2})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(ball.x, gy, r * 1.7, r * 1.7 * 0.6, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Cast shadow, stretched away from the light, then a tight contact shadow.
    const shx = ball.x + sx * r * 0.75;
    const shy = gy + sy * r * 0.75;
    let sg = ctx.createRadialGradient(shx, shy, 0, shx, shy, r * 1.5);
    sg.addColorStop(0, "rgba(0,0,0,0.38)");
    sg.addColorStop(0.55, "rgba(0,0,0,0.2)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.ellipse(shx, shy, r * 1.6, r * 1.25, Math.atan2(sy, sx), 0, Math.PI * 2);
    ctx.fill();
    sg = ctx.createRadialGradient(ball.x, gy, 0, ball.x, gy, r * 0.9);
    sg.addColorStop(0, "rgba(0,0,0,0.45)");
    sg.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.ellipse(ball.x, gy, r * 0.95, r * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    // Sphere.
    const hx = ball.x - sx * r * 0.32;
    const hy = cy - sy * r * 0.32;
    const bg = ctx.createRadialGradient(hx, hy, r * 0.05, ball.x, cy, r * 1.05);
    bg.addColorStop(0, "#ffffff");
    bg.addColorStop(0.3, ball.color);
    bg.addColorStop(0.85, shade(ball.color, 0.62));
    bg.addColorStop(1, shade(ball.color, 0.45));
    ctx.globalAlpha = ball.active ? 1 : 0.88;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.arc(ball.x, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(20,14,10,0.4)";
    ctx.lineWidth = 0.6;
    ctx.stroke();
    // Specular glint.
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.beginPath();
    ctx.ellipse(hx - r * 0.05, hy - r * 0.05, r * 0.26, r * 0.18, -0.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function shade(hex: string, k: number): string {
  const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * k));
  return `rgb(${c.join(",")})`;
}

/** The power ring and drag line, in CSS pixels, with dark halos so they read on any surface. */
function drawJoystick(ctx: CanvasRenderingContext2D, j: Joystick) {
  const R = 36;
  ctx.save();
  ctx.fillStyle = "rgba(20,14,10,0.28)";
  ctx.beginPath();
  ctx.arc(j.x, j.y, R + 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(j.x, j.y, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineCap = "round";
  const end = -Math.PI / 2 + j.power * Math.PI * 2;
  ctx.strokeStyle = "rgba(20,14,10,0.6)";
  ctx.lineWidth = 8.5;
  ctx.beginPath();
  ctx.arc(j.x, j.y, R, -Math.PI / 2, end);
  ctx.stroke();
  ctx.strokeStyle = j.color;
  ctx.lineWidth = 5.5;
  ctx.beginPath();
  ctx.arc(j.x, j.y, R, -Math.PI / 2, end);
  ctx.stroke();
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(255,255,255,0.75)";
  ctx.beginPath();
  ctx.moveTo(j.x, j.y);
  ctx.lineTo(j.cx, j.cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "rgba(20,14,10,0.4)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(j.cx, j.cy, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.font = '800 16px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const label = `${Math.round(j.power * 100)}%`;
  ctx.lineWidth = 4;
  ctx.strokeStyle = "rgba(20,14,10,0.7)";
  ctx.strokeText(label, j.x, j.y - R - 14);
  ctx.fillStyle = "#fff";
  ctx.fillText(label, j.x, j.y - R - 14);
  ctx.restore();
}
