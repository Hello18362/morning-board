const CACHE_PREFIX = "morning-board-shell-";
const CACHE = "morning-board-shell-v8-stable";
const SHELL = ["./", "./index.html", "./style.css", "./app.js", "./excel-import.js", "./vendor/xlsx.full.min.js", "./desktop-view.css", "./desktop-view.js", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./data/config.json", "./data/schedule.json", "./data/items.json", "./data/plan.json"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key))
  )).then(() => self.clients.claim()));
});
// 网络异常、HTTP 错误或超时都回退到本应用缓存；天气请求不经过这里。
async function networkFirst(request) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    const response = await Promise.race([
      fetch(request, controller ? { signal: controller.signal } : undefined),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller?.abort(); reject(new Error("network timeout")); }, 3500);
      })
    ]);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 缓存写入失败不影响本次在线访问。生命周期由 respondWith 的 promise 覆盖。
    try { const cache = await caches.open(CACHE); await cache.put(request, response.clone()); } catch {}
    return response;
  } catch {
    try {
      const cache = await caches.open(CACHE);
      const saved = await cache.match(request) || (request.mode === "navigate" ? await cache.match("./index.html") : null);
      if (saved) return saved;
    } catch {}
    return request.mode === "navigate"
      ? new Response("暂时无法打开看板。请联网后重试；本机数据没有被清除。", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
      : Response.error();
  } finally { clearTimeout(timer); }
}
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(networkFirst(event.request));
});
