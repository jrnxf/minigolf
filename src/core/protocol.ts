// Messages between a phone and its room server, plus the small helpers both
// sides use to check them. Everything is JSON over one WebSocket per player.

import type { MatchState, Seat } from "./match.ts";
import { isValidShot, type Shot } from "./physics.ts";

export const PROTOCOL = 1;

/** Room codes avoid vowels (no accidental words) and look-alikes like 0/O and 1/I. */
export const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";
export const CODE_LENGTH = 5;
export const NAME_MAX = 12;

export interface Aim {
  angle: number;
  power: number;
}

export interface PlayerView {
  name: string;
  connected: boolean;
}

export type RoomStatus = "lobby" | "playing" | "ended";

export interface RoomView {
  code: string;
  status: RoomStatus;
  players: [PlayerView | null, PlayerView | null];
  match: MatchState | null;
  /** Who has tapped on from the scorecard after a hole. */
  ready: [boolean, boolean];
  /** Who asked for a rematch after the last hole. */
  rematch: [boolean, boolean];
  /** Set when a player left the game for good. */
  leftBy: Seat | null;
}

export type ClientMessage =
  | { t: "hello"; v: number; token: string; name: string }
  | { t: "start" }
  | { t: "aim"; aim: Aim | null }
  | { t: "shot"; shot: Shot; at: number }
  | { t: "ready" }
  | { t: "rematch" }
  | { t: "leave" }
  | { t: "ping" };

export type ErrorCode = "full" | "gone" | "bad" | "replaced" | "version";

export type ServerMessage =
  | { t: "welcome"; seat: Seat; room: RoomView }
  | { t: "room"; room: RoomView }
  | { t: "shot"; seat: Seat; shot: Shot; room: RoomView }
  | { t: "aim"; seat: Seat; aim: Aim | null }
  | { t: "error"; code: ErrorCode }
  | { t: "pong" };

/** WebSocket close codes the server uses on purpose. */
export const CLOSE_REPLACED = 4001;
export const CLOSE_GONE = 4004;
export const CLOSE_FULL = 4009;

export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .split("")
    .filter((c) => CODE_ALPHABET.includes(c))
    .join("")
    .slice(0, CODE_LENGTH);
}

export function isCode(input: string): boolean {
  return input.length === CODE_LENGTH && normalizeCode(input) === input;
}

export function cleanName(input: unknown, fallback: string): string {
  if (typeof input !== "string") return fallback;
  // Drop control characters and collapse spaces; names are shown, never stored past the room.
  const name = input
    .replace(/\s+/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  return Array.from(name).slice(0, NAME_MAX).join("") || fallback;
}

function isAim(a: unknown): a is Aim {
  if (typeof a !== "object" || a === null) return false;
  const { angle, power } = a as Record<string, unknown>;
  return (
    typeof angle === "number" &&
    typeof power === "number" &&
    Number.isFinite(angle) &&
    power >= 0 &&
    power <= 1
  );
}

/** Parses a message from a phone. Returns null for anything malformed. */
export function parseClientMessage(raw: unknown): ClientMessage | null {
  if (typeof raw !== "string" || raw.length > 512) return null;
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  switch (m.t) {
    case "hello":
      if (typeof m.v !== "number" || typeof m.token !== "string" || !/^[a-f0-9]{32}$/.test(m.token))
        return null;
      return { t: "hello", v: m.v, token: m.token, name: typeof m.name === "string" ? m.name : "" };
    case "aim":
      if (m.aim !== null && !isAim(m.aim)) return null;
      return { t: "aim", aim: m.aim === null ? null : { angle: m.aim.angle, power: m.aim.power } };
    case "shot":
      if (!isValidShot(m.shot) || !Number.isInteger(m.at)) return null;
      return { t: "shot", shot: { vx: m.shot.vx, vy: m.shot.vy }, at: m.at as number };
    case "start":
    case "ready":
    case "rematch":
    case "leave":
    case "ping":
      return { t: m.t };
    default:
      return null;
  }
}
