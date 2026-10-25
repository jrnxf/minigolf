// Two-player match rules as pure functions over plain data, shared by
// pass-and-play on one phone and the online room server.

import { MAX_STROKES, PICKUP_SCORE } from "./constants.ts";
import { HOLES, type Hole } from "./holes.ts";
import { isValidShot, simulateShot, type Shot, type ShotResult } from "./physics.ts";

export type Seat = 0 | 1;

export interface BallState {
  x: number;
  y: number;
  strokes: number;
  /** In the cup, or picked up at the stroke limit. */
  done: boolean;
  pickedUp: boolean;
}

export type MatchPhase = "aim" | "holeDone" | "gameDone";

export interface MatchState {
  holeIdx: number;
  /** Whose stroke it is. */
  turn: Seat;
  /** Who teed off first on this hole (the honour). */
  first: Seat;
  phase: MatchPhase;
  balls: [BallState, BallState];
  /** Strokes per hole for each seat; null until that seat finishes the hole. */
  scores: [(number | null)[], (number | null)[]];
  /** Counts every accepted stroke in the match; clients use it to order updates. */
  strokes: number;
}

export interface ShotOutcome {
  state: MatchState;
  result: ShotResult;
  seat: Seat;
}

export function other(seat: Seat): Seat {
  return seat === 0 ? 1 : 0;
}

function freshBalls(hole: Hole): [BallState, BallState] {
  const ball = (): BallState => ({ x: hole.tee.x, y: hole.tee.y, strokes: 0, done: false, pickedUp: false });
  return [ball(), ball()];
}

export function createMatch(first: Seat = 0, holes: readonly Hole[] = HOLES): MatchState {
  return {
    holeIdx: 0,
    turn: first,
    first,
    phase: "aim",
    balls: freshBalls(holes[0]!),
    scores: [holes.map(() => null), holes.map(() => null)],
    strokes: 0,
  };
}

export function holeOf(state: MatchState, holes: readonly Hole[] = HOLES): Hole {
  return holes[state.holeIdx]!;
}

/**
 * Plays a stroke for `seat`. Returns null when the stroke is not allowed:
 * wrong turn, wrong phase, or an impossible shot.
 */
export function applyShot(
  state: MatchState,
  seat: Seat,
  shot: Shot,
  opts: { trace?: boolean; holes?: readonly Hole[] } = {},
): ShotOutcome | null {
  const holes = opts.holes ?? HOLES;
  if (state.phase !== "aim" || state.turn !== seat || !isValidShot(shot)) return null;
  const ball = state.balls[seat];
  if (ball.done) return null;

  const hole = holes[state.holeIdx]!;
  const result = simulateShot(hole, ball, shot, { trace: opts.trace });
  const strokes = ball.strokes + 1;
  const pickedUp = !result.sunk && strokes >= MAX_STROKES;
  const done = result.sunk || pickedUp;
  const nextBall: BallState = { x: result.end.x, y: result.end.y, strokes, done, pickedUp };

  const balls: [BallState, BallState] = [...state.balls];
  balls[seat] = nextBall;
  const scores: MatchState["scores"] = [[...state.scores[0]], [...state.scores[1]]];
  if (done) scores[seat][state.holeIdx] = result.sunk ? strokes : PICKUP_SCORE;

  const next: MatchState = { ...state, balls, scores, strokes: state.strokes + 1 };
  const opp = other(seat);
  if (balls[0].done && balls[1].done) {
    next.phase = state.holeIdx === holes.length - 1 ? "gameDone" : "holeDone";
  } else {
    // Strokes alternate; a player who has finished the hole is skipped.
    next.turn = balls[opp].done ? seat : opp;
  }
  return { state: next, result, seat };
}

/** Who has the honour on a hole: the lower score on the previous hole, ties keep it. */
export function honour(state: MatchState): Seat {
  const prev = state.holeIdx;
  const a = state.scores[0][prev] ?? 0;
  const b = state.scores[1][prev] ?? 0;
  if (a < b) return 0;
  if (b < a) return 1;
  return state.first;
}

/** Moves a finished hole on to the next one. Returns null if the hole is not done. */
export function nextHole(state: MatchState, holes: readonly Hole[] = HOLES): MatchState | null {
  if (state.phase !== "holeDone") return null;
  const first = honour(state);
  const holeIdx = state.holeIdx + 1;
  return { ...state, holeIdx, first, turn: first, phase: "aim", balls: freshBalls(holes[holeIdx]!) };
}

export function total(state: MatchState, seat: Seat): number {
  return state.scores[seat].reduce<number>((sum, s) => sum + (s ?? 0), 0);
}

/** The winner of a finished match, or null for a draw. */
export function winner(state: MatchState): Seat | null {
  const a = total(state, 0);
  const b = total(state, 1);
  if (a === b) return null;
  return a < b ? 0 : 1;
}

/** A new match for a rematch: the winner tees off first, a draw keeps the old order. */
export function rematch(state: MatchState): MatchState {
  return createMatch(winner(state) ?? state.first);
}

/** Golf words for a finished hole. */
export function scoreName(strokes: number, par: number, pickedUp = false): string {
  if (pickedUp) return "PICKED UP";
  if (strokes === 1) return "HOLE IN ONE";
  const diff = strokes - par;
  if (diff <= -3) return "ALBATROSS";
  if (diff === -2) return "EAGLE";
  if (diff === -1) return "BIRDIE";
  if (diff === 0) return "PAR";
  if (diff === 1) return "BOGEY";
  if (diff === 2) return "DOUBLE BOGEY";
  return `+${diff}`;
}
