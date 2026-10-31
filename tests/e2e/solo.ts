// End-to-end: a full 18-hole solo round in headless Chrome at a phone
// viewport, played through pointer events on the canvas. The best round shows
// on the home screen afterwards. Run with `pnpm test:solo` (builds first).

import { execFileSync } from "node:child_process";
import { COURSE_PAR, HOLES } from "../../src/core/holes.ts";
import { soloTotal } from "../../src/core/solo.ts";
import { findShot } from "../../src/core/solver.ts";
import { Browser, SHOTS, check, startServer, waitFor } from "./browser.ts";

const PORT = Number(process.env.E2E_PORT ?? 4319);
const URL = `http://127.0.0.1:${PORT}/`;

execFileSync("pnpm", ["build"], { stdio: "inherit" });
const server = await startServer(
  "node_modules/.bin/vite",
  ["preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  /Local:/,
);
const phone = new Browser("minigolf-e2e-solo");

try {
  console.log(`solo e2e at ${URL} (screenshots in ${SHOTS})`);
  phone.open(URL);
  check(!phone.visible("solo-best"), "no best round before the first one");
  phone.screenshot("solo-home");
  phone.click("#go-solo");
  await waitFor("game screen", () => phone.state().match);
  check(!phone.visible("hud-1"), "one player on the scoreboard");
  phone.screenshot("solo-game");

  let shots = 0;
  let scorecards = 0;
  for (;;) {
    const st = phone.state();
    const m = st.match!;
    if (st.overlay === "handoff") throw new Error("solo handed the phone over");
    if (st.overlay === "scorecard") {
      scorecards += 1;
      if (m.phase === "gameDone") break;
      if (scorecards === 1) phone.screenshot("solo-scorecard");
      const hole = m.holeIdx;
      phone.click("#score-next");
      await waitFor("next hole", () => phone.state().match!.holeIdx === hole + 1);
      continue;
    }
    if (st.busy || !st.canAim) {
      await new Promise((r) => setTimeout(r, 150));
      continue;
    }
    const found = findShot(HOLES[m.holeIdx]!, m.balls[0]);
    const before = m.strokes;
    phone.drag(found.angle, found.power);
    shots += 1;
    await waitFor(`stroke ${shots} to register`, () => phone.state().match!.strokes > before);
  }

  const final = phone.state().match!;
  phone.screenshot("solo-final");
  check(final.phase === "gameDone" && final.holeIdx === HOLES.length - 1, "all 18 holes played");
  check(
    final.scores[0].every((n) => typeof n === "number" && n >= 1),
    "every hole has a score",
  );
  check(final.strokes === shots, `every drag played one stroke (${shots})`);
  check(phone.text("#score-title") === "Round complete", "the final card says the round is complete");
  const strokes = soloTotal(final);
  const diff = strokes - COURSE_PAR;
  check(phone.text("#score-sub").includes(`${strokes} strokes`), `final card shows ${strokes} strokes`);
  check(phone.text("#score-note") === "New best round", "the first finished round is the best round");

  phone.click("#score-home");
  await waitFor("home", () => phone.visible("home"));
  const label = diff === 0 ? "E" : diff > 0 ? `+${diff}` : String(diff);
  check(
    phone.text("#solo-best") === `Best solo round ${strokes} (${label})`,
    `home shows the best round: ${phone.text("#solo-best")}`,
  );
  check(phone.consoleErrors().includes("<no console messages found>"), "no console errors");
  console.log("solo e2e passed");
} finally {
  phone.stop();
  server.kill();
}
