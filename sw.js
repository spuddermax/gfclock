/* ===========================================================
   sw.js — service worker making the whole app (simulated clock
   + Beat Timer) work completely offline once loaded, and
   installable as a standalone app.

   IMPORTANT for future edits: bump CACHE_NAME whenever any
   precached file changes. start.sh serves everything with
   Cache-Control: no-store, so a live browser tab always sees
   fresh bytes (including of this file) — but an already
   *installed* PWA only ever reads from this worker's own Cache
   Storage, so without a version bump it will keep serving the
   old cached copy indefinitely even though the site itself has
   moved on.
   =========================================================== */

const CACHE_NAME = 'gfclock-v11';

const PRECACHE_URLS = [
  './',
  'index.html',
  'styles.css',
  'manifest.json',
  'js/audio.js',
  'js/clock.js',
  'js/main.js',
  'js/beat-timer.js',
  'js/beat-processor.js',
  'js/pwa.js',
  'assets/mountains.svg',
  'assets/PurpleFirefly256.png',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/audio/westminster.mp3',
  'assets/audio/bells/C4.mp3',
  'assets/audio/bells/D4.mp3',
  'assets/audio/bells/E4.mp3',
  'assets/audio/bells/Fs4.mp3',
  'assets/audio/bells/Gs4.mp3',
  'assets/audio/bells/As4.mp3',
  'assets/audio/bells/C5.mp3',
  'assets/audio/bells/D5.mp3',
  'assets/audio/bells/E5.mp3',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Page navigations: try the network first (so a connected user always
  // gets the latest page), falling back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match('index.html'))
    );
    return;
  }

  // Everything else (scripts, styles, audio, icons): cache-first, since
  // these are all versioned together via CACHE_NAME.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      caches.open(CACHE_NAME).then((c) => c.put(req, res.clone()));
      return res;
    }))
  );
});
