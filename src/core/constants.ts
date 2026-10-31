// Shared tuning for the physics and rules. Every number here is part of the
// deterministic simulation: the browser and the room server must agree on
// all of them, so change them together and never at runtime.

/** Logical course size. Holes are drawn and simulated in these units. */
export const COURSE_W = 300;
export const COURSE_H = 500;

export const BALL_R = 7;
export const CUP_R = 11;

/** Fixed simulation clock: ticks per second and substeps per tick. */
export const TICK_HZ = 120;
export const SUBSTEPS = 4;
/** Seconds per substep (1 / (TICK_HZ * SUBSTEPS)). */
export const H = 1 / 480;

/** Course units per second at full power. */
export const MAX_SPEED = 1025;
/** The weakest shot that counts as a stroke, as a fraction of MAX_SPEED (about 45.6 units per second). */
export const MIN_POWER = 0.0445;

/** Linear rolling friction in units per second squared. */
export const DECEL = 150;
/** Per-substep drag multipliers on grass and sand (about 0.75/s and 1.5/s). */
export const DRAG_GRASS = 0.9984375;
export const DRAG_SAND = 0.996875;
export const SAND_FACTOR = 5;
/** Below this speed the ball comes to rest. */
export const STOP_SPEED = 5;

/** Restitution for walls and bumpers. */
export const WALL_E = 0.74;
export const BUMPER_E = 0.92;

/** A ball slower than this over the cup drops; faster lips out. */
export const SINK_SPEED = 430;
/** Near-miss slope around the cup: radius beyond the lip, max speed, pull. */
export const CUP_SLOPE_W = 6;
export const CUP_SLOPE_SPEED = 120;
export const CUP_SLOPE_PULL = 260;

/** Safety cap so a shot always ends: 30 seconds of simulated time. */
export const MAX_TICKS = TICK_HZ * 30;

/** Strokes allowed per hole. A ball still out after this is picked up. */
export const MAX_STROKES = 6;
/** Score recorded for a picked-up ball. */
export const PICKUP_SCORE = MAX_STROKES + 1;
