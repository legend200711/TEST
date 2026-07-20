/**
 * Shadow Nexus Live — live.js
 *
 * Firebase split architecture:
 *
 *  MAIN Firebase (horr-a08f4) — Firestore:
 *    - Auth / user profiles
 *    - Feed posts, stories, notifications
 *    - Live chat messages  (liveRooms/{roomId}/liveMessages)
 *    - Likes counter       (liveRooms/{roomId}.likes)
 *
 *  LIVE Firebase (Shadow Nexus Live) — Realtime Database:
 *    - Room status         (liveRooms/{roomId})
 *    - WebRTC offer/answer (liveConnections/{roomId})
 *    - ICE candidates      (liveConnections/{roomId}/creatorCandidates | viewerCandidates)
 *
 *  CREATOR:
 *    1. Captures local camera + mic via getUserMedia.
 *    2. Creates liveRooms/{roomId} in RTDB (status: 'live').
 *    3. Creates RTCPeerConnection, writes SDP offer to liveConnections/{roomId} in RTDB.
 *    4. Waits for viewer answer + ICE, then streams directly via WebRTC.
 *
 *  VIEWER:
 *    1. Reads liveRooms/{roomId} from RTDB to confirm stream is live.
 *    2. Reads SDP offer from liveConnections/{roomId} in RTDB.
 *    3. Creates RTCPeerConnection, sends answer + ICE back to RTDB.
 *    4. Receives creator tracks via WebRTC ontrack.
 *
 *  Chat + Likes:
 *    Stored in Firestore sub-collections under liveRooms/{roomId}.
 */

'use strict';

/* ── Main Firebase imports (Firestore + Auth) ── */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, orderBy, limit, onSnapshot,
  serverTimestamp, increment, where, deleteField, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

/* ── Realtime Database imports (signaling + room status) ── */
import {
  getDatabase,
  ref, set, get, update, remove, push, onValue, off, onDisconnect,
  serverTimestamp as rtdbTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

/* ════════════════════════════════════════════════════
   MAIN Firebase — live.html is a standalone page.
   index.html is NOT loaded here — no conflict exists.
   ════════════════════════════════════════════════════ */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _app    = initializeApp(_CFG);
const _auth   = getAuth(_app);
const _db     = getFirestore(_app);
const _liveDB = getDatabase(_app);

/* ── WebRTC ICE config ── */
const _ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80',   username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

/* ── State ── */
let _user         = null;   // Firebase Auth user
let _userData     = null;   // Firestore user doc data
let _mode         = null;   // 'creator' | 'viewer'
let _roomId       = null;
let _feedPostId   = null;   // ID of the live post created in 'posts' collection
let _localStream  = null;
let _camOn        = true;
let _micOn        = true;
let _facingMode   = 'user';

/* ── Performance: send-lock prevents double-send on rapid taps ── */
let _chatSending  = false;
/* ── Performance: rAF handle for layout batching ── */
let _layoutRafId  = null;
/* ── Performance: track if update-check has already run this session ── */
let _updateChecked = false;

// WebRTC
let _rtcPc           = null;   // RTCPeerConnection
let _rtcSignalUnsub  = null;   // RTDB listener unsubscribe (off ref)
let _rtcSignalRef    = null;   // RTDB ref being listened to

// Auto-reconnect for viewers
let _viewerReconnectTimer   = null;
let _viewerReconnectAttempt = 0;
const _MAX_RECONNECT_ATTEMPTS = 5;

let _chatUnsub        = null;
let _viewerCountRef   = null;   // RTDB ref for viewer count listener
let _viewerCountUnsub = null;
let _roomWatchRef     = null;   // saved RTDB ref so we can call off() on it
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

/* ══════════════════════════════════════════════════
   GUEST BOX CONFIGURATION — change here to update max
   ══════════════════════════════════════════════════ */
const _MAX_GUESTS = 9;   // Maximum simultaneous guest boxes (1–9 supported)

/* ── Guest Box State ── */
let _guestLayout       = 'auto';   // current layout preference
let _guestBoxSize      = 'sm';     // 'sm' | 'md' | 'lg'
let _guestPeers        = {};       // uid → { pc, stream, cell, name }
let _guestReqUnsub     = null;     // RTDB listener for incoming requests (host)
let _guestStatusUnsub  = null;     // RTDB listener for request status (viewer)
let _layoutPanelOpen   = false;
let _guestStream       = null;     // viewer's own guest media stream
let _guestCamOn        = true;     // viewer's guest cam state
let _guestMicOn        = true;     // viewer's guest mic state
let _shownReqUids      = new Set(); // host: tracks UIDs already shown in request queue
let _viewerGuestUnsub  = null;     // viewer: RTDB listener for liveGuests presence
let _layoutSyncUnsub   = null;     // viewer/guest: RTDB listener for layout sync
let _guestPc           = null;     // viewer-in-box: their own guest RTCPeerConnection (for disconnect cleanup)
let _guestSigUnsub     = null;     // viewer-in-box: unsubscribe for host-ICE signaling onValue listener
let _hostSigUnsubs     = {};       // host: uid → onValue unsubscribe for per-guest signaling listener

/* ── Disconnect / heartbeat state ── */
let _guestHeartbeatInterval = null;  // guest: periodic presence keep-alive writer
let _hostWatchdogInterval   = null;  // host: periodic sweep for stale guest presence entries
const _HEARTBEAT_INTERVAL_MS = 8000; // every 8 s the guest writes a timestamp
const _STALE_THRESHOLD_MS    = 18000; // >18 s without heartbeat → guest is gone

/* ── DOM refs (resolved after DOMContentLoaded) ── */
let D = {};

/* ═══════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  D = {
    loading:         document.getElementById('liveLoading'),
    setup:           document.getElementById('liveSetup'),
    stage:           document.getElementById('liveStage'),
    ended:           document.getElementById('liveEndedOverlay'),
    toast:           document.getElementById('liveToast'),
    unmutePrompt:    document.getElementById('liveUnmutePrompt'),

    setupPreview:    document.getElementById('setupPreview'),
    setupPreviewOff: document.getElementById('setupPreviewOff'),
    setupTitle:      document.getElementById('setupTitleInput'),
    setupCamBtn:     document.getElementById('setupBtnCam'),
    setupMicBtn:     document.getElementById('setupBtnMic'),
    setupFlipBtn:    document.getElementById('setupBtnFlip'),
    goLiveBtn:       document.getElementById('btnGoLive'),

    liveVideo:       document.getElementById('liveVideo'),
    camOffOverlay:   document.getElementById('liveCamOffOverlay'),
    topBar:          document.getElementById('liveTopBar'),
    liveBadge:       document.getElementById('liveBadge'),
    creatorName:     document.getElementById('liveCreatorName'),
    creatorAvatar:   document.getElementById('liveCreatorAvatar'),
    viewerCount:     document.getElementById('liveViewerCount'),
    likeCount:       document.getElementById('liveLikeCount'),
    connBanner:      document.getElementById('liveConnBanner'),
    connTitle:       document.getElementById('liveConnTitle'),
    connSub:         document.getElementById('liveConnSub'),

    // Creator controls
    btnCam:          document.getElementById('btnToggleCam'),
    btnMic:          document.getElementById('btnToggleMic'),
    btnFlip:         document.getElementById('btnFlipCam'),
    btnFS:           document.getElementById('btnFullscreen'),
    btnEnd:          document.getElementById('btnEndLive'),
    btnShareCreator: document.getElementById('btnShareLiveCreator'),

    // Viewer controls
    likeBtn:         document.getElementById('btnLike'),
    likeBtnCount:    document.getElementById('likeBtnCount'),
    profileBtn:      document.getElementById('btnCreatorProfile'),
    btnShare:        document.getElementById('btnShareLive'),

    // Chat
    chatMessages:    document.getElementById('liveChatMessages'),
    chatInput:       document.getElementById('liveChatInput'),
    chatSend:        document.getElementById('liveChatSend'),

    // Ended overlay
    endedTitle:      document.getElementById('endedTitle'),
    endedSub:        document.getElementById('endedSub'),
    endedBackBtn:    document.getElementById('endedBackBtn'),

    // Guest box system
    guestGrid:           document.getElementById('guestGrid'),
    guestRequestQueue:   document.getElementById('guestRequestQueue'),
    btnRequestBox:       document.getElementById('btnRequestBox'),
    btnRequestBoxLabel:  document.getElementById('btnRequestBoxLabel'),
    btnGuestCam:         document.getElementById('btnGuestCam'),
    btnGuestCamLabel:    document.getElementById('btnGuestCamLabel'),
    btnGuestMic:         document.getElementById('btnGuestMic'),
    btnGuestMicLabel:    document.getElementById('btnGuestMicLabel'),
    btnLeaveBox:         document.getElementById('btnLeaveBox'),
    btnLayoutSettings:   document.getElementById('btnLayoutSettings'),
    layoutSettingsPanel: document.getElementById('layoutSettingsPanel'),
  };

  // Disable Go Live until Firebase auth resolves
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; }

  // Wire up static buttons
  D.setupCamBtn  && D.setupCamBtn.addEventListener('click', toggleSetupCam);
  D.setupMicBtn  && D.setupMicBtn.addEventListener('click', toggleSetupMic);
  D.setupFlipBtn && D.setupFlipBtn.addEventListener('click', flipSetupCamera);
  D.goLiveBtn    && D.goLiveBtn.addEventListener('click', startLive);

  D.btnCam  && D.btnCam.addEventListener('click',   () => toggleLiveCam());
  D.btnMic  && D.btnMic.addEventListener('click',   () => toggleLiveMic());
  D.btnFlip && D.btnFlip.addEventListener('click',  () => flipLiveCamera());
  D.btnFS   && D.btnFS.addEventListener('click',    toggleFullscreen);
  D.btnEnd  && D.btnEnd.addEventListener('click',   endLive);

  D.likeBtn          && D.likeBtn.addEventListener('click',          sendLike);
  D.btnShare         && D.btnShare.addEventListener('click',         shareLive);
  D.btnShareCreator  && D.btnShareCreator.addEventListener('click',  shareLive);
  D.chatSend  && D.chatSend.addEventListener('click',  sendChat);
  D.chatInput && D.chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  D.endedBackBtn && D.endedBackBtn.addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  document.getElementById('liveCloseBtn') &&
    document.getElementById('liveCloseBtn').addEventListener('click', onCloseBtn);

  // Guest box button wiring
  D.btnRequestBox     && D.btnRequestBox.addEventListener('click', _viewerRequestBox);
  D.btnGuestCam       && D.btnGuestCam.addEventListener('click', _toggleGuestCam);
  D.btnGuestMic       && D.btnGuestMic.addEventListener('click', _toggleGuestMic);
  D.btnLeaveBox       && D.btnLeaveBox.addEventListener('click', _guestLeaveBox);
  D.btnLayoutSettings && D.btnLayoutSettings.addEventListener('click', _toggleLayoutPanel);

  // Live Settings panel wiring (host only)
  const _btnLiveSettings = document.getElementById('btnLiveSettings');
  if (_btnLiveSettings) {
    _btnLiveSettings.addEventListener('click', () => {
      const panel = document.getElementById('liveSettingsPanel');
      if (!panel) return;
      const open = panel.style.display !== 'none';
      panel.style.display = open ? 'none' : 'block';
    });
  }
  document.getElementById('toggleAISafety') &&
    document.getElementById('toggleAISafety').addEventListener('change', e => {
      _aiSafetySetEnabled(e.target.checked);
    });
  document.getElementById('toggleShadowBot') &&
    document.getElementById('toggleShadowBot').addEventListener('change', e => {
      _shadowBotSetEnabled(e.target.checked);
    });
  document.getElementById('toggleLiveTimer') &&
    document.getElementById('toggleLiveTimer').addEventListener('change', e => {
      _liveTimerSetEnabled(e.target.checked);
    });

  document.getElementById('toggleInternetQuality') &&
    document.getElementById('toggleInternetQuality').addEventListener('change', e => {
      _iqSetEnabled(e.target.checked);
    });

  // Layout option buttons
  document.querySelectorAll('.layout-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestLayout = btn.dataset.layout;
      _applyGuestLayout();
      // Broadcast layout change to all viewers and guests
      _broadcastLayout();
    });
  });

  // Box size buttons
  document.querySelectorAll('.layout-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestBoxSize = btn.dataset.size;
      _applyGuestLayout();
      // Broadcast size change to all viewers and guests
      _broadcastLayout();
    });
  });

  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge',
                    '.layout-settings-panel','.layout-option-btn','.layout-size-btn',
                    '.live-settings-panel','#liveSettingsPanel','.lsp-row','.lsp-toggle','.lsp-slider'];
    if (ignore.some(s => e.target.closest(s))) return;
    // Close layout panel on tap-away
    if (_layoutPanelOpen) { _closeLayoutPanel(); return; }
    // Close settings panel on tap-away
    const sp = document.getElementById('liveSettingsPanel');
    if (sp && sp.style.display !== 'none') { sp.style.display = 'none'; return; }
    D.stage.classList.toggle('live-controls-hidden');
  });

  onAuthStateChanged(_auth, user => {
    if (!user) {
      _hideLoading();
      window.location.href = 'index.html';
      return;
    }
    _user = user;
    _loadUserData().then(() => {
      if (D.goLiveBtn) { D.goLiveBtn.disabled = false; }
      // ── Expose uid to gift system module ──
      window._snxGiftUserId = user.uid;
      _resolveMode();
      // ── One-time update check per session ──
      _checkForUpdate();
    });
  });
});

/* ── Load Firestore user doc ── */
async function _loadUserData() {
  try {
    const snap = await getDoc(doc(_db, 'users', _user.uid));
    _userData = snap.exists() ? snap.data() : { displayName: _user.email?.split('@')[0] || 'Guest', username: '' };
  } catch (_) {
    _userData = { displayName: _user.email?.split('@')[0] || 'Guest', username: '' };
  }
}

/* ── Decide mode from URL hash ── */
async function _resolveMode() {
  const hash = location.hash;
  localStorage.removeItem('snx_live_intent');

  if (hash.startsWith('#watch=')) {
    _roomId = hash.slice(7);   // roomId is plain [a-zA-Z0-9_] — no decoding needed
    _mode   = 'viewer';
    document.body.classList.add('is-viewer');
    await _startViewer();
  } else {
    _mode = 'creator';
    document.body.classList.add('is-creator');
    await _startCreatorSetup();
  }
}

/* ═══════════════════════════════════════════════════
   CREATOR SETUP
   ═══════════════════════════════════════════════════ */
async function _startCreatorSetup() {
  _hideLoading();
  if (D.setup) D.setup.style.display = 'block';

  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      // Default: 720p 30fps — safe for 5G/4G (adaptive quality shifts tiers automatically)
      video: {
        facingMode:  _facingMode,
        width:       { ideal: 1280 },
        height:      { ideal: 720  },
        frameRate:   { ideal: 30, max: 30 },
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (D.setupPreview) {
      D.setupPreview.srcObject = _localStream;
      D.setupPreview.play().catch(() => {});
    }
    _updateSetupPreviewState(true);
  } catch (err) {
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      _camOn = false;
      _updateSetupPreviewState(false);
      toast('Camera is audio only');
    } catch (e) {
      _showSetupPermError('Camera & mic access denied. Allow Camera + Microphone in your browser settings, then refresh.');
    }
  }
}

function _showSetupPermError(msg) {
  toast(msg);
  const existing = document.getElementById('_snxSetupPermError');
  if (existing) { existing.textContent = msg; return; }
  const banner = document.createElement('div');
  banner.id = '_snxSetupPermError';
  banner.style.cssText = [
    'width:100%', 'background:rgba(180,0,30,0.18)', 'border:1px solid rgba(255,50,70,0.55)',
    'border-radius:10px', 'padding:12px 14px', 'font-size:13px', 'color:#ff8899',
    'line-height:1.5', 'text-align:center',
  ].join(';');
  banner.textContent = msg;
  const input = document.getElementById('setupTitleInput');
  if (input && input.parentNode) {
    input.parentNode.insertBefore(banner, input);
  } else if (D.goLiveBtn && D.goLiveBtn.parentNode) {
    D.goLiveBtn.parentNode.insertBefore(banner, D.goLiveBtn);
  }
  if (D.goLiveBtn) {
    D.goLiveBtn.disabled = true;
    D.goLiveBtn.title = 'Camera & mic access required';
  }
}

function _updateSetupPreviewState(hasVideo) {
  if (!D.setupPreviewOff) return;
  D.setupPreviewOff.classList.toggle('visible', !hasVideo);
  if (D.setupPreview) D.setupPreview.style.display = hasVideo ? 'block' : 'none';
}

function toggleSetupCam() {
  _camOn = !_camOn;
  if (_localStream) {
    _localStream.getVideoTracks().forEach(t => t.enabled = _camOn);
  }
  _updateSetupPreviewState(_camOn && !!(_localStream?.getVideoTracks().length));
  if (D.setupCamBtn) {
    D.setupCamBtn.querySelector('.setup-ctrl-icon').textContent = '📷';
    D.setupCamBtn.classList.toggle('off', !_camOn);
    D.setupCamBtn.querySelector('span:last-child').textContent  = _camOn ? 'Cam' : 'Cam Off';
  }
}

function toggleSetupMic() {
  _micOn = !_micOn;
  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  }
  if (D.setupMicBtn) {
    D.setupMicBtn.querySelector('.setup-ctrl-icon').textContent = _micOn ? '🎤' : '🔇';
    D.setupMicBtn.classList.toggle('off', !_micOn);
    D.setupMicBtn.querySelector('span:last-child').textContent  = _micOn ? 'Mic' : 'Mic Off';
  }
}

async function flipSetupCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  if (_localStream) {
    _localStream.getTracks().forEach(t => t.stop());
  }
  try {
    _localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: _micOn ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    if (D.setupPreview) {
      D.setupPreview.srcObject = _localStream;
      D.setupPreview.play().catch(() => {});
    }
    _camOn = true;
    _updateSetupPreviewState(true);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   START LIVE (creator)
   ═══════════════════════════════════════════════════ */
async function startLive() {
  if (!_user) {
    toast('Please wait…');
    return;
  }
  if (_user.isAnonymous) {
    toast('Sign in to go live.');
    return;
  }
  if (!_localStream || !_localStream.getTracks().length) {
    toast('Camera or mic not available. Check permissions and refresh.');
    return;
  }

  // ── Kill any previous stuck live session for this user ──
  try {
    const userSnap = await getDoc(doc(_db, 'users', _user.uid));
    const prevRoomId = userSnap.exists() ? userSnap.data().liveRoomId : null;
    if (prevRoomId) {
      await update(ref(_liveDB, `liveRooms/${prevRoomId}`), { status: 'ended', isLive: false, endedAt: Date.now() });
      await remove(ref(_liveDB, `liveConnections/${prevRoomId}`));
      await updateDoc(doc(_db, 'users', _user.uid), { isLive: deleteField(), liveRoomId: deleteField() });
    }
    // Always delete the uid-keyed Firestore liveRooms doc (and legacy roomId-keyed one)
    try { await deleteDoc(doc(_db, 'liveRooms', _user.uid)); } catch (_) {}
    if (prevRoomId) {
      try { await deleteDoc(doc(_db, 'liveRooms', prevRoomId)); } catch (_) {}
    }
    // Also clean up any orphaned feed posts with type='live' for this user
    try {
      const orphanQ = query(
        collection(_db, 'posts'),
        where('uid', '==', _user.uid),
        where('type', '==', 'live')
      );
      const orphanSnap = await getDocs(orphanQ);
      orphanSnap.forEach(async d => { try { await deleteDoc(d.ref); } catch(_) {} });
    } catch (_) {}
  } catch (_) {}

  const titleVal = (D.setupTitle?.value || '').trim();
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; D.goLiveBtn.textContent = 'Going Live…'; }

  // Sanitize uid — strip any chars forbidden in RTDB keys (. # $ / [ ])
  const _safeUid = _user.uid.replace(/[.#$/\[\]]/g, '_');
  _roomId = `${_safeUid}_${Date.now().toString(36)}`;

  const creatorData = {
    roomId:       _roomId,
    hostId:       _user.uid,
    hostName:     _userData.displayName || _user.email?.split('@')[0] || 'Creator',
    hostUsername: _userData.username || '',
    hostAvatar:   _userData.avatar || _userData.profilePicture || '',
    title:        titleVal || 'Shadow Nexus LIVE',
    status:       'live',
    isLive:       true,
    viewers:      0,
    likes:        0,
    createdAt:    Date.now(),
  };

  /* ── Write room to LIVE Realtime Database ── */
  try {
    await set(ref(_liveDB, `liveRooms/${_roomId}`), creatorData);
  } catch (e) {
    toast('Could not start live. Please try again.');
    if (D.goLiveBtn) { D.goLiveBtn.disabled = false; D.goLiveBtn.textContent = 'Start Live'; }
    return;
  }

  /* ── Mirror room to Firestore so Live Hub can query it.
        Keyed by uid so only ONE doc per user ever exists —
        reconnecting simply overwrites the previous entry.   ── */
  try {
    await setDoc(doc(_db, 'liveRooms', _user.uid), {
      ...creatorData,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  } catch (_) {}

  /* ── Guard: prevent accidental cleanup if page unloads during live ── */
  _creatorEndedFlag = false;
  window.addEventListener('beforeunload', _creatorBeforeUnload);
  window.addEventListener('pagehide',     _creatorBeforeUnload);

  if (D.setup) D.setup.style.display = 'none';
  _showStage();
  _attachLocalVideoToStage();
  _populateCreatorInfo(creatorData);

  await _startCreatorWebRTC();

  _subscribeChat();
  _subscribeViewerCount();
  _showCreatorShareBar();

  // ── Start listening for guest box requests ──
  _hostListenForGuestRequests();

  // ── Attach resize observer so guest grid re-layouts on any screen change ──
  _attachGuestGridResizeObserver();

  // ── Publish host's own presence to liveGuests (viewers see cam/mic status) ──
  try {
    const hostGuestRef = ref(_liveDB, `liveGuests/${_roomId}/_host_`);
    await set(hostGuestRef, {
      uid:      _user.uid,
      name:     creatorData.hostName,
      avatar:   creatorData.hostAvatar,
      isHost:   true,
      camOn:    _camOn,
      micOn:    _micOn,
      joinedAt: Date.now(),
      hb:       Date.now(),
    });
    // If the host's page crashes / network drops, remove the whole liveGuests room node
    try { onDisconnect(ref(_liveDB, `liveGuests/${_roomId}`)).remove(); } catch(_) {}
  } catch (_) {}

  toast('🔴 You are LIVE!');

  // ── Inform gift system of live context (creator) ──
  if (typeof window._snxGiftSetContext === 'function') {
    window._snxGiftSetContext(
      _roomId,
      _user.uid,
      _userData.displayName || _user.email?.split('@')[0] || 'Creator'
    );
  }

  // ── Read feature flags (co-host enable/disable) ──
  try {
    const cfgSnap = await getDoc(doc(_db, 'siteSettings', 'config'));
    window._snxCoHostEnabled = cfgSnap.exists()
      ? cfgSnap.data().coHostEnabled !== false
      : true;
  } catch (_) {
    window._snxCoHostEnabled = true; // default ON if unavailable
  }

  // ── Notify add-on modules (co-host, etc.) that live has started ──
  window.dispatchEvent(new CustomEvent('snxLiveReady', { detail: {
    db: _db, liveDB: _liveDB, auth: _auth,
    user: _user, userData: _userData,
    roomId: _roomId, isHost: true,
    coHostEnabled: window._snxCoHostEnabled,
  }}));

  // ── Start optional systems (respects their individual ON/OFF state) ──
  _liveTimerOnLiveStart();
  _shadowBotOnLiveStart();
  _aiSafetyOnLiveStart();
  _iqOnLiveStart();

  // ── Non-critical side-work ──
  try {
    await updateDoc(doc(_db, 'users', _user.uid), { isLive: true, liveRoomId: _roomId });
  } catch (_) {}

  // ── RTDB users/{uid} presence: mark as online + live in one atomic write ──
  try {
    const _uPresRef = ref(_liveDB, 'users/' + _user.uid);
    await update(_uPresRef, { online: true, live: true, lastSeen: rtdbTimestamp() });
    // If the page crashes or network drops, reset live to false (keep online true so they
    // appear as online once they reconnect — the login flow sets online properly on reconnect).
    onDisconnect(_uPresRef).update({ live: false, lastSeen: rtdbTimestamp() });
  } catch (_) {}
  // _createLiveFeedPost intentionally omitted — live sessions must not create
  // feed posts; they appear only in the story bar and Live Hub.
  _createLiveStory(creatorData);
  _notifyFollowersLive(creatorData);
}

function _attachLocalVideoToStage() {
  if (!D.liveVideo || !_localStream) return;
  D.liveVideo.srcObject = _localStream;
  D.liveVideo.play().catch(() => {});
  D.camOffOverlay && D.camOffOverlay.classList.toggle('visible', !_camOn);
}

/* ── Share bar: big visible URL strip shown on the live stage ──
   Creator sees their exact watch link immediately so they can copy
   and send it without going through the share modal.              */
function _showCreatorShareBar() {
  const old = document.getElementById('_snxCreatorShareBar');
  if (old) old.remove();

  const url = _buildLiveUrl();

  const bar = document.createElement('div');
  bar.id = '_snxCreatorShareBar';
  bar.style.cssText = [
    'position:absolute', 'top:64px', 'left:50%',
    'transform:translateX(-50%)',
    'z-index:50', 'max-width:calc(100vw - 24px)', 'width:420px',
    'background:rgba(0,10,30,0.93)',
    'border:1.5px solid rgba(0,174,239,0.7)',
    'border-radius:12px', 'padding:10px 14px',
    'display:flex', 'align-items:center', 'gap:10px',
    'backdrop-filter:blur(8px)',
  ].join(';');

  bar.innerHTML = `
    <div style="flex:1;min-width:0;">
      <div style="font-size:10px;color:#6a90b8;margin-bottom:3px;letter-spacing:.5px;text-transform:uppercase;">Your watch link — share this!</div>
      <div id="_snxShareUrlText" style="font-size:12px;color:#00AEEF;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;">${url}</div>
    </div>
    <button id="_snxCopyShareUrl" style="
      flex-shrink:0;padding:8px 14px;border-radius:8px;
      background:rgba(0,174,239,0.2);border:1px solid rgba(0,174,239,0.6);
      color:#00AEEF;font-size:12px;font-weight:700;cursor:pointer;
      white-space:nowrap;
    ">📋 Copy</button>
    <button id="_snxDismissShareBar" style="
      flex-shrink:0;width:28px;height:28px;border-radius:50%;
      background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);
      color:#aaa;font-size:14px;cursor:pointer;
    ">✕</button>
  `;

  // Copy button
  bar.querySelector('#_snxCopyShareUrl').addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url)
        .then(() => toast('✅ Link copied! Send it to your viewers.'))
        .catch(() => window.prompt('Copy your watch link:', url));
    } else {
      window.prompt('Copy your watch link:', url);
    }
  });

  // Dismiss
  bar.querySelector('#_snxDismissShareBar').addEventListener('click', () => bar.remove());

  // Auto-dismiss after 60 s
  setTimeout(() => bar.remove(), 60000);

  const stage = document.getElementById('liveStage');
  const videoWrap = stage?.querySelector('.live-video-wrap');
  (videoWrap || stage || document.body).appendChild(bar);
}

function _populateCreatorInfo(data) {
  if (D.creatorName)   D.creatorName.textContent  = data.hostName;
  if (D.creatorAvatar) {
    if (data.hostAvatar) {
      D.creatorAvatar.style.backgroundImage = `url('${data.hostAvatar}')`;
      D.creatorAvatar.textContent = '';
    } else {
      D.creatorAvatar.textContent = (data.hostName || '?')[0].toUpperCase();
    }
  }
}

/* ── Subscribe to viewer count + likes from LIVE RTDB
      Also mirrors viewer count to Firestore liveRooms doc so the Live Hub
      stays in real-time sync without an extra Firestore write on every tick. ── */
function _subscribeViewerCount() {
  _viewerCountRef = ref(_liveDB, `liveRooms/${_roomId}`);
  let _lastMirroredViewers = -1;
  _viewerCountUnsub = onValue(_viewerCountRef, snap => {
    const d = snap.val() || {};
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + (d.viewers || 0);
    if (D.likeCount)   D.likeCount.textContent   = '❤️ ' + (d.likes   || 0);
    // Mirror viewer count to Firestore (uid-keyed doc) so Live Hub cards update in real time
    const v = d.viewers || 0;
    if (v !== _lastMirroredViewers && _roomId && _user) {
      _lastMirroredViewers = v;
      updateDoc(doc(_db, 'liveRooms', _user.uid), { viewers: v }).catch(() => {});
    }
  });
}

/* ═══════════════════════════════════════════════════
   CREATOR CONTROLS — Cam / Mic / Flip / End
   ═══════════════════════════════════════════════════ */
function toggleLiveCam() {
  _camOn = !_camOn;
  if (_localStream) _localStream.getVideoTracks().forEach(t => t.enabled = _camOn);
  if (D.btnCam) { D.btnCam.textContent = _camOn ? '📷' : '🚫'; D.btnCam.classList.toggle('off', !_camOn); }
  if (D.camOffOverlay) D.camOffOverlay.classList.toggle('visible', !_camOn);
  // Broadcast host cam state to viewers
  if (_roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/_host_`), { camOn: _camOn }); } catch(_) {}
}

function toggleLiveMic() {
  _micOn = !_micOn;
  if (_localStream) _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  if (D.btnMic) { D.btnMic.textContent = _micOn ? '🎤' : '🔇'; D.btnMic.classList.toggle('off', !_micOn); }
  toast(_micOn ? 'Mic on' : 'Mic muted');
  // Broadcast host mic state to viewers
  if (_roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/_host_`), { micOn: _micOn }); } catch(_) {}
}

async function flipLiveCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
      audio: _micOn ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
    });
    if (oldStream) oldStream.getTracks().forEach(t => t.stop());
    _localStream = newStream;
    if (D.liveVideo) {
      D.liveVideo.srcObject = newStream;
      D.liveVideo.play().catch(() => {});
    }
    if (_rtcPc && newStream.getVideoTracks()[0]) {
      const newVideoTrack = newStream.getVideoTracks()[0];
      const sender = _rtcPc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack).catch(() => {});
      }
    }
  } catch (e) {
    toast('Could not flip camera.');
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

/* ── Creator page unload guard — only fires if endLive() was NOT called ── */
function _creatorBeforeUnload() {
  if (_creatorEndedFlag || !_roomId) return;
  // Can't do async work in beforeunload; onDisconnect handles the RTDB cleanup.
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }
}

async function endLive() {
  if (_creatorEndedFlag) return;   // prevent double-call
  _creatorEndedFlag = true;

  // Cancel the onDisconnect trigger — we are ending cleanly ourselves
  if (_roomId) {
    try { await onDisconnect(ref(_liveDB, `liveRooms/${_roomId}`)).cancel(); } catch (_) {}
  }

  window.removeEventListener('beforeunload', _creatorBeforeUnload);
  window.removeEventListener('pagehide',     _creatorBeforeUnload);

  // Stop adaptive quality monitor
  _stopAdaptiveQuality();

  // Close all guest peer connections
  _teardownAllGuestPeers();
  if (_guestReqUnsub) { try { _guestReqUnsub(); } catch(_){} _guestReqUnsub = null; }

  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountRef && _viewerCountUnsub) { off(_viewerCountRef); _viewerCountRef = null; _viewerCountUnsub = null; }

  /* ── Remove WebRTC signaling from LIVE RTDB ── */
  if (_roomId) {
    try { await remove(ref(_liveDB, `liveConnections/${_roomId}`)); } catch (_) {}
  }

  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }

  /* ── Mark room as ended in LIVE RTDB ── */
  const _endedRoomId = _roomId;
  try {
    await update(ref(_liveDB, `liveRooms/${_endedRoomId}`), {
      status:  'ended',
      isLive:  false,
      endedAt: Date.now(),
    });
  } catch (_) {}

  /* ── Clear live status from main Firestore user doc ── */
  try {
    await updateDoc(doc(_db, 'users', _user.uid), {
      isLive:     deleteField(),
      liveRoomId: deleteField(),
    });
  } catch (_) {}

  // ── RTDB users/{uid} presence: mark live ended, keep online = true ──
  try {
    // Cancel the onDisconnect we registered at startLive — we are ending cleanly
    await onDisconnect(ref(_liveDB, 'users/' + _user.uid)).cancel();
  } catch (_) {}
  try {
    await update(ref(_liveDB, 'users/' + _user.uid), { live: false, online: true, lastSeen: rtdbTimestamp() });
  } catch (_) {}

  /* ── Delete live feed post from main Firestore (safety net for old data) ── */
  if (_feedPostId) {
    try { await deleteDoc(doc(_db, 'posts', _feedPostId)); } catch (_) {}
    _feedPostId = null;
  }

  /* ── Mark share posts as ended in main Firestore ── */
  try {
    const shareQ = query(
      collection(_db, 'posts'),
      where('liveRoomId', '==', _endedRoomId),
      where('type', '==', 'live_share')
    );
    const shareSnap = await getDocs(shareQ);
    shareSnap.forEach(async shareDoc => {
      try { await updateDoc(shareDoc.ref, { isLive: false }); } catch (_) {}
    });
  } catch (_) {}

  /* ── Delete Firestore liveRooms doc (keyed by uid) so it disappears from Live Hub ── */
  try { await deleteDoc(doc(_db, 'liveRooms', _user.uid)); } catch (_) {}
  /* ── Also delete by roomId in case old data used roomId as key ── */
  try { await deleteDoc(doc(_db, 'liveRooms', _endedRoomId)); } catch (_) {}

  /* ── Schedule RTDB room deletion after 5 min (cleans up ended marker) ── */
  setTimeout(async () => {
    try { await remove(ref(_liveDB, `liveRooms/${_endedRoomId}`)); } catch (_) {}
  }, 5 * 60 * 1000);

  _deleteLiveStory();

  // ── Stop optional systems ──
  _liveTimerOnLiveEnd();
  _shadowBotOnLiveEnd();
  _aiSafetyOnLiveEnd();
  _iqOnLiveEnd();

  // ── Co-host cleanup (no-op if cohost.js is not loaded) ──
  if (typeof window._cohostCleanup === 'function') { try { window._cohostCleanup(); } catch(_){} }

  _showEndedOverlay(true);
}

/* ═══════════════════════════════════════════════════
   LIVE FEED POST — Firestore 'posts' collection
   ═══════════════════════════════════════════════════ */
async function _createLiveFeedPost(creatorData) {
  if (!_user || !_roomId) return;
  try {
    const postRef = await addDoc(collection(_db, 'posts'), {
      type:          'live',
      uid:           _user.uid,
      authorUid:     _user.uid,
      authorName:    creatorData.hostName     || '',
      authorHandle:  creatorData.hostUsername || '',
      authorAvatar:  creatorData.hostAvatar   || '',
      liveRoomId:    _roomId,
      isLive:        true,
      title:         creatorData.title        || 'Shadow Nexus LIVE',
      text:          (creatorData.hostName || 'Someone') + ' is Live now 🔴',
      timestamp:     Date.now(),
      createdAt:     Date.now(),
      likes:         0,
      comments:      [],
    });
    _feedPostId = postRef.id;
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   LIVE STORY — Firestore 'stories' collection
   ═══════════════════════════════════════════════════ */
function _liveStoryId() {
  return `live_${_user.uid}`;
}

async function _createLiveStory(creatorData) {
  if (!_user || !_roomId) return;
  const now = Date.now();
  const expiresAt = now + 12 * 60 * 60 * 1000;
  try {
    await setDoc(doc(_db, 'stories', _liveStoryId()), {
      uid:          _user.uid,
      authorName:   creatorData.hostName     || '',
      authorHandle: creatorData.hostUsername || '',
      authorAvatar: creatorData.hostAvatar   || '',
      type:         'live',
      liveRoomId:   _roomId,
      title:        creatorData.title        || 'Shadow Nexus LIVE',
      createdAt:    now,
      expiresAt,
    });
  } catch (_) {}
}

async function _deleteLiveStory() {
  if (!_user) return;
  try {
    await deleteDoc(doc(_db, 'stories', _liveStoryId()));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   FOLLOWER LIVE NOTIFICATIONS — Firestore 'notifications'
   ═══════════════════════════════════════════════════ */
async function _notifyFollowersLive(creatorData) {
  if (!_user) return;
  try {
    const snap = await getDoc(doc(_db, 'users', _user.uid));
    if (!snap.exists()) return;
    const followers = snap.data().followers || [];
    if (!followers.length) return;

    const notif = {
      id:         `live_${_user.uid}_${Date.now()}`,
      type:       'live',
      fromUid:    _user.uid,
      fromName:   creatorData.hostName    || '',
      fromAvatar: creatorData.hostAvatar  || '',
      roomId:     _roomId,
      roomTitle:  creatorData.title       || 'Shadow Nexus LIVE',
      title:      '🔴 ' + (creatorData.hostName || 'Someone') + ' is Live',
      body:       `${creatorData.hostName || 'Someone'} is live: ${creatorData.title || 'Shadow Nexus LIVE'}`,
      url:        'live.html#watch=' + _roomId,
      ts:         Date.now(),
      read:       false,
    };

    const batches = followers.map(async fUid => {
      try { await addDoc(collection(_db, 'notifications', fUid, 'items'), notif); } catch (_) {}
      try { await updateDoc(doc(_db, 'users', fUid), { pushQueue: arrayUnion(notif) }); } catch (_) {}
    });

    await Promise.allSettled(batches);
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   VIEWER — join a live stream
   ═══════════════════════════════════════════════════ */
async function _startViewer() {
  let roomData = null;

  const _MAX_RETRIES = 8;
  const _RETRY_MS    = 2000;

  for (let attempt = 0; attempt < _MAX_RETRIES; attempt++) {
    try {
      const snap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
      if (snap.exists() && snap.val().status === 'live') {
        roomData = snap.val();
        break;
      }
      if (snap.exists() && snap.val().status === 'ended') {
        _hideLoading();
        _showEndedOverlay(false, 'Stream ended', 'This live stream has already ended.');
        return;
      }
    } catch (e) {
      _hideLoading();
      toast('Could not connect. Please try again.');
      return;
    }
    if (attempt === 0) {
      _hideLoading();
      _showStage();
      _showConnBanner('Waiting for stream…', '');
    }
    await new Promise(r => setTimeout(r, _RETRY_MS));
  }

  if (!roomData) {
    _showEndedOverlay(false, 'Stream ended', 'This live stream has ended or does not exist.');
    return;
  }

  _hideLoading();
  _showStage();
  _hideConnBanner();
  _populateCreatorInfo(roomData);
  _setupViewerControls(roomData);
  _subscribeChat();

  // ── Inform gift system of live context (viewer) ──
  if (typeof window._snxGiftSetContext === 'function') {
    window._snxGiftSetContext(
      _roomId,
      roomData.hostId,
      roomData.hostName || ''
    );
  }

  // ── Read feature flags for add-on modules (viewer path) ──
  try {
    if (window._snxCoHostEnabled === undefined) {
      const cfgSnap = await getDoc(doc(_db, 'siteSettings', 'config'));
      window._snxCoHostEnabled = cfgSnap.exists()
        ? cfgSnap.data().coHostEnabled !== false
        : true;
    }
  } catch (_) {
    window._snxCoHostEnabled = true;
  }

  // ── Notify add-on modules that viewer has joined ──
  window.dispatchEvent(new CustomEvent('snxLiveReady', { detail: {
    db: _db, liveDB: _liveDB, auth: _auth,
    user: _user, userData: _userData,
    roomId: _roomId, isHost: false,
    coHostEnabled: window._snxCoHostEnabled,
  }}));

  /* ── Subscribe to live guest presence (shows guest boxes to viewers) ── */
  _startViewerGuestGrid();

  /* ── Subscribe to host layout changes so everyone sees the same layout ── */
  _startLayoutSync();

  /* ── Attach resize observer so guest grid re-layouts on any screen change ── */
  _attachGuestGridResizeObserver();

  /* ── Increment viewer count in LIVE RTDB (fire-and-forget, non-blocking) ── */
  (async () => {
    try {
      const viewersRef = ref(_liveDB, `liveRooms/${_roomId}/viewers`);
      const currentSnap = await get(viewersRef);
      await set(viewersRef, (currentSnap.val() || 0) + 1);
    } catch (_) {}
  })();

  /* ── Watch for stream ending + viewer/like counts via LIVE RTDB ──
     _startLayoutSync() already subscribes to liveRooms/{roomId}; we
     reuse that same path here to avoid a second concurrent listener. ── */
  let _roomWatchSeenFirst = false;
  _roomWatchRef = ref(_liveDB, `liveRooms/${_roomId}`);
  onValue(_roomWatchRef, snap => {
    const d = snap.val() || {};
    // Update counts (partial DOM update — only if value changed)
    const vText = '👁 ' + (d.viewers || 0);
    const lText = '❤️ ' + (d.likes   || 0);
    if (D.viewerCount && D.viewerCount.textContent !== vText) D.viewerCount.textContent = vText;
    if (D.likeCount   && D.likeCount.textContent   !== lText) D.likeCount.textContent   = lText;
    // Sync layout changes from host
    if (d.guestLayout  && d.guestLayout  !== _guestLayout)  { _guestLayout  = d.guestLayout;  _applyGuestLayout(); }
    if (d.guestBoxSize && d.guestBoxSize !== _guestBoxSize)  { _guestBoxSize = d.guestBoxSize; _applyGuestLayout(); }
    if (!_roomWatchSeenFirst) {
      _roomWatchSeenFirst = true;
      return;
    }
    if (!snap.exists() || d.status === 'ended') {
      _showEndedOverlay(false, 'Stream ended', `${roomData.hostName} has ended the live stream.`);
    }
  });

  await _startViewerWebRTC(roomData);

  window.addEventListener('beforeunload', _viewerLeave);
  window.addEventListener('pagehide',     _viewerLeave);

  // ── Auto-reconnect on network restore ──
  // If the device was offline briefly and comes back, try reconnecting immediately
  // instead of waiting for the exponential back-off timer.
  window.addEventListener('online', () => {
    if (_viewerLeftFlag) return;
    const state = _rtcPc?.connectionState;
    if (state === 'disconnected' || state === 'failed' || !_rtcPc) {
      // Reset attempt counter so we get a fresh fast reconnect
      _viewerReconnectAttempt = 0;
      if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
      _scheduleViewerReconnect(roomData);
    }
  }, { once: false });
}

async function _viewerLeave() {
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  // Cancel any pending reconnect
  if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }

  // If viewer was in a guest box, clean up that state first
  if (_guestStream || _guestPc) {
    // Direct cleanup without confirmation (page is unloading)
    if (_guestPc) { try { _guestPc.close(); } catch(_){} _guestPc = null; }
    if (_user && _roomId) {
      try { remove(ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`)); }      catch(_) {}
      try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}`)); }  catch(_) {}
    }
    if (_guestStream) { try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_){} _guestStream = null; }
  }

  // Tear down viewer guest grid listener
  if (_viewerGuestUnsub) {
    try { _viewerGuestUnsub(); } catch(_) {}
    _viewerGuestUnsub = null;
  }

  // Tear down layout sync listener
  if (_layoutSyncUnsub) {
    try { _layoutSyncUnsub(); } catch(_) {}
    _layoutSyncUnsub = null;
  }

  // Tear down room-watch listener
  if (_roomWatchRef) { try { off(_roomWatchRef); } catch(_) {} _roomWatchRef = null; }

  // Clean up any pending box request (RTDB + Firestore)
  if (_user && _roomId) {
    try { await remove(ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`)); } catch(_) {}
    const requestId = `${_roomId}_${_user.uid}`;
    try { await deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}
  }
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} _guestStatusUnsub = null; }

  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }

  /* ── Decrement viewer count in LIVE RTDB ── */
  try {
    const viewersRef = ref(_liveDB, `liveRooms/${_roomId}/viewers`);
    const snap = await get(viewersRef);
    const cur = snap.val() || 0;
    await set(viewersRef, Math.max(0, cur - 1));
  } catch (_) {}
}

function _setupViewerControls(roomData) {
  if (D.profileBtn) {
    D.profileBtn.style.display = 'flex';
    D.profileBtn.onclick = () => {
      window.open('index.html#profile=' + roomData.hostId, '_blank');
    };
  }
}

/* ═══════════════════════════════════════════════════
   WebRTC — CREATOR
   Uses LIVE Realtime Database for signaling.
   ═══════════════════════════════════════════════════ */
async function _startCreatorWebRTC() {
  if (!_localStream) {
    toast('Camera or mic not available.');
    return;
  }

  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);

  // Add tracks with explicit sendonly direction
  _localStream.getTracks().forEach(track => {
    _rtcPc.addTrack(track, _localStream);
  });

  // Ensure transceivers are sendonly and set initial encoding to 720p / 3000 kbps CBR
  _rtcPc.getTransceivers().forEach(tc => {
    tc.direction = 'sendonly';
    if (tc.sender && tc.sender.track && tc.sender.track.kind === 'video') {
      const params = tc.sender.getParameters();
      if (!params.encodings || !params.encodings.length) {
        params.encodings = [{}];
      }
      // Default tier: MED — 720p, 3000 kbps, 30fps
      params.encodings[0].maxBitrate           = 3_000_000;
      params.encodings[0].maxFramerate         = 30;
      params.encodings[0].scaleResolutionDownBy = 1;
      tc.sender.setParameters(params).catch(() => {});
    }
  });

  _rtcPc.onconnectionstatechange = () => {
    if (_rtcPc.connectionState === 'connected') {
      // Start adaptive quality monitoring (adjust bitrate based on network conditions)
      _startAdaptiveQuality(_rtcPc);
    }
  };

  const connRef = ref(_liveDB, `liveConnections/${_roomId}`);
  const _pendingCandidates = [];
  let   _offerWritten      = false;

  // Wire BEFORE createOffer so no early candidates are dropped
  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_offerWritten) {
      _pendingCandidates.push(e.candidate.toJSON());
      return;
    }
    try { await push(ref(_liveDB, `liveConnections/${_roomId}/creatorCandidates`), e.candidate.toJSON()); }
    catch (_) {}
  };

  // createOffer with a 10-second timeout
  let offer;
  try {
    offer = await Promise.race([
      _rtcPc.createOffer(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('createOffer timed out after 10s')), 10000)),
    ]);
  } catch (e) {
    toast('Could not start stream. Please try again.');
    return;
  }

  try {
    await _rtcPc.setLocalDescription(offer);
  } catch (e) {
    toast('Could not start stream. Please try again.');
    return;
  }

  // Write offer to RTDB
  try {
    await set(connRef, {
      offer:             { type: offer.type, sdp: offer.sdp },
      creatorCandidates: {},
      viewerCandidates:  {},
    });
    _offerWritten = true;
  } catch (e) {
    toast('Could not start live. Please try again.');
    return;
  }

  // Register onDisconnect AFTER offer is confirmed in RTDB
  try {
    await onDisconnect(ref(_liveDB, `liveRooms/${_roomId}`)).update({
      status: 'ended', isLive: false, endedAt: Date.now(),
    });
  } catch (_) {}

  // Flush buffered candidates
  if (_pendingCandidates.length) {
    for (const cand of _pendingCandidates) {
      try { await push(ref(_liveDB, `liveConnections/${_roomId}/creatorCandidates`), cand); } catch (_) {}
    }
    _pendingCandidates.length = 0;
  }

  // Watch for viewer answer + ICE
  let _appliedViewerCandKeys = new Set();
  _rtcSignalRef   = connRef;
  _rtcSignalUnsub = onValue(connRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();

    if (d.answer && _rtcPc.remoteDescription === null) {
      try {
        await _rtcPc.setRemoteDescription(new RTCSessionDescription(d.answer));
      } catch (_) {}
    }

    if (_rtcPc.remoteDescription && d.viewerCandidates) {
      for (const [key, cand] of Object.entries(d.viewerCandidates)) {
        if (_appliedViewerCandKeys.has(key)) continue;
        _appliedViewerCandKeys.add(key);
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });

  toast('Live now');
}

/* ═══════════════════════════════════════════════════
   WebRTC — VIEWER
   Uses LIVE Realtime Database for signaling.
   ═══════════════════════════════════════════════════ */
async function _startViewerWebRTC(roomData) {
  _showConnBanner('Waiting for stream…', '');

  const connRef = ref(_liveDB, `liveConnections/${_roomId}`);

  /* ── Read offer from LIVE RTDB ── */
  let connSnap;
  try {
    connSnap = await get(connRef);
  } catch (e) {
    _showConnBanner('Waiting for stream…', '');
    return;
  }

  if (!connSnap.exists() || !connSnap.val().offer) {
    _showConnBanner('Waiting for stream…', '');
    const offerWaitRef = ref(_liveDB, `liveConnections/${_roomId}`);
    let _offerWaitListener;
    _offerWaitListener = onValue(offerWaitRef, async snap => {
      if (!snap.exists() || !snap.val().offer) return;
      off(offerWaitRef, _offerWaitListener);
      _startViewerWebRTC(roomData);
    });
    return;
  }

  if (_rtcPc) { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);

  _rtcPc.ontrack = (e) => {
    if (!D.liveVideo) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    D.liveVideo.srcObject = stream;
    D.liveVideo.muted = true;
    // Buffer / mobile optimisation: low-latency mode where supported
    if ('playsInline' in D.liveVideo) D.liveVideo.playsInline = true;
    if (typeof D.liveVideo.disableRemotePlayback !== 'undefined') D.liveVideo.disableRemotePlayback = true;
    // Prefer low-latency (Chrome hint)
    try { D.liveVideo.setPreferredQuality && D.liveVideo.setPreferredQuality('auto'); } catch(_) {}
    D.liveVideo.play().catch(() => {});
    _showUnmutePrompt();
    _hideConnBanner();
    // Safety: hide banner once video actually starts playing
    D.liveVideo.addEventListener('playing', _hideConnBanner, { once: true });
    // ── If the guest grid is already showing a host cell, attach the stream now ──
    const hostCell = D.guestGrid?.querySelector('.vgc-cell.host-cell');
    if (hostCell && !hostCell.querySelector('video')) {
      _attachHostVideoToCell(hostCell);
    }
  };

  _rtcPc.onconnectionstatechange = () => {
    const state = _rtcPc.connectionState;
    if (state === 'connected') {
      _hideConnBanner();
      _viewerReconnectAttempt = 0; // reset on successful connection
    } else if (state === 'disconnected' || state === 'failed') {
      _showConnBanner('Reconnecting…', '');
      _scheduleViewerReconnect(roomData);
    }
  };

  /* ── Set remote description (offer) ── */
  const offer = connSnap.val().offer;
  try {
    await _rtcPc.setRemoteDescription(new RTCSessionDescription(offer));
  } catch (e) {
    _showConnBanner('Waiting for stream…', '');
    return;
  }

  /* ── Wire ICE handler BEFORE createAnswer so viewer candidates aren't lost ── */
  const _viewerPendingCands = [];
  let   _viewerAnswerWritten = false;

  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_viewerAnswerWritten) {
      _viewerPendingCands.push(e.candidate.toJSON());
      return;
    }
    try {
      await push(ref(_liveDB, `liveConnections/${_roomId}/viewerCandidates`), e.candidate.toJSON());
    } catch (_) {}
  };

  const answer = await _rtcPc.createAnswer();
  await _rtcPc.setLocalDescription(answer);

  /* ── Write answer to RTDB ── */
  try {
    await update(connRef, {
      answer: { type: answer.type, sdp: answer.sdp },
    });
    _viewerAnswerWritten = true;
  } catch (e) {
    _showConnBanner('Waiting for stream…', '');
    return;
  }

  /* ── Flush any viewer ICE candidates buffered before the answer was written ── */
  if (_viewerPendingCands.length) {
    for (const cand of _viewerPendingCands) {
      try { await push(ref(_liveDB, `liveConnections/${_roomId}/viewerCandidates`), cand); } catch (_) {}
    }
    _viewerPendingCands.length = 0;
  }

  /* ── Apply existing creator ICE candidates ── */
  let _appliedCreatorCandKeys = new Set();
  const existingCands = connSnap.val().creatorCandidates || {};
  for (const [key, cand] of Object.entries(existingCands)) {
    _appliedCreatorCandKeys.add(key);
    try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
  }

  /* ── Listen for new creator ICE candidates ── */
  _rtcSignalRef   = connRef;
  _rtcSignalUnsub = onValue(connRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.creatorCandidates) {
      for (const [key, cand] of Object.entries(d.creatorCandidates)) {
        if (_appliedCreatorCandKeys.has(key)) continue;
        _appliedCreatorCandKeys.add(key);
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });

  _showConnBanner('Waiting for stream…', '');

  // ── 3-second safety timeout: if video is already playing, remove banner ──
  setTimeout(() => {
    const v = D.liveVideo;
    if (v && v.srcObject && !v.paused && v.readyState >= 2) {
      _hideConnBanner();
    }
  }, 3000);
}

/* ═══════════════════════════════════════════════════
   STREAM QUALITY PROFILES
   Phone sends 720p 30fps 3000 kbps CBR by default.
   Auto-quality shifts between tiers based on
   bandwidth and packet-loss measured every 10 s.
   ═══════════════════════════════════════════════════ */

/**
 * Sender-side quality tiers (used by _startAdaptiveQuality).
 *
 * Tier selection on the SENDER is driven by packet-loss rate
 * (what the creator's upload path can sustain). The viewer's
 * playback simply receives whatever the sender transmits —
 * because this is a direct P2P WebRTC stream there is only one
 * encoded copy, so "viewer quality switching" means the sender
 * adapts to network conditions automatically.
 *
 *  Tier  | Resolution | maxBitrate | scaleDown | Condition
 *  ------+------------+------------+-----------+-------------------
 *  HIGH  | 1080p      | 6 000 kbps |     1     | loss < 3 %
 *  MED   | 720p       | 3 000 kbps |     1     | loss 3–10 %  (default)
 *  LOW   | 480p       | 1 500 kbps |  ~1.5     | loss 10–20 %
 *  MIN   | ~240p      |   600 kbps |     3     | loss > 20 %
 */
const _QUALITY_TIERS = [
  { name: 'HIGH', maxBitrate: 6_000_000, scaleDown: 1,   lossThreshold: 0.03  },
  { name: 'MED',  maxBitrate: 3_000_000, scaleDown: 1,   lossThreshold: 0.10  },
  { name: 'LOW',  maxBitrate: 1_500_000, scaleDown: 1.5, lossThreshold: 0.20  },
  { name: 'MIN',  maxBitrate:   600_000, scaleDown: 3,   lossThreshold: Infinity },
];

let _adaptiveQualityTimer    = null;
let _adaptiveQualityTierIdx  = 1; // start at MED (720p / 3000 kbps)

function _startAdaptiveQuality(pc) {
  if (_adaptiveQualityTimer) return; // already running

  let _prevPacketsSent = 0;
  let _prevPacketsLost = 0;

  _adaptiveQualityTimer = setInterval(async () => {
    if (!pc || pc.connectionState !== 'connected') {
      clearInterval(_adaptiveQualityTimer);
      _adaptiveQualityTimer = null;
      return;
    }

    try {
      const stats = await pc.getStats();
      let totalSent = 0, totalLost = 0, totalBytesSent = 0;

      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          totalSent      += report.packetsSent  || 0;
          totalLost      += report.packetsLost  || 0;
          totalBytesSent += report.bytesSent    || 0;
        }
      });

      const deltaSent = totalSent - _prevPacketsSent;
      const deltaLost = totalLost - _prevPacketsLost;
      _prevPacketsSent = totalSent;
      _prevPacketsLost = totalLost;

      if (deltaSent < 10) return; // not enough data yet

      const lossRate = deltaSent > 0 ? Math.max(0, deltaLost) / deltaSent : 0;

      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (!sender) return;

      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) return;

      // Determine which tier we should be in
      let targetIdx = _QUALITY_TIERS.length - 1; // default: lowest
      for (let i = 0; i < _QUALITY_TIERS.length; i++) {
        if (lossRate < _QUALITY_TIERS[i].lossThreshold) { targetIdx = i; break; }
      }

      // Only change tier when moving down immediately, or when improving
      // after two consecutive good intervals (hysteresis to avoid flapping)
      if (targetIdx === _adaptiveQualityTierIdx) return;

      // Allow instant degradation; require loss to be below prev tier threshold
      // for at least one check before upgrading (simple 1-step hysteresis)
      if (targetIdx > _adaptiveQualityTierIdx) {
        // degrading → apply immediately
      } else {
        // upgrading → only move one tier at a time
        targetIdx = _adaptiveQualityTierIdx - 1;
        if (lossRate >= _QUALITY_TIERS[targetIdx].lossThreshold) return;
      }

      _adaptiveQualityTierIdx = targetIdx;
      const tier = _QUALITY_TIERS[targetIdx];

      params.encodings[0].maxBitrate           = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      await sender.setParameters(params).catch(() => {});
      console.log(`[AdaptiveQuality] → ${tier.name} (loss:${(lossRate*100).toFixed(1)}%  bitrate:${tier.maxBitrate/1000}kbps)`);

    } catch(_) {}
  }, 10_000);
}

function _stopAdaptiveQuality() {
  if (_adaptiveQualityTimer) {
    clearInterval(_adaptiveQualityTimer);
    _adaptiveQualityTimer   = null;
    _adaptiveQualityTierIdx = 1; // reset to MED for next session
  }
}

/* ═══════════════════════════════════════════════════
   VIEWER AUTO-RECONNECT
   ═══════════════════════════════════════════════════ */

/**
 * Schedule a WebRTC reconnect attempt with exponential back-off.
 * Clears the old peer connection before creating a new one so listeners
 * and ICE candidates don't pile up.
 */
function _scheduleViewerReconnect(roomData) {
  if (_viewerLeftFlag) return;  // viewer already left
  if (_viewerReconnectAttempt >= _MAX_RECONNECT_ATTEMPTS) {
    _showConnBanner('Stream unavailable', 'Could not reconnect. The stream may have ended.');
    return;
  }

  if (_viewerReconnectTimer) clearTimeout(_viewerReconnectTimer);

  const delay = Math.min(2000 * Math.pow(1.5, _viewerReconnectAttempt), 15000);
  _viewerReconnectAttempt++;
  console.log(`[WebRTC] Reconnect attempt ${_viewerReconnectAttempt} in ${delay}ms`);

  _viewerReconnectTimer = setTimeout(async () => {
    _viewerReconnectTimer = null;
    if (_viewerLeftFlag) return;

    // Tear down old peer connection + signal listener
    if (_rtcPc) { try { _rtcPc.close(); } catch(_){} _rtcPc = null; }
    if (_rtcSignalRef && _rtcSignalUnsub) {
      try { off(_rtcSignalRef); } catch(_) {}
      _rtcSignalRef = null; _rtcSignalUnsub = null;
    }

    // Verify stream is still live before attempting
    try {
      const snap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
      if (!snap.exists() || snap.val().status !== 'live') {
        _showEndedOverlay(false, 'Stream ended', `${roomData.hostName} has ended the live stream.`);
        return;
      }
    } catch(_) {}

    // Re-run the WebRTC viewer setup
    await _startViewerWebRTC(roomData);
  }, delay);
}

/* ═══════════════════════════════════════════════════
   CHAT — Firestore sub-collection
   ═══════════════════════════════════════════════════ */
function _subscribeChat() {
  if (!_roomId) return;
  // Unsubscribe any previous listener before creating a new one
  if (_chatUnsub) { try { _chatUnsub(); } catch(_){} _chatUnsub = null; }
  const q = query(
    collection(_db, 'liveRooms', _roomId, 'liveMessages'),
    orderBy('createdAt', 'asc'),
    limit(100)   // reduced: keeps DOM lean and memory lower
  );
  _chatUnsub = onSnapshot(q, snap => {
    // Batch all 'added' changes into a single DocumentFragment
    const frag = document.createDocumentFragment();
    let hasNew = false;
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added') {
        const el = _buildChatMsgEl(ch.doc.data());
        if (el) { frag.appendChild(el); hasNew = true; }
      }
    });
    if (!hasNew) return;
    const cm = D.chatMessages;
    if (!cm) return;

    // Measure scroll position BEFORE appending (avoids forced reflow after paint)
    const atBottom = cm.scrollHeight - cm.scrollTop - cm.clientHeight < 120;
    cm.appendChild(frag);

    // Trim old messages (keep max 70 visible) — do after append
    while (cm.children.length > 70) {
      cm.removeChild(cm.firstChild);
    }

    // Auto-scroll only if already near bottom
    if (atBottom) cm.scrollTop = cm.scrollHeight;
  }, () => {});
}

function _buildChatMsgEl(data) {
  const hostUid  = _roomId ? _roomId.split('_')[0] : null;
  const isHost   = !!(hostUid && data.userId === hostUid);
  const isSystem = data.type === 'system';
  const isGift   = data.type === 'gift';

  const el = document.createElement('div');
  el.className = 'live-chat-msg' + (isSystem ? ' system' : '') + (isGift ? ' gift-msg' : '');

  if (isGift) {
    const author = document.createElement('span');
    author.className = 'live-chat-author';
    author.textContent = data.userName || 'Guest';
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = `${data.giftEmoji || '🎁'} sent ${data.giftName || 'a gift'}!`;
    el.appendChild(author);
    el.appendChild(text);
    // Show burst animation for all viewers (not just the sender)
    if (typeof window._snxRenderGiftEvent === 'function') {
      window._snxRenderGiftEvent(data.giftId, data.userName || 'Guest');
    }
  } else if (!isSystem) {
    const author = document.createElement('span');
    author.className = 'live-chat-author' + (isHost ? ' is-host' : '');
    author.textContent = data.userName || 'Guest';
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = data.text || '';
    el.appendChild(author);
    el.appendChild(text);
  } else {
    const text = document.createElement('span');
    text.className = 'live-chat-text';
    text.textContent = data.text || '';
    el.appendChild(text);
  }
  return el;
}

function _appendChatMsg(data) {
  if (!D.chatMessages) return;
  const el = _buildChatMsgEl(data);
  if (!el) return;
  const cm = D.chatMessages;
  const atBottom = cm.scrollHeight - cm.scrollTop - cm.clientHeight < 120;
  cm.appendChild(el);
  while (cm.children.length > 70) cm.removeChild(cm.firstChild);
  if (atBottom) cm.scrollTop = cm.scrollHeight;
}

/* ── Live chat AI safety rules (mirrors index.html _RULES) ── */
const _LIVE_RULES = [
  { category: 'Threats',           severity: 'block', patterns: [
      /\bi('?ll| will|'m going to|m gonna|gonna|will)\s+(kill|hurt|murder|destroy|beat|shoot|stab|end)\s+(you|u|them|him|her)/i,
      /\b(kill\s*your?self|kys|go\s*die|i\s*will\s*find\s*you|watch\s*your\s*back|you('re|\s+are)\s+dead|dead\s*man|dead\s*girl|die\s*bitch)\b/i,
      /\b(bomb|shoot up|blow up|attack)\s*(the\s*)?(school|place|building|event)/i,
  ]},
  { category: 'Hate Speech',       severity: 'block', patterns: [
      /\b(f+u+c+k+\s*(all\s*)?(blacks?|whites?|jews?|muslims?|christians?|gays?|lesbians?|trans|latinos?|asians?|mexicans?|arabs?))\b/i,
      /\b(all\s+(blacks?|whites?|jews?|muslims?|gays?|lesbians?|trans|latinos?|asians?)\s+should\s+(die|be\s+killed|disappear|burn))\b/i,
      /\b(white\s*power|white\s*supremac|ethnic\s*cleans|n[i1]+gg[e3]r|ch[i1]nk|sp[i1]c|k[i1]ke|f[a4]gg[o0]t|tr[a4]nny)\b/i,
  ]},
  { category: 'Doxxing',           severity: 'block', patterns: [
      /\b(here('?s|\s+is)\s+(your|his|her|their)\s+(address|phone|number|location|ip\s*address|home|school|work))\b/i,
      /\b(i\s*(know|found)\s+where\s+you\s+(live|work|go\s+to\s+school))\b/i,
  ]},
  { category: 'Self-Harm Promotion', severity: 'block', patterns: [
      /\b(how\s+to\s+(properly\s+)?(cut|harm|hurt)\s+(yourself|myself)|best\s+way\s+to\s+(overdose|die|end\s+(it|your\s+life)))\b/i,
      /\b(just\s+(do\s+it|end\s+it|kill\s+yourself|hurt\s+yourself)\s+(already|please|nobody\s+cares))\b/i,
  ]},
  { category: 'Harassment',        severity: 'warn',  patterns: [
      /\b(shut\s*(the\s*f[uck*@]+\s*)?up\s+(you\s+)?(stupid|dumb|idiot|ugly|fat|loser|worthless|pathetic|disgusting)\b)/i,
      /\b(nobody\s+(likes?|cares\s*about)\s+you|you\s+(are|r|re)\s+(worthless|pathetic|trash|garbage|a\s+loser|disgusting|nothing))\b/i,
  ]},
  { category: 'Spam',              severity: 'warn',  patterns: [
      /(.)\1{19,}/,
      /(\b\w+\b)(\s+\1){7,}/i,
  ]},
];

function _liveScanText(text) {
  if (!text) return null;
  for (const rule of _LIVE_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(text)) return rule;
    }
  }
  return null;
}

async function sendChat() {
  if (!_user || !_roomId) return;
  // Guard against double-send (rapid taps / Enter+click combo)
  if (_chatSending) return;

  const text = (D.chatInput?.value || '').trim();
  if (!text || text.length > 200) return;

  // ── AI Safety scan ──
  const hit = _liveScanText(text);
  if (hit) {
    const isMod = _userData?.role === 'founder' ||
                  _userData?.role === 'administrator' ||
                  _userData?.role === 'moderator';
    if (hit.severity === 'block' && !isMod) {
      toast(`🚫 Blocked · ${hit.category}: Keep it safe.`);
      return;   // hard block — do NOT clear input, let user edit
    }
    toast(`⚠️ Warning · ${hit.category}: Please keep the community safe.`);
  }

  // Clear input immediately so typing feels instant
  if (D.chatInput) {
    D.chatInput.value = '';
    D.chatInput.focus();
  }

  _chatSending = true;
  try {
    await addDoc(collection(_db, 'liveRooms', _roomId, 'liveMessages'), {
      userId:    _user.uid,
      userName:  _userData.displayName || 'Guest',
      text,
      type:      'chat',
      createdAt: serverTimestamp(),
    });
  } catch (e) {
    toast('Could not send message.');
  } finally {
    _chatSending = false;
  }
}

/* ═══════════════════════════════════════════════════
   LIKES — LIVE RTDB
   ═══════════════════════════════════════════════════ */
let _hasLiked = false;

async function sendLike() {
  if (!_user || !_roomId || _hasLiked) return;
  _hasLiked = true;
  if (D.likeBtn)      D.likeBtn.classList.add('liked');
  if (D.likeBtnCount) D.likeBtnCount.textContent = '❤️';

  _spawnHeartBurst();

  // Use RTDB transactions-style increment via set with existing value
  // For RTDB we still need a get, but fire-and-forget to keep UI instant
  (async () => {
    try {
      const likesRef = ref(_liveDB, `liveRooms/${_roomId}/likes`);
      const snap = await get(likesRef);
      await set(likesRef, (snap.val() || 0) + 1);
    } catch (_) {}
  })();

  setTimeout(() => {
    _hasLiked = false;
    if (D.likeBtn) D.likeBtn.classList.remove('liked');
  }, 5000);
}

function _spawnHeartBurst() {
  const stage = D.stage;
  if (!stage) return;
  const el = document.createElement('div');
  el.className = 'like-burst';
  el.textContent = '❤️';
  const rect = stage.getBoundingClientRect();
  el.style.left     = (rect.width  * 0.75 + (Math.random() - 0.5) * 60) + 'px';
  el.style.bottom   = (80 + Math.random() * 60) + 'px';
  el.style.position = 'absolute';
  stage.appendChild(el);
  el.addEventListener('animationend', () => el.remove());
}

/* ═══════════════════════════════════════════════════
   UI HELPERS
   ═══════════════════════════════════════════════════ */
function _hideLoading() {
  if (D.loading) D.loading.style.display = 'none';
}

function _showStage() {
  if (D.stage) D.stage.classList.add('active');
}

function _showConnBanner(title, sub) {
  if (!D.connBanner) return;
  // Don't show the banner if the video is already playing
  const v = D.liveVideo;
  if (v && v.srcObject && !v.paused && v.readyState >= 2) return;
  if (D.connTitle) D.connTitle.textContent = title;
  if (D.connSub)   D.connSub.textContent   = sub;
  D.connBanner.classList.add('visible');
}

function _hideConnBanner() {
  if (D.connBanner) D.connBanner.classList.remove('visible');
}

function _showUnmutePrompt() {
  const p = D.unmutePrompt;
  if (!p) return;
  p.style.display = 'block';
  const _unmute = () => {
    if (D.liveVideo) D.liveVideo.muted = false;
    p.style.display = 'none';
    p.removeEventListener('click', _unmute);
    if (D.stage) D.stage.removeEventListener('click', _unmute);
  };
  p.addEventListener('click', _unmute);
  if (D.stage) D.stage.addEventListener('click', _unmute, { once: true });
}

function _showEndedOverlay(wasCreator, title, sub) {
  if (!D.ended) return;
  if (D.endedTitle) D.endedTitle.textContent = title || 'Stream ended';
  if (D.endedSub)   D.endedSub.textContent   = sub   || (wasCreator
    ? 'Your live stream has ended. Thanks for going live!'
    : 'The creator has ended this live stream.');
  D.ended.classList.add('visible');
  // Cancel pending reconnect so we don't try to reconnect to an ended stream
  if (_viewerReconnectTimer) { clearTimeout(_viewerReconnectTimer); _viewerReconnectTimer = null; }
  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }
  if (_chatUnsub) { _chatUnsub(); _chatUnsub = null; }
}

function onCloseBtn() {
  if (_mode === 'creator') {
    endLive();
  } else {
    _viewerLeave();
    window.location.href = 'index.html';
  }
}

/* ═══════════════════════════════════════════════════
   SHARE
   ═══════════════════════════════════════════════════ */
function shareLive() {
  if (!_roomId) { toast('Start your live first.'); return; }
  _openShareModal();
}

function _buildLiveUrl() {
  const base = window.location.origin + window.location.pathname.replace('live.html', '');
  return base + 'live.html#watch=' + _roomId;
}

function _openShareModal() {
  const old = document.getElementById('_snxShareModal');
  if (old) old.remove();

  const url      = _buildLiveUrl();
  const name     = _userData?.displayName || 'Someone';
  const shareMsg = `${name} is Live Now 🔴 — Watch: ${url}`;

  const modal = document.createElement('div');
  modal.id    = '_snxShareModal';
  modal.style.cssText = `
    position:fixed;inset:0;z-index:9999;
    display:flex;align-items:flex-end;justify-content:center;
    background:rgba(0,0,0,0.65);backdrop-filter:blur(4px);
  `;

  modal.innerHTML = `
    <div style="
      background:#0d2444;border:1px solid rgba(0,174,239,0.3);
      border-radius:20px 20px 0 0;padding:24px 20px 36px;
      width:100%;max-width:520px;
    ">
      <div style="text-align:center;font-size:16px;font-weight:800;color:#fff;margin-bottom:18px;">
        📤 Share Live Stream
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;">
        <button id="_snxShareCopyLink" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">🔗 Copy Live Link</button>
        <button id="_snxShareToFeed" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">📣 Share to Feed</button>
        <button id="_snxShareNative" style="
          background:rgba(0,174,239,0.12);border:1px solid rgba(0,174,239,0.4);
          border-radius:12px;padding:14px 18px;color:#00AEEF;font-size:14px;
          font-weight:700;cursor:pointer;text-align:left;display:flex;align-items:center;gap:12px;
        ">📲 Share to Friends / Apps</button>
      </div>
      <button id="_snxShareClose" style="
        margin-top:18px;width:100%;background:rgba(255,255,255,0.06);
        border:1px solid rgba(255,255,255,0.12);border-radius:12px;
        padding:12px;color:#6a90b8;font-size:14px;cursor:pointer;
      ">Cancel</button>
    </div>`;

  document.body.appendChild(modal);

  modal.querySelector('#_snxShareCopyLink').addEventListener('click', () => {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url)
        .then(() => { toast('🔗 Live link copied!'); })
        .catch(() => { window.prompt('Copy this link:', url); });
    } else {
      window.prompt('Copy this link:', url);
    }
    _closeShareModal();
  });

  modal.querySelector('#_snxShareToFeed').addEventListener('click', async () => {
    _closeShareModal();
    try {
      await addDoc(collection(_db, 'posts'), {
        type:         'live_share',
        uid:          _user.uid,
        authorUid:    _user.uid,
        authorName:   _userData?.displayName || '',
        authorHandle: _userData?.username    || '',
        authorAvatar: _userData?.avatar      || '',
        liveRoomId:   _roomId,
        isLive:       true,
        text:         shareMsg,
        timestamp:    Date.now(),
        createdAt:    Date.now(),
        likes:        0,
        comments:     [],
      });
      toast('📣 Shared to Feed!');
    } catch (e) {
      toast('Could not share.');
    }
  });

  modal.querySelector('#_snxShareNative').addEventListener('click', () => {
    _closeShareModal();
    if (navigator.share) {
      navigator.share({
        title: '🔴 Watch me live on Shadow Nexus!',
        text:  shareMsg,
        url,
      }).catch(() => {});
    } else {
      window.prompt('Copy this link to share:', url);
    }
  });

  modal.querySelector('#_snxShareClose').addEventListener('click', _closeShareModal);
  modal.addEventListener('click', e => { if (e.target === modal) _closeShareModal(); });
}

function _closeShareModal() {
  const m = document.getElementById('_snxShareModal');
  if (m) m.remove();
}

function toast(msg, duration = 3200) {
  if (!D.toast) return;
  clearTimeout(_toastTimer);
  D.toast.textContent = msg;
  D.toast.classList.add('visible');
  _toastTimer = setTimeout(() => D.toast.classList.remove('visible'), duration);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── One-time version/update check ──
   Asks the SW if a newer version is waiting. If one is available, notify
   once via toast with a manual refresh prompt. Never polls again in the
   same session (guarded by _updateChecked). ── */
function _checkForUpdate() {
  if (_updateChecked) return;
  _updateChecked = true;
  if (!('serviceWorker' in navigator)) return;

  // When a new SW takes over (after SKIP_WAITING), reload the page to apply updates
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });

  navigator.serviceWorker.ready.then(reg => {
    // Trigger a background network check — does NOT block the page
    reg.update().then(() => {
      _showUpdateBarIfWaiting(reg);
    }).catch(() => {});

    // Also handle the case where a SW update event fires during this session
    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      if (!newWorker) return;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          _showUpdateBarIfWaiting(reg);
        }
      });
    });
  }).catch(() => {});
}

function _showUpdateBarIfWaiting(reg) {
  if (!reg.waiting) return;
  // Already shown once? Don't show again
  if (document.getElementById('_snxUpdateBar')) return;

  const bar = document.createElement('div');
  bar.id = '_snxUpdateBar';
  bar.style.cssText = [
    'position:fixed','bottom:72px','left:50%','transform:translateX(-50%)',
    'z-index:9999','background:rgba(0,20,60,0.97)',
    'border:1px solid rgba(0,174,239,0.7)','border-radius:10px',
    'padding:10px 18px','font-size:13px','color:#00AEEF',
    'cursor:pointer','white-space:nowrap',
    'box-shadow:0 4px 18px rgba(0,0,0,0.5)',
  ].join(';');
  bar.textContent = '🔄 New version available — tap to refresh';
  bar.addEventListener('click', () => {
    bar.textContent = 'Updating…';
    reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    // Reload will be triggered by the controllerchange event above
  });
  document.body.appendChild(bar);
  // Auto-dismiss after 15s — user can update later
  setTimeout(() => bar.remove(), 15000);
}

/* ── Confirmation dialog — Promise-based modal ──
   _snxConfirm({ icon, title, sub, okLabel, okClass })
   Resolves true (confirmed) or false (cancelled). */
function _snxConfirm({ icon = '❓', title = 'Are you sure?', sub = '', okLabel = 'Confirm', okClass = '' } = {}) {
  return new Promise(resolve => {
    // Remove any stale overlay
    document.getElementById('_snxConfirmOverlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id = '_snxConfirmOverlay';
    overlay.className = 'snx-confirm-overlay';
    overlay.innerHTML = `
      <div class="snx-confirm-box">
        <div class="snx-confirm-icon">${icon}</div>
        <div class="snx-confirm-title">${_esc(title)}</div>
        ${sub ? `<div class="snx-confirm-sub">${_esc(sub)}</div>` : ''}
        <div class="snx-confirm-actions">
          <button class="snx-confirm-cancel">Cancel</button>
          <button class="snx-confirm-ok${okClass ? ' ' + okClass : ''}">${_esc(okLabel)}</button>
        </div>
      </div>
    `;

    const close = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.snx-confirm-cancel').addEventListener('click', () => close(false));
    overlay.querySelector('.snx-confirm-ok').addEventListener('click',     () => close(true));
    // Tap backdrop to cancel
    overlay.addEventListener('click', e => { if (e.target === overlay) close(false); });

    document.body.appendChild(overlay);
  });
}

/* ═══════════════════════════════════════════════════════════════
   VIEWER GUEST GRID — real-time presence display for followers
   ─────────────────────────────────────────────────────────────
   Watches liveGuests/{roomId} in RTDB.
   Each entry: { uid, name, avatar, camOn, micOn, isHost? }
   Renders placeholder cards (no live video) so all viewers see
   who is in each box and their cam/mic status in real time.
   ═══════════════════════════════════════════════════════════════ */

/* ── HOST: Broadcast current layout + size to all viewers via RTDB ── */
function _broadcastLayout() {
  if (!_roomId) return;
  try {
    update(ref(_liveDB, `liveRooms/${_roomId}`), {
      guestLayout:  _guestLayout,
      guestBoxSize: _guestBoxSize,
    });
  } catch(_) {}
}

/* ── VIEWER / GUEST: Subscribe to layout changes broadcast by the host ──
   For pure viewers the _roomWatchRef onValue already handles layout sync
   (see _startViewer).  For guests who joined a box mid-stream, the
   _roomWatchRef is also already running, so we just mark the unsub as a
   no-op to keep the cleanup code paths consistent. ── */
function _startLayoutSync() {
  if (!_roomId) return;
  // Detach any previous dedicated listener
  if (_layoutSyncUnsub) { try { _layoutSyncUnsub(); } catch(_) {} _layoutSyncUnsub = null; }

  // If _roomWatchRef is already listening (viewer path), reuse it — no new listener needed.
  if (_roomWatchRef) {
    // Provide a no-op unsub so cleanup code paths work unchanged
    _layoutSyncUnsub = () => {};
    return;
  }

  // Guest-only path (joined as guest without _roomWatchRef running):
  // subscribe to the room node for layout changes only.
  const roomRef = ref(_liveDB, `liveRooms/${_roomId}`);
  _layoutSyncUnsub = onValue(roomRef, snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    let changed = false;
    if (d.guestLayout  && d.guestLayout  !== _guestLayout)  { _guestLayout  = d.guestLayout;  changed = true; }
    if (d.guestBoxSize && d.guestBoxSize !== _guestBoxSize)  { _guestBoxSize = d.guestBoxSize; changed = true; }
    if (changed) _applyGuestLayout();
  });
}

function _startViewerGuestGrid() {
  if (!_roomId) return;
  const guestsRef = ref(_liveDB, `liveGuests/${_roomId}`);

  _viewerGuestUnsub = onValue(guestsRef, snap => {
    const grid = D.guestGrid;
    if (!grid) return;

    // Build current set of UIDs from RTDB snapshot
    const incoming = {};
    if (snap.exists()) {
      snap.forEach(child => {
        const g = child.val();
        if (g && g.uid) incoming[child.key] = g;
      });
    }

    // ── Remove cards for guests who left — animate out then remove ──
    grid.querySelectorAll('.vgc-cell').forEach(card => {
      if (!incoming[card.dataset.guestKey] && !card.classList.contains('removing')) {
        // Animated exit in ≤220ms — never leaves empty ghost boxes
        card.classList.add('removing');
        setTimeout(() => {
          card.remove();
          _applyGuestLayout(); // re-layout after DOM node is fully gone
        }, 220);
      }
    });

    // ── Add or update cards for current guests ──
    const orderedKeys = Object.keys(incoming).sort((a, b) => {
      // _host_ always first, then by joinedAt
      if (a === '_host_') return -1;
      if (b === '_host_') return  1;
      return (incoming[a].joinedAt || 0) - (incoming[b].joinedAt || 0);
    });

    orderedKeys.forEach(key => {
      const g = incoming[key];
      let card = grid.querySelector(`.vgc-cell[data-guest-key="${key}"]`);

      if (!card) {
        // ── Create new card ──
        card = document.createElement('div');
        card.className = 'guest-cell vgc-cell' + (g.isHost ? ' host-cell' : '');
        card.dataset.guestKey = key;
        card.dataset.uid      = g.uid;

        // Avatar circle
        const avatarWrap = document.createElement('div');
        avatarWrap.className = 'vgc-avatar';
        if (g.avatar) {
          avatarWrap.style.backgroundImage = `url('${_esc(g.avatar)}')`;
        } else {
          avatarWrap.textContent = (g.name || '?')[0].toUpperCase();
        }
        card.appendChild(avatarWrap);

        // Camera-off overlay
        const camOffEl = document.createElement('div');
        camOffEl.className = 'vgc-cam-off';
        camOffEl.innerHTML = '<span>📷</span><span>Camera off</span>';
        card.appendChild(camOffEl);

        // Name label
        const nameEl = document.createElement('div');
        nameEl.className = 'guest-cell-name vgc-name';
        nameEl.textContent = g.isHost ? (g.name + ' (Host)') : (g.name || 'Guest');
        card.appendChild(nameEl);

        // Status icons bar
        const statusBar = document.createElement('div');
        statusBar.className = 'vgc-status';
        statusBar.innerHTML = `
          <span class="vgc-icon-cam">${g.camOn !== false ? '📷' : '🚫'}</span>
          <span class="vgc-icon-mic">${g.micOn !== false ? '🎤' : '🔇'}</span>
          ${g.isHost ? '<span class="vgc-host-badge">HOST</span>' : ''}
        `;
        card.appendChild(statusBar);

        // Insert: host always first
        if (g.isHost) {
          grid.insertBefore(card, grid.firstChild);
          // ── Attach host video stream to the host cell so it never disappears ──
          // For viewers, the host video arrives via WebRTC on #liveVideo.
          // Re-use that stream in the host cell so the grid always shows the host feed.
          _attachHostVideoToCell(card);
        } else {
          grid.appendChild(card);
        }

        // If this is the current viewer's own cell and they have a live guest stream,
        // attach the stream so they see their own live video (not just the avatar).
        if (_guestStream && g.uid === _user?.uid) {
          _attachGuestSelfStream(_guestStream);
        }
      } else {
        // ── Update existing card ──
        const camIcon = card.querySelector('.vgc-icon-cam');
        const micIcon = card.querySelector('.vgc-icon-mic');
        const camOff  = card.querySelector('.vgc-cam-off');
        if (camIcon) camIcon.textContent = g.camOn !== false ? '📷' : '🚫';
        if (micIcon) micIcon.textContent = g.micOn !== false ? '🎤' : '🔇';
        if (camOff)  camOff.classList.toggle('vgc-cam-off--visible', g.camOn === false);
        // Ensure host video is attached if not yet (e.g. stream arrived after card was built)
        if (g.isHost && !card.querySelector('video')) {
          _attachHostVideoToCell(card);
        }
      }
    });

    // ── Show/hide grid based on whether any guests are present ──
    const guestCount = orderedKeys.filter(k => !incoming[k].isHost).length;
    grid.dataset.count = guestCount.toString();
    if (guestCount > 0) {
      grid.classList.add('has-guests');
    } else {
      grid.classList.remove('has-guests');
    }
    _applyGuestLayout();
  });
}

/* ── Attach the host's live video stream into a viewer-side host cell ──
   The host stream arrives via WebRTC on #liveVideo. We create a <video>
   element in the host cell that reads from the same MediaStream so the
   host camera is always visible, even when the guest grid is shown. */
function _attachHostVideoToCell(cell) {
  const _tryAttach = (attempts) => {
    const liveVid = D.liveVideo;
    if (!liveVid) return;
    const stream = liveVid.srcObject;
    if (!stream) {
      // Host stream not yet arrived — retry up to 30 times (3 seconds)
      if (attempts > 0) setTimeout(() => _tryAttach(attempts - 1), 100);
      return;
    }
    // Don't add a second video if one already exists
    if (cell.querySelector('video')) return;
    const vid = document.createElement('video');
    vid.autoplay   = true;
    vid.muted      = false;   // viewers should hear the host
    vid.playsInline = true;
    vid.srcObject  = stream;
    vid.play().catch(() => {});
    // Insert before the name label so it sits behind the overlay elements
    const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
    cell.insertBefore(vid, nameEl || null);
    // Hide avatar once video is attached
    const avatar = cell.querySelector('.vgc-avatar');
    if (avatar) avatar.style.display = 'none';
    // Hide cam-off overlay (host cam state already reflects in the card)
    const camOff = cell.querySelector('.vgc-cam-off');
    if (camOff) camOff.classList.remove('vgc-cam-off--visible');
  };
  _tryAttach(30);
}

/* ═══════════════════════════════════════════════════════════════
   GUEST BOX SYSTEM
   ─────────────────────────────────────────────────────────────
   RTDB paths used:
     guestRequests/{roomId}/{viewerUid}  → { uid, name, avatar, status:'pending'|'accepted'|'declined' }
     guestSignaling/{roomId}/{viewerUid} → { offer, answer, guestCandidates:{}, hostCandidates:{} }

   Flow:
     Viewer:  taps "Request a Box"
              → writes guestRequests/{roomId}/{uid}  status:'pending'
              → watches status node for 'accepted' / 'declined'

     Host:    listens to guestRequests/{roomId}
              → sees pending card → Accept / Decline
              Accept → writes status:'accepted'  + initiates WebRTC offer
              Decline → removes request node

     WebRTC:  host is offerer, guest is answerer (like creator/viewer main flow)
   ═══════════════════════════════════════════════════════════════ */

/* ── VIEWER: Request a Box ── */
async function _viewerRequestBox() {
  console.log('[BoxRequest] Request button clicked');

  // ── Guard: user must be logged in ──
  if (!_user) {
    console.warn('[BoxRequest] User not authenticated');
    toast('❌ Please sign in to request a box.');
    return;
  }

  // ── Guard: anonymous users are blocked by Firestore rules ──
  if (_user.isAnonymous) {
    toast('❌ Sign in with an account to request a box.');
    return;
  }

  // ── Guard: user data must be loaded ──
  if (!_userData) {
    toast('Loading your profile… Please try again.');
    return;
  }

  // ── Guard: must have a valid room ──
  if (!_roomId) {
    console.warn('[BoxRequest] Missing liveId (roomId is null)');
    toast('❌ No live stream found. Try refreshing.');
    return;
  }

  const btn = D.btnRequestBox;

  // ── Guard: already in a guest box ──
  if (btn && btn.style.display === 'none') {
    console.log('[BoxRequest] Viewer already in a guest box');
    return;
  }

  // ── Guard: already has a pending request ──
  if (btn && btn.classList.contains('pending')) {
    console.log('[BoxRequest] Viewer already has a pending request');
    toast('Your request is already pending…');
    return;
  }

  // ── Resolve hostId from RTDB room ──
  let hostId = null;
  try {
    const roomSnap = await get(ref(_liveDB, `liveRooms/${_roomId}`));
    if (roomSnap.exists()) {
      hostId = roomSnap.val().hostId || null;
    }
  } catch (e) {
    console.error('[BoxRequest] Could not read liveRoom to get hostId:', e);
    toast('❌ Firebase connection error. Please try again.');
    return;
  }

  if (!hostId) {
    console.warn('[BoxRequest] Missing hostId — cannot send request');
    toast('❌ Could not find stream host. Try refreshing.');
    return;
  }

  console.log('[BoxRequest] Creating request — liveId:', _roomId, 'hostId:', hostId, 'viewerId:', _user.uid);

  const viewerName   = _userData.displayName || _user.email?.split('@')[0] || 'Guest';
  const viewerAvatar = _userData.avatar || _userData.profilePicture || '';
  const requestId    = `${_roomId}_${_user.uid}`;

  // ── Write to Firestore boxRequests ──
  try {
    await setDoc(doc(_db, 'boxRequests', requestId), {
      liveId:             _roomId,
      hostId,
      viewerId:           _user.uid,
      viewerName,
      viewerProfileImage: viewerAvatar,
      status:             'pending',
      createdAt:          serverTimestamp(),
    });
    console.log('[BoxRequest] Firestore write successful — requestId:', requestId);
  } catch (e) {
    console.error('[BoxRequest] Firestore write failed:', e.code, e.message);
    if (e.code === 'permission-denied') {
      toast('❌ Permission denied. Make sure you are signed in.');
    } else {
      toast('❌ Could not send request. Please try again.');
    }
    return;
  }

  // ── Write to RTDB guestRequests (for real-time WebRTC signaling flow) ──
  const rtdbReqRef = ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`);
  try {
    await set(rtdbReqRef, {
      uid:       _user.uid,
      name:      viewerName,
      avatar:    viewerAvatar,
      requestId,
      status:    'pending',
      ts:        Date.now(),
    });
    console.log('[BoxRequest] RTDB guestRequest written');
  } catch (e) {
    console.error('[BoxRequest] RTDB write failed:', e.code, e.message);
    // Non-fatal — Firestore is the source of truth for the host notification
  }

  // ── Update button to show pending state ──
  if (btn) {
    btn.classList.add('pending');
  }
  if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Waiting…';
  toast('📺 Request sent to host!');

  // ── Watch Firestore boxRequest status for host response ──
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} _guestStatusUnsub = null; }

  const reqDocRef = doc(_db, 'boxRequests', requestId);
  _guestStatusUnsub = onSnapshot(reqDocRef, async snap => {
    if (!snap.exists()) return;
    const status = snap.data().status;
    console.log('[BoxRequest] Status update received:', status);

    if (status === 'accepted') {
      if (btn) {
        btn.classList.remove('pending');
        btn.style.display = 'none';
      }
      toast('✅ Accepted! Joining as guest…');
      _guestStatusUnsub && _guestStatusUnsub();
      _guestStatusUnsub = null;
      await _guestJoinAsViewer();

    } else if (status === 'declined') {
      if (btn) {
        btn.classList.remove('pending');
      }
      if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';
      toast('Request declined.');
      _guestStatusUnsub && _guestStatusUnsub();
      _guestStatusUnsub = null;
      // Clean up Firestore doc
      try { await deleteDoc(reqDocRef); } catch(_) {}
    }
  }, err => {
    console.error('[BoxRequest] Snapshot listener error:', err.code, err.message);
    if (err.code === 'permission-denied') {
      toast('❌ Permission denied watching request status.');
    }
  });
}

/* ── VIEWER: Guest cam toggle ── */
function _toggleGuestCam() {
  if (!_guestStream) return;
  _guestCamOn = !_guestCamOn;
  _guestStream.getVideoTracks().forEach(t => { t.enabled = _guestCamOn; });
  if (D.btnGuestCam) D.btnGuestCam.classList.toggle('off', !_guestCamOn);
  if (D.btnGuestCamLabel) D.btnGuestCamLabel.textContent = _guestCamOn ? 'Cam' : 'Cam Off';
  const icon = D.btnGuestCam && D.btnGuestCam.querySelector('span:first-child');
  if (icon) icon.textContent = _guestCamOn ? '📷' : '🚫';
  // Broadcast cam state so host and other viewers see the change
  if (_user && _roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`), { camOn: _guestCamOn }); } catch(_) {}
}

/* ── VIEWER: Guest mic toggle ── */
function _toggleGuestMic() {
  if (!_guestStream) return;
  _guestMicOn = !_guestMicOn;
  _guestStream.getAudioTracks().forEach(t => { t.enabled = _guestMicOn; });
  if (D.btnGuestMic) D.btnGuestMic.classList.toggle('off', !_guestMicOn);
  if (D.btnGuestMicLabel) D.btnGuestMicLabel.textContent = _guestMicOn ? 'Mic' : 'Mic Off';
  const icon = D.btnGuestMic && D.btnGuestMic.querySelector('span:first-child');
  if (icon) icon.textContent = _guestMicOn ? '🎤' : '🔇';
  toast(_guestMicOn ? 'Mic on' : 'Mic muted');
  // Broadcast mic state so host and other viewers see the change
  if (_user && _roomId) try { update(ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`), { micOn: _guestMicOn }); } catch(_) {}
}

/* ── VIEWER: Leave the guest box voluntarily ── */
async function _guestLeaveBox() {
  // Guard: only a viewer who is currently in a box can leave
  if (!_guestStream && !_guestPc) return;

  const confirmed = await _snxConfirm({
    icon:     '🚪',
    title:    'Leave guest box?',
    sub:      'You will return to watching the live stream.',
    okLabel:  'Leave Box',
    okClass:  '',
  });
  if (!confirmed) return;

  _guestDoLeave();
}

/* ── Internal: perform the guest leave cleanup (called from Leave Box or removedByHost signal) ── */
function _guestDoLeave() {
  // Stop heartbeat immediately — no more presence keep-alive
  if (_guestHeartbeatInterval) {
    clearInterval(_guestHeartbeatInterval);
    _guestHeartbeatInterval = null;
  }

  // Tear down the host-ICE signaling listener first
  if (_guestSigUnsub) {
    try { _guestSigUnsub(); } catch(_) {}
    _guestSigUnsub = null;
  }

  // Close peer connection — triggers onconnectionstatechange cleanup below,
  // but also handle directly here for immediate UI response
  if (_guestPc) {
    try { _guestPc.close(); } catch(_) {}
    _guestPc = null;
  }

  // Remove own presence from RTDB so grid updates for everyone instantly.
  // Also cancel the onDisconnect hook so RTDB doesn't attempt a redundant delete.
  if (_user && _roomId) {
    const presRef = ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`);
    try { onDisconnect(presRef).cancel(); } catch(_) {}
    try { remove(presRef); } catch(_) {}
    // Clean up signaling data
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}`)); } catch(_) {}
    try { remove(ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`)); } catch(_) {}
    // Clean up Firestore boxRequest
    const requestId = `${_roomId}_${_user.uid}`;
    try { deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}
  }

  // Stop local guest media tracks
  if (_guestStream) {
    try { _guestStream.getTracks().forEach(t => t.stop()); } catch(_) {}
    _guestStream = null;
  }

  // Hide guest controls, restore Request a Box button
  if (D.btnGuestCam)  D.btnGuestCam.style.display  = 'none';
  if (D.btnGuestMic)  D.btnGuestMic.style.display  = 'none';
  if (D.btnLeaveBox)  D.btnLeaveBox.style.display   = 'none';
  if (D.btnRequestBox) {
    D.btnRequestBox.style.display = '';
    D.btnRequestBox.classList.remove('pending');
  }
  if (D.btnRequestBoxLabel) D.btnRequestBoxLabel.textContent = 'Request a Box';

  toast('You left the guest box.');
}

/* ── VIEWER: Join as a guest box (answerer) ── */
async function _guestJoinAsViewer() {
  if (!_user || !_roomId) return;

  let guestStream;
  try {
    guestStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true,
    });
  } catch (e) {
    console.error('[GuestBox] getUserMedia failed:', e.name, e.message);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError') {
      toast('❌ Camera & mic access denied. Allow in browser settings.');
    } else if (e.name === 'NotFoundError') {
      toast('❌ No camera/mic found on this device.');
    } else {
      toast('❌ Could not access camera. Please try again.');
    }
    return;
  }

  // Store stream so cam/mic toggles work
  _guestStream = guestStream;
  _guestCamOn  = true;
  _guestMicOn  = true;

  const sigRef = ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}`);
  const MAX_WAIT = 10000;
  const startedAt = Date.now();

  // Wait for offer from host
  const _waitForOffer = () => new Promise((resolve, reject) => {
    const unsub = onValue(sigRef, snap => {
      if (!snap.exists() || !snap.val().offer) return;
      off(sigRef, unsub);
      resolve(snap.val());
    });
    setTimeout(() => { off(sigRef, unsub); reject(new Error('offer timeout')); }, MAX_WAIT);
  });

  let sigData;
  try { sigData = await _waitForOffer(); }
  catch (e) { toast('Host did not respond in time.'); guestStream.getTracks().forEach(t=>t.stop()); return; }

  const guestPc = new RTCPeerConnection(_ICE_SERVERS);

  // Add local tracks
  guestStream.getTracks().forEach(t => guestPc.addTrack(t, guestStream));

  const _pendingCands = [];
  let _answerWritten = false;

  guestPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_answerWritten) { _pendingCands.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}/guestCandidates`), e.candidate.toJSON()); } catch(_) {}
  };

  try {
    await guestPc.setRemoteDescription(new RTCSessionDescription(sigData.offer));
  } catch(e) { toast('Connection error.'); guestPc.close(); guestStream.getTracks().forEach(t=>t.stop()); return; }

  const answer = await guestPc.createAnswer();
  await guestPc.setLocalDescription(answer);

  try {
    await update(sigRef, { answer: { type: answer.type, sdp: answer.sdp } });
    _answerWritten = true;
  } catch(e) { toast('Connection error.'); guestPc.close(); guestStream.getTracks().forEach(t=>t.stop()); return; }

  // Flush pending candidates
  for (const c of _pendingCands) {
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}/guestCandidates`), c); } catch(_) {}
  }
  _pendingCands.length = 0;

  // Apply existing host candidates
  const appliedHostCands = new Set();
  const hc = sigData.hostCandidates || {};
  for (const [k, c] of Object.entries(hc)) {
    appliedHostCands.add(k);
    try { await guestPc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
  }

  // Listen for more host candidates — store unsub so _guestDoLeave can clean up
  if (_guestSigUnsub) { try { off(sigRef); } catch(_) {} _guestSigUnsub = null; }
  _guestSigUnsub = onValue(sigRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.hostCandidates) {
      for (const [k, c] of Object.entries(d.hostCandidates)) {
        if (appliedHostCands.has(k)) continue;
        appliedHostCands.add(k);
        try { await guestPc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
      }
    }
  });

  // Store peer connection so disconnect handler can clean up
  _guestPc = guestPc;

  // ── Publish own presence to RTDB so everyone (incl. self) sees this box ──
  const guestName   = _userData?.displayName || _user.email?.split('@')[0] || 'Guest';
  const guestAvatar = _userData?.avatar || _userData?.profilePicture || '';
  const guestPresenceRef = ref(_liveDB, `liveGuests/${_roomId}/${_user.uid}`);
  try {
    await set(guestPresenceRef, {
      uid:      _user.uid,
      name:     guestName,
      avatar:   guestAvatar,
      camOn:    true,
      micOn:    true,
      joinedAt: Date.now(),
      hb:       Date.now(),   // initial heartbeat timestamp
    });
  } catch(_) {}

  // ── onDisconnect: RTDB automatically removes this guest's presence
  //    if the client disconnects (tab close, network loss, app kill).
  //    Fires within ~2 seconds of connection drop per Firebase RTDB guarantee.
  try { onDisconnect(guestPresenceRef).remove(); } catch(_) {}

  // ── Heartbeat: keep hb timestamp fresh so host watchdog detects live guests ──
  if (_guestHeartbeatInterval) clearInterval(_guestHeartbeatInterval);
  _guestHeartbeatInterval = setInterval(() => {
    if (!_user || !_roomId || !_guestStream) { clearInterval(_guestHeartbeatInterval); return; }
    try { update(guestPresenceRef, { hb: Date.now() }); } catch(_) {}
  }, _HEARTBEAT_INTERVAL_MS);

  // ── Subscribe to full guest grid (viewer sees all boxes including own) ──
  // If already subscribed (joined as viewer before requesting a box), it
  // is already running — the new RTDB entry above will trigger a re-render.
  // If not yet subscribed, start now.
  if (!_viewerGuestUnsub) {
    _startViewerGuestGrid();
  }

  // ── Subscribe to layout sync if not already running ──
  if (!_layoutSyncUnsub) {
    _startLayoutSync();
  }

  // ── Attach live stream to own cell once RTDB grid renders it ──
  // Poll for the cell (RTDB listener may not have fired yet)
  _attachGuestSelfStream(guestStream);

  // Show cam/mic/leave toggle buttons now that the viewer is in a box
  if (D.btnGuestCam) D.btnGuestCam.style.display = 'flex';
  if (D.btnGuestMic) D.btnGuestMic.style.display = 'flex';
  if (D.btnLeaveBox) D.btnLeaveBox.style.display  = 'flex';

  // ── Listen for host-remove signal on own signaling node ──
  // Host sets removedByHost:true when it removes this guest.
  // Guest client responds by cleaning up immediately.
  let _removedListened = false;
  const _removedRef = ref(_liveDB, `guestSignaling/${_roomId}/${_user.uid}/removedByHost`);
  onValue(_removedRef, snap => {
    if (!snap.exists() || !snap.val()) return;
    if (_removedListened) return;
    _removedListened = true;
    off(_removedRef);
    toast('The host removed you from the guest box.');
    _guestDoLeave();
  });

  // Handle peer disconnect: delegate to _guestDoLeave for consistent cleanup
  guestPc.onconnectionstatechange = () => {
    if (guestPc.connectionState === 'disconnected' || guestPc.connectionState === 'failed' || guestPc.connectionState === 'closed') {
      // Only run if _guestDoLeave hasn't already cleaned up
      if (_guestStream || _guestPc) {
        _guestDoLeave();
      }
    }
  };
}

/* ── Attach the guest's own live stream to their cell in the RTDB-driven grid ──
   The RTDB onValue callback may render the cell asynchronously; retry until found. */
function _attachGuestSelfStream(stream) {
  const uid = _user?.uid;
  if (!uid || !stream) return;

  const _tryAttach = (attempts) => {
    const grid = D.guestGrid;
    if (!grid) return;
    // Find own cell by uid (rendered by _startViewerGuestGrid)
    const cell = grid.querySelector(`.vgc-cell[data-uid="${uid}"]`);
    if (cell) {
      // Replace avatar with live video
      let vid = cell.querySelector('video');
      if (!vid) {
        vid = document.createElement('video');
        vid.autoplay = true;
        vid.muted    = true;   // mute self-preview
        vid.playsInline = true;
        // Insert before name label
        const nameEl = cell.querySelector('.vgc-name, .guest-cell-name');
        cell.insertBefore(vid, nameEl || null);
      }
      vid.srcObject = stream;
      vid.play().catch(() => {});
      // Hide camera-off overlay since stream is live
      const camOff = cell.querySelector('.vgc-cam-off');
      if (camOff) camOff.classList.remove('vgc-cam-off--visible');
      return; // done
    }
    // Cell not yet rendered — retry up to 20 times (2 seconds total)
    if (attempts > 0) {
      setTimeout(() => _tryAttach(attempts - 1), 100);
    }
  };

  _tryAttach(20);
}

/* ── HOST: Listen for incoming guest requests (Firestore + RTDB) ── */
function _hostListenForGuestRequests() {
  if (!_roomId || !_user) return;
  console.log('[BoxRequest] Host listening for guest requests on roomId:', _roomId);

  // Reset the seen-UID tracker when starting a new listen session
  _shownReqUids.clear();

  // Start the stale-guest watchdog — cleans up ghost boxes every 10 s
  _startHostGuestWatchdog();

  // ── Primary listener: Firestore boxRequests ──
  const fsReqQuery = query(
    collection(_db, 'boxRequests'),
    where('liveId',  '==', _roomId),
    where('hostId',  '==', _user.uid),
    where('status',  '==', 'pending')
  );

  const fsUnsub = onSnapshot(fsReqQuery, snap => {
    snap.docChanges().forEach(change => {
      if (change.type === 'added') {
        const d = change.doc.data();
        console.log('[BoxRequest] Request received by host from viewer:', d.viewerId, 'name:', d.viewerName);
        if (!_shownReqUids.has(d.viewerId)) {
          _shownReqUids.add(d.viewerId);
          _hostShowRequestCard({
            uid:        d.viewerId,
            name:       d.viewerName,
            avatar:     d.viewerProfileImage || '',
            requestId:  change.doc.id,
            status:     'pending',
          });
        }
      }
    });
  }, err => {
    console.error('[BoxRequest] Firestore boxRequests listener error:', err.code, err.message);
  });

  // ── Fallback: RTDB guestRequests (only fires on child_added, not all value changes) ──
  const rtdbReqsRef = ref(_liveDB, `guestRequests/${_roomId}`);
  // Use onChildAdded (via onValue snapshot forEach for new items only)
  // To avoid duplicates we check _shownReqUids which is shared with the Firestore path
  const rtdbUnsub = onValue(rtdbReqsRef, snap => {
    if (!snap.exists()) return;
    snap.forEach(child => {
      const req = child.val();
      if (req.status === 'pending' && !_shownReqUids.has(req.uid)) {
        _shownReqUids.add(req.uid);
        _hostShowRequestCard(req);
      }
    });
  });

  // Combine both unsubs into _guestReqUnsub
  _guestReqUnsub = () => {
    try { fsUnsub(); }   catch(_) {}
    try { off(rtdbReqsRef); } catch(_) {}
    _shownReqUids.clear();
  };
}

/* ── HOST: Show a request card ── */
function _hostShowRequestCard(req) {
  const queue = D.guestRequestQueue;
  if (!queue) return;

  // Prevent duplicate cards
  if (queue.querySelector(`[data-uid="${req.uid}"]`)) return;

  const card = document.createElement('div');
  card.className = 'guest-request-card';
  card.dataset.uid = req.uid;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'guest-req-avatar';
  if (req.avatar) {
    avatarEl.style.backgroundImage = `url('${req.avatar}')`;
  } else {
    avatarEl.textContent = (req.name || '?')[0].toUpperCase();
  }

  const nameWrap = document.createElement('div');
  nameWrap.style.cssText = 'flex:1;min-width:0;';
  nameWrap.innerHTML = `
    <div class="guest-req-name">${_esc(req.name || 'Guest')}</div>
    <div class="guest-req-sub">wants to join your box</div>
  `;

  const actions = document.createElement('div');
  actions.className = 'guest-req-actions';

  const acceptBtn = document.createElement('button');
  acceptBtn.className = 'guest-req-accept';
  acceptBtn.textContent = 'Accept';
  acceptBtn.addEventListener('click', () => {
    card.remove();
    _hostAcceptGuest(req);  // req carries requestId
  });

  const declineBtn = document.createElement('button');
  declineBtn.className = 'guest-req-decline';
  declineBtn.textContent = 'Decline';
  declineBtn.addEventListener('click', () => {
    card.remove();
    _hostDeclineGuest(req.uid, req.requestId);
  });

  actions.appendChild(acceptBtn);
  actions.appendChild(declineBtn);
  card.appendChild(avatarEl);
  card.appendChild(nameWrap);
  card.appendChild(actions);
  queue.appendChild(card);

  // Auto-dismiss after 30 seconds
  setTimeout(() => {
    if (card.parentNode) {
      card.remove();
      _hostDeclineGuest(req.uid, req.requestId);
    }
  }, 30000);
}

/* ── HOST: Accept guest ── */
async function _hostAcceptGuest(req) {
  if (!_roomId || !_localStream) return;

  // ── Cap: respect _MAX_GUESTS limit ──
  if (Object.keys(_guestPeers).length >= _MAX_GUESTS) {
    toast(`⚠️ Guest box full — max ${_MAX_GUESTS} guests.`);
    _hostDeclineGuest(req.uid, req.requestId || `${_roomId}_${req.uid}`);
    return;
  }

  const guestUid  = req.uid;
  const requestId = req.requestId || `${_roomId}_${guestUid}`;
  const sigRef    = ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}`);

  console.log('[BoxRequest] Host accepting guest:', guestUid, 'name:', req.name);

  // ── Update Firestore boxRequest status to "accepted" ──
  try {
    await updateDoc(doc(_db, 'boxRequests', requestId), { status: 'accepted' });
    console.log('[BoxRequest] Firestore boxRequest status → accepted');
  } catch (e) {
    console.error('[BoxRequest] Could not update Firestore boxRequest (accepted):', e.code, e.message);
  }

  // ── Update RTDB guestRequest status to "accepted" ──
  try { await update(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`), { status: 'accepted' }); } catch(_) {}

  console.log('[BoxRequest] Guest added to box — starting WebRTC signaling for:', guestUid);

  // Create peer connection for this guest
  const guestPc = new RTCPeerConnection(_ICE_SERVERS);

  // Receive guest's video track
  guestPc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    _hostAddGuestCell(guestUid, req.name || 'Guest', req.avatar || '', stream, guestPc);
  };

  const _pendingHostCands = [];
  let _offerWritten = false;

  guestPc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!_offerWritten) { _pendingHostCands.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}/hostCandidates`), e.candidate.toJSON()); } catch(_) {}
  };

  const offer = await guestPc.createOffer({ offerToReceiveVideo: true, offerToReceiveAudio: true });
  await guestPc.setLocalDescription(offer);

  try {
    await set(sigRef, { offer: { type: offer.type, sdp: offer.sdp }, guestCandidates: {}, hostCandidates: {} });
    _offerWritten = true;
  } catch(e) { toast('Could not connect guest.'); guestPc.close(); return; }

  // Flush pending host candidates
  for (const c of _pendingHostCands) {
    try { await push(ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}/hostCandidates`), c); } catch(_) {}
  }
  _pendingHostCands.length = 0;

  // Watch for guest answer + ICE — store unsub so _hostDoRemoveGuest can clean up
  const appliedGuestCands = new Set();
  const _hostGuestSigUnsub = onValue(sigRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.answer && guestPc.remoteDescription === null) {
      try { await guestPc.setRemoteDescription(new RTCSessionDescription(d.answer)); } catch(_) {}
    }
    if (guestPc.remoteDescription && d.guestCandidates) {
      for (const [k, c] of Object.entries(d.guestCandidates)) {
        if (appliedGuestCands.has(k)) continue;
        appliedGuestCands.add(k);
        try { await guestPc.addIceCandidate(new RTCIceCandidate(c)); } catch(_) {}
      }
    }
  });
  _hostSigUnsubs[guestUid] = _hostGuestSigUnsub;

  // Store peer
  _guestPeers[guestUid] = { pc: guestPc, name: req.name, avatar: req.avatar };

  // ── Publish guest presence to RTDB so viewers can see the new box ──
  try {
    await set(ref(_liveDB, `liveGuests/${_roomId}/${guestUid}`), {
      uid:       guestUid,
      name:      req.name  || 'Guest',
      avatar:    req.avatar || '',
      camOn:     true,
      micOn:     true,
      joinedAt:  Date.now(),
    });
  } catch(_) {}

  toast(`✅ ${req.name || 'Guest'} joined!`);
}

/* ── HOST: Decline guest ── */
async function _hostDeclineGuest(guestUid, requestId) {
  const reqId = requestId || `${_roomId}_${guestUid}`;
  console.log('[BoxRequest] Host declining guest:', guestUid);

  // ── Update Firestore boxRequest status to "declined" ──
  try {
    await updateDoc(doc(_db, 'boxRequests', reqId), { status: 'declined' });
    console.log('[BoxRequest] Firestore boxRequest status → declined, viewer will be notified');
  } catch (e) {
    console.error('[BoxRequest] Could not update Firestore boxRequest (declined):', e.code, e.message);
  }

  // ── Update RTDB status → declined, then remove ──
  try { await update(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`), { status: 'declined' }); } catch(_) {}
  setTimeout(async () => {
    try { await remove(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`)); } catch(_) {}
    // Clean up Firestore doc after 5s (viewer has had time to see the declined status)
    try { await deleteDoc(doc(_db, 'boxRequests', reqId)); } catch(_) {}
  }, 5000);
}

/* ── HOST: Add a guest cell to the video grid ── */
function _hostAddGuestCell(uid, name, avatar, stream, pc) {
  const grid = D.guestGrid;
  if (!grid) return;

  // If grid doesn't yet have host, add host cell first
  if (!grid.querySelector('.host-cell')) {
    _addHostCellToGrid();
  }

  // Prevent duplicate guest cells
  if (grid.querySelector(`[data-uid="${uid}"]`)) return;

  grid.classList.add('has-guests');
  grid.dataset.count = (Object.keys(_guestPeers).length).toString();

  const cell = document.createElement('div');
  cell.className = 'guest-cell';
  cell.dataset.uid = uid;

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = false;
  vid.playsInline = true;
  vid.srcObject = stream;
  vid.play().catch(()=>{});
  cell.appendChild(vid);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = name || 'Guest';
  cell.appendChild(nameEl);

  // Host can remove a guest by tapping ✕
  const removeBtn = document.createElement('button');
  removeBtn.className = 'guest-cell-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Remove guest';
  removeBtn.addEventListener('click', () => {
    _hostRemoveGuest(uid);
  });
  cell.appendChild(removeBtn);

  grid.appendChild(cell);

  // Store stream ref
  if (_guestPeers[uid]) _guestPeers[uid].stream = stream;
  if (_guestPeers[uid]) _guestPeers[uid].cell   = cell;

  _applyGuestLayout();

  // ── Fast disconnect detection: connectionstatechange fires within ~1-2 s ──
  let _dcTimer = null;
  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    if (state === 'disconnected') {
      // Give a 1.5 s grace period — WebRTC may briefly disconnect then recover
      if (!_dcTimer) {
        _dcTimer = setTimeout(() => {
          _dcTimer = null;
          // Only remove if still disconnected (not reconnected or already removed)
          if (pc.connectionState !== 'connected' && _guestPeers[uid]) {
            _hostDoRemoveGuest(uid);
          }
        }, 1500);
      }
    } else if (state === 'failed' || state === 'closed') {
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
      _hostDoRemoveGuest(uid);
    } else if (state === 'connected') {
      // Recovered — cancel any pending removal
      if (_dcTimer) { clearTimeout(_dcTimer); _dcTimer = null; }
    }
  };
}

/* ── HOST: Add own video as the host cell in the grid ── */
function _addHostCellToGrid() {
  const grid = D.guestGrid;
  if (!grid || grid.querySelector('.host-cell')) return;

  const cell = document.createElement('div');
  cell.className = 'guest-cell host-cell';

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = true;   // mute self-preview
  vid.playsInline = true;
  if (_localStream) { vid.srcObject = _localStream; vid.play().catch(()=>{}); }
  // Mirror host camera (same as main #liveVideo)
  vid.style.transform = 'scaleX(-1)';
  cell.appendChild(vid);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = (_userData?.displayName || 'Host') + ' (You)';
  cell.appendChild(nameEl);

  grid.insertBefore(cell, grid.firstChild);
}

/* ── HOST: Remove a guest (with confirmation) ── */
async function _hostRemoveGuest(uid) {
  const peer = _guestPeers[uid];
  const guestName = peer?.name || 'this guest';

  const confirmed = await _snxConfirm({
    icon:    '✕',
    title:   `Remove ${guestName}?`,
    sub:     'They will be disconnected from the guest box.',
    okLabel: 'Remove',
    okClass: '',
  });
  if (!confirmed) return;

  _hostDoRemoveGuest(uid);
}

/* ── Internal: perform the host-side guest removal ── */
function _hostDoRemoveGuest(uid) {
  // ── Signal the guest client to disconnect gracefully ──
  // Write removedByHost flag BEFORE closing the peer so the guest's listener fires
  try {
    set(ref(_liveDB, `guestSignaling/${_roomId}/${uid}/removedByHost`), true);
  } catch(_) {}

  // Tear down host-side signaling listener for this guest
  if (_hostSigUnsubs[uid]) {
    try { _hostSigUnsubs[uid](); } catch(_) {}
    delete _hostSigUnsubs[uid];
  }

  const peer = _guestPeers[uid];
  if (peer) {
    if (peer.pc) { try { peer.pc.close(); } catch(_){} }
    // Animate cell out (≤260ms) then remove — gives immediate visual feedback
    if (peer.cell && !peer.cell.classList.contains('removing')) {
      peer.cell.classList.add('removing');
      // Update count + re-layout immediately so remaining boxes rearrange without waiting
      delete _guestPeers[uid];
      const grid = D.guestGrid;
      if (grid) {
        const updatedCount = Object.keys(_guestPeers).length;
        grid.dataset.count = updatedCount.toString();
        if (updatedCount === 0) {
          grid.classList.remove('has-guests');
          if (D.liveVideo) { D.liveVideo.style.opacity = ''; D.liveVideo.style.pointerEvents = ''; }
        }
        _applyGuestLayout();
      }
      setTimeout(() => {
        try { peer.cell.remove(); } catch(_){}
        // Final layout pass once the DOM node is gone
        _applyGuestLayout();
      }, 260);
    } else {
      delete _guestPeers[uid];
      if (peer.cell) { try { peer.cell.remove(); } catch(_){} }
    }
  } else {
    // peer already cleaned up; just delete key if present
    delete _guestPeers[uid];
  }
  // Allow this UID to send a new request in a future session
  _shownReqUids.delete(uid);
  try { remove(ref(_liveDB, `guestRequests/${_roomId}/${uid}`)); }  catch(_) {}
  // Remove signaling AFTER a short delay so the guest client can read the removedByHost flag
  setTimeout(() => {
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${uid}`)); } catch(_) {}
  }, 3000);
  // Remove guest presence so viewers' grids update instantly
  try { remove(ref(_liveDB, `liveGuests/${_roomId}/${uid}`)); } catch(_) {}
  // Clean up Firestore boxRequest
  const requestId = `${_roomId}_${uid}`;
  try { deleteDoc(doc(_db, 'boxRequests', requestId)); } catch(_) {}

  const grid = D.guestGrid;
  if (!grid) return;
  const guestCount = Object.keys(_guestPeers).length;
  grid.dataset.count = guestCount.toString();

  if (guestCount === 0) {
    // Remove host cell too, show plain main video
    grid.querySelector('.host-cell')?.remove();
    grid.classList.remove('has-guests');
    if (D.liveVideo) { D.liveVideo.style.opacity = ''; D.liveVideo.style.pointerEvents = ''; }
  }
  _applyGuestLayout();
}

/* ── HOST: Start the stale-guest watchdog ──
   Runs every 10 s and evicts any guest whose heartbeat (hb) timestamp
   is older than _STALE_THRESHOLD_MS.  Protects against ghosts from
   hard-crashes / silent network drops that don't trigger onDisconnect. */
function _startHostGuestWatchdog() {
  if (!_roomId) return;
  if (_hostWatchdogInterval) clearInterval(_hostWatchdogInterval);

  _hostWatchdogInterval = setInterval(async () => {
    if (!_roomId) return;
    try {
      const snap = await get(ref(_liveDB, `liveGuests/${_roomId}`));
      if (!snap.exists()) return;
      const now = Date.now();
      snap.forEach(child => {
        const g = child.val();
        if (g.isHost) return;   // never evict host entry
        const uid = child.key;
        if (!g.hb) return;      // older guest entries without hb — skip
        if (now - g.hb > _STALE_THRESHOLD_MS) {
          console.log('[GuestWatchdog] Stale guest detected, evicting:', uid);
          // Remove RTDB presence — RTDB onValue in viewers fires instantly
          try { remove(ref(_liveDB, `liveGuests/${_roomId}/${uid}`)); } catch(_) {}
          // If this guest has an active peer on this host, tear it down too
          if (_guestPeers[uid]) {
            _hostDoRemoveGuest(uid);
          }
        }
      });
    } catch(_) {}
  }, 10000); // check every 10 s
}

/* ── Tear down all guest peers (called on endLive) ── */
function _teardownAllGuestPeers() {
  // Stop the stale-guest watchdog
  if (_hostWatchdogInterval) { clearInterval(_hostWatchdogInterval); _hostWatchdogInterval = null; }

  // Tear down all host-side signaling listeners
  for (const uid of Object.keys(_hostSigUnsubs)) {
    try { _hostSigUnsubs[uid](); } catch(_) {}
  }
  _hostSigUnsubs = {};

  for (const uid of Object.keys(_guestPeers)) {
    const p = _guestPeers[uid];
    if (p.pc)   { try { p.pc.close(); }   catch(_){} }
    if (p.cell) { try { p.cell.remove(); } catch(_){} }
  }
  _guestPeers = {};
  if (D.guestGrid) {
    D.guestGrid.innerHTML = '';
    D.guestGrid.classList.remove('has-guests');
    D.guestGrid.dataset.count = '0';
  }
  // Clean up all signaling + requests + guest presence for this room (RTDB)
  if (_roomId) {
    try { remove(ref(_liveDB, `guestRequests/${_roomId}`)); }  catch(_) {}
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}`)); } catch(_) {}
    try { remove(ref(_liveDB, `liveGuests/${_roomId}`)); }     catch(_) {}
  }
  // Clean up all pending Firestore boxRequests for this room
  if (_roomId) {
    getDocs(query(
      collection(_db, 'boxRequests'),
      where('liveId', '==', _roomId)
    )).then(snap => {
      snap.forEach(d => { try { deleteDoc(d.ref); } catch(_) {} });
    }).catch(() => {});
  }
}

/* ═══════════════════════════════════════════════════════════════════
   LAYOUT ENGINE  —  supports 1–9 guests + host (up to 10 total cells)
   ═══════════════════════════════════════════════════════════════════ */

function _applyGuestLayout() {
  // Coalesce rapid back-to-back calls into a single rAF paint
  if (_layoutRafId) return;
  _layoutRafId = requestAnimationFrame(() => {
    _layoutRafId = null;
    _doApplyGuestLayout();
  });
}

/* ── Wire a ResizeObserver so guest boxes re-layout when the
   stage (or window) resizes — covers orientation changes, split-
   screen, keyboard appearing, etc.  Called once from startLive /
   _startViewer after the stage is shown. ── */
function _attachGuestGridResizeObserver() {
  const grid = D.guestGrid;
  if (!grid || !window.ResizeObserver) return;
  const container = grid.parentElement || grid;
  const ro = new ResizeObserver(() => { _applyGuestLayout(); });
  ro.observe(container);
  window.addEventListener('orientationchange', () => {
    setTimeout(_applyGuestLayout, 150);
  }, { passive: true });
}

/* ─────────────────────────────────────────────────────────────────
   _doApplyGuestLayout  —  the single source of truth for all
   geometry.  All explicit pixel / percentage assignments live here;
   CSS only provides the flex skeleton and default resets.

   Smart auto-layout map (guestCount = number of guests, host NOT counted):
     0  → grid hidden, main #liveVideo shown
     1  → 2 participants: 50/50 split
     2  → 3 participants: host 60% + 2 guests stacked in 40%
     3  → 4 participants: 2×2 equal grid
     4  → 5 participants: host top row 100%×55% + 4 guests equal bottom
     5  → 6 participants: 2 rows × 3 cols equal
     6  → 7 participants: host 50%×60% top-left + 6 guests equal right+bottom
     7  → 8 participants: 2 rows × 4 cols equal
     8  → 9 participants: 3 rows × 3 cols equal
     9  → 10 participants: host top-left 33%×40% + 9 guests balanced
   ───────────────────────────────────────────────────────────────── */
function _doApplyGuestLayout() {
  const grid = D.guestGrid;
  if (!grid) return;

  // ── Shared setup for both modes ──
  grid.dataset.layout = _guestLayout;
  grid.classList.remove('box-sm', 'box-md', 'box-lg');
  grid.classList.add('box-' + _guestBoxSize);

  // ── Resolve guestCount based on mode ──
  let guestCount;
  if (_mode === 'viewer') {
    // Viewer: count is maintained by _startViewerGuestGrid via dataset.count
    guestCount = parseInt(grid.dataset.count || '0', 10);
  } else {
    // Creator: count from live _guestPeers
    guestCount = Object.keys(_guestPeers).length;
    grid.dataset.count = guestCount.toString();
  }

  if (guestCount === 0) {
    grid.classList.remove('has-guests');
    return;
  }
  grid.classList.add('has-guests');

  // ── Update guest-count indicator in layout panel ──
  _updateLayoutPanelCounter(guestCount);

  // ── Clear any previously JS-set inline styles on all cells ──
  // (CSS rules handle the base; JS overrides only when needed)
  grid.querySelectorAll('.guest-cell').forEach(c => {
    c.style.width = '';
    c.style.height = '';
    c.style.position = '';
    c.style.top = '';
    c.style.right = '';
    c.style.bottom = '';
    c.style.left = '';
    c.style.flex = '';
  });
  // Reset grid flex properties
  grid.style.flexDirection = '';
  grid.style.flexWrap      = '';
  grid.style.alignContent  = '';
  grid.style.alignItems    = '';

  const totalCells = guestCount + 1; // +1 for host

  // ── Named layout modes (host manually selected) ──
  if (_guestLayout === 'grid') {
    _applyEqualGrid(grid, totalCells);
    return;
  }
  if (_guestLayout === 'float') {
    _applyFloatLayout(grid, guestCount);
    return;
  }
  if (_guestLayout === 'split') {
    _applySplitLayout(grid, guestCount);
    return;
  }
  if (_guestLayout === 'host-full') {
    _applyHostFullLayout(grid, guestCount);
    return;
  }
  if (_guestLayout === 'host-big') {
    _applyHostBigLayout(grid, guestCount);
    return;
  }

  // ── 'auto' layout: pick best layout for current count ──
  _applyAutoLayout(grid, guestCount, totalCells);
}

/* ─────────────────────────────────────────────────────────────────
   AUTO LAYOUT  —  smart geometry for every count 1–9
   ───────────────────────────────────────────────────────────────── */
function _applyAutoLayout(grid, guestCount, totalCells) {
  const stageW = grid.offsetWidth  || window.innerWidth;
  const stageH = grid.offsetHeight || window.innerHeight;
  const isLandscape = stageW >= stageH;

  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  switch (guestCount) {

    /* ── 1 guest: 50/50 side-by-side ── */
    case 1: {
      grid.style.flexDirection = 'row';
      grid.style.flexWrap      = 'nowrap';
      grid.style.alignItems    = 'stretch';
      if (hostCell)       { hostCell.style.width = '50%';  hostCell.style.height = '100%'; }
      if (guestCells[0])  { guestCells[0].style.width = '50%'; guestCells[0].style.height = '100%'; }
      break;
    }

    /* ── 2 guests: host 60% left + 2 guests stacked right ── */
    case 2: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'stretch';
        if (hostCell)       { hostCell.style.width = '60%';  hostCell.style.height = '100%'; }
        guestCells.forEach(c => { c.style.width = '40%'; c.style.height = '50%'; });
      } else {
        // Portrait: host full top row, guests side-by-side below
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell)       { hostCell.style.width = '100%'; hostCell.style.height = '55%'; }
        guestCells.forEach(c => { c.style.width = '50%'; c.style.height = '45%'; });
      }
      break;
    }

    /* ── 3 guests: 2×2 grid ── */
    case 3: {
      _applyEqualGrid(grid, 4);
      break;
    }

    /* ── 4 guests: host full top + 4 equal bottom ── */
    case 4: {
      grid.style.flexDirection = 'row';
      grid.style.flexWrap      = 'wrap';
      grid.style.alignContent  = 'flex-start';
      if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = '55%'; }
      guestCells.forEach(c => { c.style.width = '25%'; c.style.height = '45%'; });
      break;
    }

    /* ── 5 guests: 2 rows × 3 cols equal (6 cells) ── */
    case 5: {
      _applyEqualGrid(grid, 6);
      break;
    }

    /* ── 6 guests: host prominent top-left + 6 guests ──
       Portrait: host top 100%×40%, 3 guests per row below
       Landscape: host left 50%×60% + 6 guests on right in 3×2 */
    case 6: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '50%'; hostCell.style.height = '66.67%'; }
        // 3 guests on right, 3 below
        guestCells.forEach((c, i) => {
          if (i < 3) { c.style.width = '16.67%'; c.style.height = '66.67%'; }
          else       { c.style.width = '16.67%'; c.style.height = '33.33%'; }
        });
      } else {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = '40%'; }
        guestCells.forEach(c => { c.style.width = '33.33%'; c.style.height = '30%'; });
      }
      break;
    }

    /* ── 7 guests: 2 rows × 4 cols equal (8 cells) ── */
    case 7: {
      _applyEqualGrid(grid, 8);
      break;
    }

    /* ── 8 guests: 3×3 equal (9 cells total) ── */
    case 8: {
      _applyEqualGrid(grid, 9);
      break;
    }

    /* ── 9 guests: host top-left prominent + 9 guests ──
       Portrait: host top 100%×33% + 3 rows of 3 below
       Landscape: host left 33%×40% + 3 cols of 3 on right */
    case 9: {
      if (isLandscape) {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '34%'; hostCell.style.height = '66.67%'; }
        guestCells.forEach((c, i) => {
          if (i < 3) { c.style.width = '22%';  c.style.height = '66.67%'; }
          else       { c.style.width = '22%';  c.style.height = '33.33%'; }
        });
      } else {
        grid.style.flexDirection = 'row';
        grid.style.flexWrap      = 'wrap';
        grid.style.alignContent  = 'flex-start';
        if (hostCell) { hostCell.style.width = '100%'; hostCell.style.height = '33%'; }
        guestCells.forEach(c => { c.style.width = '33.33%'; c.style.height = '22.33%'; });
      }
      break;
    }

    default: {
      // Fallback for counts beyond 9 (should not happen given _MAX_GUESTS cap)
      _applyEqualGrid(grid, totalCells);
    }
  }
}

/* ─────────────────────────────────────────────────────────────────
   NAMED LAYOUT HELPERS
   ───────────────────────────────────────────────────────────────── */

/* Equal grid: calculate optimal rows/cols then set dimensions */
function _applyEqualGrid(grid, totalCells) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  // Pick cols to minimise wasted space given aspect ratio
  const cols     = Math.ceil(Math.sqrt(totalCells * (stageW / Math.max(1, stageH))));
  const colsClamped = Math.max(1, Math.min(totalCells, cols));
  const rows     = Math.ceil(totalCells / colsClamped);
  const w        = (100 / colsClamped).toFixed(4) + '%';
  const h        = (100 / rows).toFixed(4) + '%';
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'wrap';
  grid.style.alignContent  = 'stretch';
  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = w;
    cell.style.height = h;
  });
}

/* Split: side-by-side — works well when guestCount ≤ 2 */
function _applySplitLayout(grid, guestCount) {
  const cells = Array.from(grid.querySelectorAll('.guest-cell'));
  const n     = cells.length;
  if (n === 0) return;
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'stretch';
  const w = (100 / n).toFixed(4) + '%';
  cells.forEach(c => { c.style.width = w; c.style.height = '100%'; });
}

/* Host full-screen — guests as responsive floating tiles */
function _applyHostFullLayout(grid, guestCount) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  const hostCell = grid.querySelector('.host-cell');
  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  // Tile size: shrink when many guests to avoid overflow
  const maxPerRow  = Math.min(guestCount, Math.ceil(Math.sqrt(guestCount * 2)));
  const baseW      = Math.max(60, Math.min(160, Math.floor(stageW * 0.18)));
  const tileW      = Math.floor(baseW * (maxPerRow > 4 ? 0.75 : 1));
  const tileH      = Math.floor(tileW * 0.75);
  const gap        = Math.max(4, Math.floor(stageW * 0.012));
  const cols       = Math.max(1, Math.floor((stageW - gap) / (tileW + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.right    = (gap + col * (tileW + gap)) + 'px';
    cell.style.top      = (gap + row * (tileH + gap)) + 'px';
    cell.style.bottom   = 'auto';
    cell.style.left     = 'auto';
    i++;
  });
}

/* Host Big: host takes most of the width, guests in a vertical strip */
function _applyHostBigLayout(grid, guestCount) {
  const stageW     = grid.offsetWidth  || window.innerWidth;
  const hostCell   = grid.querySelector('.host-cell');
  const guestCells = Array.from(grid.querySelectorAll('.guest-cell:not(.host-cell)'));

  // Strip width: clamp to avoid tiny guest tiles
  const stripW = Math.max(80, Math.min(200, Math.floor(stageW * 0.22)));
  grid.style.flexDirection = 'row';
  grid.style.flexWrap      = 'nowrap';
  grid.style.alignItems    = 'stretch';

  if (hostCell) {
    hostCell.style.flex   = '1';
    hostCell.style.height = '100%';
  }

  // Stack guests in the strip — if more than 5, split into 2 sub-columns
  const subCols  = guestCount > 5 ? 2 : 1;
  const gH       = (100 / Math.ceil(guestCount / subCols)).toFixed(4) + '%';
  const gW       = (stripW / subCols) + 'px';
  guestCells.forEach(c => {
    c.style.width  = gW;
    c.style.height = gH;
    c.style.flex   = 'none';
  });
}

/* Float layout: cascade guest boxes from top-right, responsive */
function _applyFloatLayout(grid, guestCount) {
  const stageW   = grid.offsetWidth  || window.innerWidth;
  const stageH   = grid.offsetHeight || window.innerHeight;
  const hostCell = grid.querySelector('.host-cell');

  if (hostCell) {
    hostCell.style.position = 'absolute';
    hostCell.style.inset    = '0';
    hostCell.style.width    = '100%';
    hostCell.style.height   = '100%';
  }

  // Scale tile size down for more guests
  const base    = Math.max(55, Math.min(160, Math.floor(stageW * 0.20)));
  const tileW   = guestCount > 5 ? Math.floor(base * 0.75) : base;
  const tileH   = Math.floor(tileW * 0.75);
  const gap     = Math.max(4, Math.floor(stageW * 0.012));
  const cols    = Math.max(1, Math.floor((stageW - gap) / (tileW + gap)));

  let i = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    cell.style.position = 'absolute';
    cell.style.width    = tileW + 'px';
    cell.style.height   = tileH + 'px';
    cell.style.right    = (gap + col * (tileW + gap)) + 'px';
    cell.style.top      = (gap + row * (tileH + gap)) + 'px';
    cell.style.bottom   = 'auto';
    cell.style.left     = 'auto';
    i++;
  });
}

/* ── Update the guest count indicator inside the layout panel ── */
function _updateLayoutPanelCounter(guestCount) {
  const el = document.getElementById('_guestCountIndicator');
  if (el) {
    el.textContent = `${guestCount} / ${_MAX_GUESTS} guest${guestCount === 1 ? '' : 's'}`;
    el.style.color = guestCount >= _MAX_GUESTS ? '#ff6677' : '#00AEEF';
  }
}

/* ── Toggle layout panel ── */
function _toggleLayoutPanel() {
  _layoutPanelOpen ? _closeLayoutPanel() : _openLayoutPanel();
}

function _openLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'block';
  _layoutPanelOpen = true;
  if (D.btnLayoutSettings) D.btnLayoutSettings.classList.add('has-guests');
  // Refresh counter whenever panel opens
  const guestCount = _mode === 'creator'
    ? Object.keys(_guestPeers).length
    : parseInt(D.guestGrid?.dataset.count || '0', 10);
  _updateLayoutPanelCounter(guestCount);
}

function _closeLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'none';
  _layoutPanelOpen = false;
}

/* ═══════════════════════════════════════════════════════════════════
   LIVE TIMER
   — Tracks how long the live has been running.
   — Controlled by the host via the Settings panel toggle.
   — Displays in the top bar (host only).
   ═══════════════════════════════════════════════════════════════════ */

let _liveTimerEnabled  = false;   // host's preference (ON/OFF toggle)
let _liveTimerInterval = null;    // setInterval handle
let _liveTimerStart    = 0;       // Date.now() when live started

function _liveTimerSetEnabled(on) {
  _liveTimerEnabled = on;
  const badge = document.getElementById('liveTimerDisplay');
  if (!badge) return;
  if (on) {
    badge.classList.add('visible');
    // If the live is already running, start counting.
    // If _liveTimerStart was never set (live started before timer was enabled),
    // initialize it now so the counter starts from 0 rather than showing a huge number.
    if (_roomId) {
      if (!_liveTimerStart) _liveTimerStart = Date.now();
      _liveTimerRun();
    }
  } else {
    badge.classList.remove('visible');
    if (_liveTimerInterval) { clearInterval(_liveTimerInterval); _liveTimerInterval = null; }
    const txt = document.getElementById('liveTimerText');
    if (txt) txt.textContent = '00:00:00';
  }
}

function _liveTimerOnLiveStart() {
  _liveTimerStart = Date.now();
  if (_liveTimerEnabled) _liveTimerRun();
}

function _liveTimerOnLiveEnd() {
  if (_liveTimerInterval) { clearInterval(_liveTimerInterval); _liveTimerInterval = null; }
  const badge = document.getElementById('liveTimerDisplay');
  if (badge) badge.classList.remove('visible');
  const txt = document.getElementById('liveTimerText');
  if (txt) txt.textContent = '00:00:00';
}

function _liveTimerRun() {
  if (_liveTimerInterval) clearInterval(_liveTimerInterval);
  const txt = document.getElementById('liveTimerText');
  if (!txt) return;

  const tick = () => {
    const secs = Math.floor((Date.now() - _liveTimerStart) / 1000);
    const h    = Math.floor(secs / 3600);
    const m    = Math.floor((secs % 3600) / 60);
    const s    = secs % 60;
    txt.textContent =
      String(h).padStart(2, '0') + ':' +
      String(m).padStart(2, '0') + ':' +
      String(s).padStart(2, '0');
  };
  tick();
  _liveTimerInterval = setInterval(tick, 1000);
}


/* ═══════════════════════════════════════════════════════════════════
   AI SAFETY SYSTEM
   — Monitors incoming live chat from Firestore in real time.
   — Detects spam, harassment, threats, hate speech, doxxing.
   — Shows a PRIVATE popup to the host only.
   — Host chooses: Ignore / Warn user / Remove comment / Remove guest.
   — Does NOT auto-punish users without host approval.
   — Completely separate from the existing client-side send-time scanner.
   ═══════════════════════════════════════════════════════════════════ */

let _aiSafetyEnabled   = false;    // host toggle
let _aiSafetyChatUnsub = null;     // Firestore listener handle
let _aiSafetySeenIds   = new Set(); // already-processed message IDs

/* Enable / disable the system */
function _aiSafetySetEnabled(on) {
  _aiSafetyEnabled = on;
  const badge = document.getElementById('aiSafetyBadge');
  if (badge) badge.classList.toggle('visible', on);
  if (on) {
    if (_roomId) _aiSafetyStartMonitor();
  } else {
    _aiSafetyStopMonitor();
  }
}

/* Called when live starts — starts monitor if already enabled */
function _aiSafetyOnLiveStart() {
  if (_aiSafetyEnabled && _roomId) _aiSafetyStartMonitor();
}

/* Called when live ends — clean up */
function _aiSafetyOnLiveEnd() {
  _aiSafetyStopMonitor();
  _aiSafetySeenIds.clear();
  const badge = document.getElementById('aiSafetyBadge');
  if (badge) badge.classList.remove('visible');
}

function _aiSafetyStopMonitor() {
  if (_aiSafetyChatUnsub) {
    try { _aiSafetyChatUnsub(); } catch(_) {}
    _aiSafetyChatUnsub = null;
  }
}

function _aiSafetyStartMonitor() {
  _aiSafetyStopMonitor();
  if (!_roomId || _mode !== 'creator') return;

  // Subscribe to live messages — last 50, ordered newest last
  // We only alert on messages we haven't seen yet (added after system enabled)
  const messagesRef = collection(_db, 'liveRooms', _roomId, 'liveMessages');
  const q = query(messagesRef, orderBy('createdAt', 'desc'), limit(50));

  let _firstSnapshot = true;

  _aiSafetyChatUnsub = onSnapshot(q, snap => {
    // Skip the very first snapshot (historical messages already on screen)
    if (_firstSnapshot) {
      _firstSnapshot = false;
      // Seed seen IDs so we don't alert on any existing messages
      snap.docs.forEach(d => _aiSafetySeenIds.add(d.id));
      return;
    }

    snap.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const docId = change.doc.id;
      if (_aiSafetySeenIds.has(docId)) return;
      _aiSafetySeenIds.add(docId);

      const data = change.doc.data();
      // Skip system messages and own messages
      if (data.type === 'system') return;
      if (data.userId === _user?.uid) return;

      const hit = _liveScanText(data.text || '');
      if (!hit) return;

      // Show private warning popup to host
      _aiSafetyShowWarning(hit, data, docId);
    });
  }, () => {});
}

/* Show the private warning popup to the host */
function _aiSafetyShowWarning(rule, msgData, docId) {
  // Don't stack: dismiss existing one first
  const old = document.getElementById('_snxSafetyOverlay');
  if (old) old.remove();

  const overlay = document.createElement('div');
  overlay.id = '_snxSafetyOverlay';
  overlay.className = 'snx-safety-overlay';

  const userName  = msgData.userName || 'Unknown User';
  const msgText   = msgData.text     || '';
  const msgUserId = msgData.userId   || '';

  // Severity icon
  const icon = rule.severity === 'block' ? '🚫' : '⚠️';

  overlay.innerHTML = `
    <div class="snx-safety-box">
      <div class="snx-safety-header">
        <div class="snx-safety-icon">${icon}</div>
        <div class="snx-safety-title-block">
          <div class="snx-safety-title">AI Safety Alert</div>
          <div class="snx-safety-category">${rule.category} · ${rule.severity === 'block' ? 'High Risk' : 'Warning'}</div>
        </div>
      </div>
      <div class="snx-safety-body">
        <div class="snx-safety-label">Flagged Message</div>
        <div class="snx-safety-text">${_escapeHtml(msgText)}</div>
      </div>
      <div class="snx-safety-user-row">
        <span style="font-size:16px">👤</span>
        <div class="snx-safety-user-name">${_escapeHtml(userName)}</div>
        <span style="font-size:10px;color:#4a7a9a;">user</span>
      </div>
      <div class="snx-safety-actions">
        <button class="snx-safety-btn snx-safety-btn-ignore" data-action="ignore">Ignore</button>
        <button class="snx-safety-btn snx-safety-btn-warn"   data-action="warn">Warn User</button>
        <button class="snx-safety-btn snx-safety-btn-del"    data-action="delete">Remove Comment</button>
        <button class="snx-safety-btn snx-safety-btn-kick"   data-action="kick">Remove Guest</button>
      </div>
    </div>
  `;

  overlay.querySelectorAll('.snx-safety-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      overlay.remove();
      const action = btn.dataset.action;

      if (action === 'ignore') {
        // Host chose to ignore — no action
        return;
      }

      if (action === 'warn') {
        // Send a system warning message visible to everyone in chat
        try {
          await addDoc(collection(_db, 'liveRooms', _roomId, 'liveMessages'), {
            userId:    _user.uid,
            userName:  'Safety Bot',
            text:      `⚠️ Please keep the community safe and respectful.`,
            type:      'system',
            createdAt: serverTimestamp(),
          });
        } catch(_) {}
        toast('⚠️ Warning sent to chat.');
        return;
      }

      if (action === 'delete') {
        // Delete the flagged message from Firestore
        try {
          await deleteDoc(doc(_db, 'liveRooms', _roomId, 'liveMessages', docId));
          toast('🗑 Comment removed.');
        } catch(_) {
          toast('Could not remove comment.');
        }
        return;
      }

      if (action === 'kick') {
        // Host must confirm before removing a guest
        if (!msgUserId) { toast('Cannot identify user to remove.'); return; }
        const confirmed = await _snxConfirm({
          icon:    '🚫',
          title:   `Remove ${userName} from this live?`,
          sub:     `They will be disconnected and cannot rejoin. This action cannot be undone.`,
          okLabel: 'Remove',
          okClass: '',
        });
        if (!confirmed) return;

        // Remove from guest boxes if present
        if (_guestPeers[msgUserId]) {
          _hostDoRemoveGuest(msgUserId);
        }
        // Delete the flagged message as well
        try {
          await deleteDoc(doc(_db, 'liveRooms', _roomId, 'liveMessages', docId));
        } catch(_) {}
        toast('🚫 Guest removed.');
      }
    });
  });

  document.body.appendChild(overlay);

  // Auto-dismiss after 30 s if host doesn't respond
  setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 30000);
}

/* Tiny HTML escape for user content injected into innerHTML */
function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}


/* ═══════════════════════════════════════════════════════════════════
   SHADOW BOT ASSISTANT
   — Friendly welcome and positive messages.
   — Completely separate from AI Safety System.
   — Posts as a "Shadow Bot" system message to live chat.
   — Limits: max 2 messages per hour. Only during active live.
   ═══════════════════════════════════════════════════════════════════ */

let _shadowBotEnabled      = false;    // host toggle
let _shadowBotTimer1       = null;     // first message timer
let _shadowBotTimer2       = null;     // second message timer (if needed)
let _shadowBotMsgCount     = 0;        // messages sent this hour window
let _shadowBotHourReset    = null;     // hourly counter reset timer
let _shadowBotActive       = false;    // true only when live is running

const _SHADOW_BOT_MESSAGES = [
  'Welcome to Shadow Nexus Live! 🌑',
  'Thanks for being here — keep the chat positive! ✨',
  'Great to see everyone here on Shadow Nexus Live! 🔴',
  "You're all amazing — thanks for watching! 🙌",
  'This live is powered by the Shadow Nexus community. Welcome! 💙',
  'Enjoying the stream? Share it with a friend! 📤',
];

function _shadowBotSetEnabled(on) {
  _shadowBotEnabled = on;
  const badge = document.getElementById('shadowBotBadge');
  if (badge) badge.classList.toggle('visible', on);
  if (on) {
    if (_shadowBotActive) _shadowBotSchedule();
  } else {
    _shadowBotClearTimers();
  }
}

function _shadowBotOnLiveStart() {
  _shadowBotActive   = true;
  _shadowBotMsgCount = 0;
  if (_shadowBotEnabled) _shadowBotSchedule();
}

function _shadowBotOnLiveEnd() {
  _shadowBotActive = false;
  _shadowBotClearTimers();
  const badge = document.getElementById('shadowBotBadge');
  if (badge) badge.classList.remove('visible');
}

function _shadowBotClearTimers() {
  if (_shadowBotTimer1)    { clearTimeout(_shadowBotTimer1);    _shadowBotTimer1    = null; }
  if (_shadowBotTimer2)    { clearTimeout(_shadowBotTimer2);    _shadowBotTimer2    = null; }
  if (_shadowBotHourReset) { clearTimeout(_shadowBotHourReset); _shadowBotHourReset = null; }
}

function _shadowBotSchedule() {
  _shadowBotClearTimers();
  if (!_shadowBotEnabled || !_shadowBotActive || !_roomId || _mode !== 'creator') return;

  // First message: 45–75 seconds after live starts (or bot is enabled)
  const delay1 = 45000 + Math.random() * 30000;   // 45–75 s
  // Second message: 30–40 minutes later
  const delay2 = delay1 + (30 * 60 * 1000) + Math.random() * (10 * 60 * 1000);

  _shadowBotTimer1 = setTimeout(() => _shadowBotPost(), delay1);

  // Only schedule second message if we haven't hit the hourly cap
  _shadowBotTimer2 = setTimeout(() => {
    if (_shadowBotMsgCount < 2) _shadowBotPost();
  }, delay2);

  // Reset counter every 60 minutes so the bot can post again next hour
  _shadowBotHourReset = setTimeout(() => {
    _shadowBotMsgCount = 0;
    if (_shadowBotEnabled && _shadowBotActive) _shadowBotSchedule();
  }, 60 * 60 * 1000);
}

async function _shadowBotPost() {
  if (!_shadowBotEnabled || !_shadowBotActive || !_roomId || _mode !== 'creator') return;
  if (_shadowBotMsgCount >= 2) return;   // hard cap: max 2 per hour

  _shadowBotMsgCount++;

  // Pick a random message, avoid repeating the last one
  const msg = _SHADOW_BOT_MESSAGES[
    Math.floor(Math.random() * _SHADOW_BOT_MESSAGES.length)
  ];

  try {
    await addDoc(collection(_db, 'liveRooms', _roomId, 'liveMessages'), {
      userId:    'shadow_bot',
      userName:  'Shadow Bot',
      text:      msg,
      type:      'system',
      createdAt: serverTimestamp(),
    });
  } catch(_) {}
}


/* ═══════════════════════════════════════════════════════════════════
   AUTOMATIC INTERNET QUALITY
   — Host-only feature.  Separate from existing adaptive quality.
   — Detects connection type via Network Information API.
   — Monitors upload packet-loss, latency (RTT), and buffering every 8 s.
   — Maps network conditions to four tiers: Excellent / Good / Fair / Poor.
   — Adjusts bitrate + resolution on the outbound video sender.
   — Shows a top-bar badge and toasts the host when tier changes.
   — Prevents disconnection by pre-emptively reducing quality.
   — Auto-recovers when conditions improve.
   — Does NOT touch chat, posts, comments, Firebase, or viewer code.
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────────
let _iqEnabled       = false;    // toggled by the host
let _iqLiveActive    = false;    // true only while stream is running
let _iqTimer         = null;     // monitoring interval handle
let _iqCurrentTier   = null;     // 'excellent' | 'good' | 'fair' | 'poor'
let _iqUpgradePending = false;   // hysteresis: require two good reads to upgrade
let _iqPrevSent      = 0;
let _iqPrevLost      = 0;
let _iqPrevBytes     = 0;
let _iqPrevTs        = 0;

// ── Quality tiers ────────────────────────────────────────────────────
// Each tier: { id, label, icon, maxBitrate (bps), scaleDown, lossMax, rttMax }
const _IQ_TIERS = {
  excellent: { id: 'excellent', label: '1080p',   icon: '📶', maxBitrate: 5_500_000, scaleDown: 1,   lossMax: 0.02, rttMax: 80  },
  good:      { id: 'good',      label: '720p',    icon: '📶', maxBitrate: 3_000_000, scaleDown: 1,   lossMax: 0.08, rttMax: 150 },
  fair:      { id: 'fair',      label: '480p',    icon: '📶', maxBitrate: 1_200_000, scaleDown: 1.5, lossMax: 0.18, rttMax: 300 },
  poor:      { id: 'poor',      label: '360p',    icon: '⚠️', maxBitrate:   550_000, scaleDown: 2.5, lossMax: 1,    rttMax: Infinity },
};

// ── Network type → initial tier hint ─────────────────────────────────
const _IQ_TYPE_HINT = { '5g': 'excellent', '4g': 'good', 'wifi': 'good', 'ethernet': 'excellent' };

// ── Public lifecycle hooks ───────────────────────────────────────────

function _iqSetEnabled(on) {
  _iqEnabled = on;
  if (!on) {
    _iqStop();
    _iqHideBadge();
    return;
  }
  // If live is already running, start immediately
  if (_iqLiveActive && _rtcPc) {
    _iqStart(_rtcPc);
  }
}

function _iqOnLiveStart() {
  _iqLiveActive = true;
  if (_iqEnabled && _rtcPc) _iqStart(_rtcPc);
}

function _iqOnLiveEnd() {
  _iqLiveActive = false;
  _iqStop();
  _iqHideBadge();
}

// ── Core: start monitoring ───────────────────────────────────────────

function _iqStart(pc) {
  if (_iqTimer) return; // already running

  // Detect initial tier from Network Information API if available
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    const etype = (conn.effectiveType || '').toLowerCase(); // 'slow-2g'|'2g'|'3g'|'4g'
    const type  = (conn.type || '').toLowerCase();          // 'wifi'|'cellular'|'ethernet'|…
    let hint = null;
    if (type === 'ethernet' || type === 'wifi') {
      hint = conn.downlink >= 10 ? 'excellent' : 'good';
    } else if (etype === '4g') {
      hint = 'good';
    } else if (etype === '3g') {
      hint = 'fair';
    } else if (etype === '2g' || etype === 'slow-2g') {
      hint = 'poor';
    }
    if (hint) _iqApplyTier(pc, hint, false);
  }

  // Reset counters
  _iqPrevSent  = 0;
  _iqPrevLost  = 0;
  _iqPrevBytes = 0;
  _iqPrevTs    = 0;
  _iqUpgradePending = false;

  _iqTimer = setInterval(() => _iqTick(pc), 8_000);

  // Also listen for connection-type changes
  if (conn) {
    conn.addEventListener('change', () => _iqOnConnectionChange(pc));
  }
}

// ── Monitoring tick (runs every 8 s) ─────────────────────────────────

async function _iqTick(pc) {
  if (!pc || pc.connectionState !== 'connected') return;
  if (!_iqEnabled || !_iqLiveActive) return;

  try {
    const stats = await pc.getStats();

    let sent  = 0, lost  = 0, bytes = 0, rtt = 0, rttCount = 0;
    let roundTripMs = null;

    stats.forEach(r => {
      if (r.type === 'outbound-rtp' && r.kind === 'video') {
        sent  += r.packetsSent  || 0;
        lost  += r.packetsLost  || 0;
        bytes += r.bytesSent    || 0;
      }
      if (r.type === 'remote-inbound-rtp' && r.kind === 'video') {
        if (r.roundTripTime != null) { rtt += r.roundTripTime; rttCount++; }
      }
      // candidate-pair for RTT fallback
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
        if (!rttCount) { rtt = r.currentRoundTripTime; rttCount = 1; }
      }
    });

    const now      = Date.now();
    const deltaSent = sent  - _iqPrevSent;
    const deltaLost = lost  - _iqPrevLost;
    const deltaBytes = bytes - _iqPrevBytes;
    const deltaSec   = _iqPrevTs ? (now - _iqPrevTs) / 1000 : 8;

    _iqPrevSent  = sent;
    _iqPrevLost  = lost;
    _iqPrevBytes = bytes;
    _iqPrevTs    = now;

    if (deltaSent < 5) return; // too few packets to be meaningful

    const lossRate = Math.max(0, deltaLost) / deltaSent;
    const kbps     = (deltaBytes * 8 / 1000) / deltaSec;
    roundTripMs    = rttCount ? (rtt / rttCount) * 1000 : null;

    const targetTier = _iqPickTier(lossRate, roundTripMs, kbps);
    _iqMaybeChangeTier(pc, targetTier, lossRate, roundTripMs);

  } catch(_) {}
}

// ── Pick the best tier based on current network metrics ──────────────

function _iqPickTier(lossRate, rttMs, kbps) {
  const rtt = rttMs != null ? rttMs : 0;
  if (lossRate <= _IQ_TIERS.excellent.lossMax && rtt <= _IQ_TIERS.excellent.rttMax && kbps >= 4000) return 'excellent';
  if (lossRate <= _IQ_TIERS.good.lossMax      && rtt <= _IQ_TIERS.good.rttMax      && kbps >= 1500) return 'good';
  if (lossRate <= _IQ_TIERS.fair.lossMax      && rtt <= _IQ_TIERS.fair.rttMax      && kbps >= 600)  return 'fair';
  return 'poor';
}

// ── Change-tier logic with hysteresis ────────────────────────────────

function _iqMaybeChangeTier(pc, targetTier, lossRate, rttMs) {
  const order = ['excellent', 'good', 'fair', 'poor'];
  const curIdx = order.indexOf(_iqCurrentTier ?? 'good');
  const tarIdx = order.indexOf(targetTier);

  if (tarIdx === curIdx) { _iqUpgradePending = false; return; }

  if (tarIdx > curIdx) {
    // Degrading → apply immediately (protect stream first)
    _iqUpgradePending = false;
    _iqApplyTier(pc, targetTier, true);
  } else {
    // Improving → require two consecutive good reads (hysteresis)
    if (!_iqUpgradePending) {
      _iqUpgradePending = true;
      return;
    }
    _iqUpgradePending = false;
    // Improve one step at a time
    const nextTier = order[curIdx - 1];
    _iqApplyTier(pc, nextTier, true);
  }
}

// ── Apply a quality tier to the sender ───────────────────────────────

async function _iqApplyTier(pc, tierId, notify) {
  if (_iqCurrentTier === tierId) return;
  const prev = _iqCurrentTier;
  _iqCurrentTier = tierId;
  const tier = _IQ_TIERS[tierId];

  // Apply to the video sender
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].maxBitrate            = tier.maxBitrate;
      params.encodings[0].scaleResolutionDownBy = tier.scaleDown;
      await sender.setParameters(params).catch(() => {});
    }
  } catch(_) {}

  // Also align the existing adaptive-quality module's tier index so they don't fight
  const legacyMap = { excellent: 0, good: 1, fair: 2, poor: 3 };
  _adaptiveQualityTierIdx = legacyMap[tierId] ?? 1;

  _iqShowBadge(tierId, tier);
  if (notify && prev !== null) _iqNotify(prev, tierId, tier);

  console.log(`[IQ] → ${tierId.toUpperCase()} (${tier.label} / ${tier.maxBitrate/1000} kbps)`);
}

// ── Handle Network Information API change event ───────────────────────

function _iqOnConnectionChange(pc) {
  if (!_iqEnabled || !_iqLiveActive) return;
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!conn) return;
  const etype = (conn.effectiveType || '').toLowerCase();
  let hint = null;
  if      (etype === '4g')                   hint = 'good';
  else if (etype === '3g')                   hint = 'fair';
  else if (etype === '2g' || etype === 'slow-2g') hint = 'poor';
  if (hint) _iqMaybeChangeTier(pc, hint, null, null);
}

// ── Badge ─────────────────────────────────────────────────────────────

function _iqShowBadge(tierId, tier) {
  const badge = document.getElementById('iqBadge');
  if (!badge) return;
  badge.className = `iq-visible iq-${tierId}`;
  badge.textContent = `${tier.icon} ${tier.label}`;
}

function _iqHideBadge() {
  const badge = document.getElementById('iqBadge');
  if (!badge) return;
  badge.className = '';
  badge.textContent = '';
  _iqCurrentTier = null;
}

// ── Toast notification to streamer ───────────────────────────────────

function _iqNotify(prevId, nextId, tier) {
  const order = ['excellent', 'good', 'fair', 'poor'];
  const improved = order.indexOf(nextId) < order.indexOf(prevId);
  const msg = improved
    ? `📶 Quality improved → ${tier.label}`
    : `⚠️ Quality reduced → ${tier.label} (weak signal)`;
  toast(msg, 3500);
}

// ── Stop & cleanup ────────────────────────────────────────────────────

function _iqStop() {
  if (_iqTimer) { clearInterval(_iqTimer); _iqTimer = null; }
  _iqPrevSent  = 0;
  _iqPrevLost  = 0;
  _iqPrevBytes = 0;
  _iqPrevTs    = 0;
  _iqUpgradePending = false;
  // Remove network-change listener
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) conn.removeEventListener('change', _iqOnConnectionChange);
}
