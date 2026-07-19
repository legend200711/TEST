/**
 * Shadow Nexus Social — Service Worker
 *
 * Strategy:
 *   - Navigation (HTML page loads) → Network-first, fallback to cache → offline.html
 *   - Same-origin assets (CSS/JS/icons) → Cache-first, network fallback
 *   - Firebase & external CDN requests  → Network-only (always fresh)
 *
 * Path detection: base is derived from sw.js location so this works on both
 * GitHub Pages (/ShadowNexusSocial/) and any local dev server (/).
 */

const CACHE_VERSION = 'v9';
const CACHE_NAME    = `shadow-nexus-${CACHE_VERSION}`;

// Detect base path from the SW's own URL (e.g. /ShadowNexusSocial/ or /)
const SW_URL  = new URL(self.location.href);
const BASE    = SW_URL.pathname.replace(/sw\.js$/, ''); // e.g. '/ShadowNexusSocial/' or '/'
const OFFLINE = BASE + 'offline.html';

/** Files pre-cached on install — paths relative to BASE */
const SHELL_FILES = [
  '',            // root / index
  'index.html',
  'offline.html',
  'style.css',
  'script.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
  'favicon-32x32.png',
  'favicon-16x16.png',
  // Live streaming pages
  'live.html',
  'live.js',
  'live.css',
];

const PRECACHE_URLS = SHELL_FILES.map(f => BASE + f);

/** Hosts that must always go to the network */
const NETWORK_ONLY_HOSTS = [
  'firestore.googleapis.com',
  'firebase.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'www.gstatic.com',
  'firebaseio.com',
  'googleapis.com',
];

/* ─────────────────────────────────────────────
   INSTALL — pre-cache the app shell
   ───────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) =>
        Promise.allSettled(
          PRECACHE_URLS.map((url) =>
            cache.add(url).catch((err) =>
              console.warn(`[SW] Pre-cache skipped: ${url}`, err.message)
            )
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

/* ─────────────────────────────────────────────
   ACTIVATE — clean up old caches
   ───────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) =>
        Promise.all(
          names
            .filter((n) => n !== CACHE_NAME)
            .map((n) => {
              console.log(`[SW] Deleting old cache: ${n}`);
              return caches.delete(n);
            })
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ─────────────────────────────────────────────
   FETCH — request routing
   ───────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  // Network-only: Firebase & external API hosts
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host))) {
    event.respondWith(fetch(request));
    return;
  }

  // Navigation requests (page loads) — network-first, cache fallback, then offline page
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) => cached || caches.match(OFFLINE)
          )
        )
    );
    return;
  }

  // Same-origin assets — cache-first, network fallback
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() =>
          new Response('', { status: 404, statusText: 'Not Found' })
        );
      })
    );
    return;
  }

  // Cross-origin assets (CDN) — network-first, cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});

/* ─────────────────────────────────────────────
   MESSAGE — cache control from the page
   ───────────────────────────────────────────── */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});
