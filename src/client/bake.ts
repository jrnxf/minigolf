// Bakes a hole into a lit picture: a heightfield of carpet, timber rails, posts,
// sand and a cone-shaped volcano, shaded by a low afternoon sun and drawn with a
// slight oblique camera so raised things show their front faces. It is pure
// (no DOM), so it runs in a worker, and it is deterministic, so a unit test can
// pin the look.
//
// Per sample: geometry -> height and material -> lighting (normal, soft
// shadow, ambient occlusion) -> oblique raster.

import { CUP_R } from "../core/constants.ts";
import type { Hole } from "../core/holes.ts";

/** Screen rise, in course units, per unit of height. */
export const OBL = 0.5;

/** The parts of a hole the bake needs. */
export type BakeHole = Pick<
  Hole,
  "outline" | "rails" | "slopes" | "mounds" | "sand" | "blocks" | "bumpers" | "tee" | "cup"
>;

export interface BakeRequest {
  hole: BakeHole;
  /** Course-space origin and size of the picture. */
  x0: number;
  y0: number;
  wU: number;
  hU: number;
  /** Samples per course unit. */
  res: number;
}

export interface BakeResult {
  /** RGBA, W wide and H + Mg tall: Mg extra rows on top hold what rises above the course. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Ground height per sample (W x H), for lifting the ball, aim and flag. */
  ground: Float32Array<ArrayBuffer>;
  W: number;
  H: number;
  Mg: number;
  res: number;
  x0: number;
  y0: number;
}

export const SUN = [-0.55, -0.5, 0.67] as const;

// ---- look
const AMBIENT = [0.34, 0.38, 0.48] as const;
const SUNLIGHT = [1.28, 1.17, 0.98] as const;
const SHADOW_SOFT = 0.6;
const SHADOW_K = 0.7;
const AO_K = 0.06;
/** Brightness of a front face, relative to the lit top. */
const FACE_K = 0.5;
const VOLCANO = 58;
const MOUND = 32;
/** Rail and outline wall: height, width of the outer wall, profile sharpness. */
const WALL_H = 9;
const WALL_W = 9;
const WALL_P = 9;
const RAIL_R = 4.2;
const RAIL_P = 8;
const BLOCK_BEVEL = 1.4;
const POST_H = 13;
const POST_BEVEL = 0.14;
const POST_P = 7;

// ---- noise
function hash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h & 0xffffff) / 0xffffff;
}

function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, seed: number, oct: number): number {
  let s = 0;
  let a = 0.5;
  let f = 1;
  let n = 0;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x * f, y * f, seed + i * 17);
    n += a;
    a *= 0.5;
    f *= 2.03;
  }
  return s / n;
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

type RGB = readonly [number, number, number];
const hex = (h: string): RGB => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];

/** What a material writes for one sample: colour (0-1) and a height offset. */
type Sample = Float32Array;
function setc(o: Sample, c: RGB, k: number) {
  o[0] = c[0] * k;
  o[1] = c[1] * k;
  o[2] = c[2] * k;
}

// Materials.
const OUT = 0;
const FLOOR = 1;
const WALL = 2;
const SAND = 3;
const BUMP = 4;
const CUP = 5;
const RIM = 6;
const TEE = 7;

// Per-sample context the bake sets before asking for a material: distance to the
// course-facing edge of a wall, bumper radius and distance, and the normalised
// distance to a volcano centre (9 when there is none). Module state, not
// arguments, because the material code is the hot loop.
let _we = 9;
let _br = 1;
let _bd = 0;
let _vc = 9;
let _w1 = 0;
let _w2 = 0;
let _wid = 0;

const RUBBER = hex("#26272a");
const WOOD = hex("#cfae84");
const PAINT_W = hex("#f1efe9");
const FLOOR_C = hex("#3e8f4e");
const CRATER_C = hex("#c9472f");
const WALL_C = hex("#b8402e");
const SAND_C = hex("#e9d6a7");

function worley(x: number, y: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  let f1 = 9;
  let f2 = 9;
  let id = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i;
      const cy = iy + j;
      const px = cx + hash(cx, cy, seed);
      const py = cy + hash(cx, cy, seed + 1);
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = (cx * 7919 + cy * 104729) | 0;
      } else if (d < f2) f2 = d;
    }
  }
  _w1 = Math.sqrt(f1);
  _w2 = Math.sqrt(f2);
  _wid = id;
}

/**
 * Tight-loop outdoor carpet: a 1.6-unit weave of heathered loops, matte. Its
 * texture stays near one cell per unit so it resolves as weave instead of
 * aliasing into a velvet fuzz.
 */
function loopWeave(base: RGB, x: number, y: number, o: Sample) {
  const P = 1.6;
  const row = Math.floor(y / P);
  const u = x / P + (row % 2) * 0.5;
  const col = Math.floor(u);
  const fu = u - col;
  const fv = y / P - row;
  const loop = Math.sin(Math.PI * fu) * Math.sin(Math.PI * fv);
  const yarn = hash(col, row, 221);
  const fade = fbm(x / 50, y / 50, 222, 2);
  const k = (0.62 + loop * 0.42) * (0.92 + fade * 0.12);
  const alt = yarn > 0.72 ? 0.78 : yarn < 0.12 ? 1.16 : 1;
  setc(o, base, k * alt);
  o[3] = loop * 0.45;
}

/** Black rubber tee mat. */
function rubberMat(x: number, y: number, o: Sample) {
  const g = hash(Math.floor(x * 2.5), Math.floor(y * 2.5), 111);
  const dimple = vnoise(x * 0.9, y * 0.9, 112);
  setc(o, RUBBER, 0.95 + g * 0.12);
  o[3] = dimple > 0.6 ? -0.15 : 0;
}

/** Loose sand: grains at three scales, soft drifts and scuffs, no regular pattern. */
function sandSurf(x: number, y: number, o: Sample) {
  const g1 = hash(Math.floor(x * 4.3), Math.floor(y * 4.3), 121);
  const g2 = hash(Math.floor(x * 2.2), Math.floor(y * 2.2), 122);
  const drift = fbm(x / 7, y / 7, 123, 3);
  const scuff = Math.max(0, vnoise(x / 5.5, y / 4.5, 124) - 0.62);
  let k = 0.82 + g1 * 0.2 + (g2 - 0.5) * 0.1 + (drift - 0.5) * 0.14 - scuff * 0.5;
  if (g1 > 0.965) k *= 0.62;
  else if (g1 < 0.03) k *= 1.18;
  setc(o, SAND_C, k);
  o[3] = (drift - 0.5) * 1.6 - scuff * 2.2 + g1 * 0.3 + g2 * 0.15;
}

/** Plastic cup liner: pale wall near the rim, dark below. */
function cupIn(cd: number, o: Sample) {
  const t = sstep(CUP_R - 6, CUP_R - 1.3, cd);
  const v = 0.08 + 0.55 * t;
  o[0] = v;
  o[1] = v;
  o[2] = v + 0.01;
  o[3] = 0;
}

/** Plain bark mulch around the course. */
function mulch(x: number, y: number, o: Sample) {
  worley(x / 1.7, y / 3.1, 132);
  const edge = sstep(0.02, 0.22, _w2 - _w1);
  const t = hash(_wid, 2, 133);
  const k = 0.5 + edge * 0.5;
  o[0] = (0.36 + t * 0.12) * k;
  o[1] = (0.24 + t * 0.07) * k;
  o[2] = (0.15 + t * 0.04) * k;
  o[3] = edge * 0.7;
}

/** Colour and height detail for a material at a sample (a1, a2: material-specific coordinates). */
function surface(m: number, x: number, y: number, a1: number, a2: number, o: Sample) {
  if (m === FLOOR) return loopWeave(FLOOR_C, x, y, o);
  if (m === OUT) return mulch(x, y, o);
  if (m === SAND) return sandSurf(x, y, o);
  if (m === TEE) return rubberMat(x, y, o);
  if (m === CUP) return cupIn(a1, o);
  let c: RGB;
  let k = 1;
  let dh = 0;
  if (m === WALL) {
    if (_we < 1.5) {
      // Black rubber strip on the course-facing edge.
      c = RUBBER;
      k = 0.9 + hash(Math.floor(a2 * 2), 1, 3) * 0.1;
      dh = -0.4;
    } else {
      // Painted timber: grain along the rail, chipped paint showing pale wood.
      const g = Math.sin(a1 * 2.4 + fbm(a2 * 0.06, a1 * 0.3, 4, 3) * 7);
      const chip = fbm(x / 3.2, y / 3.2, 61, 3) > 0.7;
      c = chip ? WOOD : WALL_C;
      k = 0.9 + 0.07 * g + (fbm(a2 * 0.2, a1, 8, 2) - 0.5) * 0.12;
      dh = g * 0.06 + (Math.abs((a2 % 60) - 30) > 29.5 ? -0.8 : 0);
    }
  } else if (m === BUMP) {
    // Timber post: white painted top with a red band.
    c = _bd > _br * 0.62 ? WALL_C : PAINT_W;
    k = 0.93 + hash(Math.floor(x * 3), Math.floor(y * 3), 5) * 0.08;
  } else c = PAINT_W; // RIM
  setc(o, c, k);
  o[3] = dh;
}

// ---- geometry helpers
type Seg = readonly [number, number, number, number, number, number, number, number];
function segList(lines: readonly (readonly [number, number, number, number])[]): Seg[] {
  return lines.map(([x1, y1, x2, y2]) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy || 1;
    return [x1, y1, x2, y2, dx, dy, l2, Math.sqrt(l2)] as const;
  });
}

let _d = 0;
let _a = 0;
/** Nearest segment to a point: sets _d to the distance and _a to a coordinate along it. */
function segNear(px: number, py: number, segs: readonly Seg[]) {
  let best = 1e9;
  let along = 0;
  for (const s of segs) {
    let t = ((px - s[0]) * s[4] + (py - s[1]) * s[5]) / s[6];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = s[0] + t * s[4] - px;
    const qy = s[1] + t * s[5] - py;
    const d = qx * qx + qy * qy;
    if (d < best) {
      best = d;
      along = t * s[7] + s[0] * 0.37 + s[1] * 0.61;
    }
  }
  _d = Math.sqrt(best);
  _a = along;
}

const bump = (u: number, p: number) => (u >= 1 ? 0 : Math.pow(1 - Math.pow(u, p), 1 / p));

function boxBlur(src: Float32Array, W: number, H: number, r: number): Float32Array {
  const tmp = new Float32Array(W * H);
  const dst = new Float32Array(W * H);
  const n = 2 * r + 1;
  for (let j = 0; j < H; j++) {
    let s = 0;
    const row = j * W;
    for (let i = -r; i <= r; i++) s += src[row + Math.min(W - 1, Math.max(0, i))]!;
    for (let i = 0; i < W; i++) {
      tmp[row + i] = s / n;
      s += src[row + Math.min(W - 1, i + r + 1)]! - src[row + Math.max(0, i - r)]!;
    }
  }
  for (let i = 0; i < W; i++) {
    let s = 0;
    for (let j = -r; j <= r; j++) s += tmp[Math.min(H - 1, Math.max(0, j)) * W + i]!;
    for (let j = 0; j < H; j++) {
      dst[j * W + i] = s / n;
      s += tmp[Math.min(H - 1, j + r + 1) * W + i]! - tmp[Math.max(0, j - r) * W + i]!;
    }
  }
  return dst;
}

/** Heights and albedo for every sample. */
function buildField(req: BakeRequest, W: number, H: number) {
  const { hole, x0, y0, res } = req;
  const N = W * H;
  const hgt = new Float32Array(N);
  const ground = new Float32Array(N);
  const alb = new Float32Array(N * 3);
  const ol = hole.outline;
  const outSegs = segList(
    ol.map((p, i) => {
      const q = ol[(i + 1) % ol.length]!;
      return [p[0], p[1], q[0], q[1]] as const;
    }),
  );
  const railSegs = segList(hole.rails);
  const o: Sample = new Float32Array(4);
  const o2: Sample = new Float32Array(4);
  const slopes = hole.slopes.map((s) => {
    const l = Math.hypot(s.ax, s.ay);
    const dx = s.ax / l;
    const dy = s.ay / l;
    const len = Math.abs(dx) * s.w + Math.abs(dy) * s.h;
    return { ...s, dx, dy, len, drop: Math.min(16, len * 0.1 * (l / 220)) };
  });
  // The mound holding the cup is the volcano.
  const volcano = hole.mounds.find((md) => Math.hypot(hole.cup.x - md.x, hole.cup.y - md.y) < md.r * 0.25);

  for (let j = 0; j < H; j++) {
    const y = y0 + (j + 0.5) / res;
    const xs: number[] = [];
    for (let e = 0; e < ol.length; e++) {
      const [x1, y1] = ol[e]!;
      const [x2, y2] = ol[(e + 1) % ol.length]!;
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) xs.push(x1 + ((y - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((a, b) => a - b);
    let xi = 0;
    for (let i = 0; i < W; i++) {
      const x = x0 + (i + 0.5) / res;
      const idx = j * W + i;
      while (xi < xs.length && xs[xi]! < x) xi++;
      const inside = xi % 2 === 1;
      let h = 0;
      let m = FLOOR;
      let a1 = 0;
      let a2 = 0;
      let sandM = 0;
      _vc = 9;
      _we = 9;
      if (!inside) {
        segNear(x, y, outSegs);
        if (_d < WALL_W) {
          m = WALL;
          h = WALL_H * bump(Math.abs((2 * _d) / WALL_W - 1), WALL_P);
          a1 = _d;
          a2 = _a;
          _we = _d;
        } else {
          m = OUT;
          a1 = _d;
        }
        ground[idx] = 0;
      } else {
        for (const md of hole.mounds) {
          const dx = x - md.x;
          const dy = y - md.y;
          const d2 = (dx * dx + dy * dy) / (md.r * md.r);
          if (d2 >= 1) continue;
          const d = Math.sqrt(d2);
          const s = md.strength / 600;
          if (md === volcano) {
            // A steep cone with a crater lip and a dish around the cup.
            h +=
              VOLCANO *
              s *
              (Math.pow(1 - d, 1.1) * sstep(1, 0.9, d) +
                0.07 * Math.exp(-(((d - 0.33) / 0.06) ** 2)) -
                0.3 * sstep(0.33, 0.14, d));
            _vc = d;
          } else h += MOUND * s * 0.9 * (1 - d * d) * sstep(1, 0.8, d); // firm dome with a fillet foot
        }
        for (const s of slopes) {
          if (x > s.x - 4 && x < s.x + s.w + 4 && y > s.y - 4 && y < s.y + s.h + 4) {
            const along = (x - s.x - s.w / 2) * s.dx + (y - s.y - s.h / 2) * s.dy;
            const edge = Math.min(x - s.x, s.x + s.w - x, y - s.y, s.y + s.h - y);
            h += (-along / s.len) * s.drop * sstep(-3, 5, edge);
          }
        }
        for (const sd of hole.sand) {
          const rr = 16;
          const qx = Math.max(Math.abs(x - sd.x - sd.w / 2) - sd.w / 2 + rr, 0);
          const qy = Math.max(Math.abs(y - sd.y - sd.h / 2) - sd.h / 2 + rr, 0);
          const inner = Math.min(
            Math.max(
              Math.abs(x - sd.x - sd.w / 2) - sd.w / 2 + rr,
              Math.abs(y - sd.y - sd.h / 2) - sd.h / 2 + rr,
            ),
            0,
          );
          const sdist = Math.hypot(qx, qy) + inner - rr; // < 0 inside
          const wob = (fbm(x / 11, y / 11, 41, 3) - 0.5) * 9;
          sandM = Math.max(sandM, sstep(1.5, -2.5, sdist + wob));
        }
        h -= 2.4 * sandM;
        const tx = Math.abs(x - hole.tee.x) - 18;
        const ty = Math.abs(y - hole.tee.y) - 12;
        const teeD =
          Math.hypot(Math.max(tx + 7, 0), Math.max(ty + 7, 0)) + Math.min(Math.max(tx + 7, ty + 7), 0) - 7;
        if (teeD < 0) m = TEE;
        ground[idx] = h;
        const cdx = x - hole.cup.x;
        const cdy = y - hole.cup.y;
        const cd = Math.sqrt(cdx * cdx + cdy * cdy);
        if (cd < CUP_R) {
          m = cd > CUP_R - 1.3 ? RIM : CUP;
          h -= cd > CUP_R - 1.3 ? 0.3 : 10;
          a1 = cd;
        }
        let wh = 0;
        if (railSegs.length) {
          segNear(x, y, railSegs);
          if (_d < RAIL_R) {
            wh = WALL_H * 0.92 * bump(_d / RAIL_R, RAIL_P);
            m = WALL;
            a1 = _d;
            a2 = _a;
            _we = RAIL_R - _d;
          }
        }
        for (const b of hole.blocks) {
          if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.h) {
            const e = Math.min(x - b.x, b.x + b.w - x, y - b.y, b.y + b.h - y);
            const v = WALL_H * bump(1 - Math.min(e / BLOCK_BEVEL, 1), WALL_P);
            if (v > wh) {
              wh = v;
              m = WALL;
              a1 = b.w > b.h ? y - b.y : x - b.x;
              a2 = b.w > b.h ? x : y;
              _we = e;
            }
          }
        }
        for (const b of hole.bumpers) {
          const dx = x - b.x;
          const dy = y - b.y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < b.r) {
            const v = POST_H * bump(1 - Math.min((b.r - d) / (b.r * POST_BEVEL), 1), POST_P);
            if (v > wh) {
              wh = v;
              m = BUMP;
              a1 = d;
              a2 = 0;
              _br = b.r;
              _bd = d;
            }
          }
        }
        h += wh;
        if (m === FLOOR && sandM > 0.5) m = SAND;
      }
      // Surface detail and albedo, with sand blended at its soft edge.
      surface(m, x, y, a1, a2, o);
      if (inside && sandM > 0 && sandM < 1 && (m === FLOOR || m === SAND || m === TEE)) {
        surface(m === SAND ? FLOOR : SAND, x, y, a1, a2, o2);
        let k = m === SAND ? 1 - sandM : sandM;
        // Loose grains: the edge breaks up into scattered sand on the carpet.
        const r = hash(Math.floor(x * 4.3), Math.floor(y * 4.3), 125) * 0.8 + 0.1;
        k = sstep(r - 0.06, r + 0.06, k) * 0.85 + k * 0.15;
        for (let c = 0; c < 4; c++) o[c] = o[c]! + (o2[c]! - o[c]!) * k;
      }
      // The crater around the cup is a red carpet.
      if (_vc < 0.33 && (m === FLOOR || m === SAND)) loopWeave(CRATER_C, x, y, o);
      hgt[idx] = h + o[3]!;
      alb[idx * 3] = o[0]!;
      alb[idx * 3 + 1] = o[1]!;
      alb[idx * 3 + 2] = o[2]!;
    }
  }
  return { hgt, ground, alb };
}

/** Lights the heightfield: sun with soft shadows, ambient occlusion, gamma. */
function lightField(hgt: Float32Array, alb: Float32Array, W: number, H: number, res: number) {
  const N = W * H;
  const blur = boxBlur(hgt, W, H, Math.max(1, Math.round(4 * res)));
  const blur2 = boxBlur(hgt, W, H, Math.max(1, Math.round(1.2 * res)));
  const ll = Math.hypot(SUN[0], SUN[1], SUN[2]);
  const lx = SUN[0] / ll;
  const ly = SUN[1] / ll;
  const lz = SUN[2] / ll;
  const lxy = Math.hypot(lx, ly);
  const stepX = lx / lxy;
  const stepY = ly / lxy;
  const rise = lz / lxy;
  const col = new Uint8ClampedArray(N * 4);
  const maxSteps = Math.ceil(26 * res);
  let maxH = 0;
  for (let i = 0; i < N; i++) if (hgt[i]! > maxH) maxH = hgt[i]!;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const idx = j * W + i;
      const h = hgt[idx]!;
      const hl = hgt[j * W + Math.max(0, i - 1)]!;
      const hr = hgt[j * W + Math.min(W - 1, i + 1)]!;
      const hu = hgt[Math.max(0, j - 1) * W + i]!;
      const hd = hgt[Math.min(H - 1, j + 1) * W + i]!;
      let nx = (-(hr - hl) * res) / 2;
      let ny = (-(hd - hu) * res) / 2;
      let nz = 1;
      const nl = Math.hypot(nx, ny, nz);
      nx /= nl;
      ny /= nl;
      nz /= nl;
      // Soft shadow: march toward the light over the heightfield.
      let sh = 1;
      for (let s = 1; s <= maxSteps; s++) {
        const px = i + stepX * s;
        const py = j + stepY * s;
        if (px < 0 || py < 0 || px >= W || py >= H) break;
        const rayH = h + (rise * s) / res;
        if (rayH > maxH) break;
        const th = hgt[(py | 0) * W + (px | 0)]!;
        if (th > rayH) {
          sh = Math.min(sh, 1 - Math.min(1, (th - rayH) / SHADOW_SOFT));
          if (sh <= 0) break;
        }
      }
      sh = 1 - SHADOW_K * (1 - sh);
      const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
      const ao =
        Math.max(0.3, Math.min(1.08, 1 - (blur[idx]! - h) * AO_K)) *
        Math.max(0.6, Math.min(1.1, 1 - (blur2[idx]! - h) * 0.12));
      const lit = diff * sh;
      for (let c = 0; c < 3; c++) {
        const v = alb[idx * 3 + c]! * (AMBIENT[c]! * ao + SUNLIGHT[c]! * lit * (0.75 + 0.25 * ao));
        col[idx * 4 + c] = Math.pow(Math.max(0, v), 1 / 1.08) * 255;
      }
      col[idx * 4 + 3] = 255;
    }
  }
  return { col, maxH };
}

/**
 * Oblique raster: scan each column from the front (bottom) back, so raised
 * samples rise and show a face, and dips hide behind their rims.
 */
function rasterise(
  col: Uint8ClampedArray,
  hgt: Float32Array,
  alb: Float32Array,
  W: number,
  H: number,
  res: number,
  maxH: number,
) {
  const Mg = Math.ceil(maxH * OBL * res) + 2;
  const Ho = H + Mg;
  const out = new Uint8ClampedArray(W * Ho * 4);
  for (let i = 0; i < W; i++) {
    let last = Ho;
    for (let j = H - 1; j >= 0; j--) {
      const idx = j * W + i;
      let top = Math.floor(j + Mg - hgt[idx]! * OBL * res);
      if (top < 0) top = 0;
      if (top >= last) continue;
      const gap = last - top;
      for (let r = top; r < last; r++) {
        const p = (r * W + i) * 4;
        if (r === top || gap <= 2.5 || last === Ho) {
          out[p] = col[idx * 4]!;
          out[p + 1] = col[idx * 4 + 1]!;
          out[p + 2] = col[idx * 4 + 2]!;
        } else {
          // Front face: in shade, darker toward its foot.
          const t = (r - top) / gap;
          const k = FACE_K * (1.05 - 0.35 * t);
          out[p] = alb[idx * 3]! * 255 * k * (AMBIENT[0] + 0.25);
          out[p + 1] = alb[idx * 3 + 1]! * 255 * k * (AMBIENT[1] + 0.25);
          out[p + 2] = alb[idx * 3 + 2]! * 255 * k * (AMBIENT[2] + 0.25);
        }
        out[p + 3] = 255;
      }
      last = top;
    }
    // Whatever is left above the farthest row repeats it.
    for (let r = 0; r < last; r++) {
      const p = (r * W + i) * 4;
      const q = (last * W + i) * 4;
      out[p] = out[q]!;
      out[p + 1] = out[q + 1]!;
      out[p + 2] = out[q + 2]!;
      out[p + 3] = 255;
    }
  }
  return { out, Mg };
}

export function bake(req: BakeRequest): BakeResult {
  const { res, x0, y0 } = req;
  const W = Math.ceil(req.wU * res);
  const H = Math.ceil(req.hU * res);
  const { hgt, ground, alb } = buildField(req, W, H);
  const { col, maxH } = lightField(hgt, alb, W, H, res);
  const { out, Mg } = rasterise(col, hgt, alb, W, H, res, maxH);
  return { pixels: out, ground, W, H, Mg, res, x0, y0 };
}

/** Ground height at a course point, bilinear over the baked samples. */
export function groundAt(
  b: Pick<BakeResult, "ground" | "W" | "H" | "res" | "x0" | "y0">,
  x: number,
  y: number,
): number {
  const fx = (x - b.x0) * b.res - 0.5;
  const fy = (y - b.y0) * b.res - 0.5;
  const i = Math.max(0, Math.min(b.W - 2, Math.floor(fx)));
  const j = Math.max(0, Math.min(b.H - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - i));
  const ty = Math.max(0, Math.min(1, fy - j));
  const g = b.ground;
  const W = b.W;
  const a = g[j * W + i]!;
  const c = g[j * W + i + 1]!;
  const d = g[(j + 1) * W + i]!;
  const e = g[(j + 1) * W + i + 1]!;
  return (a + (c - a) * tx) * (1 - ty) + (d + (e - d) * tx) * ty;
}
