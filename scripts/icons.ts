// Draws the app icons (a white ball putting toward a red-flagged cup on loop-pile carpet) into
// public/icons. Generated at build time so the repo holds no binary images.

import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";

const OUT = new URL("../public/icons/", import.meta.url);

type RGB = [number, number, number];
const GRASS_TOP: RGB = [74, 160, 90];
const GRASS: RGB = [52, 124, 70];
const RAIL: RGB = [184, 64, 46];
const CUP_DARK: RGB = [20, 18, 14];
const CUP_RIM: RGB = [241, 239, 233];
const FLAG_RED: RGB = [226, 64, 47];
const POLE: RGB = [232, 232, 232];
const BALL_C: RGB = [255, 255, 255];
const BALL_SHADE: RGB = [176, 176, 168];
const WHITE: RGB = [255, 255, 255];
const LINE: RGB = [244, 246, 234];

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
  // Carpet with a timber rail around the edge.
  const g = Math.min(1, Math.hypot(u - 0.5, v * 0.9) / 0.9);
  let c: RGB = [0, 1, 2].map((i) => GRASS_TOP[i]! * (1 - g) + GRASS[i]! * g) as RGB;
  const over = (col: RGB, a: number) => {
    c = c.map((x, i) => x * (1 - a) + col[i]! * a) as RGB;
  };
  const edge = Math.min(u, v, 1 - u, 1 - v);
  over(RAIL, smooth(0.045, edge, aa));

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
  over(LINE, smooth(0.016, dot, aa));

  // Cup: dark hole with a pale liner rim, and a flag.
  const dc = Math.hypot(u - CUP.x, v - CUP.y);
  over(CUP_RIM, smooth(CUP.r, dc, aa));
  over(CUP_DARK, smooth(CUP.r - 0.02, dc, aa));
  const [pa, pb] = [FLAG[0]!, FLAG[1]!];
  const pole = segDist(u, v, pa[0], pa[1], pb[0], pb[1]);
  over(POLE, smooth(0.01, pole, aa));
  // Flag cloth: the triangle from the top of the pole.
  const [f1, f2, f3] = [FLAG[1]!, FLAG[2]!, FLAG[3]!];
  const inTri = (() => {
    const d = (a: readonly number[], b: readonly number[]) =>
      (u - b[0]!) * (a[1]! - b[1]!) - (a[0]! - b[0]!) * (v - b[1]!);
    const d1 = d(f1, f2);
    const d2 = d(f2, f3);
    const d3 = d(f3, f1);
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
  })();
  if (inTri) over(FLAG_RED, 1);

  // Ball: white with a soft highlight and a shadow.
  const sh = Math.hypot(u - BALL.x - 0.018, v - BALL.y - 0.022);
  over([0, 0, 0], smooth(BALL.r, sh, aa) * 0.3);
  const db = Math.hypot(u - BALL.x, v - BALL.y);
  const lit = Math.hypot(u - BALL.x + BALL.r * 0.3, v - BALL.y + BALL.r * 0.3) / (BALL.r * 1.2);
  const body: RGB = [0, 1, 2].map(
    (i) => BALL_C[i]! * (1 - Math.min(1, lit)) + BALL_SHADE[i]! * Math.min(1, lit),
  ) as RGB;
  over(body, smooth(BALL.r, db, aa));
  over(
    WHITE,
    smooth(BALL.r * 0.22, Math.hypot(u - BALL.x + BALL.r * 0.35, v - BALL.y + BALL.r * 0.35), aa) * 0.85,
  );
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
    <radialGradient id="bg" cx="50%" cy="0%" r="100%"><stop offset="0" stop-color="#4aa05a"/><stop offset="1" stop-color="#347c46"/></radialGradient>
    <radialGradient id="ball" cx="34%" cy="30%" r="75%"><stop offset="0" stop-color="#fff"/><stop offset="0.3" stop-color="#fff"/><stop offset="1" stop-color="#b0b0a8"/></radialGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="#b8402e"/>
  <rect x="4.5" y="4.5" width="91" height="91" rx="18" fill="url(#bg)"/>
  <path d="M33 69 L64 40" stroke="#f4f6ea" stroke-width="3" stroke-linecap="round" stroke-dasharray="0.1 4.4" fill="none"/>
  <circle cx="64" cy="40" r="12" fill="#14120e" stroke="#f1efe9" stroke-width="2.4"/>
  <path d="M64 28 V12" stroke="#e8e8e8" stroke-width="2" stroke-linecap="round" fill="none"/>
  <path d="M64 12 L77 16.5 L64 21 Z" fill="#e2402f"/>
  <circle cx="34.8" cy="71.2" r="7.4" fill="#000" opacity="0.3"/>
  <circle cx="33" cy="69" r="7.4" fill="url(#ball)"/>
</svg>
`;

mkdirSync(OUT, { recursive: true });
writeFileSync(new URL("icon.svg", OUT), svg);
writeFileSync(new URL("icon-192.png", OUT), png(192, 1));
writeFileSync(new URL("icon-512.png", OUT), png(512, 1));
writeFileSync(new URL("icon-maskable-512.png", OUT), png(512, 1.25));
writeFileSync(new URL("apple-touch-icon.png", OUT), png(180, 1.1));
