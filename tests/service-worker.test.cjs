const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadWorker({
  cacheKeys = [],
  fetchImpl = async () => { throw new Error("offline"); },
  cacheMatch = async () => null,
  setTimeoutImpl = setTimeout,
} = {}) {
  const listeners = new Map();
  const deleted = [];
  const stored = [];
  const worker = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    clients: { claim: async () => {} },
    location: { origin: "https://example.test" },
  };
  const cache = {
    match: cacheMatch,
    put: async (request, response) => { stored.push({ request, response }); },
  };
  const caches = {
    keys: async () => cacheKeys,
    delete: async (key) => { deleted.push(key); return true; },
    open: async () => cache,
  };
  vm.runInNewContext(fs.readFileSync("sw.js", "utf8"), {
    self: worker,
    caches,
    URL,
    fetch: fetchImpl,
    Response,
    clearTimeout,
    setTimeout: setTimeoutImpl,
    AbortController,
  });
  return { listeners, deleted, stored };
}

async function dispatchFetch(listeners, request) {
  let responsePromise;
  let intercepted = false;
  listeners.get("fetch")({
    request,
    respondWith: (promise) => { intercepted = true; responsePromise = promise; },
    waitUntil: () => {},
  });
  return { intercepted, response: responsePromise ? await responsePromise : null };
}

test("activation deletes only old Morning Board caches", async () => {
  const { listeners, deleted } = loadWorker({ cacheKeys: [
      "morning-board-shell-v6-excel",
      "morning-board-shell-v8-stable",
      "workbox-precache-v2",
      "another-app-cache",
    ] });
  let finished;
  listeners.get("activate")({ waitUntil: (promise) => { finished = promise; } });
  await finished;
  assert.deepEqual(deleted, ["morning-board-shell-v6-excel"]);
});

test("offline fallback opens the app's own cache", async () => {
  let cacheWasRead = false;
  const { listeners } = loadWorker({ cacheMatch: async () => { cacheWasRead = true; return null; } });
  const request = { method: "GET", url: "https://example.test/app.js", mode: "cors" };
  const { response: offlineResponse } = await dispatchFetch(listeners, request);
  assert.equal(cacheWasRead, true);
  assert.equal(offlineResponse.status, 0);
});

test("online response is returned and cached", async () => {
  const { listeners, stored } = loadWorker({
    fetchImpl: async () => new Response("fresh", { status: 200 }),
  });
  const request = { method: "GET", url: "https://example.test/app.js", mode: "cors" };
  const { response } = await dispatchFetch(listeners, request);
  assert.equal(await response.text(), "fresh");
  assert.equal(stored.length, 1);
  assert.equal(await stored[0].response.text(), "fresh");
});

test("HTTP errors and network errors fall back to cache", async () => {
  for (const fetchImpl of [
    async () => new Response("missing", { status: 404 }),
    async () => { throw new Error("offline"); },
  ]) {
    const { listeners } = loadWorker({
      fetchImpl,
      cacheMatch: async () => new Response("cached", { status: 200 }),
    });
    const { response } = await dispatchFetch(listeners, { method: "GET", url: "https://example.test/app.js", mode: "cors" });
    assert.equal(await response.text(), "cached");
  }
});

test("network timeout falls back to cache without waiting 3.5 seconds", async () => {
  const { listeners } = loadWorker({
    fetchImpl: async () => new Promise(() => {}),
    cacheMatch: async () => new Response("cached after timeout", { status: 200 }),
    setTimeoutImpl: (callback) => { queueMicrotask(callback); return 1; },
  });
  const { response } = await dispatchFetch(listeners, { method: "GET", url: "https://example.test/app.js", mode: "cors" });
  assert.equal(await response.text(), "cached after timeout");
});

test("navigation without cache returns a readable 503 response", async () => {
  const { listeners } = loadWorker();
  const { response } = await dispatchFetch(listeners, { method: "GET", url: "https://example.test/", mode: "navigate" });
  assert.equal(response.status, 503);
  assert.match(await response.text(), /暂时无法打开看板/);
});

test("external weather requests are not intercepted", async () => {
  const { listeners } = loadWorker();
  const result = await dispatchFetch(listeners, {
    method: "GET",
    url: "https://api.open-meteo.com/v1/forecast?latitude=1&longitude=1",
    mode: "cors",
  });
  assert.equal(result.intercepted, false);
  assert.equal(result.response, null);
});
