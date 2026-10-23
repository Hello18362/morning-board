const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadWorker(cacheKeys = []) {
  const listeners = new Map();
  const deleted = [];
  const worker = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    clients: { claim: async () => {} },
    location: { origin: "https://example.test" },
  };
  const cache = { match: async () => null, put: async () => {} };
  const caches = {
    keys: async () => cacheKeys,
    delete: async (key) => { deleted.push(key); return true; },
    open: async () => cache,
  };
  vm.runInNewContext(fs.readFileSync("sw.js", "utf8"), {
    self: worker,
    caches,
    URL,
    fetch: async () => { throw new Error("offline"); },
    Response,
  });
  return { listeners, deleted, cache };
}

test("activation deletes only old Morning Board caches", async () => {
  const { listeners, deleted } = loadWorker([
    "morning-board-shell-v6-excel",
    "morning-board-shell-v7-isolated",
    "workbox-precache-v2",
    "another-app-cache",
  ]);
  let finished;
  listeners.get("activate")({ waitUntil: (promise) => { finished = promise; } });
  await finished;
  assert.deepEqual(deleted, ["morning-board-shell-v6-excel"]);
});

test("offline fallback opens the app's own cache", async () => {
  const { listeners, cache } = loadWorker();
  let cacheWasRead = false;
  cache.match = async () => { cacheWasRead = true; return null; };
  const request = { method: "GET", url: "https://example.test/app.js", mode: "cors" };
  let response;
  listeners.get("fetch")({
    request,
    respondWith: (promise) => { response = promise; },
    waitUntil: () => {},
  });
  const offlineResponse = await response;
  assert.equal(cacheWasRead, true);
  assert.equal(offlineResponse.status, 0);
});
