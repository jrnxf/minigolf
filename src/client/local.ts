// Pass-and-play: both players on one phone. The match lives here and is
// saved after every stroke, so a reload or a killed tab can resume it.

import { applyShot, createMatch, nextHole, rematch, type MatchState } from "../core/match.ts";
import type { Shot } from "../core/physics.ts";
import type { Driver, GameScreen } from "./game.ts";
import { loadJson, save } from "./storage.ts";

interface Saved {
  names: [string, string];
  match: MatchState;
}

const KEY = "local";

export function savedLocalGame(): Saved | null {
  const saved = loadJson<Saved>(KEY);
  if (!saved?.match || !Array.isArray(saved.names) || saved.match.phase === "gameDone") return null;
  return saved;
}

export class LocalGame implements Driver {
  readonly me = null;
  private match: MatchState;
  private names: [string, string];
  private screen: GameScreen;
  private onQuit: () => void;

  constructor(screen: GameScreen, names: [string, string], onQuit: () => void, match?: MatchState) {
    this.screen = screen;
    this.names = names;
    this.onQuit = onQuit;
    this.match = match ?? createMatch(0);
    this.persist();
    screen.start(this, names, this.match);
  }

  shoot(shot: Shot): void {
    const out = applyShot(this.match, this.match.turn, shot);
    if (!out) return;
    this.screen.enqueueShot(out.seat, shot, this.match, out.state);
    this.match = out.state;
    this.persist();
  }

  aim(): void {
    // Nobody else to show the aim to.
  }

  next(): void {
    const next = nextHole(this.match);
    if (!next) return;
    this.match = next;
    this.screen.enqueueState(next);
    this.persist();
  }

  again(): void {
    this.match = rematch(this.match);
    this.screen.enqueueState(this.match);
    this.persist();
  }

  quit(): void {
    save(KEY, null);
    this.screen.stop();
    this.onQuit();
  }

  private persist() {
    save(KEY, JSON.stringify({ names: this.names, match: this.match } satisfies Saved));
  }
}
