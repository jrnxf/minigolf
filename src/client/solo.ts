// Solo play on this phone. Nothing leaves the device: the round lives in
// memory and only the best finished round is kept in local storage.

import { COURSE_PAR } from "../core/holes.ts";
import type { MatchState } from "../core/match.ts";
import type { Shot } from "../core/physics.ts";
import {
  createSolo,
  formatVsPar,
  isRoundDone,
  soloAgain,
  soloNext,
  soloShot,
  soloTotal,
} from "../core/solo.ts";
import type { Driver, GameScreen } from "./game.ts";
import { loadJson, save } from "./storage.ts";

const BEST_KEY = "solo-best";

export interface BestRound {
  /** Total strokes for the round. */
  strokes: number;
  /** Strokes minus the par of all 18 holes. */
  vsPar: number;
}

export function loadBest(): BestRound | null {
  const best = loadJson<BestRound>(BEST_KEY);
  if (!best || !Number.isInteger(best.strokes) || !Number.isInteger(best.vsPar)) return null;
  return best;
}

/** Keeps `strokes` as the best round if it beats the saved one. Returns true when it did. */
export function recordRound(strokes: number): boolean {
  const best = loadBest();
  if (best && best.strokes <= strokes) return false;
  save(BEST_KEY, JSON.stringify({ strokes, vsPar: strokes - COURSE_PAR } satisfies BestRound));
  return true;
}

export class SoloGame implements Driver {
  readonly me = null;
  readonly solo = true;
  private match: MatchState;
  private screen: GameScreen;
  private onQuit: () => void;
  private newBest = false;

  constructor(screen: GameScreen, name: string, onQuit: () => void) {
    this.screen = screen;
    this.onQuit = onQuit;
    this.match = createSolo();
    screen.start(this, [name, ""], this.match);
  }

  shoot(shot: Shot): void {
    const out = soloShot(this.match, shot);
    if (!out) return;
    this.screen.enqueueShot(out.seat, shot, this.match, out.state);
    this.match = out.state;
    if (isRoundDone(out.state)) this.newBest = recordRound(soloTotal(out.state));
  }

  aim(): void {
    // Nobody else to show the aim to.
  }

  next(): void {
    const next = soloNext(this.match);
    if (!next) return;
    this.match = next;
    this.screen.enqueueState(next);
  }

  again(): void {
    this.match = soloAgain();
    this.newBest = false;
    this.screen.enqueueState(this.match);
  }

  quit(): void {
    this.screen.stop();
    this.onQuit();
  }

  /** The line under the final card: whether this round set the best. */
  finalNote(): string {
    const best = loadBest();
    if (this.newBest) return "New best round";
    return best ? `Best round ${best.strokes} (${formatVsPar(best.vsPar)})` : "";
  }
}
