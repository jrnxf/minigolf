// Neon canvas renderer. The course (floor, walls, sand) is drawn once per
// hole and size into an offscreen layer, since glow blur is expensive on
// phones; each frame only draws what moves on top of it.

import { BALL_R, COURSE_H, COURSE_W, CUP_R } from "../core/constants.ts";
import type { Hole, Point } from "../core/holes.ts";

export const COLORS = {
  p1: "#29f0ff",
  p2: "#ff3fb4",
  lime: "#c6ff3d",
  violet: "#7b5cff",
  amber: "#ffb020",
  sand: "255,170,60",
  ink: "#f3f0ff",
};

export const PLAYER_COLORS = [COLORS.p1, COLORS.p2] as const;

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

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layer = document.createElement("canvas");
  private layerKey = "";
  /** Course-to-screen transform in CSS pixels. */
  s = 1;
  ox = 0;
  oy = 0;
  private dpr = 1;
  private w = 0;
  private h = 0;

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
    const pad = 10;
    this.s = Math.min((r.width - pad * 2) / COURSE_W, (r.height - pad * 2) / COURSE_H);
    this.ox = (r.width - COURSE_W * this.s) / 2;
    this.oy = (r.height - COURSE_H * this.s) / 2;
    this.layerKey = "";
  }

  /** Forces the course layer to redraw, e.g. after web fonts load. */
  invalidate(): void {
    this.layerKey = "";
  }

  toCourse(sx: number, sy: number): Point {
    return { x: (sx - this.ox) / this.s, y: (sy - this.oy) / this.s };
  }

  draw(scene: Scene, t: number): void {
    const { ctx, dpr } = this;
    if (!this.w) this.resize();
    if (!this.w) return;
    const key = `${scene.hole.name}|${this.canvas.width}x${this.canvas.height}`;
    if (key !== this.layerKey) {
      this.paintLayer(scene.hole);
      this.layerKey = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);

    this.toCourseSpace(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawSlopes(ctx, scene.hole, t);
    drawMounds(ctx, scene.hole, t);
    drawBumpers(ctx, scene.hole, t, dpr);
    drawCup(ctx, scene.hole, t, dpr);
    if (scene.aim) drawAim(ctx, scene.aim, dpr);
    if (scene.trail) drawTrail(ctx, scene.trail.points, scene.trail.color);
    for (const ball of scene.balls) drawBall(ctx, ball, dpr);
    if (scene.joystick) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawJoystick(ctx, scene.joystick, dpr);
    }
  }

  private toCourseSpace(ctx: CanvasRenderingContext2D) {
    const { dpr, s, ox, oy } = this;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
  }

  private paintLayer(hole: Hole) {
    const layer = this.layer;
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const ctx = layer.getContext("2d")!;
    ctx.clearRect(0, 0, layer.width, layer.height);
    this.toCourseSpace(ctx);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const outline = () => {
      ctx.beginPath();
      hole.outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    };

    // Floor and grid.
    outline();
    ctx.fillStyle = "rgba(41,240,255,0.035)";
    ctx.fill();
    ctx.save();
    outline();
    ctx.clip();
    ctx.strokeStyle = "rgba(143,136,201,0.13)";
    ctx.lineWidth = 1 / this.s;
    ctx.beginPath();
    for (let x = 0; x <= COURSE_W; x += 25) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, COURSE_H);
    }
    for (let y = 0; y <= COURSE_H; y += 25) {
      ctx.moveTo(0, y);
      ctx.lineTo(COURSE_W, y);
    }
    ctx.stroke();
    ctx.restore();

    // Tee pad.
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = "rgba(243,240,255,0.22)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(hole.tee.x - 18, hole.tee.y - 12, 36, 24, 8);
    ctx.stroke();
    ctx.restore();

    for (const r of hole.sand) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(r.x + 4, r.y + 4, r.w - 8, r.h - 8, 14);
      ctx.fillStyle = `rgba(${COLORS.sand},0.09)`;
      ctx.fill();
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = `rgba(${COLORS.sand},0.6)`;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = `rgba(${COLORS.sand},0.6)`;
      ctx.font = '600 9px "Outfit Variable", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("SAND", r.x + r.w / 2, r.y + r.h / 2);
    }

    for (const s of hole.slopes) {
      ctx.fillStyle = "rgba(123,92,255,0.07)";
      ctx.fillRect(s.x, s.y, s.w, s.h);
    }

    // Walls glow twice: a wide soft pass and a crisp core.
    const walls = () => {
      outline();
      for (const b of hole.blocks) ctx.roundRect(b.x, b.y, b.w, b.h, 4);
      for (const [x1, y1, x2, y2] of hole.rails) {
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
      }
    };
    for (const b of hole.blocks) {
      ctx.fillStyle = "rgba(123,92,255,0.16)";
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, 4);
      ctx.fill();
    }
    glow(ctx, walls, COLORS.violet, 3, 18, this.dpr);
    ctx.strokeStyle = "rgba(214,204,255,0.85)";
    ctx.lineWidth = 1;
    walls();
    ctx.stroke();
  }
}

function glow(
  ctx: CanvasRenderingContext2D,
  path: () => void,
  color: string,
  width: number,
  blur: number,
  dpr: number,
) {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * dpr;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  path();
  ctx.stroke();
  ctx.restore();
}

function drawSlopes(ctx: CanvasRenderingContext2D, hole: Hole, t: number) {
  for (const s of hole.slopes) {
    const len = Math.hypot(s.ax, s.ay);
    const dx = s.ax / len;
    const dy = s.ay / len;
    const gap = 22;
    const shift = (t * 26) % gap;
    ctx.save();
    ctx.beginPath();
    ctx.rect(s.x, s.y, s.w, s.h);
    ctx.clip();
    ctx.strokeStyle = "rgba(164,139,255,0.42)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    // Chevrons that drift downhill, laid out across the slope.
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const span = Math.max(s.w, s.h);
    for (let along = -span; along <= span; along += gap) {
      for (let across = -span; across <= span; across += 34) {
        const px = cx + dx * (along + shift) - dy * across;
        const py = cy + dy * (along + shift) + dx * across;
        ctx.moveTo(px - dx * 6 - dy * 8, py - dy * 6 + dx * 8);
        ctx.lineTo(px, py);
        ctx.lineTo(px - dx * 6 + dy * 8, py - dy * 6 - dx * 8);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}

function drawMounds(ctx: CanvasRenderingContext2D, hole: Hole, t: number) {
  for (const m of hole.mounds) {
    // Contour rings; a hill's ripples run outward, a bowl's inward.
    ctx.save();
    for (let i = 0; i < 4; i++) {
      let k = (i / 4 + t * 0.25) % 1;
      if (m.strength < 0) k = 1 - k;
      ctx.globalAlpha = 0.5 * (1 - k) + 0.1;
      ctx.strokeStyle = "rgba(164,139,255,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(m.x, m.y, CUP_R + 4 + k * (m.r - CUP_R - 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawBumpers(ctx: CanvasRenderingContext2D, hole: Hole, t: number, dpr: number) {
  for (const b of hole.bumpers) {
    const pulse = 0.6 + Math.sin(t * 3 + b.x) * 0.4;
    ctx.fillStyle = "rgba(255,176,32,0.08)";
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    glow(ctx, () => ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2), COLORS.amber, 2.5, 8 + pulse * 10, dpr);
    glow(ctx, () => ctx.arc(b.x, b.y, b.r * 0.45, 0, Math.PI * 2), COLORS.amber, 1.5, 6, dpr);
  }
}

function drawCup(ctx: CanvasRenderingContext2D, hole: Hole, t: number, dpr: number) {
  const c = hole.cup;
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.arc(c.x, c.y, CUP_R, 0, Math.PI * 2);
  ctx.fill();
  glow(ctx, () => ctx.arc(c.x, c.y, CUP_R, 0, Math.PI * 2), COLORS.lime, 2, 14, dpr);
  const wave = Math.sin(t * 2.4) * 1.5;
  glow(
    ctx,
    () => {
      ctx.moveTo(c.x, c.y - CUP_R);
      ctx.lineTo(c.x, c.y - 40);
      ctx.lineTo(c.x + 18, c.y - 33 + wave);
      ctx.lineTo(c.x, c.y - 27);
    },
    COLORS.lime,
    2,
    10,
    dpr,
  );
  const k = (t * 0.8) % 1;
  ctx.save();
  ctx.globalAlpha = 1 - k;
  ctx.strokeStyle = COLORS.lime;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(c.x, c.y, CUP_R + k * 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawAim(ctx: CanvasRenderingContext2D, aim: AimSprite, dpr: number) {
  const pts = aim.path;
  const n = pts.length / 2;
  if (n < 2) return;
  const base = aim.ghost ? 0.5 : 1;
  ctx.save();
  ctx.shadowColor = aim.color;
  ctx.shadowBlur = 10 * dpr;
  ctx.strokeStyle = aim.color;
  ctx.lineWidth = 2.5;
  ctx.setLineDash([1, 7]);
  // Fade along the path in a few chunks so the far end trails off.
  const chunks = 6;
  for (let c = 0; c < chunks; c++) {
    const from = Math.floor((c / chunks) * (n - 1));
    const to = Math.floor(((c + 1) / chunks) * (n - 1));
    ctx.globalAlpha = base * (1 - (c / chunks) * 0.8);
    ctx.beginPath();
    ctx.moveTo(pts[from * 2]!, pts[from * 2 + 1]!);
    for (let i = from + 1; i <= to; i++) ctx.lineTo(pts[i * 2]!, pts[i * 2 + 1]!);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineWidth = 1.5;
  for (const b of aim.bounces) {
    ctx.globalAlpha = base * 0.9;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 4, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Where the preview ends.
  ctx.globalAlpha = base * 0.5;
  ctx.fillStyle = aim.color;
  ctx.beginPath();
  ctx.arc(pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!, 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTrail(ctx: CanvasRenderingContext2D, points: Point[], color: string) {
  ctx.save();
  ctx.fillStyle = color;
  points.forEach((p, i) => {
    const k = (i + 1) / points.length;
    ctx.globalAlpha = k * 0.35;
    ctx.beginPath();
    ctx.arc(p.x, p.y, BALL_R * k * 0.9, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function drawBall(ctx: CanvasRenderingContext2D, ball: BallSprite, dpr: number) {
  if (ball.sink >= 1) return;
  const r = BALL_R * (1 - ball.sink * 0.8);
  ctx.save();
  ctx.globalAlpha = (ball.active ? 1 : 0.5) * (1 - ball.sink * 0.6);
  ctx.shadowColor = ball.color;
  ctx.shadowBlur = (ball.active ? 18 : 6) * dpr;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.arc(ball.x, ball.y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = ball.color;
  ctx.stroke();
  ctx.restore();
}

function drawJoystick(ctx: CanvasRenderingContext2D, j: Joystick, dpr: number) {
  const R = 36;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(243,240,255,0.25)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(j.x, j.y, R, 0, Math.PI * 2);
  ctx.stroke();
  ctx.shadowColor = j.color;
  ctx.shadowBlur = 12 * dpr;
  ctx.strokeStyle = j.color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(j.x, j.y, R, -Math.PI / 2, -Math.PI / 2 + j.power * Math.PI * 2);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.setLineDash([4, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = "rgba(243,240,255,0.6)";
  ctx.beginPath();
  ctx.moveTo(j.x, j.y);
  ctx.lineTo(j.cx, j.cy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(243,240,255,0.9)";
  ctx.beginPath();
  ctx.arc(j.cx, j.cy, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '15px "Bungee", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = j.color;
  ctx.shadowColor = j.color;
  ctx.shadowBlur = 8 * dpr;
  ctx.fillText(`${Math.round(j.power * 100)}%`, j.x, j.y - R - 12);
  ctx.restore();
}
