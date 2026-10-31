// The in-game screen: canvas, HUD, drag-anywhere aiming and the overlays
// between strokes. It only shows a match; a driver (pass-and-play or
// online) decides what the next state is.

import { TICK_HZ } from "../core/constants.ts";
import { HOLES, type Point } from "../core/holes.ts";
import { holeOf, other, scoreName, total, winner, type MatchState, type Seat } from "../core/match.ts";
import { shotFromAim, simulateShot, type Shot, type ShotResult } from "../core/physics.ts";
import type { Aim } from "../core/protocol.ts";
import { formatVsPar, soloTotal, soloVsPar } from "../core/solo.ts";
import { $, show } from "./dom.ts";
import { MIN_DRAG, powerFromDrag } from "./power.ts";
import { PLAYER_COLORS, Renderer, type AimSprite, type Joystick, type Scene } from "./render.ts";
import { sfx } from "./sfx.ts";

export interface Driver {
  /** The seat this phone plays, or null when both players share it. */
  readonly me: Seat | null;
  /** One player on one phone: no second seat, scores read against par. */
  readonly solo?: boolean;
  shoot(shot: Shot): void;
  aim(aim: Aim | null): void;
  next(): void;
  again(): void;
  quit(): void;
  /** Solo: the line under the final card. */
  finalNote?(): string;
}

type QueueItem =
  | { kind: "shot"; seat: Seat; shot: Shot; before: MatchState; after: MatchState }
  | { kind: "state"; match: MatchState };

interface Rolling {
  seat: Seat;
  result: ShotResult;
  after: MatchState;
  start: number;
  event: number;
}

interface Drag {
  id: number;
  x: number;
  y: number;
  cx: number;
  cy: number;
  aim: Aim | null;
}

type Overlay = "handoff" | "scorecard" | "menu" | "ended";

/** Preview length in course units: short for a tap, longer for a full swing. */
const previewLength = (power: number) => 70 + power * 160;

export class GameScreen {
  private renderer = new Renderer($<HTMLCanvasElement>("canvas"));
  private driver: Driver | null = null;
  private names: [string, string] = ["", ""];
  private match: MatchState | null = null;
  private queue: QueueItem[] = [];
  private rolling: Rolling | null = null;
  private trail: Point[] = [];
  private drag: Drag | null = null;
  private preview: AimSprite | null = null;
  private ghost: AimSprite | null = null;
  private sinkAt: [number | null, number | null] = [null, null];
  private overlay: Overlay | null = null;
  /** A hand-off card is about to open; nobody may aim until it has been dismissed. */
  private handoffDue = false;
  private lastShooter: Seat | null = null;
  private connected = true;
  private flags = { ready: [false, false], rematch: [false, false] };
  private lastAimSent = 0;
  private timers: number[] = [];
  private frame = 0;
  private calloutTimer = 0;
  private toastTimer = 0;

  constructor() {
    const canvas = this.renderer.canvas;
    canvas.addEventListener("pointerdown", (e) => this.pointerDown(e));
    canvas.addEventListener("pointermove", (e) => this.pointerMove(e));
    canvas.addEventListener("pointerup", (e) => this.pointerUp(e, false));
    canvas.addEventListener("pointercancel", (e) => this.pointerUp(e, true));
    new ResizeObserver(() => this.renderer.resize()).observe($("stage"));
    void document.fonts?.ready.then(() => this.renderer.invalidate());

    $("handoff-ready").addEventListener("click", () => this.closeOverlay());
    $("menu-btn").addEventListener("click", () => this.openMenu());
    $("menu-resume").addEventListener("click", () => this.closeOverlay());
    $("menu-sound").addEventListener("click", () => {
      sfx.enabled = !sfx.enabled;
      this.syncSoundLabel();
    });
    $("menu-quit").addEventListener("click", () => {
      this.closeOverlay();
      this.driver?.quit();
    });
    $("score-next").addEventListener("click", () => {
      if (!this.match || !this.driver) return;
      if (this.match.phase === "gameDone") this.driver.again();
      else this.driver.next();
      this.renderScorecard();
    });
    $("score-home").addEventListener("click", () => {
      this.closeOverlay();
      this.driver?.quit();
    });

    // Read-only view for the end-to-end tests: what is on screen and where.
    (window as unknown as { __minigolf: unknown }).__minigolf = {
      state: () => ({
        match: this.match,
        me: this.driver?.me ?? null,
        busy: !!this.rolling || this.queue.length > 0,
        canAim: this.canAim(),
        overlay: this.overlay,
        view: { s: this.renderer.s, ox: this.renderer.ox, oy: this.renderer.oy, maxDrag: this.maxDrag() },
      }),
    };
  }

  /** Shows the game screen for a match without animating anything. */
  start(driver: Driver, names: [string, string], match: MatchState): void {
    this.stop();
    this.driver = driver;
    this.names = names;
    this.match = match;
    this.lastShooter = null;
    this.sinkAt = [null, null];
    this.flags = { ready: [false, false], rematch: [false, false] };
    this.connected = true;
    $("hud-1").hidden = !!driver.solo;
    for (const seat of (driver.solo ? [0] : [0, 1]) as Seat[]) {
      const el = $(`hud-${seat}`).querySelector(".hud-name")!;
      el.textContent = names[seat];
      const len = Array.from(names[seat]).length;
      el.classList.toggle("long", len > 7 && len <= 9);
      el.classList.toggle("longer", len > 9);
    }
    show("game");
    this.renderer.resize();
    this.renderHud();
    if (match.phase !== "aim") this.later(() => this.openScorecard(), 200);
    else if (driver.me !== null && match.turn === driver.me) this.later(() => this.yourTurn(), 400);
    this.loop();
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.queue = [];
    this.rolling = null;
    this.drag = null;
    this.preview = null;
    this.ghost = null;
    this.trail = [];
    this.handoffDue = false;
    this.closeOverlay();
    this.setBanner(null);
    this.driver = null;
  }

  get active(): boolean {
    return this.driver !== null;
  }

  /** Plays a stroke from `before`, then settles on `after`. */
  enqueueShot(seat: Seat, shot: Shot, before: MatchState, after: MatchState): void {
    this.queue.push({ kind: "shot", seat, shot, before, after });
  }

  /** Moves to a new state once any stroke on screen has finished. */
  enqueueState(match: MatchState): void {
    this.queue.push({ kind: "state", match });
  }

  /** The other player's live aim (online). */
  setGhost(seat: Seat, aim: Aim | null): void {
    const m = this.match;
    if (!aim || !m || m.turn !== seat || this.rolling) {
      this.ghost = null;
      return;
    }
    this.ghost = this.aimSprite(seat, aim, true);
  }

  /** Who has tapped on from the scorecard or asked for a rematch (online). */
  setFlags(ready: [boolean, boolean], rematch: [boolean, boolean]): void {
    this.flags = { ready, rematch };
    if (this.overlay === "scorecard") this.renderScorecard();
  }

  /** Online only: input is blocked while this phone is not connected. */
  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) this.cancelDrag();
    this.renderHud();
  }

  setBanner(text: string | null, ok = false): void {
    const el = $("banner");
    el.hidden = !text;
    el.textContent = text ?? "";
    el.classList.toggle("ok", ok);
  }

  /** Online: the friend left, so the game is over. */
  showEnded(title: string, sub: string): void {
    this.cancelDrag();
    $("toast").classList.remove("on");
    this.openOverlay("ended");
    $("ended-title").textContent = title;
    $("ended-sub").textContent = sub;
  }

  toast(text: string, color: string): void {
    const el = $("toast");
    el.textContent = text;
    el.style.setProperty("--c", color);
    el.classList.add("on");
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove("on"), 2200);
  }

  // ---------- stroke playback ----------

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    this.advance(now);
    this.draw(now / 1000);
  };

  private advance(now: number) {
    if (!this.rolling && this.queue.length) {
      // Catching up after a reconnect: jump instead of replaying every stroke.
      while (this.queue.length > 2) {
        const item = this.queue.shift()!;
        this.commit(item.kind === "shot" ? item.after : item.match, null);
      }
      const item = this.queue.shift()!;
      if (item.kind === "state") this.commit(item.match, null);
      else this.roll(item, now);
    }
    const r = this.rolling;
    if (!r) return;
    const tick = Math.min(r.result.ticks, Math.floor(((now - r.start) / 1000) * TICK_HZ));
    while (r.event < r.result.events.length && r.result.events[r.event]!.tick <= tick) {
      const e = r.result.events[r.event++]!;
      if (e.kind === "wall") sfx.wall(e.v);
      else if (e.kind === "bumper") sfx.bumper(e.v);
      else if (e.kind === "lip") sfx.lip();
      else sfx.sink();
    }
    const p = this.ballAt(r.result, tick);
    this.trail.push(p);
    if (this.trail.length > 26) this.trail.shift();
    if (tick >= r.result.ticks) {
      this.rolling = null;
      this.commit(r.after, r.seat);
    }
  }

  private roll(item: Extract<QueueItem, { kind: "shot" }>, now: number) {
    const hole = holeOf(item.before);
    const from = item.before.balls[item.seat];
    // Shows the authoritative state the stroke was played from, then rolls it.
    this.match = item.before;
    const result = simulateShot(hole, from, item.shot);
    this.rolling = { seat: item.seat, result, after: item.after, start: now, event: 0 };
    this.trail = [];
    this.ghost = null;
    this.preview = null;
    this.lastShooter = item.seat;
    this.renderHud();
  }

  private ballAt(result: ShotResult, tick: number): Point {
    const i = Math.min(tick, result.trace.length / 2 - 1);
    return { x: result.trace[i * 2]!, y: result.trace[i * 2 + 1]! };
  }

  /** Settles on a new state and reacts to what changed. */
  private commit(next: MatchState, shooter: Seat | null) {
    const prev = this.match;
    this.match = next;
    const now = performance.now();
    const newHole = !prev || prev.holeIdx !== next.holeIdx || next.strokes < prev.strokes;
    if (newHole) {
      this.sinkAt = [null, null];
      this.trail = [];
      if (this.overlay === "scorecard") this.closeOverlay();
      if (prev) this.callout(`Hole ${next.holeIdx + 1}`, "var(--lime)", holeOf(next).name, 1100);
    } else if (shooter !== null) {
      const ball = next.balls[shooter];
      if (ball.done && !prev!.balls[shooter].done) {
        this.sinkAt[shooter] = ball.pickedUp ? null : now;
        const color = PLAYER_COLORS[shooter];
        const word = scoreName(ball.strokes, holeOf(next).par, ball.pickedUp);
        this.callout(
          word,
          color,
          ball.pickedUp ? `${this.names[shooter]} scores ${ball.strokes + 1}` : "",
          1300,
        );
        if (!ball.pickedUp) this.flash(color);
      }
    }
    this.renderHud();

    if (next.phase !== "aim") {
      this.later(() => this.openScorecard(), shooter === null ? 0 : 1200);
      return;
    }
    const me = this.driver?.me ?? null;
    if (me === null) {
      // Pass-and-play: hand the phone over whenever the player changes.
      if (this.lastShooter !== null && next.turn !== this.lastShooter && this.overlay !== "scorecard") {
        this.handoffDue = true;
        // Let a sink callout play before the card covers the course.
        const sank = shooter !== null && next.balls[shooter].done;
        this.later(() => this.openHandoff(next), shooter === null ? 0 : sank ? 1300 : 700);
      }
    } else if (next.turn === me && (shooter === null ? newHole || prev?.turn !== me : shooter !== me)) {
      this.later(() => this.yourTurn(), shooter === null ? 300 : 600);
    }
  }

  private yourTurn() {
    if (!this.match || this.match.turn !== this.driver?.me || this.match.phase !== "aim") return;
    this.toast("Your turn", PLAYER_COLORS[this.driver.me]);
    sfx.yourTurn();
  }

  // ---------- input ----------

  private canAim(): boolean {
    const m = this.match;
    if (!m || !this.driver || this.rolling || this.queue.length || this.overlay) return false;
    if (this.handoffDue || !this.connected) return false;
    if (m.phase !== "aim" || m.balls[m.turn].done) return false;
    return this.driver.me === null || this.driver.me === m.turn;
  }

  private localPoint(e: PointerEvent) {
    const r = this.renderer.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pointerDown(e: PointerEvent) {
    sfx.unlock();
    if (this.drag || !this.canAim()) return;
    const p = this.localPoint(e);
    this.drag = { id: e.pointerId, x: p.x, y: p.y, cx: p.x, cy: p.y, aim: null };
    try {
      this.renderer.canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers in tests cannot be captured.
    }
    e.preventDefault();
  }

  private pointerMove(e: PointerEvent) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    const p = this.localPoint(e);
    d.cx = p.x;
    d.cy = p.y;
    // Pull back like a slingshot: the ball goes the opposite way to the drag.
    const dx = d.x - p.x;
    const dy = d.y - p.y;
    const drag = Math.min(1, Math.hypot(dx, dy) / this.maxDrag());
    const before = d.aim;
    d.aim = drag >= MIN_DRAG ? { angle: Math.atan2(dy, dx), power: powerFromDrag(drag) } : null;
    if (d.aim && (!before || Math.round(before.power * 20) !== Math.round(d.aim.power * 20))) sfx.tick();
    this.preview = d.aim ? this.aimSprite(this.match!.turn, d.aim, false) : null;
    const now = performance.now();
    if (now - this.lastAimSent > 66) {
      this.lastAimSent = now;
      this.driver?.aim(d.aim);
    }
  }

  private pointerUp(e: PointerEvent, cancelled: boolean) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.preview = null;
    this.driver?.aim(null);
    if (cancelled || !d.aim || !this.canAim()) return;
    sfx.putt(d.aim.power);
    this.driver!.shoot(shotFromAim(d.aim.angle, d.aim.power));
  }

  /** Drag length in CSS pixels for a full-power stroke. */
  private maxDrag(): number {
    return Math.min(170, Math.max(110, this.renderer.canvas.clientWidth * 0.38));
  }

  private cancelDrag() {
    if (this.drag) this.driver?.aim(null);
    this.drag = null;
    this.preview = null;
  }

  private aimSprite(seat: Seat, aim: Aim, ghost: boolean): AimSprite {
    const m = this.match!;
    const hole = holeOf(m);
    const r = simulateShot(hole, m.balls[seat], shotFromAim(aim.angle, aim.power), {
      maxDistance: previewLength(aim.power),
    });
    const bounces = r.events
      .filter((e) => e.kind === "wall" || e.kind === "bumper")
      .map((e) => this.ballAt(r, e.tick));
    return { path: r.trace, bounces, color: PLAYER_COLORS[seat], ghost };
  }

  // ---------- drawing ----------

  private draw(t: number) {
    const m = this.match;
    if (!m) return;
    const now = performance.now();
    const balls = ([0, 1] as const).flatMap((seat) => {
      const b = m.balls[seat];
      const rolling = this.rolling?.seat === seat;
      // A ball still on the tee only shows when it is that player's turn.
      if (!rolling && b.strokes === 0 && m.turn !== seat) return [];
      if (b.pickedUp && !rolling) return [];
      const sinkAt = this.sinkAt[seat];
      const sink = b.done && !rolling ? (sinkAt === null ? 1 : Math.min(1, (now - sinkAt) / 350)) : 0;
      const pos = rolling ? this.trail[this.trail.length - 1]! : b;
      return [{ x: pos.x, y: pos.y, color: PLAYER_COLORS[seat], active: m.turn === seat || rolling, sink }];
    });
    const shooter = this.rolling?.seat;
    let joystick: Joystick | null = null;
    if (this.drag) {
      const d = this.drag;
      joystick = {
        x: d.x,
        y: d.y,
        cx: d.cx,
        cy: d.cy,
        power: d.aim?.power ?? 0,
        color: PLAYER_COLORS[m.turn],
      };
    }
    const scene: Scene = {
      hole: holeOf(m),
      balls,
      trail: shooter !== undefined ? { points: this.trail, color: PLAYER_COLORS[shooter] } : null,
      aim: this.preview ?? this.ghost,
      joystick,
    };
    this.renderer.draw(scene, t);
  }

  private renderHud() {
    const m = this.match;
    if (!m) return;
    const hole = holeOf(m);
    const me = this.driver?.me ?? null;
    const rolling = this.rolling;
    const solo = !!this.driver?.solo;
    for (const seat of solo ? [0 as const] : ([0, 1] as const)) {
      const el = $(`hud-${seat}`);
      el.classList.toggle("on", m.turn === seat && m.phase === "aim");
      const b = m.balls[seat];
      const state = b.pickedUp ? "picked up" : b.done ? "in" : `stroke ${b.strokes}`;
      el.querySelector(".hud-meta")!.textContent = solo
        ? `${formatVsPar(soloVsPar(m))} vs par · ${state}`
        : `${total(m, seat)} total · ${state}`;
    }
    $("hud-hole").textContent = `H${m.holeIdx + 1}`;
    $("hud-par").textContent = `par ${hole.par}`;

    const seat = rolling ? rolling.seat : m.turn;
    const turn = $("turn");
    const between = !rolling && m.phase !== "aim";
    turn.style.setProperty("--c", between ? "var(--lime)" : PLAYER_COLORS[seat]);
    const mine = me === null || me === seat;
    turn.classList.toggle("wait", !mine && !between);
    const name = this.names[seat];
    let who: string;
    let tip: string;
    if (rolling) {
      who = me === null || me !== seat ? name : "You";
      tip = "Rolling...";
    } else if (m.phase !== "aim") {
      who = m.phase === "gameDone" ? "Final card" : `Hole ${m.holeIdx + 1} done`;
      tip = "Tap through the scorecard";
    } else if (me === null) {
      who = name;
      tip = "Your turn · drag anywhere";
    } else if (mine) {
      who = "Your turn";
      tip = this.connected ? "Drag anywhere to putt" : "Reconnecting...";
    } else {
      who = `${name} is aiming`;
      tip = "Watch their line";
    }
    $("turn-who").textContent = who;
    $("turn-tip").textContent = tip;
    const ball = m.balls[seat];
    $("turn-strokes").textContent = String(rolling ? ball.strokes + 1 : Math.max(1, ball.strokes + 1));
    $("turn-strokes").parentElement!.style.visibility = between ? "hidden" : "";
  }

  // ---------- overlays ----------

  private openOverlay(which: Overlay) {
    for (const id of ["handoff", "scorecard", "menu", "ended"] as const) $(id).hidden = id !== which;
    this.overlay = which;
  }

  private closeOverlay() {
    for (const id of ["handoff", "scorecard", "menu", "ended"] as const) $(id).hidden = true;
    this.overlay = null;
  }

  private openHandoff(m: MatchState) {
    this.handoffDue = false;
    if (this.match !== m || this.overlay || m.phase !== "aim") return;
    const seat = m.turn;
    const color = PLAYER_COLORS[seat];
    const ball = m.balls[seat];
    $("handoff-ball").style.setProperty("--c", color);
    $("handoff").querySelector<HTMLElement>(".panel")!.style.setProperty("--c", color);
    $("handoff-title").textContent = `Pass to ${this.names[seat]}`;
    $("handoff-sub").textContent =
      ball.strokes === 0 && m.first === seat
        ? `${this.names[seat]} has the honour on hole ${m.holeIdx + 1}`
        : `Stroke ${ball.strokes + 1} · hand the phone over`;
    this.openOverlay("handoff");
  }

  private openMenu() {
    if (this.overlay === "ended") return;
    this.cancelDrag();
    this.syncSoundLabel();
    $("menu-quit").textContent =
      this.driver?.me === null ? (this.driver.solo ? "End round" : "End game") : "Leave game";
    this.openOverlay("menu");
  }

  private syncSoundLabel() {
    $("menu-sound").textContent = sfx.enabled ? "Sound on" : "Sound off";
  }

  private openScorecard() {
    if (!this.match || this.match.phase === "aim" || this.overlay === "ended") return;
    this.openOverlay("scorecard");
    this.renderScorecard();
  }

  private renderScorecard() {
    const m = this.match;
    if (!m || this.overlay !== "scorecard") return;
    const final = m.phase === "gameDone";
    const solo = !!this.driver?.solo;
    const me = this.driver?.me ?? null;
    const panel = $("scorecard").querySelector<HTMLElement>(".panel")!;
    const win = final ? winner(m) : null;
    panel.style.setProperty("--c", win === null || solo ? "var(--lime)" : PLAYER_COLORS[win]);

    if (solo) {
      const diff = formatVsPar(soloVsPar(m));
      if (final) {
        $("score-title").textContent = "Round complete";
        $("score-sub").textContent = `${soloTotal(m)} strokes · ${diff} vs par`;
      } else {
        const next = HOLES[m.holeIdx + 1]!;
        $("score-title").textContent = `Hole ${m.holeIdx + 1} clear`;
        $("score-sub").textContent = `${diff} vs par · Next: ${next.name} · par ${next.par}`;
      }
    } else if (final) {
      $("score-title").textContent =
        win === null
          ? "Dead heat"
          : me === null
            ? `${this.names[win]} wins`
            : win === me
              ? "You win"
              : `${this.names[win]} wins`;
      $("score-sub").textContent = "Lowest total takes the round";
    } else {
      const next = HOLES[m.holeIdx + 1]!;
      $("score-title").textContent = `Hole ${m.holeIdx + 1} clear`;
      $("score-sub").textContent = `Next: ${next.name} · par ${next.par}`;
    }

    $("score-table").innerHTML = (solo ? this.soloRows(m) : this.matchRows(m)).join("");
    // Eighteen rows outgrow a phone: the table scrolls on its own, just far enough to show the hole
    // just played above the pinned total row. Done after layout, once the panel has its final height.
    requestAnimationFrame(() => {
      const scroll = $("score-scroll");
      const row = $("score-table").querySelector<HTMLElement>("tr.now");
      const totalRow = $("score-table").querySelector<HTMLElement>("tr.total");
      if (row && totalRow) {
        scroll.scrollTop = row.offsetTop + row.offsetHeight - (scroll.clientHeight - totalRow.offsetHeight);
      }
    });

    const btn = $<HTMLButtonElement>("score-next");
    const note = $("score-note");
    const flags = final ? this.flags.rematch : this.flags.ready;
    btn.textContent = final ? (solo ? "Play again" : "Run it back") : "Next hole";
    btn.disabled = false;
    note.textContent = final && solo ? (this.driver?.finalNote?.() ?? "") : "";
    $("score-home").hidden = !final;
    if (me !== null) {
      const friend = this.names[other(me)];
      if (flags[me]) {
        btn.disabled = true;
        btn.textContent = `Waiting for ${friend}`;
      } else if (flags[other(me)]) {
        note.textContent = final ? `${friend} wants a rematch` : `${friend} is ready`;
      }
    }
  }

  private soloRows(m: MatchState): string[] {
    const rows = [
      `<tr><th style="--c:${PLAYER_COLORS[0]}"></th><th style="--c:${PLAYER_COLORS[0]}">Strokes</th><th style="--c:${PLAYER_COLORS[0]}">vs par</th></tr>`,
    ];
    HOLES.forEach((h, i) => {
      const s = m.scores[0][i] ?? null;
      const cells =
        s === null
          ? `<td class="dim">·</td><td class="dim">·</td>`
          : `<td>${s}</td><td class="${s < h.par ? "best" : ""}">${formatVsPar(s - h.par)}</td>`;
      rows.push(`<tr class="${i === m.holeIdx ? "now" : ""}"><td>H${i + 1} · par ${h.par}</td>${cells}</tr>`);
    });
    rows.push(
      `<tr class="total"><td>Total</td><td>${soloTotal(m)}</td><td>${formatVsPar(soloVsPar(m))}</td></tr>`,
    );
    return rows;
  }

  private matchRows(m: MatchState): string[] {
    const rows: string[] = [];
    rows.push(
      `<tr><th></th>${([0, 1] as const)
        .map((s) => {
          const long = Array.from(this.names[s]).length > 8 ? ' class="long"' : "";
          return `<th${long} style="--c:${PLAYER_COLORS[s]}">${escapeHtml(this.names[s])}</th>`;
        })
        .join("")}</tr>`,
    );
    HOLES.forEach((h, i) => {
      const a = m.scores[0][i] ?? null;
      const b = m.scores[1][i] ?? null;
      const cell = (s: number | null, o: number | null) =>
        s === null ? `<td class="dim">·</td>` : `<td class="${o !== null && s < o ? "best" : ""}">${s}</td>`;
      rows.push(
        `<tr class="${i === m.holeIdx ? "now" : ""}"><td>H${i + 1} · par ${h.par}</td>${cell(a, b)}${cell(b, a)}</tr>`,
      );
    });
    const par = HOLES.slice(0, m.holeIdx + 1).reduce((s, h) => s + h.par, 0);
    const vsPar = (seat: Seat) => {
      const played = m.scores[seat].slice(0, m.holeIdx + 1).every((s) => s !== null);
      if (!played) return "";
      return ` <small>${formatVsPar(total(m, seat) - par)}</small>`;
    };
    rows.push(
      `<tr class="total"><td>Total</td><td>${total(m, 0)}${vsPar(0)}</td><td>${total(m, 1)}${vsPar(1)}</td></tr>`,
    );
    return rows;
  }

  private callout(text: string, color: string, sub: string, ms: number) {
    const el = $("callout");
    el.style.setProperty("--c", color);
    el.textContent = text;
    if (sub) {
      const small = document.createElement("small");
      small.textContent = sub;
      el.append(small);
    }
    el.classList.add("on");
    clearTimeout(this.calloutTimer);
    this.calloutTimer = window.setTimeout(() => el.classList.remove("on"), ms);
  }

  private flash(color: string) {
    const el = $("flash");
    el.style.setProperty("--c", color);
    el.classList.add("on");
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("on")));
  }

  private later(fn: () => void, ms: number) {
    this.timers.push(window.setTimeout(fn, ms));
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
