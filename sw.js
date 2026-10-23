const CACHE_PREFIX = "morning-board-shell-";
const CACHE = "morning-board-shell-v7-isolated";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./excel-import.js", "./vendor/xlsx.full.min.js", "./desktop-view.css", "./desktop-view.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./data/config.json", "./data/schedule.json", "./data/items.json", "./data/plan.json"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {}));
    }
    return response;
  }).catch(async () => {
    const cache = await caches.open(CACHE);
    return (await cache.match(event.request)) || (event.request.mode === "navigate" ? cache.match("./index.html") : Response.error());
  }));
});
