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

// WebRTC
let _rtcPc           = null;   // RTCPeerConnection
let _rtcSignalUnsub  = null;   // RTDB listener unsubscribe (off ref)
let _rtcSignalRef    = null;   // RTDB ref being listened to

let _chatUnsub        = null;
let _viewerCountRef   = null;   // RTDB ref for viewer count listener
let _viewerCountUnsub = null;
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

/* ── Guest Box State ── */
let _guestLayout       = 'auto';   // current layout preference
let _guestBoxSize      = 'sm';     // 'sm' | 'md' | 'lg'
let _guestPeers        = {};       // uid → { pc, stream, cell, name }
let _guestReqUnsub     = null;     // RTDB listener for incoming requests (host)
let _guestStatusUnsub  = null;     // RTDB listener for request status (viewer)
let _layoutPanelOpen   = false;

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
  D.btnLayoutSettings && D.btnLayoutSettings.addEventListener('click', _toggleLayoutPanel);

  // Layout option buttons
  document.querySelectorAll('.layout-option-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-option-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestLayout = btn.dataset.layout;
      _applyGuestLayout();
    });
  });

  // Box size buttons
  document.querySelectorAll('.layout-size-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _guestBoxSize = btn.dataset.size;
      _applyGuestLayout();
    });
  });

  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge',
                    '.layout-settings-panel','.layout-option-btn','.layout-size-btn'];
    if (ignore.some(s => e.target.closest(s))) return;
    // Close layout panel on tap-away
    if (_layoutPanelOpen) { _closeLayoutPanel(); return; }
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
      _resolveMode();
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
      video: { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: true,
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
      video: { facingMode: _facingMode }, audio: _micOn,
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

  toast('🔴 You are LIVE!');

  // ── Non-critical side-work ──
  try {
    await updateDoc(doc(_db, 'users', _user.uid), { isLive: true, liveRoomId: _roomId });
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
}

function toggleLiveMic() {
  _micOn = !_micOn;
  if (_localStream) _localStream.getAudioTracks().forEach(t => t.enabled = _micOn);
  if (D.btnMic) { D.btnMic.textContent = _micOn ? '🎤' : '🔇'; D.btnMic.classList.toggle('off', !_micOn); }
  toast(_micOn ? 'Mic on' : 'Mic muted');
}

async function flipLiveCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: _facingMode }, audio: _micOn,
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

  /* ── Increment viewer count in LIVE RTDB ── */
  try {
    const viewersRef = ref(_liveDB, `liveRooms/${_roomId}/viewers`);
    const currentSnap = await get(viewersRef);
    await set(viewersRef, (currentSnap.val() || 0) + 1);
  } catch (_) {}

  /* ── Watch for stream ending via LIVE RTDB ── */
  let _roomWatchSeenFirst = false;
  const roomWatchRef = ref(_liveDB, `liveRooms/${_roomId}`);
  onValue(roomWatchRef, snap => {
    const d = snap.val() || {};
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + (d.viewers || 0);
    if (D.likeCount)   D.likeCount.textContent   = '❤️ ' + (d.likes   || 0);
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
}

async function _viewerLeave() {
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  // Clean up any pending box request
  if (_user && _roomId) {
    try { await remove(ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`)); } catch(_) {}
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

  // Ensure transceivers are explicitly set to sendonly (belt+braces for iOS Safari)
  _rtcPc.getTransceivers().forEach(tc => {
    tc.direction = 'sendonly';
  });

  _rtcPc.onconnectionstatechange = () => {
    if (_rtcPc.connectionState === 'connected') {
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
    D.liveVideo.play().catch(() => {});
    _showUnmutePrompt();
    _hideConnBanner();
  };

  _rtcPc.onconnectionstatechange = () => {
    if (_rtcPc.connectionState === 'connected') {
      _hideConnBanner();
      // connected — banner already hidden by ontrack
    } else if (_rtcPc.connectionState === 'disconnected' || _rtcPc.connectionState === 'failed') {
      _showConnBanner('Waiting for stream…', '');
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
}

/* ═══════════════════════════════════════════════════
   CHAT — Firestore sub-collection
   ═══════════════════════════════════════════════════ */
function _subscribeChat() {
  if (!_roomId) return;
  const q = query(
    collection(_db, 'liveRooms', _roomId, 'liveMessages'),
    orderBy('createdAt', 'asc'),
    limit(150)
  );
  _chatUnsub = onSnapshot(q, snap => {
    snap.docChanges().forEach(ch => {
      if (ch.type === 'added') _appendChatMsg(ch.doc.data());
    });
  }, () => {});
}

function _appendChatMsg(data) {
  if (!D.chatMessages) return;
  const hostUid  = _roomId ? _roomId.split('_')[0] : null;
  const isHost   = !!(hostUid && data.userId === hostUid);
  const isSystem = data.type === 'system';

  const el = document.createElement('div');
  el.className = 'live-chat-msg' + (isSystem ? ' system' : '');
  if (!isSystem) {
    el.innerHTML = `<span class="live-chat-author${isHost ? ' is-host' : ''}">${_esc(data.userName || 'Guest')}</span>
                    <span class="live-chat-text">${_esc(data.text)}</span>`;
  } else {
    el.innerHTML = `<span class="live-chat-text">${_esc(data.text)}</span>`;
  }
  D.chatMessages.appendChild(el);
  D.chatMessages.scrollTop = D.chatMessages.scrollHeight;

  while (D.chatMessages.children.length > 80) {
    D.chatMessages.removeChild(D.chatMessages.firstChild);
  }
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

  if (D.chatInput) D.chatInput.value = '';

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

  try {
    const likesRef = ref(_liveDB, `liveRooms/${_roomId}/likes`);
    const snap = await get(likesRef);
    await set(likesRef, (snap.val() || 0) + 1);
  } catch (_) {}

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

function toast(msg) {
  if (!D.toast) return;
  clearTimeout(_toastTimer);
  D.toast.textContent = msg;
  D.toast.classList.add('visible');
  _toastTimer = setTimeout(() => D.toast.classList.remove('visible'), 3200);
}

function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  if (!_user || !_roomId) return;
  const btn = D.btnRequestBox;
  if (btn && btn.classList.contains('pending')) return; // already requested

  const reqRef = ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}`);
  try {
    await set(reqRef, {
      uid:    _user.uid,
      name:   _userData.displayName || 'Guest',
      avatar: _userData.avatar || _userData.profilePicture || '',
      status: 'pending',
      ts:     Date.now(),
    });
  } catch (e) {
    toast('Could not send request. Try again.');
    return;
  }

  if (btn) {
    btn.classList.add('pending');
    btn.querySelector('span:last-child') && (btn.querySelector('span:last-child').textContent = 'Waiting…');
  }
  toast('📺 Request sent to host!');

  // Watch for host's response
  if (_guestStatusUnsub) { try { _guestStatusUnsub(); } catch(_){} }
  const statusRef = ref(_liveDB, `guestRequests/${_roomId}/${_user.uid}/status`);
  _guestStatusUnsub = onValue(statusRef, async snap => {
    const status = snap.val();
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
        const label = btn.querySelector('span:last-child');
        if (label) label.textContent = 'Request a Box';
      }
      toast('Request declined.');
      _guestStatusUnsub && _guestStatusUnsub();
      _guestStatusUnsub = null;
    }
  });
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
    toast('Camera access denied. Cannot join box.');
    return;
  }

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

  // Listen for more host candidates
  onValue(sigRef, async snap => {
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

  // Show own video locally (viewer sees their own box)
  _guestAddViewerSelf(guestStream, guestPc);
}

/* ── Show viewer's own guest box on their screen ── */
function _guestAddViewerSelf(stream, pc) {
  const grid = D.guestGrid;
  if (!grid) return;

  grid.classList.add('has-guests');
  grid.dataset.count = (parseInt(grid.dataset.count || '0') + 1).toString();

  const cell = document.createElement('div');
  cell.className = 'guest-cell';
  cell.dataset.uid = _user.uid;

  const vid = document.createElement('video');
  vid.autoplay = true;
  vid.muted = true;   // mute self-preview
  vid.playsInline = true;
  vid.srcObject = stream;
  vid.play().catch(()=>{});
  cell.appendChild(vid);

  const nameEl = document.createElement('div');
  nameEl.className = 'guest-cell-name';
  nameEl.textContent = (_userData.displayName || 'You') + ' (You)';
  cell.appendChild(nameEl);

  grid.appendChild(cell);
  _applyGuestLayout();

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cell.remove();
      _applyGuestLayout();
    }
  };
}

/* ── HOST: Listen for incoming guest requests ── */
function _hostListenForGuestRequests() {
  if (!_roomId) return;
  const reqsRef = ref(_liveDB, `guestRequests/${_roomId}`);
  _guestReqUnsub = onValue(reqsRef, snap => {
    if (!snap.exists()) return;
    snap.forEach(child => {
      const req = child.val();
      if (req.status === 'pending') {
        _hostShowRequestCard(req);
      }
    });
  });
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
    _hostAcceptGuest(req);
  });

  const declineBtn = document.createElement('button');
  declineBtn.className = 'guest-req-decline';
  declineBtn.textContent = 'Decline';
  declineBtn.addEventListener('click', () => {
    card.remove();
    _hostDeclineGuest(req.uid);
  });

  actions.appendChild(acceptBtn);
  actions.appendChild(declineBtn);
  card.appendChild(avatarEl);
  card.appendChild(nameWrap);
  card.appendChild(actions);
  queue.appendChild(card);

  // Auto-dismiss after 30 seconds
  setTimeout(() => { if (card.parentNode) { card.remove(); _hostDeclineGuest(req.uid); } }, 30000);
}

/* ── HOST: Accept guest ── */
async function _hostAcceptGuest(req) {
  if (!_roomId || !_localStream) return;

  const guestUid = req.uid;
  const sigRef = ref(_liveDB, `guestSignaling/${_roomId}/${guestUid}`);

  // Update request status to accepted
  try { await update(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`), { status: 'accepted' }); } catch(_) {}

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

  // Watch for guest answer + ICE
  const appliedGuestCands = new Set();
  onValue(sigRef, async snap => {
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

  // Store peer
  _guestPeers[guestUid] = { pc: guestPc, name: req.name, avatar: req.avatar };

  toast(`✅ ${req.name || 'Guest'} joined!`);
}

/* ── HOST: Decline guest ── */
async function _hostDeclineGuest(guestUid) {
  try { await update(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`), { status: 'declined' }); } catch(_) {}
  setTimeout(async () => {
    try { await remove(ref(_liveDB, `guestRequests/${_roomId}/${guestUid}`)); } catch(_) {}
  }, 3000);
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

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      _hostRemoveGuest(uid);
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

/* ── HOST: Remove a guest ── */
function _hostRemoveGuest(uid) {
  const peer = _guestPeers[uid];
  if (peer) {
    if (peer.pc) { try { peer.pc.close(); } catch(_){} }
    if (peer.cell) { try { peer.cell.remove(); } catch(_){} }
    delete _guestPeers[uid];
  }
  try { remove(ref(_liveDB, `guestRequests/${_roomId}/${uid}`)); } catch(_) {}
  try { remove(ref(_liveDB, `guestSignaling/${_roomId}/${uid}`)); } catch(_) {}

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

/* ── Tear down all guest peers (called on endLive) ── */
function _teardownAllGuestPeers() {
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
  // Clean up all signaling + requests for this room
  if (_roomId) {
    try { remove(ref(_liveDB, `guestRequests/${_roomId}`)); }  catch(_) {}
    try { remove(ref(_liveDB, `guestSignaling/${_roomId}`)); } catch(_) {}
  }
}

/* ═══════════════════════════════════════════════════
   LAYOUT ENGINE
   ═══════════════════════════════════════════════════ */

function _applyGuestLayout() {
  const grid = D.guestGrid;
  if (!grid) return;

  const guestCount = Object.keys(_guestPeers).length;  // guests only (not host)
  const totalCount = guestCount;                         // data-count = guest count

  grid.dataset.count  = guestCount.toString();
  grid.dataset.layout = _guestLayout;

  // Box size class
  grid.classList.remove('box-sm', 'box-md', 'box-lg');
  grid.classList.add('box-' + _guestBoxSize);

  if (guestCount === 0) {
    grid.classList.remove('has-guests');
    return;
  }
  grid.classList.add('has-guests');

  // For the 'grid' layout and 6+ guests in 'auto', set equal sizes via JS
  if (_guestLayout === 'grid') {
    _applyEqualGrid(grid, guestCount + 1); // +1 for host
  } else if (_guestLayout === 'float') {
    _applyFloatLayout(grid, guestCount);
  } else if (_guestLayout === 'auto' && guestCount >= 5) {
    _applyEqualGrid(grid, guestCount + 1);
  }
}

/* ── Equal grid: calculate rows/cols then set dimensions ── */
function _applyEqualGrid(grid, totalCells) {
  const cols  = Math.ceil(Math.sqrt(totalCells));
  const rows  = Math.ceil(totalCells / cols);
  const w     = (100 / cols).toFixed(2) + '%';
  const h     = (100 / rows).toFixed(2) + '%';
  grid.querySelectorAll('.guest-cell').forEach(cell => {
    cell.style.width  = w;
    cell.style.height = h;
  });
}

/* ── Float layout: cascade guest boxes from top-right ── */
function _applyFloatLayout(grid, guestCount) {
  let guestIndex = 0;
  grid.querySelectorAll('.guest-cell:not(.host-cell)').forEach(cell => {
    const col = guestIndex % 3;
    const row = Math.floor(guestIndex / 3);
    cell.style.width  = '160px';
    cell.style.height = '120px';
    cell.style.right  = (12 + col * 176) + 'px';
    cell.style.top    = (12 + row * 136) + 'px';
    cell.style.bottom = 'auto';
    cell.style.left   = 'auto';
    guestIndex++;
  });
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
}

function _closeLayoutPanel() {
  if (!D.layoutSettingsPanel) return;
  D.layoutSettingsPanel.style.display = 'none';
  _layoutPanelOpen = false;
}
