// Draws the app icons (a glowing ball putting toward a neon cup) into
// public/icons. Generated at build time so the repo holds no binary images.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const OUT = new URL("../public/icons/", import.meta.url);

type RGB = [number, number, number];
const BG_TOP: RGB = [21, 18, 58];
const BG: RGB = [11, 10, 31];
const CYAN: RGB = [41, 240, 255];
const LIME: RGB = [198, 255, 61];
const WHITE: RGB = [255, 255, 255];

// Icon layout in unit coordinates (0..1), before the maskable safe-zone scale.
const BALL = { x: 0.33, y: 0.69, r: 0.085 };
const CUP = { x: 0.64, y: 0.4, r: 0.12 };
const FLAG = [
  [0.64, 0.28],
  [0.64, 0.12],
  [0.77, 0.165],
  [0.64, 0.21],
] as const;

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const smooth = (edge: number, d: number, aa: number) => Math.max(0, Math.min(1, (edge - d) / aa + 0.5));

function pixel(u: number, v: number, aa: number): RGB {
  const g = Math.min(1, Math.hypot(u - 0.5, v * 0.9) / 0.9);
  let c: RGB = [0, 1, 2].map((i) => BG_TOP[i]! * (1 - g) + BG[i]! * g) as RGB;
  const add = (col: RGB, k: number) => {
    c = c.map((x, i) => Math.min(255, x + col[i]! * k)) as RGB;
  };
  const over = (col: RGB, a: number) => {
    c = c.map((x, i) => x * (1 - a) + col[i]! * a) as RGB;
  };

  // Dotted putt line from the ball's edge to the cup's edge.
  const len = Math.hypot(CUP.x - BALL.x, CUP.y - BALL.y);
  const t0 = (BALL.r + 0.035) / len;
  const t1 = 1 - (CUP.r + 0.035) / len;
  let dot = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = t0 + ((t1 - t0) * i) / 2;
    const x = BALL.x + (CUP.x - BALL.x) * t;
    const y = BALL.y + (CUP.y - BALL.y) * t;
    dot = Math.min(dot, Math.hypot(u - x, v - y));
  }
  add(CYAN, 0.5 * Math.exp(-dot / 0.02));
  over(CYAN, smooth(0.016, dot, aa));

  // Cup: black hole, lime ring and flag, all glowing.
  const dc = Math.hypot(u - CUP.x, v - CUP.y);
  over([0, 0, 0], smooth(CUP.r, dc, aa));
  const ring = Math.abs(dc - CUP.r);
  let flag = Infinity;
  for (let i = 0; i < FLAG.length - 1; i++) {
    const [a, b] = [FLAG[i]!, FLAG[i + 1]!];
    flag = Math.min(flag, segDist(u, v, a[0], a[1], b[0], b[1]));
  }
  const lime = Math.min(ring, flag);
  add(LIME, 0.55 * Math.exp(-lime / 0.03));
  over(LIME, smooth(0.014, lime, aa));

  // Ball: white with a cyan rim and a strong glow.
  const db = Math.hypot(u - BALL.x, v - BALL.y);
  add(CYAN, 0.9 * Math.exp(-Math.max(0, db - BALL.r) / 0.045));
  over(CYAN, smooth(BALL.r, db, aa));
  over(WHITE, smooth(BALL.r - 0.022, db, aa));
  return c;
}

function png(size: number, scale: number): Buffer {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  const aa = (1.2 * scale) / size;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // Shrink the art toward the middle for maskable icons.
      const u = 0.5 + ((x + 0.5) / size - 0.5) * scale;
      const v = 0.5 + ((y + 0.5) / size - 0.5) * scale;
      const [r, g, b] = pixel(u, v, aa);
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(r);
      raw[o + 1] = Math.round(g);
      raw[o + 2] = Math.round(b);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <radialGradient id="bg" cx="50%" cy="0%" r="100%"><stop offset="0" stop-color="#15123a"/><stop offset="1" stop-color="#0b0a1f"/></radialGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#bg)"/>
  <g filter="url(#glow)" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <path d="M33 69 L64 40" stroke="#29f0ff" stroke-width="3" stroke-dasharray="0.1 4.4"/>
    <circle cx="64" cy="40" r="12" fill="#000" stroke="#c6ff3d" stroke-width="2.8"/>
    <path d="M64 28 V12 L77 16.5 L64 21" stroke="#c6ff3d" stroke-width="2.8"/>
    <circle cx="33" cy="69" r="7.4" fill="#fff" stroke="#29f0ff" stroke-width="2.6"/>
  </g>
</svg>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL("icon.svg", OUT), svg);
writeFileSync(new URL("icon-192.png", OUT), png(192, 1));
writeFileSync(new URL("icon-512.png", OUT), png(512, 1));
writeFileSync(new URL("icon-maskable-512.png", OUT), png(512, 1.25));
writeFileSync(new URL("apple-touch-icon.png", OUT), png(180, 1.1));
