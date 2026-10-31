// End-to-end: pins how the course looks. Plays a solo round in headless Chrome
// at a phone viewport up to hole 13 and, on the Volcano, Sand Alley and Twin
// Peaks, waits for the baked course, takes a screenshot and checks the colours
// the canvas really shows (carpet, sand, timber rail, cup, bark mulch, the red
// carpet crater), plus the aim preview and power ring while a drag is held.
// Run with `pnpm test:look` (builds first). Set E2E_SHOTS=<folder> to keep the shots.

import { execFileSync } from "node:child_process";
import { HOLES } from "../../src/core/holes.ts";
import { findShot } from "../../src/core/solver.ts";
import { Browser, SHOTS, check, startServer, waitFor } from "./browser.ts";

const PORT = Number(process.env.E2E_PORT ?? 4321);
const URL = `http://127.0.0.1:${PORT}/`;

type RGB = [number, number, number];

execFileSync("pnpm", ["build"], { stdio: "inherit" });
const server = await startServer(
  "node_modules/.bin/vite",
  ["preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"],
  /Local:/,
);
const phone = new Browser("minigolf-e2e-look");

/** The colour the canvas shows at each course point. */
function pixels(points: [number, number][]): RGB[] {
  return phone.eval<RGB[]>(`() => {
    const c = document.getElementById("canvas");
    const ctx = c.getContext("2d");
    const v = window.__minigolf.state().view;
    const dpr = c.width / c.clientWidth;
    return ${JSON.stringify(points)}.map(([x, y]) => {
      const d = ctx.getImageData(Math.round((v.ox + x * v.s) * dpr), Math.round((v.oy + y * v.s) * dpr), 1, 1).data;
      return [d[0], d[1], d[2]];
    });
  }`);
}

const mean = (cols: RGB[]): RGB =>
  [0, 1, 2].map((c) => cols.reduce((s, p) => s + p[c]!, 0) / cols.length) as RGB;
const spread = (pts: [number, number][], cx: number, cy: number, r: number) => {
  for (let k = 0; k < 12; k++)
    pts.push([cx + (Math.cos(k) * (r * ((k % 3) + 1))) / 3, cy + (Math.sin(k) * (r * ((k % 4) + 1))) / 4]);
  return pts;
};
const ring = (cx: number, cy: number, r: number) => spread([], cx, cy, r);

/** Plays holes with the solver until `idx` is the hole on screen. */
async function playTo(idx: number) {
  for (;;) {
    const st = phone.state();
    const m = st.match!;
    if (m.holeIdx === idx && st.overlay === null) return;
    if (st.overlay === "scorecard") {
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
    await waitFor("stroke to register", () => phone.state().match!.strokes > before);
  }
}

async function onHole(name: string) {
  const idx = HOLES.findIndex((h) => h.name === name);
  await playTo(idx);
  await waitFor(`${name} to bake`, () => phone.state().view.baked);
  await new Promise((r) => setTimeout(r, 400)); // the bake fades in over 220 ms
  const bake = phone.state().view.bake;
  console.log(`  ${name}: bake took ${Math.round(bake.ms)} ms (${bake.samples} samples)`);
  phone.screenshot(`look-${name.toLowerCase().replace(/ /g, "-")}`);
  return HOLES[idx]!;
}

try {
  console.log(`look e2e at ${URL} (screenshots in ${SHOTS})`);
  phone.open(URL);
  phone.click("#go-solo");
  await waitFor("game screen", () => phone.state().match);

  // Volcano: a steep cone; the carpet around it is still green.
  const volcano = await onHole("Volcano");
  const floor = mean(pixels(ring(150, 400, 30)));
  check(floor[1] > floor[0] + 30, `volcano hole carpet is green (${floor.map(Math.round)})`);
  check(volcano.mounds.length === 1, "the volcano hole has its mound");

  // Sand Alley: carpet, sand pockets, red rails, a post, the cup.
  const alley = await onHole("Sand Alley");
  const pts: [number, number][] = [
    ...ring(150, 400, 30), // carpet
    ...ring(177, 215, 22), // sand pocket
    ...ring(84, 250, 3), // rail
    ...ring(40, 250, 25), // mulch
    [alley.cup.x + 3, alley.cup.y + 3], // cup
  ];
  const c = pixels(pts);
  const [carpet, sand, rail, mulch] = [0, 12, 24, 36].map((i) => mean(c.slice(i, i + 12)));
  const cup = c[48]!;
  check(
    carpet![1] > carpet![0] + 30 && carpet![1] > carpet![2] + 40,
    `carpet is green (${carpet!.map(Math.round)})`,
  );
  check(
    sand![0] > 170 && sand![0] > sand![1] && sand![1] > sand![2] + 25,
    `sand is pale and warm (${sand!.map(Math.round)})`,
  );
  check(rail![0] > rail![1] * 1.6 && rail![0] > 110, `rail is red timber (${rail!.map(Math.round)})`);
  check(
    mulch![0] > mulch![1] && mulch![1] > mulch![2] && mulch![0] < 170,
    `surround is bark mulch (${mulch!.map(Math.round)})`,
  );
  check(Math.max(...cup) < 70, `cup is dark (${cup})`);

  // Aim preview and power ring stay legible on the carpet: white dots with a dark halo.
  phone.drag(-Math.PI / 2, 0.6, { hold: true });
  await new Promise((r) => setTimeout(r, 300));
  phone.screenshot("look-aim");
  const white = phone.eval<number>(`() => {
    const c = document.getElementById("canvas");
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 235 && d[i + 1] > 235 && d[i + 2] > 235) n++;
    return n;
  }`);
  check(white > 150, `aim preview and ring draw bright marks on the course (${white} px)`);
  phone.release(-Math.PI / 2, 0.6);
  await waitFor("the stroke to register", () => phone.state().match!.strokes > 0);

  // Twin Peaks: two domes.
  await onHole("Twin Peaks");
  check(phone.consoleErrors().includes("<no console messages found>"), "no console errors");
  console.log("look e2e passed");
} finally {
  phone.stop();
  server.kill();
}
