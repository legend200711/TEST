/**
 * Shadow Nexus Social — Service Worker
 * Scope: /ShadowNexusSocial/
 *
 * Strategy:
 *   - App shell (HTML, CSS, JS, icons) → Cache-first, network fallback
 *   - Firebase SDK requests          → Network-only (always fresh auth/data)
 *   - Navigation requests            → Cache-first, fallback to offline.html
 *   - Everything else                → Network-first, cache fallback
 *
 * Cache auto-updates: on every SW activation the old cache is deleted
 * and the new one is pre-cached, so users always get the latest shell.
 */

const CACHE_NAME    = 'shadow-nexus-v5';
const OFFLINE_URL   = '/ShadowNexusSocial/offline.html';

/** Files that make up the app shell — pre-cached on install */
const PRECACHE_URLS = [
  '/ShadowNexusSocial/',
  '/ShadowNexusSocial/index.html',
  '/ShadowNexusSocial/offline.html',
  '/ShadowNexusSocial/style.css',
  '/ShadowNexusSocial/script.js',
  '/ShadowNexusSocial/manifest.json',
  '/ShadowNexusSocial/icon-192.png',
  '/ShadowNexusSocial/icon-512.png',
  '/ShadowNexusSocial/apple-touch-icon.png',
  '/ShadowNexusSocial/favicon.ico',
  '/ShadowNexusSocial/favicon-32x32.png',
  '/ShadowNexusSocial/favicon-16x16.png',
];

/** Hosts that must always go to the network (Firebase, CDNs) */
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
      .then((cache) => Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[SW] Pre-cache skipped: ${url}`, err.message)
          )
        )
      ))
      // Take over immediately — script.js no longer reloads on
      // controllerchange so this is safe on both first install and updates.
      .then(() => self.skipWaiting())
  );
});

/* ─────────────────────────────────────────────
   ACTIVATE — clean up old caches
   ───────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log(`[SW] Deleting old cache: ${name}`);
            return caches.delete(name);
          })
      );
    }).then(() => self.clients.claim())
    // clients.claim() lets the new SW take over all open tabs immediately
    // after an update activates, so the reloaded page is served by the
    // fresh SW right away. On first install this fires but the page has no
    // prior controller so _hadControllerOnLoad is false and script.js will
    // not trigger a reload.
  );
});

/* ─────────────────────────────────────────────
   FETCH — request routing
   ───────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // 1. Only handle GET requests
  if (request.method !== 'GET') return;

  // 2. Network-only: Firebase & external API hosts
  if (NETWORK_ONLY_HOSTS.some((host) => url.hostname.includes(host))) {
    event.respondWith(fetch(request));
    return;
  }

  // 3. Navigation requests (page loads) — network-first so users always get
  //    the latest HTML. Only fall back to the cache when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => {
        // Offline: serve the cached page if available, else the offline page
        return caches.match(request).then((cached) => cached || caches.match(OFFLINE_URL));
      })
    );
    return;
  }

  // 4. App-shell assets (same origin) — cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        // Not in cache yet — fetch, cache, return
        return fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        }).catch(() => {
          // For font/image misses, just fail gracefully
          return new Response('', { status: 404, statusText: 'Not Found' });
        });
      })
    );
    return;
  }

  // 5. Cross-origin assets (CDN fonts, images) — network-first, cache fallback
  event.respondWith(
    fetch(request).then((response) => {
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    }).catch(() => caches.match(request))
  );
});

/* ─────────────────────────────────────────────
   MESSAGE — allow pages to trigger cache refresh
   ───────────────────────────────────────────── */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data && event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      event.source && event.source.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
});
