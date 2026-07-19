/**
 * Shadow Nexus Social — script.js
 * Shared JavaScript utilities loaded by feed.html
 *
 * Responsibilities:
 *  1. Register the app service worker (sw.js)
 *  2. Handle SW update notifications (new version available toast)
 *  3. Capture the PWA install prompt and show the install banner
 *  4. Online/offline status handling
 *  5. Misc global utilities used across pages
 *
 * NOTE: firebase-messaging-sw.js is NOT registered here.
 * It is registered lazily inside index.html by initPushNotifications(),
 * which runs after the user logs in and the correct scope path is known.
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   1 & 2. SERVICE WORKER REGISTRATION
   Detects whether we're on GitHub Pages (/TEST/)
   or running locally (file:// or localhost) and adjusts paths.
   ═══════════════════════════════════════════════════════════ */
(function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  const isGH   = location.pathname.startsWith('/TEST');
  const base   = isGH ? '/TEST/' : './';
  const swPath = base + 'sw.js';

  window.addEventListener('load', async () => {

    // ── Register main app service worker ──
    try {
      const reg = await navigator.serviceWorker.register(swPath, { scope: base });
      console.log('[SW] Registered, scope:', reg.scope);

      // If a new SW is already waiting on first load, show the update toast now
      if (reg.waiting) {
        showUpdateToast(reg.waiting);
      }

      // Detect new SW installing while the page is open
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            // New version ready — prompt user to reload
            showUpdateToast(newWorker);
          }
        });
      });

      // When the new SW takes control, reload so the fresh files are used
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!sessionStorage.getItem('snx-sw-reloading')) {
          sessionStorage.setItem('snx-sw-reloading', '1');
          window.location.reload();
        }
      });
    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }

    // NOTE: firebase-messaging-sw.js is registered by initPushNotifications()
    // inside index.html (after auth resolves + permission is granted) so that
    // the scope is derived from the live page path and the registration is
    // bound to a valid FCM token.  A separate early registration here would
    // use the wrong scope on GitHub Pages and conflicts with that flow.

  });

})();

/* ═══════════════════════════════════════════════
   4. PWA INSTALL BANNER
   ═══════════════════════════════════════════════ */
let _deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  _deferredInstallPrompt = e;

  if (sessionStorage.getItem('snx-install-dismissed')) return;
  setTimeout(() => showInstallBanner(), 3000);
});

function showInstallBanner() {
  const banner = document.getElementById('pwa-install-banner');
  if (!banner || !_deferredInstallPrompt) return;
  banner.classList.add('visible');
}

window.snxInstallApp = async function () {
  const banner = document.getElementById('pwa-install-banner');
  if (!_deferredInstallPrompt) return;

  _deferredInstallPrompt.prompt();
  const { outcome } = await _deferredInstallPrompt.userChoice;

  console.log('[PWA] Install outcome:', outcome);
  _deferredInstallPrompt = null;
  if (banner) banner.classList.remove('visible');
};

window.snxDismissInstallBanner = function () {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.classList.remove('visible');
  sessionStorage.setItem('snx-install-dismissed', '1');
};

window.addEventListener('appinstalled', () => {
  const banner = document.getElementById('pwa-install-banner');
  if (banner) banner.classList.remove('visible');
  _deferredInstallPrompt = null;
  console.log('[PWA] App installed successfully.');
});

/* ═══════════════════════════════════════════════
   5. ONLINE / OFFLINE STATUS
   ═══════════════════════════════════════════════ */
function updateOnlineStatus() {
  const isOnline = navigator.onLine;
  let offlineBanner = document.getElementById('snx-offline-bar');

  if (!isOnline) {
    if (!offlineBanner) {
      offlineBanner = document.createElement('div');
      offlineBanner.id = 'snx-offline-bar';
      offlineBanner.setAttribute('role', 'alert');
      offlineBanner.setAttribute('aria-live', 'polite');
      offlineBanner.style.cssText = `
        position: fixed; top: 0; left: 0; right: 0;
        z-index: 99999;
        background: rgba(180, 10, 30, 0.92);
        color: #fff; text-align: center;
        font-size: 13px; font-weight: 600;
        padding: 8px 16px; letter-spacing: 0.3px;
        border-bottom: 1px solid rgba(255, 51, 80, 0.5);
        box-shadow: 0 2px 12px rgba(255, 40, 70, 0.3);
        backdrop-filter: blur(4px);
        animation: slideDownBar 0.25s ease both;
      `;
      offlineBanner.textContent = "📡 You're offline — some features may be unavailable";
      document.body.prepend(offlineBanner);

      if (!document.getElementById('snx-offline-bar-style')) {
        const s = document.createElement('style');
        s.id = 'snx-offline-bar-style';
        s.textContent = '@keyframes slideDownBar { from { transform: translateY(-100%); } to { transform: translateY(0); } }';
        document.head.appendChild(s);
      }
    }
  } else {
    if (offlineBanner) offlineBanner.remove();
  }
}

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
document.addEventListener('DOMContentLoaded', updateOnlineStatus);

/* ═══════════════════════════════════════════════
   6. GLOBAL UTILITIES
   ═══════════════════════════════════════════════ */

/** Copy text to clipboard with a toast confirmation. */
window.snxCopyToClipboard = function (text, successMsg) {
  const msg = successMsg || 'Copied to clipboard!';
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(() => { if (typeof toastNotification === 'function') toastNotification(msg); })
      .catch(() => { window.prompt('Copy this:', text); });
  } else {
    window.prompt('Copy this:', text);
  }
};

/** Format byte count as human-readable string. */
window.snxFormatBytes = function (bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
};

/** Debounce helper. */
window.snxDebounce = function (fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
};

/** Throttle helper. */
window.snxThrottle = function (fn, interval) {
  let last = 0;
  return function (...args) {
    const now = Date.now();
    if (now - last >= interval) { last = now; fn.apply(this, args); }
  };
};

/** Generate a random alphanumeric ID. */
window.snxUid = function (length) {
  length = length || 8;
  return Array.from({ length }, () => Math.random().toString(36)[2] || '0')
    .join('').toUpperCase();
};

/** Check if the app is running as an installed PWA (standalone mode). */
window.snxIsStandalone = function () {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
};

document.addEventListener('DOMContentLoaded', () => {
  if (window.snxIsStandalone()) {
    console.log('[PWA] Running in standalone mode.');
    document.documentElement.setAttribute('data-pwa', 'standalone');
  }
});
