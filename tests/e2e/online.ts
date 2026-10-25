// End-to-end: online play against `wrangler dev` on this machine, no
// Cloudflare account needed. Part one talks the room protocol with two raw
// WebSocket clients; part two plays through the real UI on two headless
// phones (separate Chrome sessions). Covers join, turns, live aim,
// reconnect (page reload and a server restart) and leaving.
// Run with `pnpm test:online`.

import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyShot, holeOf, type MatchState } from "../../src/core/match.ts";
import { PROTOCOL, type ClientMessage, type ServerMessage } from "../../src/core/protocol.ts";
import { findShot } from "../../src/core/solver.ts";
import { Browser, check, SHOTS, startServer, waitFor } from "./browser.ts";

const PORT = Number(process.env.E2E_PORT ?? 8797);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const STATE = mkdtempSync(join(tmpdir(), "minigolf-wrangler-"));

let worker: ChildProcess | null = null;

async function startWorker() {
  worker = await startServer(
    "node_modules/.bin/wrangler",
    ["dev", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", STATE],
    /Ready on/,
  );
}

function stopWorker(): Promise<void> {
  return new Promise((resolve) => {
    if (!worker || worker.exitCode !== null) return resolve();
    worker.removeAllListeners("exit");
    worker.once("exit", () => resolve());
    worker.kill("SIGINT");
  });
}

const token = (c: string) => c.repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw protocol client: one WebSocket and every message it received. */
class Client {
  readonly inbox: ServerMessage[] = [];
  closed: number | null = null;
  private ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => this.inbox.push(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = (e) => (this.closed = e.code);
  }

  static async join(code: string, tok: string, name: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/rooms/${code}/ws`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    const c = new Client(ws);
    c.send({ t: "hello", v: PROTOCOL, token: tok, name });
    return c;
  }

  send(msg: ClientMessage) {
    this.ws.send(JSON.stringify(msg));
  }

  /** Waits for the next message (after `from`) that matches. */
  async next<T extends ServerMessage["t"]>(
    t: T,
    match: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    ms = 5000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const found = await waitFor(
      `"${t}" message`,
      () => this.inbox.find((m): m is Extract<ServerMessage, { t: T }> => m.t === t && match(m as never)),
      ms,
    );
    this.inbox.splice(this.inbox.indexOf(found), 1);
    return found;
  }

  /** Every message from now on is new. */
  drain() {
    this.inbox.length = 0;
  }

  close() {
    this.ws.close();
  }
}

async function protocolTest() {
  console.log("part 1: room protocol with two clients");
  const res = await fetch(`${ORIGIN}/api/rooms`, { method: "POST" });
  check(res.status === 201, "POST /api/rooms creates a room");
  const { code } = (await res.json()) as { code: string };
  check(/^[A-Z0-9]{5}$/.test(code), `room code looks right (${code})`);

  const ana = await Client.join(code, token("a"), "Ana");
  const welcomeA = await ana.next("welcome");
  check(welcomeA.seat === 0 && welcomeA.room.status === "lobby", "host takes seat 0 in the lobby");
  const info = (await (await fetch(`${ORIGIN}/api/rooms/${code}`)).json()) as { host: string; open: boolean };
  check(info.host === "Ana" && info.open, "join page sees the host's name and an open seat");

  const kai = await Client.join(code, token("b"), "Kai");
  check((await kai.next("welcome")).seat === 1, "friend joins seat 1 from the invite");
  const joined = await ana.next("room", (m) => !!m.room.players[1]);
  check(
    joined.room.players[1]?.name === "Kai" && joined.room.players[1].connected,
    "host sees the friend arrive",
  );

  ana.send({ t: "hello", v: PROTOCOL, token: token("d"), name: "Sneaky" });
  check((await ana.next("error")).code === "bad", "a socket cannot claim a second seat");

  const zed = await Client.join(code, token("c"), "Zed");
  check((await zed.next("error")).code === "full", "a third player is turned away");
  await waitFor("third socket closed", () => zed.closed);

  // The friend's phone drops in the lobby; another phone takes the seat.
  kai.close();
  await ana.next("room", (m) => m.room.players[1]?.connected === false);
  const reopened = (await (await fetch(`${ORIGIN}/api/rooms/${code}`)).json()) as { open: boolean };
  check(reopened.open, "join page sees the seat open again after the friend drops");
  const kaiPhone = await Client.join(code, token("e"), "Kai");
  check((await kaiPhone.next("welcome")).seat === 1, "a new phone takes a dropped friend's lobby seat");
  const swapped = await ana.next("room", (m) => m.room.players[1]?.connected === true);
  check(swapped.room.players[1]?.name === "Kai", "host sees the friend on the new phone");
  const oldPhone = await Client.join(code, token("b"), "Kai");
  check((await oldPhone.next("error")).code === "full", "the old phone no longer owns the seat");
  await waitFor("old phone socket closed", () => oldPhone.closed);

  kaiPhone.send({ t: "start" });
  ana.send({ t: "start" });
  const started = await kaiPhone.next("room", (m) => m.room.status === "playing");
  check(started.room.match?.turn === 0, "only the host can start; the host tees off");
  await ana.next("room", (m) => m.room.status === "playing");
  let match: MatchState = started.room.match!;

  ana.send({ t: "aim", aim: { angle: -1.5, power: 0.4 } });
  const aim = await kaiPhone.next("aim");
  check(aim.seat === 0 && aim.aim?.power === 0.4, "the friend sees the live aim");
  kaiPhone.send({ t: "aim", aim: { angle: 1, power: 0.5 } });
  await sleep(300);
  check(!ana.inbox.some((m) => m.t === "aim"), "aim out of turn is not relayed");

  kaiPhone.send({ t: "shot", shot: { vx: 0, vy: -300 }, at: 0 });
  await kaiPhone.next("room");
  check(!ana.inbox.some((m) => m.t === "shot"), "a stroke out of turn is refused");

  const shot = findShot(holeOf(match), match.balls[0]).shot;
  ana.send({ t: "shot", shot, at: 0 });
  const [sa, sk] = [await ana.next("shot"), await kaiPhone.next("shot")];
  const local = applyShot(match, 0, shot)!.state;
  check(
    JSON.stringify(sa.room.match) === JSON.stringify(local),
    "server and client physics agree on the stroke",
  );
  check(JSON.stringify(sk.room.match) === JSON.stringify(local), "both phones get the same result");
  match = sa.room.match!;

  ana.send({ t: "shot", shot, at: 0 });
  check((await ana.next("room")).room.match?.strokes === 1, "a repeated stroke is refused and resynced");

  kaiPhone.close();
  const away = await ana.next("room", (m) => m.room.players[1]?.connected === false);
  check(!!away, "host sees the friend drop");
  const kai2 = await Client.join(code, token("e"), "Kai");
  const back = await kai2.next("welcome");
  check(
    back.seat === 1 && JSON.stringify(back.room.match) === JSON.stringify(match),
    "friend reconnects into the same seat and state",
  );
  await ana.next("room", (m) => m.room.players[1]?.connected === true);

  // Play out the hole, alternating as the rules say.
  const clients = [ana, kai2] as const;
  while (match.phase === "aim") {
    const seat = match.turn;
    const s = findShot(holeOf(match), match.balls[seat]).shot;
    clients[seat].send({ t: "shot", shot: s, at: match.strokes });
    const msg = await clients[seat].next("shot");
    match = msg.room.match!;
  }
  check(match.phase === "holeDone", "both balls in: hole done");
  ana.send({ t: "ready" });
  const waiting = await kai2.next("room", (m) => m.room.ready[0]);
  check(waiting.room.match?.holeIdx === 0, "next hole waits for both players");
  kai2.send({ t: "ready" });
  const hole2 = await ana.next("room", (m) => m.room.match?.holeIdx === 1);
  check(hole2.room.match?.phase === "aim", "both ready: hole 2 starts");

  kai2.send({ t: "leave" });
  const ended = await ana.next("room", (m) => m.room.status === "ended");
  check(ended.room.leftBy === 1, "host is told the friend left");
  const gone = await Client.join(code, token("e"), "Kai");
  check((await gone.next("error")).code === "gone", "a finished room cannot be rejoined");
  const missing = await fetch(`${ORIGIN}/api/rooms/BCDFG`);
  check(missing.status === 404, "unknown rooms are 404");
  ana.close();
}

async function uiTest() {
  console.log("part 2: two phones through the UI");
  const a = new Browser("minigolf-e2e-online-a");
  const b = new Browser("minigolf-e2e-online-b");
  try {
    a.open(`${ORIGIN}/`);
    a.click("#go-online");
    a.fill("#online-name", "Ana");
    a.click("#create-room");
    const code = await waitFor("room code", () => {
      const c = a.text("#room-code");
      return /^[A-Z0-9]{5}$/.test(c) && a.visible("lobby") ? c : null;
    });
    check(a.text("#invite-url").endsWith(`/r/${code}`), "lobby shows the invite link");
    a.screenshot("online-lobby-waiting");

    b.open(`${ORIGIN}/r/${code}`);
    await waitFor("join screen", () => b.text("#join-title") === "Ana invited you");
    b.screenshot("online-join");
    b.fill("#join-name", "Kai");
    b.click("#join-go");
    await waitFor("guest in lobby", () => b.visible("lobby") && b.text("#lobby-note").includes("Ana"));
    await waitFor("host sees guest", () => a.text("#slot-1").includes("Kai"));
    a.screenshot("online-lobby-joined");
    a.click("#start-round");

    await waitFor("both in game", () => a.state().match && b.state().match);
    check(a.state().canAim && !b.state().canAim, "host's turn on the host's phone only");
    check(b.text("#turn-who") === "Ana is aiming", "the friend's phone says who is aiming");

    // Ghost aim: Ana holds a drag, Kai sees the line.
    const m0 = a.state().match!;
    const s0 = findShot(holeOf(m0), m0.balls[0]);
    a.drag(s0.angle, s0.power * 0.8, { hold: true });
    await sleep(400);
    b.screenshot("online-friend-aiming");
    a.release(s0.angle, s0.power * 0.8);
    await waitFor(
      "stroke on both phones",
      () => b.state().match!.strokes === 1 && a.state().match!.strokes === 1,
    );
    await waitFor("same state", () => JSON.stringify(a.state().match) === JSON.stringify(b.state().match));
    check(true, "the stroke lands the same on both phones");
    await waitFor("your-turn toast", () =>
      b.eval<boolean>(`() => document.getElementById("toast").classList.contains("on")`),
    );
    check(b.text("#toast") === "Your turn", "friend gets the your-turn alert");
    b.screenshot("online-your-turn");

    // A dropped tab: Kai's page reloads and takes the seat back.
    b.open(`${ORIGIN}/r/${code}`);
    await waitFor("rejoined", () => b.state().match?.strokes === 1 && b.state().me === 1);
    check(b.state().canAim, "after a reload the friend is back in the game, still on turn");

    // A dropped connection: the server restarts; both phones reconnect by themselves.
    await stopWorker();
    await waitFor("host notices", () => a.visible("banner") && a.text("#banner").includes("reconnecting"));
    a.screenshot("online-reconnecting");
    await startWorker();
    await waitFor(
      "host reconnected",
      () => !a.visible("banner") || a.text("#banner") === "Back online",
      30_000,
    );
    await waitFor("friend reconnected", () => b.state().canAim, 30_000);
    check(true, "both phones reconnect after the connection drops");

    const m1 = b.state().match!;
    const s1 = findShot(holeOf(m1), m1.balls[1]);
    b.drag(s1.angle, s1.power);
    await waitFor("second stroke on host", () => a.state().match!.strokes === 2);
    await waitFor(
      "same state again",
      () => JSON.stringify(a.state().match) === JSON.stringify(b.state().match),
    );
    check(true, "play carries on after the reconnect");

    // Kai leaves from the menu; Ana is told.
    await waitFor("friend idle", () => !b.state().busy);
    b.click("#menu-btn");
    b.click("#menu-quit");
    await waitFor("friend home", () => b.visible("home"));
    await waitFor("host told", () => a.visible("ended"));
    check(a.text("#ended-title") === "Kai left", "host sees that the friend left");
    a.screenshot("online-friend-left");
    for (const [name, browser] of [
      ["host", a],
      ["friend", b],
    ] as const) {
      // The server restart above makes the browser log failed socket connections; nothing else is allowed.
      const errors = browser
        .consoleErrors()
        .split("\n")
        .filter((l) => /msgid=/.test(l))
        .filter((l) => !/WebSocket|ERR_CONNECTION_REFUSED|Failed to load resource/.test(l));
      if (errors.length) console.log(browser.consoleErrors());
      check(errors.length === 0, `no unexpected console errors on the ${name}'s phone`);
    }
  } finally {
    a.stop();
    b.stop();
  }
}

execFileSync("pnpm", ["build"], { stdio: "inherit" });
await startWorker();
try {
  console.log(`online e2e at ${ORIGIN} (screenshots in ${SHOTS})`);
  await protocolTest();
  await uiTest();
  console.log("online e2e passed");
} finally {
  await stopWorker();
  rmSync(STATE, { recursive: true, force: true });
}
