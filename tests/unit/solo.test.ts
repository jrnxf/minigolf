import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_STROKES, PICKUP_SCORE } from "../../src/core/constants.ts";
import { COURSE_PAR, HOLES } from "../../src/core/holes.ts";
import { total } from "../../src/core/match.ts";
import {
  createSolo,
  formatVsPar,
  isRoundDone,
  soloAgain,
  soloNext,
  soloShot,
  soloTotal,
  soloVsPar,
} from "../../src/core/solo.ts";
import { findShot } from "../../src/core/solver.ts";
import { loadBest, recordRound } from "../../src/client/solo.ts";

/** A stroke that is legal but goes nowhere near the cup: straight into the near wall. */
const WASTED = { vx: 0, vy: 60 };

function playHole(state: ReturnType<typeof createSolo>) {
  let s = state;
  for (let guard = 0; guard < MAX_STROKES + 1 && s.phase === "aim"; guard++) {
    const hole = HOLES[s.holeIdx]!;
    const out = soloShot(s, findShot(hole, s.balls[0]).shot)!;
    s = out.state;
  }
  return s;
}

describe("solo scoring", () => {
  it("starts on hole 1 with one player to move", () => {
    const s = createSolo();
    expect(s).toMatchObject({ holeIdx: 0, turn: 0, phase: "aim" });
    expect(soloVsPar(s)).toBe(0);
    expect(formatVsPar(0)).toBe("E");
  });

  it("reads strokes against par: an ace on a par 2 is -1", () => {
    const hole = HOLES[0]!;
    const out = soloShot(createSolo(), findShot(hole, hole.tee).shot)!;
    expect(out.result.sunk).toBe(true);
    expect(out.state.scores[0][0]).toBe(1);
    expect(out.state.phase).toBe("holeDone");
    expect(soloVsPar(out.state)).toBe(1 - hole.par);
    expect(formatVsPar(soloVsPar(out.state))).toBe("-1");
  });

  it("keeps the turn on the player and the second seat out of play across holes", () => {
    let s = playHole(createSolo());
    expect(s.phase).toBe("holeDone");
    s = soloNext(s)!;
    expect(s).toMatchObject({ holeIdx: 1, turn: 0, first: 0, phase: "aim" });
    expect(s.balls[1].done).toBe(true);
    expect(soloShot(s, WASTED)).not.toBeNull();
  });

  it("picks the ball up at the stroke cap, scoring one over it (+3 on a par 4)", () => {
    let s = createSolo();
    // Walk to a par 4 (Switchback, hole 5) the quick way: score the first four by solver.
    for (let i = 0; i < 4; i++) s = soloNext(playHole(s))!;
    expect(HOLES[s.holeIdx]!.par).toBe(4);
    for (let i = 0; i < MAX_STROKES; i++) {
      expect(s.phase).toBe("aim");
      s = soloShot(s, WASTED)!.state;
    }
    expect(s.phase).toBe("holeDone");
    expect(s.balls[0].pickedUp).toBe(true);
    expect(s.scores[0][s.holeIdx]).toBe(PICKUP_SCORE);
    expect(PICKUP_SCORE - HOLES[s.holeIdx]!.par).toBe(3);
  });

  it("finishes a whole round with a total and a vs-par that agree", () => {
    let s = createSolo();
    for (let i = 0; i < HOLES.length; i++) {
      s = playHole(s);
      if (i < HOLES.length - 1) s = soloNext(s)!;
    }
    expect(isRoundDone(s)).toBe(true);
    expect(s.scores[0]).toHaveLength(18);
    expect(s.scores[0].every((n) => typeof n === "number")).toBe(true);
    expect(soloTotal(s)).toBe(total(s, 0));
    expect(soloVsPar(s)).toBe(soloTotal(s) - COURSE_PAR);
    expect(soloNext(s)).toBeNull();
    expect(soloAgain().scores[0].every((n) => n === null)).toBe(true);
  });
}, 60_000);

describe("best round", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });

  it("starts empty", () => {
    expect(loadBest()).toBeNull();
  });

  it("saves the first round, then only a lower total", () => {
    expect(recordRound(COURSE_PAR + 9)).toBe(true);
    expect(loadBest()).toEqual({ strokes: COURSE_PAR + 9, vsPar: 9 });
    expect(recordRound(COURSE_PAR + 12)).toBe(false);
    expect(recordRound(COURSE_PAR + 9)).toBe(false);
    expect(loadBest()?.vsPar).toBe(9);
    expect(recordRound(COURSE_PAR - 1)).toBe(true);
    expect(loadBest()).toEqual({ strokes: COURSE_PAR - 1, vsPar: -1 });
  });

  it("survives a reload: it is read back from storage", () => {
    recordRound(60);
    expect(store.get("minigolf.solo-best")).toBe(JSON.stringify({ strokes: 60, vsPar: 60 - COURSE_PAR }));
    expect(loadBest()).toEqual({ strokes: 60, vsPar: 60 - COURSE_PAR });
  });

  it("ignores a damaged record and still works when storage throws", () => {
    store.set("minigolf.solo-best", "{nope");
    expect(loadBest()).toBeNull();
    store.set("minigolf.solo-best", JSON.stringify({ strokes: "x" }));
    expect(loadBest()).toBeNull();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadBest()).toBeNull();
    expect(() => recordRound(50)).not.toThrow();
  });
});
