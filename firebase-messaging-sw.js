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
 *   mention | tag | repost | wallPost | announcement | system
 */

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
});

const messaging = firebase.messaging();

// GitHub Pages serves this app under /TEST/
const SNX_BASE = '/TEST/';
const ICON  = SNX_BASE + 'icon-192.png';
const BADGE = SNX_BASE + 'favicon-32x32.png';
const APP_URL = SNX_BASE;

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
  if (type === 'message')       return [120, 60, 120, 60, 120]; // triple pulse for messages
  if (type === 'system')        return [300, 100, 300];          // double long for alerts
  if (type === 'friendRequest') return [200, 100, 200];
  if (type === 'live')          return [100, 50, 100, 50, 100]; // quick burst for live
  return [200, 100, 200];
}

// ── Background FCM messages (app closed / background) ─────────────────────────
messaging.onBackgroundMessage((payload) => {
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
  });
});

// ── Notification click handler ─────────────────────────────────────────────────
// • message  → open app + post SNX_OPEN_CHAT → ipcOpen(fromUid)
// • live     → open live.html#watch={roomId} (or focus existing tab)
// • system   → open Notification Center
// • default  → focus existing tab or open app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data    = event.notification.data || {};
  const url     = data.url || APP_URL;
  const type    = data.type    || '';
  const fromUid = data.fromUid || '';
  const roomId  = data.roomId  || '';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const appTab  = list.find(c => c.url.includes('/TEST'));
      const liveTab = list.find(c => c.url.includes('live.html'));

      if (type === 'live' && roomId) {
        // Open (or focus) the live room directly
        const liveUrl = APP_URL + 'live.html#watch=' + roomId;
        if (liveTab) { liveTab.focus(); return; }
        return clients.openWindow(liveUrl);
      }

      if (type === 'message' && fromUid) {
        // Tell the open page to call window.ipcOpen(fromUid)
        if (appTab) {
          appTab.focus();
          appTab.postMessage({ type: 'SNX_OPEN_CHAT', fromUid });
          return;
        }
        // App not open — launch with ?snxChat param; page handles it on load
        return clients.openWindow(APP_URL + '?snxChat=' + encodeURIComponent(fromUid));
      }

      if (type === 'system') {
        // Open / focus app and navigate to Notification Center
        if (appTab) {
          appTab.focus();
          appTab.postMessage({ type: 'SNX_OPEN_NOTIFS' });
          return;
        }
        return clients.openWindow(APP_URL + '?snxPage=notifications');
      }

      // All other notification types — open Notification Center
      if (appTab) {
        appTab.focus();
        appTab.postMessage({ type: 'SNX_OPEN_NOTIFS' });
        return;
      }
      return clients.openWindow(APP_URL + '?snxPage=notifications');
    })
  );
});
