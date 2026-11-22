// Vetrina DM service worker.
// - app shell: precached for offline use, but served network-first so deploys show up immediately
// - data/*.json: stale-while-revalidate (the weekly job changes them)
// - card images (local copies or the wiki CDN): cache-first with a size cap
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const DATA = "data-v1";
const IMAGES = "images-v1";
const MAX_IMAGES = 600;

const SHELL_FILES = [
  "./", "index.html", "css/stile.css", "js/app.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png", "icons/favicon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("shell-") && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Pages: network first so a fresh deploy shows up, cache as offline fallback.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req).then((res) => { caches.open(SHELL).then((c) => c.put("index.html", res.clone())); return res; })
        .catch(() => caches.match("index.html"))
    );
    return;
  }

  if (url.origin === location.origin) {
    if (url.pathname.includes("/data/")) {
      e.respondWith(caches.open(DATA).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
        return hit || net;
      }));
      return;
    }
    if (url.pathname.includes("/images/")) {
      e.respondWith(caches.open(IMAGES).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()); trim(IMAGES, MAX_IMAGES); }
        return res;
      }));
      return;
    }
    // App code (js/css/manifest/icons): network first so a new deploy is picked up at once,
    // the cached copy only serves when offline.
    e.respondWith(
      fetch(req).then((res) => { if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone())); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Wiki CDN images (no-cors => opaque responses are fine to cache for <img>).
  if (url.hostname === "static.wikia.nocookie.net") {
    e.respondWith(caches.open(IMAGES).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok || res.type === "opaque") { cache.put(req, res.clone()); trim(IMAGES, MAX_IMAGES); }
        return res;
      } catch (err) { return hit || Response.error(); }
    }));
  }
});
