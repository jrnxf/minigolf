import "@fontsource-variable/outfit/wght.css";
import "./styles.css";

import { formatVsPar } from "../core/solo.ts";
import { cleanName, isCode, normalizeCode, type ErrorCode } from "../core/protocol.ts";
import { $, show } from "./dom.ts";
import { GameScreen } from "./game.ts";
import { LocalGame, savedLocalGame } from "./local.ts";
import { OnlineSession } from "./online.ts";
import { SoloGame, loadBest } from "./solo.ts";
import { sfx } from "./sfx.ts";
import { load, save } from "./storage.ts";

const screen = new GameScreen();
let session: OnlineSession | null = null;

// ---------- navigation ----------

function roomPath(code: string) {
  return `/r/${code}`;
}

function goHome(replace = true) {
  session?.end();
  session = null;
  if (screen.active) screen.stop();
  if (location.pathname !== "/") history[replace ? "replaceState" : "pushState"](null, "", "/");
  $("resume-local").hidden = !savedLocalGame();
  const best = loadBest();
  $("solo-best").hidden = !best;
  if (best) $("solo-best").textContent = `Best solo round ${best.strokes} (${formatVsPar(best.vsPar)})`;
  show("home");
}

function route() {
  const m = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
  const code = m ? normalizeCode(decodeURIComponent(m[1]!)) : "";
  if (m && isCode(code)) void openRoom(code);
  else goHome();
}

window.addEventListener("popstate", () => {
  if (screen.active && session === null) return;
  route();
});

for (const el of document.querySelectorAll("[data-home]")) {
  el.addEventListener("click", () => goHome());
}

document.addEventListener("pointerdown", () => sfx.unlock(), { capture: true });

// ---------- home ----------

function syncSound() {
  const btn = $("sound-toggle");
  btn.textContent = sfx.enabled ? "Sound on" : "Sound off";
  btn.setAttribute("aria-pressed", String(sfx.enabled));
}
syncSound();
$("sound-toggle").addEventListener("click", () => {
  sfx.enabled = !sfx.enabled;
  syncSound();
});

$("go-local").addEventListener("click", () => {
  const names = load("names")?.split("\n") ?? [];
  $<HTMLInputElement>("local-name-0").value = names[0] ?? "";
  $<HTMLInputElement>("local-name-1").value = names[1] ?? "";
  show("local-setup");
});

$("go-solo").addEventListener("click", () => new SoloGame(screen, "You", () => goHome()));

$("resume-local").addEventListener("click", () => {
  const saved = savedLocalGame();
  if (saved) new LocalGame(screen, saved.names, () => goHome(), saved.match);
});

$("go-online").addEventListener("click", () => {
  $<HTMLInputElement>("online-name").value = load("name") ?? "";
  setNote("");
  show("online-setup");
});

// ---------- pass and play ----------

$("local-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const a = cleanName($<HTMLInputElement>("local-name-0").value, "Zoe");
  let b = cleanName($<HTMLInputElement>("local-name-1").value, "Kai");
  if (b.toLowerCase() === a.toLowerCase()) b = `${b} 2`;
  save("names", `${a}\n${b}`);
  new LocalGame(screen, [a, b], () => goHome());
});

// ---------- online ----------

function setNote(text: string, error = false) {
  const note = $("online-note");
  note.textContent = text;
  note.classList.toggle("error", error);
}

function onlineName(id: string): string {
  const name = cleanName($<HTMLInputElement>(id).value, "");
  if (name) save("name", name);
  return name;
}

$("create-room").addEventListener("click", async () => {
  if (!navigator.onLine) return setNote("You're offline. Pass & play works without a connection.", true);
  const btn = $<HTMLButtonElement>("create-room");
  btn.disabled = true;
  setNote("Opening a room...");
  try {
    const res = await fetch("/api/rooms", { method: "POST" });
    if (!res.ok) throw new Error(String(res.status));
    const { code } = (await res.json()) as { code: string };
    history.pushState(null, "", roomPath(code));
    setNote("");
    connect(code, onlineName("online-name"));
  } catch {
    setNote("Couldn't reach the server. Check your connection and try again.", true);
  } finally {
    btn.disabled = false;
  }
});

$("code-input").addEventListener("input", (e) => {
  const input = e.target as HTMLInputElement;
  input.value = normalizeCode(input.value);
});

$("code-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode($<HTMLInputElement>("code-input").value);
  if (!isCode(code)) return setNote("Room codes are 5 letters and numbers.", true);
  onlineName("online-name");
  history.pushState(null, "", roomPath(code));
  void openRoom(code);
});

function connect(code: string, name: string) {
  session?.end();
  session = new OnlineSession(code, name, screen, {
    home: () => {
      session = null;
      goHome();
    },
    refused: (reason) => {
      session = null;
      showRefused(code, reason);
    },
  });
  show("lobby");
  $("room-code").textContent = code;
  $("invite-url").textContent = `${location.host}${roomPath(code)}`;
}

/** Landing on an invite link: rejoin our own room, or ask for a name first. */
async function openRoom(code: string) {
  if (session?.code === code) return;
  if (load("room") === code) return connect(code, load("name") ?? "");
  show("join");
  $("join-code").textContent = `Room ${code}`;
  $("join-title").textContent = "You're invited";
  $("join-lead").textContent = "Two players, 18 holes, about thirty minutes.";
  $("join-name-field").hidden = false;
  $<HTMLInputElement>("join-name").value = load("name") ?? "";
  $("join-go").hidden = false;
  $("join-go").textContent = "Join game";
  $("join-home").textContent = "Not now";
  try {
    const res = await fetch(`/api/rooms/${code}`);
    if (res.status === 404) return showRefused(code, "gone");
    const info = (await res.json()) as { status: string; host: string | null; open: boolean };
    if (info.host) $("join-title").textContent = `${info.host} invited you`;
    if (!info.open) {
      // Already underway: it may be our own seat from another visit.
      $("join-lead").textContent = "This game has already started. If it's yours, you can jump back in.";
      $("join-go").textContent = "Rejoin";
    }
  } catch {
    if (!navigator.onLine) $("join-lead").textContent = "You're offline. Connect to join this game.";
  }
}

$("join-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const code = normalizeCode(location.pathname.split("/")[2] ?? "");
  if (isCode(code)) connect(code, onlineName("join-name"));
});

function showRefused(code: string, reason: ErrorCode) {
  show("join");
  $("join-code").textContent = `Room ${code}`;
  $("join-name-field").hidden = true;
  $("join-go").hidden = true;
  $("join-home").textContent = "Home";
  const copy: Record<string, [string, string]> = {
    full: ["Game's full", "Two players are already in this room. Ask for a new link."],
    gone: ["Room closed", "This room has ended or expired. Start a new one from home."],
    version: ["Update ready", "A newer version of the game is out. Reload the page to play."],
  };
  const [title, lead] = copy[reason] ?? copy.gone!;
  $("join-title").textContent = title;
  $("join-lead").textContent = lead;
}

// ---------- lobby ----------

$("lobby-leave").addEventListener("click", () => session?.quit());
$("start-round").addEventListener("click", () => session?.startRound());

$("copy-link").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}`;
  const btn = $("copy-link");
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "Copied";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy link"), 1500);
});

$("share-link").addEventListener("click", async () => {
  const url = `${location.origin}${location.pathname}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Mini golf?", text: "Play a round of mini golf with me", url });
    } catch {
      // Dismissed.
    }
  } else {
    $("copy-link").click();
  }
});

// ---------- start ----------

route();

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js"));
}
