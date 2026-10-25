// Entry point: room API under /api, everything else is the static app.

import { CODE_ALPHABET, CODE_LENGTH, isCode } from "../src/core/protocol.ts";
import type { Room } from "./room.ts";

export { Room } from "./room.ts";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  ASSETS: Fetcher;
}

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/rooms") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      // A fresh code almost never collides; init refuses one that is taken.
      for (let i = 0; i < 5; i++) {
        const code = newCode();
        if (await env.ROOMS.getByName(code).init(code)) return json({ code }, 201);
      }
      return json({ error: "busy" }, 503);
    }

    const match = /^\/api\/rooms\/([^/]+)(\/ws)?$/.exec(url.pathname);
    if (match && isCode(match[1]!)) {
      const room = env.ROOMS.getByName(match[1]!);
      if (match[2]) {
        if (request.headers.get("upgrade") !== "websocket") return json({ error: "upgrade" }, 426);
        return room.fetch(request);
      }
      const info = await room.info();
      return info ? json(info) : json({ error: "gone" }, 404);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
