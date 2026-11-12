const C = "gulfbite-v3";
const SHELL = ["./", "./index.html", "./app.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const u = new URL(e.request.url);
  const put = res => { const cp = res.clone(); caches.open(C).then(c => c.put(e.request, cp)); return res; };
  if (u.origin === location.origin) { // app files: network first so updates show up, cache when offline
    e.respondWith(fetch(e.request).then(put).catch(() => caches.match(e.request)));
  } else if (/cdnjs|fonts\.(googleapis|gstatic)/.test(u.host)) { // libraries and fonts: cache first
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(put)));
  }
});
