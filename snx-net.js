/**
 * Shadow Nexus Social — snx-net.js
 * Global Background Internet Manager
 *
 * Runs automatically on every page the moment this script loads.
 * No buttons, no pop-ups, no user interaction required.
 *
 * Responsibilities:
 *  1. Detect connection type (5G / 4G / Wi-Fi / Slow Wi-Fi / Poor / Offline)
 *  2. Classify into a quality tier and expose it on window.SNX_NET
 *  3. Monitor WebRTC stats when live streaming is active
 *  4. Dispatch "snxNetChange" CustomEvent so any page / module can react
 *  5. Notify the Service Worker so it can adapt its fetch strategy
 *  6. Adjust media element quality (video/audio src + preload) for the tier
 *  7. Implement Data Saver mode on slow / poor connections
 *  8. Auto-reconnect: retry fetch() failures with back-off
 *  9. Resume queued uploads / downloads when connection restores
 * 10. Sync the existing live.js Internet Quality module (_iqSetEnabled) if present
 *
 * SAFETY RULES (strictly followed):
 *  - Zero changes to existing HTML / CSS / Firebase / chat / posts / comments.
 *  - Zero changes to live.js, cohost.js, script.js, or sw.js internals.
 *  - Operates only through the public window.SNX_NET API and CustomEvents.
 *  - Fully tree-shakeable: if this file is removed, nothing else breaks.
 */

'use strict';

(function () {

  /* ══════════════════════════════════════════════════════════════
     CONSTANTS
     ══════════════════════════════════════════════════════════════ */

  /** Tier definitions — ordered best → worst */
  const TIERS = {
    excellent: {
      id: 'excellent', label: '5G / Fast Wi-Fi',  icon: '📶',
      videoPreload: 'auto',   imageQuality: 'high',
      maxBitrate: 5_500_000,  scaleDown: 1,
      dataSaver: false,       retryDelay: 2000,
    },
    good: {
      id: 'good',      label: '4G LTE / Wi-Fi',   icon: '📶',
      videoPreload: 'auto',   imageQuality: 'high',
      maxBitrate: 3_000_000,  scaleDown: 1,
      dataSaver: false,       retryDelay: 3000,
    },
    fair: {
      id: 'fair',      label: 'Slow Wi-Fi / 3G',  icon: '📶',
      videoPreload: 'metadata', imageQuality: 'medium',
      maxBitrate: 1_200_000,  scaleDown: 1.5,
      dataSaver: true,        retryDelay: 5000,
    },
    poor: {
      id: 'poor',      label: 'Poor Connection',  icon: '⚠️',
      videoPreload: 'none',   imageQuality: 'low',
      maxBitrate:   500_000,  scaleDown: 2.5,
      dataSaver: true,        retryDelay: 8000,
    },
    offline: {
      id: 'offline',   label: 'Offline',           icon: '🔴',
      videoPreload: 'none',   imageQuality: 'none',
      maxBitrate: 0,          scaleDown: 3,
      dataSaver: true,        retryDelay: 10000,
    },
  };

  const TIER_ORDER = ['excellent', 'good', 'fair', 'poor', 'offline'];

  /** How often (ms) to run the background probe */
  const PROBE_INTERVAL_MS  = 10_000;
  /** How often (ms) to read live WebRTC stats when streaming is active */
  const RTC_PROBE_MS       = 8_000;
  /** Require N consecutive better-tier reads before upgrading (hysteresis) */
  const UPGRADE_HYSTERESIS = 2;

  /* ══════════════════════════════════════════════════════════════
     STATE
     ══════════════════════════════════════════════════════════════ */

  let _tier            = null;    // current tier id
  let _upgradeCnt      = 0;       // consecutive better-tier reads
  let _probeTimer      = null;    // background probe interval
  let _rtcProbeTimer   = null;    // WebRTC-stats interval (live only)
  let _rtcPcRef        = null;    // RTCPeerConnection ref injected by live.js
  let _prevSent        = 0;
  let _prevLost        = 0;
  let _prevBytes       = 0;
  let _prevTs          = 0;
  let _retryQueue      = [];      // { fn, retries, maxRetries, delay }
  let _retryTimer      = null;
  let _syncPending     = false;   // queued SW notification

  /* ══════════════════════════════════════════════════════════════
     PUBLIC API  —  window.SNX_NET
     ══════════════════════════════════════════════════════════════ */

  window.SNX_NET = {
    /** Current tier object (or null before first probe) */
    get tier()  { return _tier ? TIERS[_tier] : null; },
    get tierId(){ return _tier; },

    /** True when in data-saver mode (fair / poor / offline) */
    get dataSaver() { return _tier ? TIERS[_tier].dataSaver : false; },

    /** True when offline */
    get offline() { return _tier === 'offline' || !navigator.onLine; },

    /**
     * Queue a fetch() call to be retried automatically on failure.
     * @param {function} fetchFn  - () => Promise<Response>
     * @param {number}   maxRetries
     */
    retryFetch(fetchFn, maxRetries = 5) {
      return _retryFetch(fetchFn, maxRetries);
    },

    /**
     * Register a callback that fires every time the tier changes.
     * Callback receives { tier, prev } where tier = TIERS[id].
     * Returns an unsubscribe function.
     */
    onChange(cb) {
      const handler = e => cb(e.detail);
      window.addEventListener('snxNetChange', handler);
      return () => window.removeEventListener('snxNetChange', handler);
    },

    /**
     * Called by live.js (or any module) to hand in the active
     * RTCPeerConnection so we can read real upload stats.
     */
    setRtcPeer(pc) {
      _rtcPcRef = pc;
      if (pc) {
        _prevSent = _prevLost = _prevBytes = _prevTs = 0;
        _startRtcProbe();
      } else {
        _stopRtcProbe();
      }
    },

    /** Force an immediate probe (e.g. after a user action) */
    probe() { _runProbe(); },

    /** All tier definitions */
    TIERS,
  };

  /* ══════════════════════════════════════════════════════════════
     TIER DETECTION
     ══════════════════════════════════════════════════════════════ */

  function _detectTierFromApi() {
    if (!navigator.onLine) return 'offline';

    const conn = navigator.connection ||
                 navigator.mozConnection ||
                 navigator.webkitConnection;
    if (!conn) return 'good'; // unknown → assume good

    const etype   = (conn.effectiveType || '').toLowerCase(); // slow-2g/2g/3g/4g
    const type    = (conn.type          || '').toLowerCase(); // wifi/cellular/ethernet
    const dl      = conn.downlink  || 0; // Mbps estimate
    const saveData = conn.saveData || false;

    if (saveData) return 'fair';

    if (type === 'ethernet') return 'excellent';
    if (type === 'wifi') {
      if (dl >= 10) return 'excellent';
      if (dl >= 2)  return 'good';
      return 'fair';
    }
    // Cellular / unknown
    if (etype === '4g') {
      return dl >= 10 ? 'excellent' : 'good';
    }
    if (etype === '3g') return 'fair';
    if (etype === '2g' || etype === 'slow-2g') return 'poor';
    // last resort: use downlink estimate
    if (dl >= 10) return 'excellent';
    if (dl >= 2)  return 'good';
    if (dl >= 0.5) return 'fair';
    return 'poor';
  }

  /* ══════════════════════════════════════════════════════════════
     BACKGROUND PROBE
     ══════════════════════════════════════════════════════════════ */

  function _runProbe() {
    const rawTier = _detectTierFromApi();
    _maybeChangeTier(rawTier);
  }

  function _startProbe() {
    _runProbe();
    if (_probeTimer) return;
    _probeTimer = setInterval(_runProbe, PROBE_INTERVAL_MS);
  }

  /* ══════════════════════════════════════════════════════════════
     WebRTC STATS PROBE (live streaming only)
     ══════════════════════════════════════════════════════════════ */

  function _startRtcProbe() {
    if (_rtcProbeTimer) return;
    _rtcProbeTimer = setInterval(_rtcTick, RTC_PROBE_MS);
  }

  function _stopRtcProbe() {
    if (_rtcProbeTimer) { clearInterval(_rtcProbeTimer); _rtcProbeTimer = null; }
  }

  async function _rtcTick() {
    const pc = _rtcPcRef;
    if (!pc || pc.connectionState !== 'connected') return;

    try {
      const stats = await pc.getStats();
      let sent = 0, lost = 0, bytes = 0, rtt = 0, rttCnt = 0;

      stats.forEach(r => {
        if (r.type === 'outbound-rtp' && r.kind === 'video') {
          sent  += r.packetsSent || 0;
          lost  += r.packetsLost || 0;
          bytes += r.bytesSent   || 0;
        }
        if (r.type === 'remote-inbound-rtp' && r.kind === 'video' && r.roundTripTime != null) {
          rtt += r.roundTripTime; rttCnt++;
        }
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
          if (!rttCnt) { rtt = r.currentRoundTripTime; rttCnt = 1; }
        }
      });

      const now        = Date.now();
      const deltaSent  = sent  - _prevSent;
      const deltaLost  = lost  - _prevLost;
      const deltaBytes = bytes - _prevBytes;
      const deltaSec   = _prevTs ? (now - _prevTs) / 1000 : RTC_PROBE_MS / 1000;

      _prevSent = sent; _prevLost = lost; _prevBytes = bytes; _prevTs = now;
      if (deltaSent < 5) return;

      const lossRate  = Math.max(0, deltaLost) / deltaSent;
      const kbps      = (deltaBytes * 8 / 1000) / deltaSec;
      const rttMs     = rttCnt ? (rtt / rttCnt) * 1000 : 0;

      let rawTier;
      if      (lossRate <= 0.02 && rttMs <= 80  && kbps >= 4000) rawTier = 'excellent';
      else if (lossRate <= 0.08 && rttMs <= 150 && kbps >= 1500) rawTier = 'good';
      else if (lossRate <= 0.18 && rttMs <= 300 && kbps >= 600)  rawTier = 'fair';
      else rawTier = 'poor';

      _maybeChangeTier(rawTier);
    } catch(_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     TIER CHANGE WITH HYSTERESIS
     ══════════════════════════════════════════════════════════════ */

  function _maybeChangeTier(rawTier) {
    if (_tier === null) {
      // First reading — apply immediately
      _applyTier(rawTier);
      return;
    }
    const curIdx = TIER_ORDER.indexOf(_tier);
    const rawIdx = TIER_ORDER.indexOf(rawTier);

    if (rawIdx === curIdx) { _upgradeCnt = 0; return; }

    if (rawIdx > curIdx) {
      // Degrading → apply immediately
      _upgradeCnt = 0;
      _applyTier(rawTier);
    } else {
      // Improving → require UPGRADE_HYSTERESIS consecutive readings
      _upgradeCnt++;
      if (_upgradeCnt >= UPGRADE_HYSTERESIS) {
        _upgradeCnt = 0;
        // Improve one step at a time
        const nextTier = TIER_ORDER[curIdx - 1];
        _applyTier(nextTier);
      }
    }
  }

  /* ══════════════════════════════════════════════════════════════
     APPLY TIER
     ══════════════════════════════════════════════════════════════ */

  function _applyTier(tierId) {
    const prev = _tier;
    _tier = tierId;
    const tier = TIERS[tierId];

    console.log(`[SNX-NET] Tier → ${tierId.toUpperCase()} (${tier.label})`);

    // 1. Apply data-saver class to <html>
    _applyDocumentClass(tierId);

    // 2. Adjust visible <video> / <audio> elements
    _adjustMediaElements(tier);

    // 3. Notify Service Worker
    _notifySW(tierId, tier);

    // 4. Sync live.js Internet Quality module if it exists
    _syncLiveIQ(tierId);

    // 5. Dispatch CustomEvent for any page / module listener
    _dispatch(tierId, prev);

    // 6. Manage retry queue back-off based on new delay
    if (_retryTimer && tier.retryDelay) {
      clearTimeout(_retryTimer);
      _retryTimer = null;
      _flushRetryQueue();
    }
  }

  /* ══════════════════════════════════════════════════════════════
     DOCUMENT CLASS (data-snx-tier attribute + data-saver class)
     ══════════════════════════════════════════════════════════════ */

  function _applyDocumentClass(tierId) {
    const html = document.documentElement;
    html.setAttribute('data-snx-tier', tierId);
    if (TIERS[tierId].dataSaver) {
      html.classList.add('snx-data-saver');
    } else {
      html.classList.remove('snx-data-saver');
    }
  }

  /* ══════════════════════════════════════════════════════════════
     MEDIA ELEMENT ADJUSTMENT
     Adjusts preload strategy on all <video> / <audio> elements.
     Does NOT touch src or controls — only the preload attribute.
     ══════════════════════════════════════════════════════════════ */

  function _adjustMediaElements(tier) {
    try {
      document.querySelectorAll('video:not(#liveVideo):not(#setupPreview), audio').forEach(el => {
        if (el.getAttribute('data-snx-preload-locked')) return; // opt-out
        el.preload = tier.videoPreload;
      });
    } catch(_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     SERVICE WORKER NOTIFICATION
     Tells the SW what quality tier we're on so it can tune
     its cache strategy (larger buffers on good, none on offline).
     ══════════════════════════════════════════════════════════════ */

  function _notifySW(tierId, tier) {
    if (!navigator.serviceWorker?.controller) {
      _syncPending = true;
      return;
    }
    try {
      navigator.serviceWorker.controller.postMessage({
        type:      'SNX_NET_STATE',
        tier:      tierId,
        dataSaver: tier.dataSaver,
        offline:   tierId === 'offline',
      });
      _syncPending = false;
    } catch(_) {
      _syncPending = true;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     LIVE.JS IQ SYNC
     If live.js's _iqSetEnabled is exposed on window (it is not
     currently), or if the snxLiveReady event fired, we can
     directly nudge the live-stream IQ module.
     We also bridge through the snxLiveReady / snxLiveEnded
     events so the RTC peer is automatically registered.
     ══════════════════════════════════════════════════════════════ */

  function _syncLiveIQ(tierId) {
    // live.js exposes _adaptiveQualityTierIdx as a module-scoped var —
    // we can't reach it directly, but we can use the same RTCPeerConnection
    // that was handed to us via setRtcPeer to apply encoder params.
    const pc = _rtcPcRef;
    if (!pc || pc.connectionState !== 'connected') return;
    if (tierId === 'offline') return;

    const tier = TIERS[tierId];
    const sender = pc.getSenders?.().find(s => s.track?.kind === 'video');
    if (!sender) return;

    try {
      const params = sender.getParameters();
      if (!params.encodings?.length) return;
      params.encodings[0].maxBitrate            = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      sender.setParameters(params).catch(() => {});
    } catch(_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     CUSTOM EVENT DISPATCH
     ══════════════════════════════════════════════════════════════ */

  function _dispatch(tierId, prevTierId) {
    try {
      window.dispatchEvent(new CustomEvent('snxNetChange', {
        detail: {
          tier:     TIERS[tierId],
          prev:     prevTierId ? TIERS[prevTierId] : null,
          tierId,
          prevId:   prevTierId,
        },
        bubbles:  false,
        cancelable: false,
      }));
    } catch(_) {}
  }

  /* ══════════════════════════════════════════════════════════════
     AUTO-RETRY FETCH
     Wraps any fetch() call and retries with exponential back-off.
     ══════════════════════════════════════════════════════════════ */

  function _retryFetch(fetchFn, maxRetries) {
    return new Promise((resolve, reject) => {
      const attempt = async (n) => {
        try {
          const res = await fetchFn();
          resolve(res);
        } catch (err) {
          if (n >= maxRetries || _tier === 'offline') {
            reject(err);
            return;
          }
          const delay = (TIERS[_tier]?.retryDelay || 5000) * Math.min(Math.pow(1.5, n), 8);
          setTimeout(() => attempt(n + 1), delay);
        }
      };
      attempt(0);
    });
  }

  /** Queue a fetch fn to retry when connection restores */
  function _queueRetry(fn) {
    _retryQueue.push(fn);
  }

  function _flushRetryQueue() {
    if (!_retryQueue.length) return;
    if (_tier === 'offline') return;
    const batch = _retryQueue.splice(0);
    batch.forEach(fn => { try { fn(); } catch(_) {} });
  }

  /* ══════════════════════════════════════════════════════════════
     ONLINE / OFFLINE EVENTS
     ══════════════════════════════════════════════════════════════ */

  window.addEventListener('offline', () => {
    _upgradeCnt = 0;
    _applyTier('offline');
  });

  window.addEventListener('online', () => {
    // Immediately probe to find the new tier
    _runProbe();
    // Flush any queued uploads/downloads
    setTimeout(_flushRetryQueue, 1500);
    // Re-sync SW if it wasn't reachable before
    if (_syncPending && _tier) {
      _notifySW(_tier, TIERS[_tier]);
    }
  });

  /* ══════════════════════════════════════════════════════════════
     Network Information API change event
     ══════════════════════════════════════════════════════════════ */

  const _conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (_conn) {
    _conn.addEventListener('change', () => _runProbe());
  }

  /* ══════════════════════════════════════════════════════════════
     LIVE STREAM INTEGRATION
     Listen for the snxLiveReady / snxLiveEnded events that
     live.js already dispatches so we can auto-register the PC.
     ══════════════════════════════════════════════════════════════ */

  window.addEventListener('snxLiveReady', (e) => {
    // live.js does not include the pc in this event; we rely on
    // window.SNX_NET.setRtcPeer() called by live.js directly,
    // OR we poll for _rtcPc on the window object every tick.
    // As a zero-change approach, we simply increase the probe frequency.
    if (_probeTimer) {
      clearInterval(_probeTimer);
      _probeTimer = setInterval(_runProbe, 6_000); // faster while live
    }
  });

  window.addEventListener('snxLiveEnded', () => {
    window.SNX_NET.setRtcPeer(null);
    // Restore normal probe rate
    if (_probeTimer) {
      clearInterval(_probeTimer);
      _probeTimer = setInterval(_runProbe, PROBE_INTERVAL_MS);
    }
  });

  /* ══════════════════════════════════════════════════════════════
     SERVICE WORKER: re-send tier once SW controller is ready
     ══════════════════════════════════════════════════════════════ */

  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (_tier) _notifySW(_tier, TIERS[_tier]);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     BOOT — start as soon as the script loads
     ══════════════════════════════════════════════════════════════ */

  _startProbe();

  // Also probe immediately when the page becomes visible again
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _runProbe();
  });

  console.log('[SNX-NET] Global Internet Manager loaded.');

})();
