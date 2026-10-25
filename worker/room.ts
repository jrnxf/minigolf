// One Durable Object per room. It holds the authoritative room record,
// replays every stroke with the shared physics, and fans updates out to
// both players' sockets. Sockets use the hibernation API, so the room only
// costs anything while someone is actually sending messages.

import { DurableObject } from "cloudflare:workers";
import type { Seat } from "../src/core/match.ts";
import {
  CLOSE_FULL,
  CLOSE_GONE,
  CLOSE_REPLACED,
  PROTOCOL,
  cleanName,
  parseClientMessage,
  type ErrorCode,
  type ServerMessage,
} from "../src/core/protocol.ts";
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
} from "../src/core/room.ts";
import type { Env } from "./index.ts";

/** A room nobody has touched for this long is deleted. */
const IDLE_TTL_MS = 2 * 60 * 60 * 1000;
/** A room someone left is kept just long enough for the other phone to see it. */
const ENDED_TTL_MS = 10 * 60 * 1000;

interface Attachment {
  seat: Seat | null;
}

export class Room extends DurableObject<Env> {
  private room: RoomRecord | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keep-alive pings are answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    void ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomRecord>("room")) ?? null;
    });
  }

  /** Claims this room for a new code. False if it already exists. */
  async init(code: string): Promise<boolean> {
    if (this.room) return false;
    this.room = createRoom(code);
    await this.save();
    return true;
  }

  /** Lobby info for the join screen, or null when the room does not exist. */
  async info(): Promise<{ status: RoomRecord["status"]; host: string | null; open: boolean } | null> {
    if (!this.room) return null;
    return {
      status: this.room.status,
      host: this.room.seats[0]?.name ?? null,
      open: this.room.status === "lobby" && !this.room.seats[1],
    };
  }

  override async fetch(): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: null } satisfies Attachment);
    if (!this.room) this.reject(server, "gone", CLOSE_GONE);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const room = this.room;
    const msg = parseClientMessage(data);
    if (!room || !msg) return this.send(ws, { t: "error", code: room ? "bad" : "gone" });
    const { seat } = ws.deserializeAttachment() as Attachment;

    if (msg.t === "ping") return this.send(ws, { t: "pong" });
    if (msg.t === "hello") return this.hello(ws, room, msg.v, msg.token, msg.name);
    if (seat === null) return this.send(ws, { t: "error", code: "bad" });

    switch (msg.t) {
      case "aim":
        // Live aim is cosmetic: relay it to the other phone, never store it.
        if (room.match?.turn === seat && room.match.phase === "aim") {
          this.broadcast({ t: "aim", seat, aim: msg.aim }, ws);
        }
        return;
      case "shot": {
        const outcome = shoot(room, seat, msg.shot, msg.at);
        // A refused stroke means this phone is out of date: send it the truth.
        if (!outcome) return this.send(ws, { t: "room", room: this.view() });
        await this.save();
        return this.broadcast({ t: "shot", seat, shot: msg.shot, room: this.view() });
      }
      case "start":
        if (start(room, seat)) await this.saveAndShare();
        return;
      case "ready":
        if (ready(room, seat)) await this.saveAndShare();
        return;
      case "rematch":
        if (rematch(room, seat)) await this.saveAndShare();
        return;
      case "leave":
        leave(room, seat);
        ws.serializeAttachment({ seat: null } satisfies Attachment);
        await this.saveAndShare();
        ws.close(1000, "left");
        return;
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.dropped(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.dropped(ws);
  }

  override async alarm(): Promise<void> {
    const last = (await this.ctx.storage.get<number>("active")) ?? 0;
    const ttl = this.room?.status === "ended" ? ENDED_TTL_MS : IDLE_TTL_MS;
    if (Date.now() - last < ttl) {
      await this.ctx.storage.setAlarm(last + ttl);
      return;
    }
    for (const ws of this.ctx.getWebSockets()) this.reject(ws, "gone", CLOSE_GONE);
    this.room = null;
    await this.ctx.storage.deleteAll();
  }

  private async hello(ws: WebSocket, room: RoomRecord, v: number, token: string, name: string) {
    if (v !== PROTOCOL) return this.reject(ws, "version", CLOSE_GONE);
    const fallback = room.seats[0] ? "Player 2" : "Player 1";
    const seat = claimSeat(room, token, cleanName(name, fallback));
    if (typeof seat !== "number") return this.reject(ws, seat, seat === "full" ? CLOSE_FULL : CLOSE_GONE);
    // The same player on a fresh connection replaces their old one.
    for (const other of this.sockets(seat)) {
      if (other !== ws) {
        other.serializeAttachment({ seat: null } satisfies Attachment);
        this.reject(other, "replaced", CLOSE_REPLACED);
      }
    }
    ws.serializeAttachment({ seat } satisfies Attachment);
    await this.save();
    this.send(ws, { t: "welcome", seat, room: this.view() });
    this.broadcast({ t: "room", room: this.view() }, ws);
  }

  private dropped(ws: WebSocket) {
    const { seat } = (ws.deserializeAttachment() as Attachment | null) ?? { seat: null };
    ws.serializeAttachment({ seat: null } satisfies Attachment);
    if (seat !== null && this.room) this.broadcast({ t: "room", room: this.view() }, ws);
  }

  private sockets(seat: Seat): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment() as Attachment | null;
      return a?.seat === seat && ws.readyState === WebSocket.OPEN;
    });
  }

  private view() {
    return roomView(this.room!, [this.sockets(0).length > 0, this.sockets(1).length > 0]);
  }

  private async save() {
    const now = Date.now();
    await this.ctx.storage.put({ room: this.room, active: now });
    const ttl = this.room?.status === "ended" ? ENDED_TTL_MS : IDLE_TTL_MS;
    await this.ctx.storage.setAlarm(now + ttl);
  }

  private async saveAndShare() {
    await this.save();
    this.broadcast({ t: "room", room: this.view() });
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // The socket is already closing; its close handler cleans up.
    }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (ws !== except && a?.seat != null) this.send(ws, msg);
    }
  }

  private reject(ws: WebSocket, code: ErrorCode, closeCode: number) {
    this.send(ws, { t: "error", code });
    try {
      ws.close(closeCode, code);
    } catch {
      // Already closed.
    }
  }
}
