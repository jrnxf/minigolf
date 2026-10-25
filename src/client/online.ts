// Online play: lobby, live turns and presence for one room. The room server
// is the authority; this phone predicts its own strokes so they start
// rolling at once, then settles on whatever the server says.

import { applyShot, other, type MatchState, type Seat } from "../core/match.ts";
import type { Shot } from "../core/physics.ts";
import type { Aim, ErrorCode, RoomView, ServerMessage } from "../core/protocol.ts";
import { $, show } from "./dom.ts";
import type { Driver, GameScreen } from "./game.ts";
import { RoomSocket, type SocketStatus } from "./net.ts";
import { PLAYER_COLORS } from "./render.ts";
import { sfx } from "./sfx.ts";
import { deviceToken, save } from "./storage.ts";

export interface OnlineHooks {
  /** Back to the home screen. */
  home(): void;
  /** The room cannot be joined. */
  refused(code: ErrorCode): void;
}

export class OnlineSession implements Driver {
  me: Seat | null = null;
  readonly code: string;
  private room: RoomView | null = null;
  /** The last match state the server confirmed. */
  private match: MatchState | null = null;
  private shown = "";
  /** The `at` of a stroke this phone sent and has already started rolling. */
  private pending: number | null = null;
  private status: SocketStatus = "connecting";
  private socket: RoomSocket;
  private screen: GameScreen;
  private hooks: OnlineHooks;
  private bannerTimer = 0;

  constructor(code: string, name: string, screen: GameScreen, hooks: OnlineHooks) {
    this.code = code;
    this.screen = screen;
    this.hooks = hooks;
    save("room", code);
    this.socket = new RoomSocket(code, deviceToken(), name, {
      message: (m) => this.onMessage(m),
      status: (s) => this.onStatus(s),
    });
    this.socket.connect();
  }

  // ---------- Driver ----------

  shoot(shot: Shot): void {
    const m = this.match;
    if (!m || this.me === null || this.pending !== null) return;
    const out = applyShot(m, this.me, shot);
    if (!out || !this.socket.send({ t: "shot", shot, at: m.strokes })) return;
    this.pending = m.strokes;
    this.screen.enqueueShot(this.me, shot, m, out.state);
    this.shown = JSON.stringify(out.state);
  }

  aim(aim: Aim | null): void {
    this.socket.send({ t: "aim", aim });
  }

  next(): void {
    this.socket.send({ t: "ready" });
  }

  again(): void {
    this.socket.send({ t: "rematch" });
  }

  quit(): void {
    this.socket.send({ t: "leave" });
    this.end();
    this.hooks.home();
  }

  /** Starts the round from the lobby (host only). */
  startRound(): void {
    this.socket.send({ t: "start" });
  }

  /** Stops talking to the room without leaving it (the seat stays ours). */
  end(): void {
    this.socket.close();
    this.screen.stop();
    save("room", null);
  }

  // ---------- server ----------

  private onMessage(msg: ServerMessage) {
    switch (msg.t) {
      case "welcome":
        this.me = msg.seat;
        this.applyRoom(msg.room, true);
        return;
      case "room":
        this.applyRoom(msg.room, false);
        return;
      case "shot":
        this.applyShot(msg.seat, msg.shot, msg.room);
        return;
      case "aim":
        if (msg.seat !== this.me) this.screen.setGhost(msg.seat, msg.aim);
        return;
      case "error":
        this.onError(msg.code);
        return;
    }
  }

  private onError(code: ErrorCode) {
    if (code === "bad") return;
    if (code === "replaced") {
      this.screen.setBanner("This game is open on another screen.");
      this.socket.close();
      return;
    }
    this.end();
    this.hooks.refused(code);
  }

  private onStatus(status: SocketStatus) {
    const was = this.status;
    this.status = status;
    if (this.screen.active) {
      this.screen.setConnected(status === "open");
      this.updateBanner(was !== "open" && status === "open");
    }
    this.renderLobby();
  }

  private applyRoom(room: RoomView, fresh: boolean) {
    const before = this.room;
    this.room = room;
    if (room.status === "ended") {
      this.onEnded(room);
      return;
    }
    if (room.status === "lobby" || !room.match) {
      if (this.screen.active) this.screen.stop();
      show("lobby");
      this.renderLobby();
      // A friend just walked in.
      if (before && !before.players[1] && room.players[1] && this.me === 0) sfx.yourTurn();
      return;
    }

    const names = this.names();
    if (!this.screen.active) {
      this.match = room.match;
      this.shown = JSON.stringify(room.match);
      this.pending = null;
      this.screen.start(this, names, room.match);
    } else {
      if (fresh && this.pending !== null && room.match.strokes === this.pending) {
        // The stroke we sent before the drop never arrived.
        this.screen.toast("Connection hiccup · take that one again", PLAYER_COLORS[this.me ?? 0]);
      }
      if (this.pending !== null && room.match.strokes <= this.pending) this.pending = null;
      this.match = room.match;
      this.settle(room.match);
    }
    this.screen.setConnected(this.status === "open");
    this.screen.setFlags(room.ready, room.rematch);
    this.updateBanner(false);
  }

  private applyShot(seat: Seat, shot: Shot, room: RoomView) {
    const before = this.match;
    this.room = room;
    if (!room.match || !before) return this.applyRoom(room, false);
    if (seat === this.me && this.pending === before.strokes) {
      // Our own stroke, already rolling: settle on the server's result (a no-op when the prediction was right).
      this.pending = null;
      this.match = room.match;
      this.settle(room.match);
    } else {
      this.match = room.match;
      this.screen.enqueueShot(seat, shot, before, room.match);
      this.shown = JSON.stringify(room.match);
    }
    this.screen.setFlags(room.ready, room.rematch);
  }

  /** Queues a state only when it differs from what the screen will end up showing. */
  private settle(match: MatchState) {
    const json = JSON.stringify(match);
    if (json === this.shown) return;
    this.shown = json;
    this.screen.enqueueState(match);
  }

  private onEnded(room: RoomView) {
    const leaver = room.leftBy;
    if (leaver === this.me) return;
    const name = leaver === null ? "Your friend" : (room.players[leaver]?.name ?? "Your friend");
    this.socket.close();
    save("room", null);
    if (this.screen.active) {
      this.screen.setBanner(null);
      this.screen.showEnded(`${name} left`, "This round is over.");
    } else {
      this.hooks.refused("gone");
    }
  }

  private names(): [string, string] {
    const p = this.room?.players;
    return [p?.[0]?.name ?? "Player 1", p?.[1]?.name ?? "Player 2"];
  }

  private updateBanner(recovered: boolean) {
    clearTimeout(this.bannerTimer);
    const room = this.room;
    if (this.status !== "open") {
      this.screen.setBanner("Connection lost · reconnecting...");
      return;
    }
    const friend = this.me === null ? null : room?.players[other(this.me)];
    if (friend && !friend.connected && room?.status === "playing") {
      this.screen.setBanner(`${friend.name} dropped out · waiting...`);
      return;
    }
    if (recovered) {
      this.screen.setBanner("Back online", true);
      this.bannerTimer = window.setTimeout(() => this.screen.setBanner(null), 1600);
    } else {
      this.screen.setBanner(null);
    }
  }

  private renderLobby() {
    const room = this.room;
    if (!room || room.status !== "lobby") return;
    $("room-code").textContent = room.code;
    $("invite-url").textContent = `${location.host}/r/${room.code}`;
    const live = $("lobby-live");
    live.classList.toggle("off", this.status !== "open");
    live.lastChild!.textContent = this.status === "open" ? "Room open" : "Reconnecting";

    for (const seat of [0, 1] as const) {
      const p = room.players[seat];
      const el = $(`slot-${seat}`);
      el.className = p ? "slot" : "slot empty";
      el.style.setProperty("--c", PLAYER_COLORS[seat]);
      el.replaceChildren();
      const ball = document.createElement("i");
      ball.className = "ball";
      const nm = document.createElement("div");
      nm.className = "nm";
      const st = document.createElement("div");
      st.className = "st";
      if (p) {
        nm.textContent = p.name;
        st.textContent = seat === this.me ? "You" : p.connected ? "Joined" : "Away";
      } else {
        nm.textContent = "Friend";
        st.textContent = "Waiting";
        st.classList.add("dots");
      }
      el.append(ball, nm, st);
    }

    const startBtn = $<HTMLButtonElement>("start-round");
    const note = $("lobby-note");
    if (this.me === 0) {
      startBtn.hidden = false;
      startBtn.disabled = !room.players[1]?.connected || this.status !== "open";
      note.textContent = room.players[1] ? "" : "Send the link. The round starts when you tap start.";
    } else {
      startBtn.hidden = true;
      note.textContent = `Waiting for ${room.players[0]?.name ?? "the host"} to start the round`;
    }
  }
}
