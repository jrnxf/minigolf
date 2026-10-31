import { describe, expect, it } from "vitest";
import { MAX_STROKES, PICKUP_SCORE } from "../../src/core/constants.ts";
import { HOLES, type Hole } from "../../src/core/holes.ts";
import {
  applyShot,
  createMatch,
  holeOf,
  honour,
  nextHole,
  rematch,
  scoreName,
  total,
  winner,
  type MatchState,
  type Seat,
} from "../../src/core/match.ts";
import { findShot } from "../../src/core/solver.ts";

/** A soft tap that never reaches the cup from the tee. */
const TAP = { vx: 0, vy: -60 };

function sinkNow(state: MatchState, seat: Seat): MatchState {
  // Keep shooting the solver's best shot until this seat's ball drops.
  let s = state;
  while (!s.balls[seat].done && s.turn === seat) {
    const ball = s.balls[seat];
    s = applyShot(s, seat, findShot(holeOf(s), ball).shot)!.state;
  }
  return s;
}

describe("strokes and turns", () => {
  it("starts on the first hole with seat 0 to play", () => {
    const m = createMatch();
    expect(m).toMatchObject({ holeIdx: 0, turn: 0, first: 0, phase: "aim", strokes: 0 });
    expect(m.balls[0]).toMatchObject({ x: HOLES[0]!.tee.x, y: HOLES[0]!.tee.y, strokes: 0, done: false });
  });

  it("alternates strokes between players", () => {
    let m = createMatch();
    m = applyShot(m, 0, TAP)!.state;
    expect(m.turn).toBe(1);
    expect(m.balls[0].strokes).toBe(1);
    expect(m.balls[0].y).toBeLessThan(HOLES[0]!.tee.y);
    m = applyShot(m, 1, TAP)!.state;
    expect(m.turn).toBe(0);
    expect(m.strokes).toBe(2);
  });

  it("refuses a stroke out of turn, an impossible shot, or after the hole", () => {
    const m = createMatch();
    expect(applyShot(m, 1, TAP)).toBeNull();
    expect(applyShot(m, 0, { vx: 0, vy: -1 })).toBeNull();
    expect(applyShot({ ...m, phase: "holeDone" }, 0, TAP)).toBeNull();
  });

  it("does not change the state it was given", () => {
    const m = createMatch();
    const copy = structuredClone(m);
    applyShot(m, 0, TAP);
    expect(m).toEqual(copy);
  });

  it("skips a player who has holed out", () => {
    let m = sinkNow(createMatch(), 0);
    expect(m.balls[0].done).toBe(true);
    expect(m.scores[0][0]).toBe(m.balls[0].strokes);
    m = applyShot(m, 1, TAP)!.state;
    expect(m.turn).toBe(1);
  });

  it("picks the ball up at the stroke limit", () => {
    let m = createMatch();
    for (let i = 0; i < MAX_STROKES; i++) {
      m = applyShot(m, 0, { vx: 0, vy: i % 2 ? 60 : -60 })!.state;
      if (i < MAX_STROKES - 1) m = applyShot(m, 1, i % 2 ? TAP : { vx: 0, vy: 60 })!.state;
    }
    expect(m.balls[0]).toMatchObject({ done: true, pickedUp: true, strokes: MAX_STROKES });
    expect(m.scores[0][0]).toBe(PICKUP_SCORE);
    expect(m.turn).toBe(1);
  });
});

describe("holes and honour", () => {
  it("finishes the hole when both balls are in", () => {
    let m = sinkNow(createMatch(), 0);
    m = sinkNow(m, 1);
    expect(m.phase).toBe("holeDone");
    expect(nextHole(createMatch())).toBeNull();
  });

  it("gives the honour to the lower score on the last hole", () => {
    const base = { ...createMatch(), phase: "holeDone" as const };
    expect(honour({ ...base, scores: [[3], [2]] })).toBe(1);
    expect(honour({ ...base, scores: [[2], [3]] })).toBe(0);
    // A tie keeps whoever teed off first.
    expect(honour({ ...base, first: 1, scores: [[2], [2]] })).toBe(1);
  });

  it("moves to the next hole with fresh balls and the honour on the tee", () => {
    const done: MatchState = { ...createMatch(), phase: "holeDone", scores: [[3], [2]] };
    const m = nextHole(done)!;
    expect(m).toMatchObject({ holeIdx: 1, turn: 1, first: 1, phase: "aim" });
    expect(m.balls[1]).toMatchObject({ x: HOLES[1]!.tee.x, y: HOLES[1]!.tee.y, strokes: 0 });
  });

  it("plays a whole game to the end", () => {
    let m = createMatch();
    while (m.phase !== "gameDone") {
      if (m.phase === "holeDone") m = nextHole(m)!;
      // Rock each ball back and forth by the tee until it is picked up: the
      // whole course's flow without a solver search per stroke.
      else m = applyShot(m, m.turn, { vx: 0, vy: m.balls[m.turn].strokes % 2 ? 60 : -60 })!.state;
    }
    expect(m.holeIdx).toBe(HOLES.length - 1);
    expect(m.scores[0].every((s) => s !== null)).toBe(true);
    expect(m.scores[1].every((s) => s !== null)).toBe(true);
    expect(total(m, 0)).toBe(m.scores[0].reduce((a, b) => a! + b!, 0));
  });

  it("works on a custom course", () => {
    const holes: Hole[] = [HOLES[0]!];
    const m = createMatch(0, holes);
    const out = applyShot(m, 0, findShot(holes[0]!, holes[0]!.tee).shot, { holes })!;
    expect(out.result.sunk).toBe(true);
  });
});

describe("results", () => {
  const finished = (a: number[], b: number[]): MatchState => ({
    ...createMatch(),
    phase: "gameDone",
    first: 1,
    scores: [a, b],
  });

  it("names the winner by the lowest total", () => {
    expect(winner(finished([2, 3], [3, 3]))).toBe(0);
    expect(winner(finished([4, 3], [3, 3]))).toBe(1);
    expect(winner(finished([3, 3], [3, 3]))).toBeNull();
  });

  it("starts a rematch with the winner on the tee", () => {
    expect(rematch(finished([2, 3], [3, 3])).turn).toBe(0);
    expect(rematch(finished([4, 3], [3, 3])).turn).toBe(1);
    expect(rematch(finished([3, 3], [3, 3])).turn).toBe(1);
    expect(rematch(finished([3, 3], [3, 3])).scores[0].every((s) => s === null)).toBe(true);
  });

  it("names scores the golf way", () => {
    expect(scoreName(1, 3)).toBe("HOLE IN ONE");
    expect(scoreName(2, 4)).toBe("EAGLE");
    expect(scoreName(2, 3)).toBe("BIRDIE");
    expect(scoreName(3, 3)).toBe("PAR");
    expect(scoreName(4, 3)).toBe("BOGEY");
    expect(scoreName(5, 3)).toBe("DOUBLE BOGEY");
    expect(scoreName(6, 2)).toBe("+4");
    expect(scoreName(7, 2, true)).toBe("PICKED UP");
  });
});
