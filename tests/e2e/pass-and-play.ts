// End-to-end: a full six-hole pass-and-play game in headless Chrome at a
// phone viewport, played through pointer events on the canvas, then a
// rematch. Run with `pnpm test:e2e` (builds first, serves with vite preview).

import { execFileSync } from "node:child_process";
import { HOLES } from "../../src/core/holes.ts";
import { total } from "../../src/core/match.ts";
import { findShot } from "../../src/core/solver.ts";
import { Browser, SHOTS, check, startServer, waitFor } from "./browser.ts";

const PORT = Number(process.env.E2E_PORT ?? 4317);
const URL = `http://127.0.0.1:${PORT}/`;

execFileSync("pnpm", ["build"], { stdio: "inherit" });
const server = await startServer(
  "node_modules/.bin/vite",
  ["preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  /Local:/,
);
const phone = new Browser("minigolf-e2e-pass-and-play");

try {
  console.log(`pass-and-play e2e at ${URL} (screenshots in ${SHOTS})`);
  phone.open(URL);
  phone.screenshot("pp-home");
  phone.click("#go-local");
  phone.fill("#local-name-0", "Zoe");
  phone.fill("#local-name-1", "Kai");
  phone.click("#local-form button[type=submit]");
  await waitFor("game screen", () => phone.state().match);
  check(phone.text("#turn-who") === "Zoe", "Zoe tees off first");

  let shots = 0;
  let handoffs = 0;
  let scorecards = 0;
  const seen = new Set<string>();
  for (;;) {
    const st = phone.state();
    const m = st.match!;
    if (st.overlay === "handoff") {
      handoffs += 1;
      if (!seen.has("handoff")) {
        seen.add("handoff");
        check(phone.text("#handoff-title").startsWith("Pass to"), "hand-off card names the next player");
        phone.screenshot("pp-handoff");
      }
      phone.click("#handoff-ready");
      continue;
    }
    if (st.overlay === "scorecard") {
      scorecards += 1;
      if (m.phase === "gameDone") break;
      if (!seen.has("card")) {
        seen.add("card");
        phone.screenshot("pp-scorecard");
      }
      const hole = m.holeIdx;
      phone.click("#score-next");
      await waitFor("next hole", () => phone.state().match!.holeIdx === hole + 1);
      continue;
    }
    if (st.busy || !st.canAim) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const hole = HOLES[m.holeIdx]!;
    const ball = m.balls[m.turn];
    const found = findShot(hole, ball);
    const before = m.strokes;
    if (m.holeIdx === 1 && !seen.has("aim")) {
      // Catch the drag-anywhere aim with its bounce preview mid-gesture.
      seen.add("aim");
      phone.drag(found.angle, found.power, { hold: true });
      phone.screenshot("pp-aim");
      phone.release(found.angle, found.power);
    } else {
      phone.drag(found.angle, found.power);
    }
    shots += 1;
    await waitFor(`stroke ${shots} to register`, () => phone.state().match!.strokes > before).catch((e) => {
      console.log(JSON.stringify(phone.state()));
      throw e;
    });
  }

  const final = phone.state().match!;
  phone.screenshot("pp-final");
  check(final.phase === "gameDone" && final.holeIdx === HOLES.length - 1, "all six holes played");
  check(
    final.scores.every((s) => s.every((n) => typeof n === "number" && n >= 1)),
    "every hole has a score for both players",
  );
  check(final.strokes === shots, `every drag played one stroke (${shots})`);
  check(handoffs > 0, `the phone was handed over (${handoffs} times)`);
  check(scorecards >= HOLES.length, "scorecard shown after every hole");
  const [a, b] = [total(final, 0), total(final, 1)];
  const title = phone.text("#score-title");
  check(
    title === (a === b ? "Dead heat" : `${a < b ? "Zoe" : "Kai"} wins`),
    `result reads "${title}" (${a}-${b})`,
  );

  phone.click("#score-next");
  await waitFor("rematch", () => {
    const m = phone.state().match!;
    return m.phase === "aim" && m.holeIdx === 0 && m.strokes === 0;
  });
  check(true, "rematch starts a fresh round");
  check(phone.consoleErrors().includes("<no console messages found>"), "no console errors");

  // Installed-app check: with no network at all, the app shell still loads and the saved game resumes.
  await waitFor("service worker", () => phone.eval<boolean>("() => !!navigator.serviceWorker.controller"));
  phone.openOffline(URL);
  await waitFor("home offline", () => phone.visible("home"));
  check(phone.visible("resume-local"), "offline: the app loads from the service worker");
  phone.click("#resume-local");
  await waitFor("resumed", () => phone.state().match?.holeIdx === 0);
  check(phone.state().canAim, "offline: the saved pass-and-play game resumes and is playable");
  phone.screenshot("pp-offline");
  console.log("pass-and-play e2e passed");
} finally {
  phone.stop();
  server.kill();
}
