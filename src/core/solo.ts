// Solo play: one player, every hole, a running score against par. It reuses
// the two-player match rules with the second seat parked as already finished,
// so the stroke cap, pick-up score and physics are exactly the same.

import { HOLES, type Hole } from "./holes.ts";
import { applyShot, createMatch, nextHole, type BallState, type MatchState } from "./match.ts";
import type { Shot } from "./physics.ts";

/** The idle second seat: finished on every hole, never shown, never to move. */
function parked(): BallState {
  return { x: 0, y: 0, strokes: 0, done: true, pickedUp: true };
}

export function createSolo(holes: readonly Hole[] = HOLES): MatchState {
  const match = createMatch(0, holes);
  match.balls[1] = parked();
  return match;
}

/** Plays a stroke; null when it is not allowed (wrong phase or an impossible shot). */
export function soloShot(state: MatchState, shot: Shot, holes: readonly Hole[] = HOLES) {
  return applyShot(state, 0, shot, { trace: false, holes });
}

/** Moves a finished hole on to the next one; null while the hole is still going. */
export function soloNext(state: MatchState, holes: readonly Hole[] = HOLES): MatchState | null {
  const next = nextHole(state, holes);
  if (!next) return null;
  // nextHole hands the honour to the lower score; with one player it is always ours.
  return { ...next, first: 0, turn: 0, balls: [next.balls[0], parked()] };
}

/** A fresh round. */
export function soloAgain(holes: readonly Hole[] = HOLES): MatchState {
  return createSolo(holes);
}

/** Strokes taken so far, counting a picked-up hole as its score. */
export function soloTotal(state: MatchState): number {
  return state.scores[0].reduce<number>((sum, s) => sum + (s ?? 0), 0);
}

/** Total strokes minus the par of every hole played so far. */
export function soloVsPar(state: MatchState, holes: readonly Hole[] = HOLES): number {
  let diff = 0;
  state.scores[0].forEach((s, i) => {
    if (s !== null) diff += s - holes[i]!.par;
  });
  return diff;
}

/** "E", "+3" or "-2". */
export function formatVsPar(diff: number): string {
  return diff === 0 ? "E" : diff > 0 ? `+${diff}` : String(diff);
}

export function isRoundDone(state: MatchState): boolean {
  return state.phase === "gameDone";
}
