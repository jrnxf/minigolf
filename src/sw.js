// Service worker: keeps the app shell offline so pass-and-play works with
// no connection. The build fills in VERSION and ASSETS (see vite.config.ts).

const VERSION = "__VERSION__";
const ASSETS = ["__ASSETS__"];
const CACHE = `minigolf-${VERSION}`;
/** How long a page load waits for the network before using the cached shell. */
const NAV_TIMEOUT_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(["/", ...ASSETS]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith("minigolf-") && k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/"))
    return;

  if (request.mode === "navigate") {
    // Network first so new versions arrive; the cached shell covers offline and slow starts.
    event.respondWith(
      new Promise((resolve) => {
        const fallback = () => caches.match("/").then((hit) => hit && resolve(hit));
        const timer = setTimeout(fallback, NAV_TIMEOUT_MS);
        fetch(request)
          .then((res) => {
            clearTimeout(timer);
            resolve(res);
          })
          .catch(() => {
            clearTimeout(timer);
            caches.match("/").then((hit) => resolve(hit ?? Response.error()));
          });
      }),
    );
    return;
  }

  event.respondWith(caches.match(request).then((hit) => hit ?? fetch(request)));
});
