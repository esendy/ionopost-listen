// sw.js — keeps the whole app on the phone, so it opens with no signal: in the field is the point.
// The cache name carries a hash of the build; a new build replaces the old cache on next open.
const CACHE = "ionopost-listen-abedde0a0628";
const FILES = ["./", "index.html", "worker.js", "worklet.js", "webrx.js", "webrx.wasm", "words.txt",
               "manifest.webmanifest", "icon-180.png", "icon-192.png", "icon-512.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
