/* MyDimension — service-worker.js
 * App-shell caching ONLY: HTML/CSS/JS/manifest/logo.
 * NEVER cached: /api/* responses, /auth/*, media (/api/media/*),
 * tokens, or any private diary data. Those always go to the network.
 */
var CACHE = 'mydimension-shell-v1';
var SHELL = [
  './', 'index.html',
  'css/styles.css',
  'js/api.js', 'js/auth.js', 'js/journal.js', 'js/media.js', 'js/ai.js', 'js/app.js',
  'manifest.webmanifest', 'assets/logo.svg'
];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  // Only same-origin GETs, and never API / auth / media.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/auth/') === 0) return;
  event.respondWith(
    caches.match(event.request).then(function (cached) {
      // Cache-first for the static shell; network fallback for anything else.
      return cached || fetch(event.request);
    })
  );
});
