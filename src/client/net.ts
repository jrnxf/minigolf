// One WebSocket to a room that keeps itself alive: it reconnects with
// backoff after a drop, right away when the tab comes back to the front or
// the phone goes back online, and notices a silently dead connection.

import {
  CLOSE_FULL,
  CLOSE_GONE,
  CLOSE_REPLACED,
  PROTOCOL,
  type ClientMessage,
  type ServerMessage,
} from "../core/protocol.ts";

export type SocketStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface SocketHandlers {
  message(msg: ServerMessage): void;
  status(status: SocketStatus): void;
}

const PING_MS = 15_000;
/** How long a wake-up ping may take before the socket counts as dead. */
const PROBE_MS = 4_000;
/** No message for this long means the connection is dead even if the browser has not noticed. */
const STALE_MS = 40_000;
/** Server close codes after which reconnecting would not help. */
const FINAL = new Set([CLOSE_REPLACED, CLOSE_GONE, CLOSE_FULL, 1000]);

export class RoomSocket {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retry = 0;
  private pinger = 0;
  private lastHeard = 0;
  private stopped = false;
  private code: string;
  private token: string;
  private name: string;
  private handlers: SocketHandlers;

  constructor(code: string, token: string, name: string, handlers: SocketHandlers) {
    this.code = code;
    this.token = token;
    this.name = name;
    this.handlers = handlers;
    document.addEventListener("visibilitychange", this.wake);
    window.addEventListener("online", this.wake);
    window.addEventListener("pageshow", this.wake);
  }

  connect(): void {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.ws?.close();
    this.handlers.status(this.attempt === 0 ? "connecting" : "reconnecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${this.code}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastHeard = Date.now();
      ws.send(JSON.stringify({ t: "hello", v: PROTOCOL, token: this.token, name: this.name }));
      this.handlers.status("open");
      clearInterval(this.pinger);
      this.pinger = window.setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      this.lastHeard = Date.now();
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as ServerMessage;
      } catch {
        return;
      }
      if (msg.t !== "pong") this.handlers.message(msg);
    };
    ws.onclose = (e) => {
      if (ws !== this.ws) return;
      clearInterval(this.pinger);
      this.ws = null;
      if (this.stopped || FINAL.has(e.code)) {
        this.stopped = true;
        this.handlers.status("closed");
        return;
      }
      this.scheduleRetry();
    };
  }

  send(msg: ClientMessage): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Closes for good, e.g. after leaving the room. */
  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.pinger);
    document.removeEventListener("visibilitychange", this.wake);
    window.removeEventListener("online", this.wake);
    window.removeEventListener("pageshow", this.wake);
    this.ws?.close(1000);
    this.ws = null;
  }

  private ping() {
    if (Date.now() - this.lastHeard > STALE_MS) {
      // Dead without a close event (common after a phone sleeps): start over.
      this.ws?.close();
      this.ws = null;
      clearInterval(this.pinger);
      this.scheduleRetry(0);
      return;
    }
    this.send({ t: "ping" });
  }

  private scheduleRetry(delay?: number) {
    this.attempt += 1;
    this.handlers.status("reconnecting");
    const wait = delay ?? Math.min(8000, 400 * 2 ** Math.min(this.attempt - 1, 5));
    clearTimeout(this.retry);
    this.retry = window.setTimeout(() => this.connect(), wait);
  }

  private wake = () => {
    if (this.stopped || document.visibilityState === "hidden") return;
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      this.connect();
    } else if (ws.readyState === WebSocket.OPEN && Date.now() - this.lastHeard > PING_MS) {
      // Back from the background, where a socket can die without a close event:
      // ping, and start over if nothing comes back quickly.
      const asked = Date.now();
      this.send({ t: "ping" });
      window.setTimeout(() => {
        if (this.ws === ws && !this.stopped && this.lastHeard < asked) {
          ws.close();
          this.ws = null;
          clearInterval(this.pinger);
          this.scheduleRetry(0);
        }
      }, PROBE_MS);
    }
  };
}
