/*
 * Offline support. Caches only this site's own static files (app, pdf.js,
 * ONNX Runtime, tesseract) so reading works in airplane mode. Never caches
 * or touches cross-origin requests (the encrypted submission goes straight
 * to the network) and never sees document data — documents are never
 * fetched, they are read from the file picker into memory.
 */
const CACHE = "pde-app-v3";

/** Only the app's own static files — never APIs or anything else on the origin. */
function isStaticAsset(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
  const rel = url.pathname.slice(scope.pathname.length);
  // Model weights are cached and hash-verified by the app itself.
  if (rel.startsWith("models/")) return rel === "models/manifest.json";
  return (
    rel === "" ||
    rel === "index.html" ||
    rel === "pde.config.json" ||
    rel === "manifest.webmanifest" ||
    rel === "icon.svg" ||
    rel.startsWith("assets/") ||
    rel.startsWith("pdfjs/") ||
    rel.startsWith("tesseract/")
  );
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      // Drop caches from older versions of this service worker.
      for (const key of await caches.keys()) if (key.startsWith("pde-app-") && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

/** Content-hashed or versioned files that never change under the same URL. */
function isImmutable(rel) {
  return rel.startsWith("assets/") || rel.startsWith("pdfjs/") || rel.startsWith("tesseract/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || !isStaticAsset(url)) return;
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isImmutable(rel)) {
        // Cache first: these URLs change whenever their content changes.
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const res = await fetch(req);
        // Hand the response back at once and cache in the background: waiting
        // for cache.put first would hold large files (the 14–26 MB runtime)
        // until fully stored, and WebKit can stall on that.
        if (res.ok && res.type === "basic") event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
        return res;
      }
      // The page, config and manifests: network first so fixes and config
      // changes arrive on the next load; the cache is only the offline fallback.
      try {
        const res = await fetch(req, { cache: "no-cache" });
        if (res.ok && res.type === "basic") event.waitUntil(cache.put(req, res.clone()).catch(() => {}));
        return res;
      } catch {
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw new Error("offline and not cached");
      }
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-urls") return;
  const port = event.ports[0];
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const failed = [];
      const scope = self.registration.scope;
      const wanted = [...event.data.urls, new URL("./", scope).href, new URL("./pde.config.json", scope).href, new URL("./models/manifest.json", scope).href];
      for (const u of wanted) {
        if (!isStaticAsset(new URL(u))) continue;
        try {
          if (!(await cache.match(u, { ignoreSearch: true }))) await cache.add(u);
        } catch {
          failed.push(u);
        }
      }
      port?.postMessage({ ok: failed.length === 0, failed });
    })(),
  );
});
