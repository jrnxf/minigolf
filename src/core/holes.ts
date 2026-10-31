import { COURSE_H, COURSE_W } from "./constants.ts";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Bumper {
  x: number;
  y: number;
  r: number;
}

/** A rectangle of tilted ground that pushes the ball with a constant acceleration. */
export interface Slope extends Rect {
  ax: number;
  ay: number;
}

/** A round hill (positive strength pushes out) or bowl (negative pulls in). */
export interface Mound {
  x: number;
  y: number;
  r: number;
  strength: number;
}

/** A wall segment as [x1, y1, x2, y2]. */
export type Segment = readonly [number, number, number, number];

export interface HoleDef {
  name: string;
  par: number;
  /** Closed outer wall, listed corner by corner. */
  outline: readonly (readonly [number, number])[];
  tee: Point;
  cup: Point;
  blocks?: Rect[];
  rails?: Segment[];
  bumpers?: Bumper[];
  sand?: Rect[];
  slopes?: Slope[];
  mounds?: Mound[];
}

export interface Hole extends Required<HoleDef> {
  /** Every wall the ball can hit: the outline, block edges and rails. */
  walls: Segment[];
}

function rectWalls({ x, y, w, h }: Rect): Segment[] {
  return [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ];
}

function buildHole(def: HoleDef): Hole {
  const outline = def.outline;
  const walls: Segment[] = outline.map((a, i) => {
    const b = outline[(i + 1) % outline.length]!;
    return [a[0], a[1], b[0], b[1]] as const;
  });
  for (const block of def.blocks ?? []) walls.push(...rectWalls(block));
  walls.push(...(def.rails ?? []));
  return {
    blocks: [],
    rails: [],
    bumpers: [],
    sand: [],
    slopes: [],
    mounds: [],
    ...def,
    walls,
  };
}

const FULL: HoleDef["outline"] = [
  [20, 20],
  [COURSE_W - 20, 20],
  [COURSE_W - 20, COURSE_H - 20],
  [20, COURSE_H - 20],
];

// Sideways slopes stay under the rolling friction (150): a stronger one pins a
// ball against the wall for good and the stroke runs out the 30 second clock.
export const HOLES: readonly Hole[] = [
  buildHole({
    name: "The Gate",
    par: 2,
    outline: FULL,
    tee: { x: 150, y: 430 },
    cup: { x: 150, y: 82 },
    blocks: [
      { x: 20, y: 250, w: 100, h: 22 },
      { x: 180, y: 250, w: 100, h: 22 },
    ],
    bumpers: [{ x: 150, y: 168, r: 15 }],
  }),
  buildHole({
    name: "Dogleg",
    par: 3,
    outline: [
      [20, 20],
      [280, 20],
      [280, 170],
      [130, 170],
      [130, 480],
      [20, 480],
    ],
    tee: { x: 75, y: 432 },
    cup: { x: 228, y: 82 },
    rails: [[20, 92, 92, 20]],
    sand: [{ x: 20, y: 252, w: 110, h: 64 }],
    bumpers: [{ x: 175, y: 120, r: 13 }],
  }),
  buildHole({
    name: "The Ramp",
    par: 3,
    outline: [
      [50, 20],
      [250, 20],
      [250, 480],
      [50, 480],
    ],
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 70 },
    blocks: [{ x: 118, y: 104, w: 64, h: 12 }],
    slopes: [{ x: 50, y: 200, w: 200, h: 90, ax: 0, ay: 240 }],
    bumpers: [
      { x: 92, y: 150, r: 12 },
      { x: 208, y: 150, r: 12 },
    ],
  }),
  buildHole({
    name: "Pinball",
    par: 3,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 84 },
    rails: [
      [20, 92, 92, 20],
      [208, 20, 280, 92],
    ],
    bumpers: [
      { x: 150, y: 168, r: 15 },
      { x: 108, y: 214, r: 13 },
      { x: 192, y: 214, r: 13 },
      { x: 62, y: 320, r: 12 },
      { x: 238, y: 320, r: 12 },
    ],
  }),
  buildHole({
    name: "Switchback",
    par: 4,
    outline: FULL,
    tee: { x: 225, y: 435 },
    cup: { x: 64, y: 78 },
    blocks: [
      { x: 20, y: 150, w: 190, h: 20 },
      { x: 90, y: 320, w: 190, h: 20 },
    ],
    sand: [{ x: 20, y: 190, w: 75, h: 56 }],
    slopes: [
      { x: 20, y: 360, w: 70, h: 120, ax: 0, ay: -200 },
      { x: 20, y: 20, w: 260, h: 130, ax: -140, ay: 0 },
    ],
    bumpers: [{ x: 168, y: 115, r: 13 }],
  }),
  buildHole({
    name: "Volcano",
    par: 3,
    outline: [
      [80, 20],
      [220, 20],
      [280, 80],
      [280, 420],
      [220, 480],
      [80, 480],
      [20, 420],
      [20, 80],
    ],
    tee: { x: 150, y: 432 },
    cup: { x: 150, y: 150 },
    mounds: [{ x: 150, y: 150, r: 64, strength: 600 }],
    rails: [
      [52, 300, 112, 330],
      [248, 300, 188, 330],
    ],
    bumpers: [
      { x: 64, y: 160, r: 12 },
      { x: 236, y: 160, r: 12 },
    ],
  }),
  buildHole({
    name: "Bank Shot",
    par: 2,
    outline: FULL,
    tee: { x: 75, y: 435 },
    cup: { x: 75, y: 90 },
    blocks: [{ x: 20, y: 230, w: 190, h: 24 }],
  }),
  buildHole({
    name: "Sand Alley",
    par: 3,
    outline: [
      [90, 20],
      [210, 20],
      [210, 480],
      [90, 480],
    ],
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 60 },
    sand: [
      { x: 90, y: 300, w: 66, h: 70 },
      { x: 144, y: 180, w: 66, h: 70 },
    ],
    bumpers: [{ x: 150, y: 120, r: 10 }],
  }),
  buildHole({
    name: "Crosswind",
    par: 3,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 70 },
    slopes: [
      { x: 20, y: 300, w: 260, h: 60, ax: -140, ay: 0 },
      { x: 20, y: 160, w: 260, h: 60, ax: 140, ay: 0 },
    ],
    bumpers: [
      { x: 60, y: 250, r: 12 },
      { x: 240, y: 250, r: 12 },
    ],
  }),
  buildHole({
    name: "Diamond",
    par: 2,
    outline: [
      [150, 20],
      [280, 250],
      [150, 480],
      [20, 250],
    ],
    tee: { x: 150, y: 430 },
    cup: { x: 175, y: 75 },
    mounds: [{ x: 150, y: 250, r: 62, strength: 520 }],
  }),
  buildHole({
    name: "Hairpin",
    par: 4,
    outline: FULL,
    tee: { x: 75, y: 440 },
    cup: { x: 225, y: 430 },
    blocks: [{ x: 135, y: 130, w: 30, h: 350 }],
    rails: [
      [20, 80, 80, 20],
      [220, 20, 280, 80],
    ],
    slopes: [{ x: 165, y: 150, w: 115, h: 255, ax: 0, ay: 170 }],
    bumpers: [{ x: 150, y: 70, r: 12 }],
  }),
  buildHole({
    name: "Pinwheel",
    par: 3,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 250 },
    rails: [
      [105, 205, 175, 205],
      [195, 205, 195, 275],
      [195, 295, 125, 295],
      [105, 295, 105, 225],
    ],
    bumpers: [
      { x: 70, y: 120, r: 13 },
      { x: 230, y: 120, r: 13 },
      { x: 150, y: 90, r: 11 },
    ],
  }),
  buildHole({
    name: "Twin Peaks",
    par: 3,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 205, y: 90 },
    mounds: [
      { x: 88, y: 260, r: 58, strength: 520 },
      { x: 212, y: 260, r: 58, strength: 520 },
    ],
    sand: [{ x: 20, y: 20, w: 260, h: 46 }],
    bumpers: [
      { x: 45, y: 140, r: 11 },
      { x: 255, y: 140, r: 11 },
    ],
  }),
  buildHole({
    name: "Ricochet Row",
    par: 2,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 90 },
    bumpers: [
      { x: 45, y: 250, r: 12 },
      { x: 97, y: 250, r: 12 },
      { x: 150, y: 250, r: 12 },
      { x: 203, y: 250, r: 12 },
      { x: 255, y: 250, r: 12 },
    ],
  }),
  buildHole({
    name: "Keyhole",
    par: 2,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 100, y: 80 },
    blocks: [
      { x: 20, y: 240, w: 180, h: 20 },
      { x: 226, y: 240, w: 54, h: 20 },
    ],
  }),
  buildHole({
    name: "Slide",
    par: 3,
    outline: [
      [20, 20],
      [280, 20],
      [280, 480],
      [160, 480],
      [160, 160],
      [20, 160],
    ],
    tee: { x: 220, y: 440 },
    cup: { x: 60, y: 90 },
    slopes: [{ x: 160, y: 20, w: 120, h: 140, ax: -140, ay: 0 }],
    bumpers: [{ x: 120, y: 60, r: 11 }],
  }),
  buildHole({
    name: "Bunker Blast",
    par: 3,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 80 },
    sand: [{ x: 20, y: 190, w: 260, h: 110 }],
    bumpers: [{ x: 150, y: 150, r: 11 }],
  }),
  buildHole({
    name: "Bank Vault",
    par: 3,
    outline: FULL,
    tee: { x: 150, y: 440 },
    cup: { x: 150, y: 210 },
    blocks: [
      { x: 105, y: 175, w: 10, h: 75 },
      { x: 185, y: 175, w: 10, h: 75 },
      { x: 105, y: 240, w: 90, h: 10 },
    ],
  }),
];

export const COURSE_PAR = HOLES.reduce((sum, h) => sum + h.par, 0);
