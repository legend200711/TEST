/**
 * Shadow Nexus Social — script.js
 * Shared JavaScript utilities loaded by feed.html
 *
 * Responsibilities:
 *  1. Register the app service worker (sw.js)
 *  2. Register the FCM messaging service worker (firebase-messaging-sw.js)
 *  3. Handle SW update notifications (new version available toast)
 *  4. Capture the PWA install prompt and show the install banner
 *  5. Online/offline status handling
 *  6. Misc global utilities used across pages
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   1 & 2. SERVICE WORKER REGISTRATION
   Detects whether we're on GitHub Pages (/ShadowNexusSocial/)
   or running locally (file:// or localhost) and adjusts paths.
   ═══════════════════════════════════════════════════════════ */
(function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  const isGH    = location.pathname.startsWith('/ShadowNexusSocial');
  const base    = isGH ? '/ShadowNexusSocial/' : './';
  const swPath  = base + 'sw.js';
  const fcmPath = base + 'firebase-messaging-sw.js';

  window.addEventListener('load', async () => {

    // ── Register main app service worker ──
    try {
      const reg = await navigator.serviceWorker.register(swPath, { scope: base });
      console.log('[SW] Registered, scope:', reg.scope);

      // When a NEW service worker activates (cache version bumped), reload
      // the page exactly once so users immediately get the latest files.
      // sessionStorage flag prevents a reload loop: if we just reloaded we
      // skip the next controllerchange event that fires on the fresh page.
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (sessionStorage.getItem('snx-sw-reloading')) return;
        sessionStorage.setItem('snx-sw-reloading', '1');
        window.location.reload();
      });
    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }

    // ── Register FCM messaging service worker ──
    try {
      await navigator.serviceWorker.register(fcmPath, { scope: base });
      console.log('[FCM-SW] Registered');
    } catch (err) {
      console.warn('[FCM-SW] Registration failed:', err);
    }

  });

  // Clear the reload-guard flag on every fresh page load so the next update
  // can trigger a reload again.
  sessionStorage.removeItem('snx-sw-reloading');
})();

/* ═══════════════════════════════════════════════
   3. UPDATE AVAILABLE TOAST
   ═══════════════════════════════════════════════ */
function showUpdateToast(worker) {
  const toast = document.getElementById('pwa-update-toast');
  if (!toast) return;

  toast.classList.add('visible');

  const btn = toast.querySelector('.update-btn');
  if (btn) {
    btn.addEventListener('click', () => {
      toast.classList.remove('visible');
      worker.postMessage({ type: 'SKIP_WAITING' });
    }, { once: true });
  }

  // Auto-dismiss after 12 seconds
  setTimeout(() => toast.classList.remove('visible'), 12000);
}

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
