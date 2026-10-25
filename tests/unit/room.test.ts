import { describe, expect, it } from "vitest";
import { holeOf } from "../../src/core/match.ts";
import {
  claimSeat,
  createRoom,
  leave,
  ready,
  rematch,
  roomView,
  shoot,
  start,
  type RoomRecord,
} from "../../src/core/room.ts";
import { findShot } from "../../src/core/solver.ts";

const HOST = "a".repeat(32);
const GUEST = "b".repeat(32);
const STRANGER = "c".repeat(32);
const LIVE: [boolean, boolean] = [true, true];

function playingRoom(): RoomRecord {
  const room = createRoom("BCDFG");
  claimSeat(room, HOST, "Ana", LIVE);
  claimSeat(room, GUEST, "Kai", LIVE);
  start(room, 0);
  return room;
}

describe("seats", () => {
  it("seats the host first, then the friend, then refuses a third", () => {
    const room = createRoom("BCDFG");
    expect(claimSeat(room, HOST, "Ana", LIVE)).toBe(0);
    expect(claimSeat(room, GUEST, "Kai", LIVE)).toBe(1);
    expect(claimSeat(room, STRANGER, "Zed", LIVE)).toBe("full");
  });

  it("gives a player their own seat back by token", () => {
    const room = playingRoom();
    expect(claimSeat(room, GUEST, "Kai", LIVE)).toBe(1);
    expect(claimSeat(room, HOST, "Ana", LIVE)).toBe(0);
    expect(claimSeat(room, STRANGER, "Zed", LIVE)).toBe("full");
  });

  it("hides tokens and reports who is connected", () => {
    const view = roomView(playingRoom(), [true, false]);
    expect(view.players).toEqual([
      { name: "Ana", connected: true },
      { name: "Kai", connected: false },
    ]);
    expect(JSON.stringify(view)).not.toContain(HOST);
  });
});

describe("lobby", () => {
  it("starts only when the host asks and both players are in", () => {
    const room = createRoom("BCDFG");
    claimSeat(room, HOST, "Ana", LIVE);
    expect(start(room, 0)).toBe(false);
    claimSeat(room, GUEST, "Kai", LIVE);
    expect(start(room, 1)).toBe(false);
    expect(start(room, 0)).toBe(true);
    expect(room.status).toBe("playing");
    expect(room.match?.turn).toBe(0);
  });

  it("frees the seat when the friend leaves the lobby", () => {
    const room = createRoom("BCDFG");
    claimSeat(room, HOST, "Ana", LIVE);
    claimSeat(room, GUEST, "Kai", LIVE);
    leave(room, 1);
    expect(room.status).toBe("lobby");
    expect(room.seats[1]).toBeNull();
    expect(claimSeat(room, STRANGER, "Zed", LIVE)).toBe(1);
  });

  it("gives a dropped friend's seat to a new phone, and the old token no longer owns it", () => {
    const room = createRoom("BCDFG");
    claimSeat(room, HOST, "Ana", LIVE);
    claimSeat(room, GUEST, "Kai", LIVE);
    expect(claimSeat(room, STRANGER, "Zed", [true, false])).toBe(1);
    expect(room.seats[1]?.name).toBe("Zed");
    expect(claimSeat(room, STRANGER, "Zed", LIVE)).toBe(1);
    expect(claimSeat(room, GUEST, "Kai", LIVE)).toBe("full");
  });

  it("never gives away the host's seat", () => {
    const room = createRoom("BCDFG");
    claimSeat(room, HOST, "Ana", LIVE);
    claimSeat(room, GUEST, "Kai", LIVE);
    expect(claimSeat(room, STRANGER, "Zed", [false, true])).toBe("full");
    expect(room.seats[0]?.name).toBe("Ana");
  });

  it("keeps a dropped player's seat once the round has started", () => {
    const room = playingRoom();
    expect(claimSeat(room, STRANGER, "Zed", [true, false])).toBe("full");
    expect(claimSeat(room, GUEST, "Kai", [true, false])).toBe(1);
  });

  it("ends the room when the host leaves", () => {
    const room = createRoom("BCDFG");
    claimSeat(room, HOST, "Ana", LIVE);
    leave(room, 0);
    expect(room.status).toBe("ended");
    expect(claimSeat(room, HOST, "Ana", LIVE)).toBe("gone");
  });
});

describe("play", () => {
  it("applies a stroke only on the right turn and the latest state", () => {
    const room = playingRoom();
    const shot = { vx: 0, vy: -200 };
    expect(shoot(room, 1, shot, 0)).toBeNull();
    expect(shoot(room, 0, shot, 5)).toBeNull();
    const out = shoot(room, 0, shot, 0);
    expect(out?.seat).toBe(0);
    expect(room.match?.strokes).toBe(1);
    expect(room.match?.turn).toBe(1);
    // The same stroke sent twice is refused the second time.
    expect(shoot(room, 0, shot, 0)).toBeNull();
  });

  it("waits for both players before the next hole and the rematch", () => {
    const room = playingRoom();
    while (room.match!.phase === "aim") {
      const m = room.match!;
      shoot(room, m.turn, findShot(holeOf(m), m.balls[m.turn]).shot, m.strokes);
    }
    expect(room.match!.phase).toBe("holeDone");
    expect(ready(room, 0)).toBe(true);
    expect(ready(room, 0)).toBe(false);
    expect(room.match!.holeIdx).toBe(0);
    expect(ready(room, 1)).toBe(true);
    expect(room.match!.holeIdx).toBe(1);
    expect(room.ready).toEqual([false, false]);

    room.match = { ...room.match!, phase: "gameDone", scores: [[2], [3]] };
    expect(rematch(room, 1)).toBe(true);
    expect(room.match.phase).toBe("gameDone");
    expect(rematch(room, 0)).toBe(true);
    expect(room.match).toMatchObject({ phase: "aim", holeIdx: 0, turn: 0 });
  });

  it("ends the game for both when a player leaves mid-round", () => {
    const room = playingRoom();
    leave(room, 1);
    expect(room.status).toBe("ended");
    expect(room.leftBy).toBe(1);
    expect(shoot(room, 0, { vx: 0, vy: -200 }, 0)).toBeNull();
  });
});
