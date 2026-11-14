// Vizora service worker: caches the app shell so Vizora opens offline and can be installed.
// Bump VERSION when shipping changes; old caches are dropped on activate.
const VERSION = 'vizora-v2';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/css/app.css',
  '/js/calc.js',
  '/js/chart.js',
  '/js/dashboard.js',
  '/js/data.js',
  '/js/engine.js',
  '/js/files.js',
  '/js/formula.js',
  '/js/main.js',
  '/js/model.js',
  '/js/pills.js',
  '/js/render.js',
  '/js/sheet.js',
  '/js/sql.js',
  '/js/store.js',
  '/js/ui.js',
  '/js/util.js',
  '/js/visuals.js',
  '/vendor/papaparse.min.js',
  '/vendor/vega-embed.min.js',
  '/vendor/vega-lite.min.js',
  '/vendor/vega.min.js',
  '/vendor/fonts/archivo-latin-standard-normal.woff2',
  '/vendor/fonts/fonts.css',
  '/vendor/fonts/ibm-plex-mono-latin-400-normal.woff2',
  '/vendor/fonts/ibm-plex-mono-latin-500-normal.woff2',
  '/icons/icon.svg',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first (so a new deploy shows up right away), falling back to the cache when offline.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
