# Decisions

Short records of the choices behind the first version, newest last. Each says what was picked, why, and what it costs.

## A web app, not a native app

One codebase that runs on any phone, installs from the browser to the home screen, and needs no app store review. A manifest and a service worker make it installable and let pass & play work offline. The cost: no push notifications on every platform and a little less control over the screen than a native app, neither of which this game needs.

## TypeScript, Vite, canvas, no UI framework

The game is one canvas plus a handful of simple screens. Vite gives a fast dev server and a hashed production build with almost no config. A framework would add weight and churn for a few buttons and forms, so screens are plain HTML in `index.html` shown and hidden by id. Canvas 2D draws the course; the static parts (floor, walls, sand) are drawn once per hole into an offscreen layer because glow blur is expensive on phones.

## One shared, deterministic core

`src/core` holds the physics, the six holes, the match rules and the online protocol, and both the phone and the room server import it. The physics runs on a fixed clock (120 ticks a second, 4 substeps each) and uses only `+ - * /` and `Math.sqrt`, never `Math.exp`, `Math.hypot` or trigonometry, because those may round differently between JavaScript engines. A stroke is sent as a whole-number velocity, so a shot means the same thing everywhere. A unit test pins one shot's exact result, so an accidental physics change fails CI rather than splitting online games between versions.

## Cloudflare Worker with a Durable Object per room

Online play needs a small authority that holds turn state and fans out moves to two phones. A Durable Object is exactly one stateful instance per room, addressed by the room code, with WebSockets built in. One Worker serves both the static app and the `/api` routes, so there is a single deploy and no CORS. Rooms use the WebSocket hibernation API (idle rooms cost nothing) and SQLite-backed storage (free plan). It runs fully locally with `wrangler dev`.

The room replays every stroke with the shared physics and broadcasts the result, so it is the source of truth: a phone animates its own stroke at once (it would compute the same path) and then settles on the server's state. A stroke carries the stroke count it was aimed from; a stale or out-of-turn stroke is refused and the phone is resynced.

## No accounts, no personal data kept

A phone gets a random token on first launch and keeps it in local storage. That token is the only thing that ties a player to a seat, which is enough to take the seat back after a dropped connection or a reload. The one exception is the lobby: a guest seat whose phone has no live connection goes to the next phone that opens the invite, so a stale join cannot lock the host's friend out. Names are typed per game and live only in the room. A room deletes all of its storage two hours after its last activity, or ten minutes after a player leaves.

## Turn and score rules

- Strokes alternate; a player whose ball is in is skipped.
- The lower score on the last hole tees off first on the next (the honour); a tie keeps the order.
- A ball still out after 6 strokes is picked up and scores 7, so no hole drags on.
- Lowest total after six holes wins. A rematch starts with the winner on the tee.
- Online, the next hole and a rematch wait until both players have tapped on, so nobody is rushed off the scorecard.

## Aim: drag anywhere with a bounce preview

Chosen on the prototype board. You drag anywhere on the screen (no need to touch the small ball), pull back like a slingshot, and let go. The preview is the real physics run forward for a short distance, so it shows bounces off walls and bumpers exactly. Its length grows with power but is capped at a short stretch, so it shows the line and the first bounces without solving the hole. Online, the other phone sees the same line, dimmed, while you aim.

## Pass & play hand-off card

Also from the board: after each stroke a full-screen "Pass to Kai / I'm ready" card covers the course until the next player taps, so the next aim stays private. Input is blocked from the moment the stroke ends until the card is dismissed.

## Fonts and icons are not committed binaries

Fonts come from pinned `@fontsource` packages and are bundled and cached for offline use, so no request goes to a font CDN. App icons are drawn by `scripts/icons.ts` at build time (a tiny PNG encoder on Node's zlib), which keeps the repository free of image files.

## Pinned versions

Every npm dependency is pinned to an exact version and GitHub Actions are pinned by commit. TypeScript stays on 6.0 because `typescript-eslint` does not support 7.0 yet.
