/**
 * Shadow Nexus Social — Firebase Messaging Service Worker
 *
 * Handles background push notifications when the app is closed/locked.
 * Message flow:
 *   Profile → Message Button → Firebase /chats → pushNotification()
 *   → pushQueue → OS Notification → Notification Center 🔔
 *
 * Notification types routed here:
 *   message | like | comment | follow | friendRequest |
 *   mention | tag | repost | wallPost | announcement | system | live
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

// ── Guard: prevent double-initialisation if SW is reused ──────────────────────
if (!self._snxFbInitialised) {
  self._snxFbInitialised = true;

  try {
    firebase.initializeApp({
      apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
      authDomain:        'horr-a08f4.firebaseapp.com',
      projectId:         'horr-a08f4',
      storageBucket:     'horr-a08f4.firebasestorage.app',
      messagingSenderId: '933810617818',
      appId:             '1:933810617818:web:efb24f123337dd987c14e3',
    });
    console.log('[FCM-SW] Firebase initialised');
  } catch (initErr) {
    console.error('[FCM-SW] Firebase init error:', initErr.message);
  }
}

const messaging = firebase.messaging();

// Derive base path from this SW's own URL so it works on any deployment path
// e.g. /TEST/ on GitHub Pages or / on localhost
const _swBase = self.location.pathname.replace(/firebase-messaging-sw\.js$/, '');
const SNX_BASE = _swBase || '/';
const ICON     = SNX_BASE + 'icon-192.png';
const BADGE    = SNX_BASE + 'favicon-32x32.png';
const APP_URL  = SNX_BASE;

// ── Notification type → display title ────────────────────────────────────────
const TYPE_TITLES = {
  message:       '💬 New Message',
  like:          '❤️ Post Liked',
  comment:       '💬 New Comment',
  reply:         '↩️ New Reply',
  follow:        '👤 New Follower',
  friendRequest: '🦋 Friend Request',
  familyInvite:  '❤️ Family Invitation',
  mention:       '@ You were mentioned',
  tag:           '🏷️ You were tagged',
  announcement:  '📢 Announcement',
  repost:        '🔄 Post Reposted',
  wallPost:      '📝 New Wall Post',
  system:        '⚙️ System Alert',
  live:          '🔴 Someone is Live',
};

// ── Vibration patterns by type ────────────────────────────────────────────────
function vibrateFor(type) {
  if (type === 'message')       return [120, 60, 120, 60, 120];
  if (type === 'system')        return [300, 100, 300];
  if (type === 'friendRequest') return [200, 100, 200];
  if (type === 'live')          return [100, 50, 100, 50, 100];
  return [200, 100, 200];
}

// ── Background FCM messages (app closed / background) ─────────────────────────
messaging.onBackgroundMessage((payload) => {
  console.log('[FCM-SW] Background message received:', payload);

  const data    = payload.data  || {};
  const notif   = payload.notification || {};
  const type    = data.type    || 'announcement';
  const fromUid = data.fromUid || '';
  const roomId  = data.roomId  || '';
  const title   = notif.title || TYPE_TITLES[type] || '🔔 Shadow Nexus Social';
  const body    = notif.body  || data.body || 'You have a new notification';

  // For live notifications the tap should open the live room directly
  const targetUrl = type === 'live' && roomId
    ? APP_URL + 'live.html#watch=' + roomId
    : APP_URL;

  return self.registration.showNotification(title, {
    body,
    icon:     ICON,
    badge:    BADGE,
    tag:      `snx-${type}-${fromUid || Date.now()}`,
    renotify: true,
    vibrate:  vibrateFor(type),
    requireInteraction: type === 'message' || type === 'system' || type === 'live',
    data:     { url: targetUrl, type, fromUid, roomId },
  }).catch(err => {
    console.error('[FCM-SW] showNotification error:', err);
  });
});

// ── Notification click handler ─────────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data    = event.notification.data || {};
  const url     = data.url || APP_URL;
  const type    = data.type    || '';
  const fromUid = data.fromUid || '';
  const roomId  = data.roomId  || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      // Find any open app tab (match on the base path so /TEST/ variants all match)
      const appTab  = list.find(c => c.url.includes(SNX_BASE.replace(/\/$/, '')));
      const liveTab = list.find(c => c.url.includes('live.html'));

      if (type === 'live' && roomId) {
        const liveUrl = APP_URL + 'live.html#watch=' + roomId;
        if (liveTab) { liveTab.focus(); return; }
        if (appTab)  { appTab.focus();  return appTab.navigate ? appTab.navigate(liveUrl) : clients.openWindow(liveUrl); }
        return clients.openWindow(liveUrl);
      }

      if (type === 'message' && fromUid) {
        if (appTab) {
          appTab.focus();
          appTab.postMessage({ type: 'SNX_OPEN_CHAT', fromUid });
          return;
        }
        return clients.openWindow(APP_URL + '?snxChat=' + encodeURIComponent(fromUid));
      }

      if (type === 'system') {
        if (appTab) {
          appTab.focus();
          appTab.postMessage({ type: 'SNX_OPEN_NOTIFS' });
          return;
        }
        return clients.openWindow(APP_URL + '?snxPage=notifications');
      }

      // All other notification types → open Notification Center
      if (appTab) {
        appTab.focus();
        appTab.postMessage({ type: 'SNX_OPEN_NOTIFS' });
        return;
      }
      return clients.openWindow(APP_URL + '?snxPage=notifications');
    })
  );
});

// ── Push event fallback ────────────────────────────────────────────────────────
// Catches raw Web Push payloads that arrive outside the FCM SDK path.
// This ensures notifications are shown even if the FCM compat layer misses them.
self.addEventListener('push', (event) => {
  // The Firebase compat SDK handles most cases via onBackgroundMessage above.
  // Only show a fallback if there is no notification in the payload and
  // the FCM SDK didn't already call showNotification.
  if (!event.data) return;

  let parsed = null;
  try { parsed = event.data.json(); } catch (_) {}

  // If the FCM SDK would handle it (has 'google.firebase.fcm.project_number'), skip.
  if (parsed && parsed['google.firebase.fcm.project_number']) return;

  const title = (parsed && parsed.notification && parsed.notification.title) || '🔔 Shadow Nexus Social';
  const body  = (parsed && parsed.notification && parsed.notification.body)  || 'You have a new notification';

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon:  ICON,
      badge: BADGE,
      data:  { url: APP_URL },
    }).catch(err => console.error('[FCM-SW] Fallback push showNotification error:', err))
  );
});
