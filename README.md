# Minigolf

Mini golf for your phone, on a sunny outdoor course. Eighteen holes, played solo against par, by passing one phone back and forth, or online with a friend through an invite link. It is a web app you add to your home screen: no app store, no accounts.

- **Pass & play**: both players on one phone. A "Pass to Kai / I'm ready" card goes up between strokes so nobody sees the other player's aim.
- **Online**: create a room, send the link (or the five-letter code), and take live turns. You see your friend's aim line as they drag, get a "your turn" alert, and drop back in after a lost connection or a closed tab.
- **Aim**: drag anywhere on the screen and let go. The preview line shows where the ball goes, bounces included.

## Stack

TypeScript everywhere, no framework.

| Part   | What                                                                         |
| ------ | ---------------------------------------------------------------------------- |
| Client | Vite, canvas 2D rendering, plain DOM screens, a hand-written service worker  |
| Server | One Cloudflare Worker that serves the app and a Durable Object per room      |
| Shared | `src/core`: physics, rules and protocol, used by both the phone and the room |

Why these, and the other choices: [docs/decisions.md](docs/decisions.md).

## Develop

Needs Node 24+ and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm dev            # the app with hot reload at http://localhost:5173 (pass & play)
pnpm dev:worker     # in a second terminal: the room server on :8787, so online play works in `pnpm dev`
pnpm preview        # production build served by `wrangler dev` on :8787, app and rooms together
```

`wrangler dev` runs the Worker and Durable Objects locally; it needs no Cloudflare login.

## Test

```sh
pnpm lint           # eslint + prettier
pnpm typecheck      # app, tests and worker
pnpm test           # unit tests: physics, rules, rooms, protocol, course bake
pnpm test:e2e       # a full 18-hole pass-and-play game in headless Chrome at 390x844, plus offline load
pnpm test:solo      # a full 18-hole solo round in headless Chrome, then the best round on the home screen
pnpm test:online    # two clients against `wrangler dev`: join, turns, reconnect, leave
pnpm test:look      # plays to the Volcano, Sand Alley and Twin Peaks and checks the colours on screen
```

The browser suites drive Chrome through [`chrome-devtools-axi`](https://www.npmjs.com/package/chrome-devtools-axi), which must be on your `PATH`. Set `E2E_SHOTS=<folder>` to keep their screenshots. Cloudflare Workers Builds runs lint, type-check, unit tests and a build on every push.

## Deploy

```sh
pnpm build && pnpm exec wrangler deploy
```

This creates the `minigolf` Worker with its `ROOMS` Durable Object (SQLite-backed, so it runs on the free plan). Rooms delete themselves after two idle hours.

## Layout

```
src/core/      shared physics, holes, match rules, room model, wire protocol
src/client/    the app: screens, canvas renderer, input, sounds, online client
src/sw.js      service worker template (the build fills in the file list)
worker/        Worker entry and the Room Durable Object
scripts/       icon generator (icons are drawn at build time, not committed)
tests/unit/    vitest
tests/e2e/     browser and online end-to-end runs
```
