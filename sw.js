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

const CACHE_VERSION = 'v12';
const CACHE_NAME    = `shadow-nexus-${CACHE_VERSION}`;
const MEDIA_CACHE   = `shadow-nexus-media-${CACHE_VERSION}`;

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
  'album.css',
  'script.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
  'favicon-32x32.png',
  'favicon-16x16.png',
  // live.html / live.js / live.css intentionally excluded — always network-fresh
];

/** Max entries for the media cache (CDN images / avatars). */
const MEDIA_CACHE_MAX = 100;
/** Max age for media cache entries (24 hours). */
const MEDIA_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Paths that must always go to the network (never served from cache) */
const NETWORK_FIRST_PATHS = ['live.html', 'live.js', 'live.css'];

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
            .filter((n) => n !== CACHE_NAME && n !== MEDIA_CACHE)
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

  // Live streaming files — always network, never cache
  const pathname = url.pathname;
  if (url.origin === self.location.origin &&
      NETWORK_FIRST_PATHS.some(p => pathname.endsWith(p))) {
    event.respondWith(fetch(request));
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

  // Cross-origin CDN media (images, avatars) — stale-while-revalidate with size cap
  const isMedia = /\.(jpe?g|png|gif|webp|svg|mp4|webm|mp3|m4a|ogg|opus)(\?|$)/i.test(url.pathname);
  if (isMedia) {
    event.respondWith(
      caches.open(MEDIA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          // Serve cached copy; revalidate in background
          const dateHeader = cached.headers.get('date');
          const age = dateHeader ? Date.now() - new Date(dateHeader).getTime() : Infinity;
          if (age < MEDIA_CACHE_MAX_AGE_MS) {
            return cached; // fresh enough — no revalidation needed
          }
          // Stale — refresh in background
          fetch(request).then((fresh) => {
            if (fresh && fresh.status === 200) {
              _trimMediaCache(cache).then(() => cache.put(request, fresh.clone()));
            }
          }).catch(() => {});
          return cached;
        }
        // Not in cache — fetch, store, then serve
        try {
          const response = await fetch(request);
          if (response && response.status === 200) {
            await _trimMediaCache(cache);
            cache.put(request, response.clone());
          }
          return response;
        } catch (_) {
          return caches.match(request);
        }
      })
    );
    return;
  }

  // Cross-origin non-media assets (fonts, scripts from CDN) — network-first, cache fallback
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

/** Trim media cache to MEDIA_CACHE_MAX entries (LRU by insertion order). */
async function _trimMediaCache(cache) {
  const keys = await cache.keys();
  if (keys.length >= MEDIA_CACHE_MAX) {
    const toDelete = keys.slice(0, keys.length - MEDIA_CACHE_MAX + 1);
    await Promise.all(toDelete.map((k) => cache.delete(k)));
  }
}

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
