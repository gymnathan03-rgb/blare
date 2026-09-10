const CACHE_NAME = "blare-v3";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=1",
  "./app.js?v=1",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  // Fetch with {cache: "reload"} so install-time caching bypasses the
  // browser's normal HTTP cache — GitHub Pages sets max-age=600 on assets,
  // which can otherwise let a stale response get baked into a fresh SW cache.
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((url) =>
          fetch(url, { cache: "reload" })
            .then((res) => cache.put(url, res))
            .catch(() => {}) // a single flaky fetch shouldn't fail the whole install
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request).catch(() => caches.match("./index.html"))
      );
    })
  );
});
