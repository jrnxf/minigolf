// The online room as plain data and pure transitions. The Durable Object
// only stores this record, wires sockets to these functions and broadcasts
// the result, so the whole turn flow is unit-testable without a server.

import {
  applyShot,
  createMatch,
  nextHole,
  rematch as rematchOf,
  type MatchState,
  type Seat,
  type ShotOutcome,
} from "./match.ts";
import type { Shot } from "./physics.ts";
import type { ErrorCode, RoomStatus, RoomView } from "./protocol.ts";

export interface SeatRecord {
  /** Random per-device secret that lets a player take their seat back after a drop. */
  token: string;
  name: string;
}

export interface RoomRecord {
  code: string;
  status: RoomStatus;
  seats: [SeatRecord | null, SeatRecord | null];
  match: MatchState | null;
  ready: [boolean, boolean];
  rematch: [boolean, boolean];
  leftBy: Seat | null;
}

export function createRoom(code: string): RoomRecord {
  return {
    code,
    status: "lobby",
    seats: [null, null],
    match: null,
    ready: [false, false],
    rematch: [false, false],
    leftBy: null,
  };
}

/** What phones see: no tokens. `connected` comes from the live sockets, not storage. */
export function roomView(room: RoomRecord, connected: [boolean, boolean]): RoomView {
  const player = (seat: Seat) => {
    const s = room.seats[seat];
    return s ? { name: s.name, connected: connected[seat] } : null;
  };
  return {
    code: room.code,
    status: room.status,
    players: [player(0), player(1)],
    match: room.match,
    ready: room.ready,
    rematch: room.rematch,
    leftBy: room.leftBy,
  };
}

/** Seats a player: back in their own seat by token, else the first free one while in the lobby. */
export function claimSeat(room: RoomRecord, token: string, name: string): Seat | ErrorCode {
  if (room.status === "ended") return "gone";
  for (const seat of [0, 1] as const) {
    const s = room.seats[seat];
    if (s && s.token === token) return seat;
  }
  if (room.status !== "lobby") return "full";
  for (const seat of [0, 1] as const) {
    if (!room.seats[seat]) {
      room.seats[seat] = { token, name };
      return seat;
    }
  }
  return "full";
}

/** A player leaves on purpose. In the lobby a guest just frees the seat; otherwise the room ends. */
export function leave(room: RoomRecord, seat: Seat): void {
  if (room.status === "ended") return;
  if (room.status === "lobby" && seat === 1) {
    room.seats[1] = null;
    return;
  }
  room.status = "ended";
  room.leftBy = seat;
}

/** The host starts the round once a friend has joined. */
export function start(room: RoomRecord, seat: Seat): boolean {
  if (room.status !== "lobby" || seat !== 0 || !room.seats[0] || !room.seats[1]) return false;
  room.status = "playing";
  room.match = createMatch(0);
  return true;
}

/** Applies a stroke if it is this seat's turn and the client saw the latest state (`at`). */
export function shoot(room: RoomRecord, seat: Seat, shot: Shot, at: number): ShotOutcome | null {
  if (room.status !== "playing" || !room.match || room.match.strokes !== at) return null;
  const outcome = applyShot(room.match, seat, shot, { trace: false });
  if (!outcome) return null;
  room.match = outcome.state;
  return outcome;
}

/** A player taps on from the scorecard; the next hole starts when both have. */
export function ready(room: RoomRecord, seat: Seat): boolean {
  if (room.status !== "playing" || room.match?.phase !== "holeDone" || room.ready[seat]) return false;
  room.ready[seat] = true;
  if (room.ready[0] && room.ready[1]) {
    room.match = nextHole(room.match);
    room.ready = [false, false];
  }
  return true;
}

/** A player asks for a rematch; a new match starts when both have. */
export function rematch(room: RoomRecord, seat: Seat): boolean {
  if (room.status !== "playing" || room.match?.phase !== "gameDone" || room.rematch[seat]) return false;
  room.rematch[seat] = true;
  if (room.rematch[0] && room.rematch[1]) {
    room.match = rematchOf(room.match);
    room.rematch = [false, false];
  }
  return true;
}
