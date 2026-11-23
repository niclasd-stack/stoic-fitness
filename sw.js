// Service Worker: macht die App offline nutzbar.
// Bei Änderungen an den Dateien VERSION erhöhen, damit die Geräte die neue Fassung laden.
// Alle Caches beginnen mit „fit-“: Das Stoische Journal liegt auf derselben Origin,
// und jede App darf nur ihre eigenen Caches aufräumen.
const VERSION = 'v1';
const PREFIX = 'fit-';
const SHELL = `${PREFIX}shell-${VERSION}`;
const RUNTIME = `${PREFIX}runtime-v1`;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './js/app.js',
  './js/auth.js',
  './js/charts.js',
  './js/config.js',
  './js/db.js',
  './js/plan.js',
  './js/quotes.js',
  './js/stats.js',
  './js/sync.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/dist/umd/supabase.js',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL)
    .then(c => c.addAll(SHELL_FILES.map(u => new Request(u, { cache: 'no-cache' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith(PREFIX) && key !== SHELL && key !== RUNTIME) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Supabase-API nie cachen
  if (url.hostname.endsWith('.supabase.co')) return;

  // Schriften und CDN: einmal laden, dann aus dem Cache
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com' || url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(caches.match(req, { cacheName: RUNTIME }).then(hit => hit || caches.match(req, { cacheName: SHELL })).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(RUNTIME).then(c => c.put(req, copy));
      return res;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Eigene Dateien: Netz zuerst (immer aktuell), offline aus dem Cache
  event.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) {
        const copy = res.clone();
        caches.open(SHELL).then(c => c.put(req, copy));
      }
      return res;
    } catch {
      const cache = await caches.open(SHELL);
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return cache.match('./index.html');
      throw new Error('offline');
    }
  })());
});
