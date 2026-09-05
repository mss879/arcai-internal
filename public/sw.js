// ARC AI service worker — handles background web-push notifications.

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "ARC AI", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "ARC AI";
  const options = {
    body: data.body || "",
    icon: "/new-logo.png",
    badge: "/new-logo.png",
    data: { link: data.link || "/" },
    // Vibrate on supported mobile devices.
    vibrate: [80, 40, 80],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || "/";

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      // Focus an already-open tab and navigate it to the link.
      for (const client of all) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(link);
            } catch (e) {
              /* cross-origin or unsupported — ignore */
            }
          }
          return;
        }
      }
      // Otherwise open a fresh window.
      if (self.clients.openWindow) await self.clients.openWindow(link);
    })(),
  );
});

// ---------------------------------------------------------------------------
// 0119 — /projects/go works without signal.
//
// Three things, and only three, so the rest of the app is untouched:
//   1. The on-the-go page and its JSON (/api/go/data) are served network-
//      first, and the last good copy is kept for when the network is gone.
//   2. Next's hashed static chunks are cached as they are fetched, so the
//      cached page can actually render offline rather than showing a blank
//      shell that references scripts it cannot load.
//   3. Background Sync ("go-outbox") replays the IndexedDB outbox through
//      /api/go/sync — the same server actions a tap uses — and tells any
//      open tab what happened. Safari has no Background Sync; the page
//      replays on its own when it comes back online.
//
// The database and store names must match src/lib/go-outbox.ts.
// ---------------------------------------------------------------------------

const GO_CACHE = "arc-go-v1";
const GO_SHELL = "/projects/go";
const GO_DATA = "/api/go/data";
const GO_SYNC_URL = "/api/go/sync";
const GO_SYNC_TAG = "go-outbox";
const GO_DB = "arc-go";
const GO_STORE = "outbox";

self.addEventListener("install", (event) => {
  // Best-effort: warm the shell if the person is signed in. A 307 to /login
  // is not worth keeping, so only a real 200 goes in the cache.
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(GO_CACHE);
        const res = await fetch(GO_SHELL, { credentials: "same-origin" });
        if (res.ok && !res.redirected) await cache.put(GO_SHELL, res.clone());
      } catch (e) {
        /* offline at install — the first visit fills it */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("arc-go-") && n !== GO_CACHE).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

function isGoShell(url) {
  return url.pathname === GO_SHELL || url.pathname === GO_SHELL + "/";
}

function isStaticChunk(url) {
  return url.pathname.startsWith("/_next/static/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // 1. The page and its data: network first, cache as fallback.
  if ((req.mode === "navigate" && isGoShell(url)) || url.pathname === GO_DATA) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(GO_CACHE);
        try {
          const res = await fetch(req);
          // A redirect to /login means signed out — never cache that over a
          // good copy, and never serve it back as the page.
          if (res.ok && !res.redirected) await cache.put(req.mode === "navigate" ? GO_SHELL : GO_DATA, res.clone());
          return res;
        } catch (e) {
          const cached = await cache.match(req.mode === "navigate" ? GO_SHELL : GO_DATA);
          if (cached) return cached;
          throw e;
        }
      })(),
    );
    return;
  }

  // 2. Hashed chunks: cache first. The hash IS the version.
  if (isStaticChunk(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(GO_CACHE);
        const cached = await cache.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) await cache.put(req, res.clone());
        return res;
      })(),
    );
  }
});

// 3. Background Sync — the outbox, replayed through the real server actions.

function openGoDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(GO_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GO_STORE)) db.createObjectStore(GO_STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function readOutbox(db) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(GO_STORE, "readonly");
    const req = t.objectStore(GO_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function writeOutbox(db, done, refused) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(GO_STORE, "readwrite");
    const store = t.objectStore(GO_STORE);
    for (const id of done) store.delete(id);
    for (const item of refused) store.put(item);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function replayOutbox() {
  const db = await openGoDb();
  try {
    const items = await readOutbox(db);
    if (!items.length) return;
    const res = await fetch(GO_SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        items: items.map((i) => ({ id: i.id, kind: i.kind, payload: i.payload })),
      }),
    });
    // Anything but a real answer: keep everything and let sync retry.
    if (!res.ok) throw new Error("sync failed: " + res.status);
    const data = await res.json();
    const results = (data && data.results) || [];
    const done = [];
    const refused = [];
    for (const r of results) {
      const item = items.find((i) => i.id === r.id);
      if (!item) continue;
      if (r.ok) done.push(r.id);
      else refused.push(Object.assign({}, item, { error: r.error || "Refused." }));
    }
    await writeOutbox(db, done, refused);
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of all) {
      client.postMessage({ type: "go-outbox-synced", synced: done.length, refused: refused.length });
    }
  } finally {
    db.close();
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === GO_SYNC_TAG) event.waitUntil(replayOutbox());
});
