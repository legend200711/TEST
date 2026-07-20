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

// WebRTC (host↔viewer 1-to-1 stream)
let _rtcPc           = null;   // RTCPeerConnection
let _rtcSignalUnsub  = null;   // RTDB listener unsubscribe (off ref)
let _rtcSignalRef    = null;   // RTDB ref being listened to

let _chatUnsub        = null;
let _viewerCountRef   = null;   // RTDB ref for viewer count listener
let _viewerCountUnsub = null;
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile
let _creatorEndedFlag = false;  // guard: prevent beforeunload re-running endLive cleanup

// Guest WebRTC — one RTCPeerConnection per box (both host and guest perspectives)
// _guestPcs[boxNum] = { pc: RTCPeerConnection, statsInterval, guestId, localStream }
const _guestPcs = {};
// Layout mode
let _layoutMode = 'grid';   // 'side' | 'grid' | 'floating' | 'equal'  (grid = TikTok auto)
// Guest self-stream (the guest's own camera/mic when they are in a box)
let _guestSelfStream   = null;
let _guestSelfCamOn    = true;
let _guestSelfMicOn    = true;
let _guestSelfBoxNum   = null;  // which box number I (the guest) am in

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
    btnGuestBoxes:   document.getElementById('btnGuestBoxes'),

    // Guest boxes panel
    guestBoxPanel:      document.getElementById('guestBoxPanel'),
    guestQueueBadge:    document.getElementById('guestQueueBadge'),
    guestQueueCount:    document.getElementById('guestQueueCount'),
    btnCloseGuestPanel: document.getElementById('btnCloseGuestPanel'),

    // Guest stage (multi-participant video area)
    guestStage:      document.getElementById('guestStage'),
    gsHostVideo:     document.getElementById('gsHostVideo'),
    gsHostCamOff:    document.getElementById('gsHostCamOff'),
    gsHostAvatar:    document.getElementById('gsHostAvatar'),
    gsHostName:      document.getElementById('gsHostName'),
    gsHostConnWarn:  document.getElementById('gsHostConnWarn'),
    layoutSwitcher:  document.getElementById('layoutSwitcher'),

    // Guest self-controls bar
    guestSelfControls: document.getElementById('guestSelfControls'),
    btnGuestCam:       document.getElementById('btnGuestCam'),
    btnGuestMic:       document.getElementById('btnGuestMic'),
    btnGuestLeave:     document.getElementById('btnGuestLeave'),

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
  D.btnGuestBoxes      && D.btnGuestBoxes.addEventListener('click', _gbTogglePanel);
  D.btnCloseGuestPanel && D.btnCloseGuestPanel.addEventListener('click', _gbTogglePanel);

  // Layout switcher buttons
  if (D.layoutSwitcher) {
    D.layoutSwitcher.querySelectorAll('.layout-btn').forEach(btn => {
      btn.addEventListener('click', () => _setLayout(btn.dataset.layout));
    });
  }

  // Guest self-controls (visible when viewer is accepted into a box)
  D.btnGuestCam   && D.btnGuestCam.addEventListener('click',   _guestToggleCam);
  D.btnGuestMic   && D.btnGuestMic.addEventListener('click',   _guestToggleMic);
  D.btnGuestLeave && D.btnGuestLeave.addEventListener('click', () => {
    if (_guestSelfBoxNum !== null) _gbViewerLeave(_guestSelfBoxNum);
  });

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

  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge'];
    if (ignore.some(s => e.target.closest(s))) return;
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
  _gbInitCreator();

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
    /* FIX: keep host tile in guest stage in sync when camera is flipped */
    if (D.gsHostVideo) {
      D.gsHostVideo.srcObject = newStream;
      D.gsHostVideo.play().catch(() => {});
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

  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalRef && _rtcSignalUnsub) { off(_rtcSignalRef); _rtcSignalRef = null; _rtcSignalUnsub = null; }
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountRef && _viewerCountUnsub) { off(_viewerCountRef); _viewerCountRef = null; _viewerCountUnsub = null; }
  _gbCleanupCreator();

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
  _gbInitViewer(roomData);

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

  _gbCleanupViewer();
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

/* ════════════════════════════════════════════════════════════════════
   GUEST BOXES — TikTok-style multi-guest feature
   ════════════════════════════════════════════════════════════════════

   Firebase RTDB data layout (under liveRooms/{roomId}/guestBoxes):
     guestBoxes/
       boxes/
         1: { status, guestId, guestName, guestAvatar, joinedAt }
         2: { ... }
         3: { ... }
         4: { ... }
       queue/
         {pushKey}: { guestId, guestName, guestAvatar, requestedAt }
       requests/
         {guestId}: { guestId, guestName, guestAvatar, requestedAt, status }
*/

const _GB_MAX_BOXES = 4;
let _gbPanelVisible  = false;
let _gbBoxesUnsub    = null;   // RTDB onValue unsubscribe for boxes
let _gbQueueUnsub    = null;   // RTDB onValue unsubscribe for queue
let _gbMyBoxNum      = null;   // box number (1-4) the current viewer is in
let _gbMyRequestKey  = null;   // push key for this viewer's queue entry
let _gbRequestBtn    = null;   // DOM ref — "Request a Box" button

/* ── RTDB helper paths ── */
function _gbRef(path)  { return ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/${path}`); }
function _gbBoxRef(n)  { return _gbRef(`boxes/${n}`); }
function _gbQueueRef() { return _gbRef('queue'); }
function _gbReqRef(uid){ return _gbRef(`requests/${uid.replace(/[.#$/\[\]]/g,'_')}`); }

/* ════════════════════════════════════════════
   CREATOR INIT
   ════════════════════════════════════════════ */
async function _gbInitCreator() {
  if (!_roomId) return;

  /* initialise all 4 boxes as available */
  const initialBoxes = {};
  for (let i = 1; i <= _GB_MAX_BOXES; i++) {
    initialBoxes[i] = { status: 'available', guestId: null };
  }
  try {
    await set(_gbRef('boxes'), initialBoxes);
    await set(_gbQueueRef(), null);          // clear any old queue
    /* persist initial layout mode to RTDB */
    await set(_gbRef('layoutMode'), _layoutMode);
  } catch (_) {}

  /* show panel and subscribe */
  _gbShowPanel();
  _gbSubscribeBoxes('creator');
  _gbSubscribeQueue();

  /* add notification dot to the toggle button */
  if (D.btnGuestBoxes) {
    const dot = document.createElement('span');
    dot.className = 'gb-notif-dot';
    dot.id = '_gbNotifDot';
    D.btnGuestBoxes.appendChild(dot);
  }

  /* populate host tile in guest stage */
  _gsPopulateHostTile();
  /* apply default layout */
  _setLayout(_layoutMode);
}

/* ════════════════════════════════════════════
   VIEWER INIT
   ════════════════════════════════════════════ */
function _gbInitViewer(roomData) {
  if (!_roomId) return;

  /* inject "Request a Box" button into the viewer actions bar */
  const actionsBar = document.querySelector('.live-viewer-actions');
  if (actionsBar && !document.getElementById('_gbRequestBtn')) {
    const btn = document.createElement('button');
    btn.id        = '_gbRequestBtn';
    btn.className = 'live-request-box-btn';
    btn.setAttribute('aria-label', 'Request a guest box');
    btn.innerHTML = `<span class="live-request-box-icon">🎥</span><span>Request Box</span>`;
    btn.addEventListener('click', _gbViewerRequestBox);
    actionsBar.prepend(btn);
    _gbRequestBtn = btn;
  }

  /* show the panel for viewers (read-only view of boxes + request btn) */
  _gbShowPanel();
  _gbSubscribeBoxes('viewer');

  /* listen for layout mode changes from the host */
  onValue(_gbRef('layoutMode'), snap => {
    if (snap.exists()) _setLayout(snap.val(), false);
  });

  /* populate guest stage host tile for viewers too */
  if (roomData) _gsPopulateHostTileViewer(roomData);
}

/* ════════════════════════════════════════════
   PANEL TOGGLE
   ════════════════════════════════════════════ */
function _gbTogglePanel() {
  _gbPanelVisible = !_gbPanelVisible;
  const panel = D.guestBoxPanel;
  if (!panel) return;
  if (_gbPanelVisible) {
    panel.style.display = 'block';
    panel.classList.remove('hidden');
  } else {
    panel.classList.add('hidden');
    setTimeout(() => { if (!_gbPanelVisible) panel.style.display = 'none'; }, 300);
  }
}

function _gbShowPanel() {
  _gbPanelVisible = true;
  const panel = D.guestBoxPanel;
  if (!panel) return;
  panel.style.display = 'block';
  panel.classList.remove('hidden');
}

/* ════════════════════════════════════════════
   SUBSCRIBE — boxes (both creator + viewer)
   ════════════════════════════════════════════ */
function _gbSubscribeBoxes(role) {
  const boxesRef = _gbRef('boxes');
  _gbBoxesUnsub = onValue(boxesRef, snap => {
    const boxes = snap.val() || {};
    for (let i = 1; i <= _GB_MAX_BOXES; i++) {
      _gbRenderBox(i, boxes[i] || { status: 'available', guestId: null }, role);
    }
  });
}

/* ════════════════════════════════════════════
   SUBSCRIBE — queue (creator only)
   ════════════════════════════════════════════ */
function _gbSubscribeQueue() {
  _gbQueueUnsub = onValue(_gbQueueRef(), snap => {
    const queueData = snap.val() || {};
    const queueList = Object.entries(queueData);
    const count = queueList.length;

    /* update queue badge */
    if (D.guestQueueBadge) D.guestQueueBadge.style.display = count > 0 ? 'inline-block' : 'none';
    if (D.guestQueueCount)  D.guestQueueCount.textContent  = count;

    /* notification dot on toggle button */
    const dot = document.getElementById('_gbNotifDot');
    if (dot) dot.classList.toggle('visible', count > 0);

    /* render "Next in queue" accept button in the first available open box */
    if (count > 0) {
      const [firstKey, firstUser] = queueList[0];
      _gbRenderQueueNext(firstKey, firstUser);
    }
  });
}

/* ════════════════════════════════════════════
   RENDER — single box
   ════════════════════════════════════════════ */
function _gbRenderBox(boxNum, data, role) {
  const boxEl      = document.getElementById(`guestBox${boxNum}`);
  const statusEl   = document.getElementById(`guestBoxStatus${boxNum}`);
  const nameEl     = document.getElementById(`guestBoxName${boxNum}`);
  const actionsEl  = document.getElementById(`guestBoxActions${boxNum}`);
  if (!boxEl || !statusEl || !actionsEl) return;

  const status = data.status || 'available';
  const prevStatus = boxEl.dataset.prevStatus || 'available';
  boxEl.dataset.prevStatus = status;

  /* reset classes */
  boxEl.classList.remove('gb-available', 'gb-pending', 'gb-occupied');
  boxEl.classList.add(`gb-${status}`);

  /* status label */
  statusEl.className = `guest-box-status-label gb-status-${status}`;
  statusEl.textContent =
    status === 'available' ? 'Available' :
    status === 'pending'   ? 'Request Pending' :
    'Occupied';

  /* name label */
  if (nameEl) {
    if (status === 'occupied' && data.guestName) {
      nameEl.textContent = data.guestName;
      nameEl.style.display = 'block';
    } else {
      nameEl.textContent   = '';
      nameEl.style.display = 'none';
    }
  }

  /* ── Profile picture ── */
  const avatarWrap    = document.getElementById(`gbAvatar${boxNum}`);
  const avatarImg     = document.getElementById(`gbAvatarImg${boxNum}`);
  const avatarInitial = document.getElementById(`gbAvatarInitial${boxNum}`);
  if (avatarWrap) {
    if (status === 'occupied' || status === 'pending') {
      avatarWrap.classList.add('visible');
      const av = data.guestAvatar || '';
      const nm = data.guestName   || '?';
      if (av) {
        if (avatarImg) { avatarImg.src = av; avatarImg.style.display = 'block'; }
        if (avatarInitial) avatarInitial.style.display = 'none';
      } else {
        if (avatarImg) avatarImg.style.display = 'none';
        if (avatarInitial) {
          avatarInitial.textContent  = nm[0].toUpperCase();
          avatarInitial.style.display = 'flex';
        }
      }
    } else {
      avatarWrap.classList.remove('visible');
    }
  }

  /* ── Status icons (cam / mic / conn) — only when occupied ── */
  const iconsEl = document.getElementById(`gbStatusIcons${boxNum}`);
  if (iconsEl) {
    if (status === 'occupied') {
      iconsEl.style.display = 'flex';
      const camIcon  = document.getElementById(`gbIconCam${boxNum}`);
      const micIcon  = document.getElementById(`gbIconMic${boxNum}`);
      const connIcon = document.getElementById(`gbIconConn${boxNum}`);
      if (camIcon)  camIcon.classList.toggle('off',  data.cameraEnabled    === false);
      if (micIcon)  micIcon.classList.toggle('off',  data.microphoneEnabled === false);
      if (connIcon) {
        const q = data.connectionQuality || 'good';
        connIcon.className = 'gb-icon-conn conn-' + q;
        connIcon.title = 'Connection: ' + q;
      }
    } else {
      iconsEl.style.display = 'none';
    }
  }

  /* ── Weak connection warning badge ── */
  const warnEl = document.getElementById(`gbConnWarn${boxNum}`);
  if (warnEl) {
    const isWeak = status === 'occupied' &&
      (data.connectionQuality === 'weak' || data.connectionQuality === 'bad');
    warnEl.classList.toggle('visible', isWeak);
  }

  /* ── Guest stage tile: show/hide + populate ── */
  _gsUpdateTile(boxNum, data, role);

  /* action buttons */
  actionsEl.innerHTML = '';

  if (role === 'creator') {
    if (status === 'pending') {
      actionsEl.append(
        _gbMakeBtn('✔ Accept',  'gb-btn-accept',  () => _gbCreatorAccept(boxNum, data)),
        _gbMakeBtn('✘ Decline', 'gb-btn-decline', () => _gbCreatorDecline(boxNum, data))
      );
    } else if (status === 'occupied') {
      /* Mute guest mic button */
      const micLabel = data.microphoneEnabled === false ? '🔇 Unmute Mic' : '🔇 Mute Mic';
      const camLabel = data.cameraEnabled     === false ? '📷 Enable Cam' : '📷 Disable Cam';
      actionsEl.append(
        _gbMakeBtn(micLabel,  'gb-btn-remove', () => _gbHostToggleGuestMic(boxNum, data)),
        _gbMakeBtn(camLabel,  'gb-btn-close',  () => _gbHostToggleGuestCam(boxNum, data)),
        _gbMakeBtn('Remove',  'gb-btn-remove', () => _gbCreatorRemove(boxNum, data)),
        _gbMakeBtn('Close',   'gb-btn-close',  () => _gbCreatorClose(boxNum))
      );
    } else {
      /* available — host can manually close/reopen (noop for clean state) */
    }
  } else if (role === 'viewer') {
    /* viewer who is in this box sees a Leave button */
    if (status === 'occupied' && data.guestId === _user?.uid) {
      actionsEl.append(
        _gbMakeBtn('Leave Box', 'gb-btn-leave', () => _gbViewerLeave(boxNum))
      );
    }
    /* if I was just removed (prev = occupied, now = available and was mine) */
    if (prevStatus === 'occupied' && status === 'available' && _guestSelfBoxNum === boxNum) {
      _guestSelfBoxNum = null;
      _gsHideSelfControls();
      toast('You have been removed from the guest box.');
    }
  }
}

/* ════════════════════════════════════════════
   RENDER — "next in queue" prompt (creator)
   ════════════════════════════════════════════ */
function _gbRenderQueueNext(queueKey, userData) {
  /* find first available box */
  for (let i = 1; i <= _GB_MAX_BOXES; i++) {
    const boxEl     = document.getElementById(`guestBox${i}`);
    const actionsEl = document.getElementById(`guestBoxActions${i}`);
    if (!boxEl) continue;
    if (boxEl.classList.contains('gb-available')) {
      /* add "Accept Next" button if not already there */
      if (!actionsEl.querySelector('.gb-btn-queue-accept')) {
        const btn = _gbMakeBtn(`📥 ${userData.guestName || 'Next'}`, 'gb-btn-accept gb-btn-queue-accept',
          () => _gbCreatorAcceptFromQueue(i, queueKey, userData));
        actionsEl.appendChild(btn);
      }
      break;
    }
  }
}

function _gbMakeBtn(text, classes, fn) {
  const btn = document.createElement('button');
  btn.className = `gb-action-btn ${classes}`;
  btn.textContent = text;
  btn.addEventListener('click', fn);
  return btn;
}

/* ════════════════════════════════════════════
   VIEWER — Request a box
   ════════════════════════════════════════════ */
async function _gbViewerRequestBox() {
  if (!_user || !_roomId) return;

  /* prevent duplicate request */
  if (_gbMyBoxNum !== null) {
    toast('You are already in a box.');
    return;
  }

  /* check if user already has a pending request */
  try {
    const reqSnap = await get(_gbReqRef(_user.uid));
    if (reqSnap.exists() && reqSnap.val().status === 'pending') {
      toast('Your request is already pending.');
      return;
    }
  } catch (_) {}

  /* disable button to prevent spam */
  if (_gbRequestBtn) {
    _gbRequestBtn.disabled = true;
    _gbRequestBtn.querySelector('span:last-child').textContent = 'Pending…';
  }

  const userName = _userData?.displayName || _user.email?.split('@')[0] || 'Guest';
  const payload = {
    guestId:     _user.uid,
    guestName:   userName,
    guestAvatar: _userData?.avatar || _userData?.profilePicture || '',
    requestedAt: Date.now(),
    status:      'pending',
  };

  /* find first available box */
  let placed = false;
  try {
    const boxesSnap = await get(_gbRef('boxes'));
    const boxes = boxesSnap.val() || {};
    for (let i = 1; i <= _GB_MAX_BOXES; i++) {
      if (!boxes[i] || boxes[i].status === 'available') {
        /* put the request directly on the box as 'pending' */
        await set(_gbBoxRef(i), { ...payload, status: 'pending', boxNumber: i });
        placed = true;

        /* record in requests map for dedup */
        await set(_gbReqRef(_user.uid), { ...payload, boxNumber: i });

        /* notify host */
        await _gbNotifyHost('request', userName, i);
        toast('📩 Request sent! Waiting for host…');
        break;
      }
    }
  } catch (e) {
    placed = false;
  }

  if (!placed) {
    /* all boxes occupied/pending — add to queue */
    try {
      const qRef = push(_gbQueueRef());
      _gbMyRequestKey = qRef.key;
      await set(qRef, payload);
      /* record in requests map for dedup */
      await set(_gbReqRef(_user.uid), { ...payload, inQueue: true });
      /* notify host */
      await _gbNotifyHost('queue', userName, null);
      toast('🕐 All boxes are full. You are in the queue!');
    } catch (e) {
      toast('Could not send request. Try again.');
      if (_gbRequestBtn) {
        _gbRequestBtn.disabled = false;
        _gbRequestBtn.querySelector('span:last-child').textContent = 'Request Box';
      }
      return;
    }
  }

  /* listen for own box acceptance/decline */
  _gbWatchOwnRequest();
}

/* ════════════════════════════════════════════
   VIEWER — watch own request for accept/decline
   ════════════════════════════════════════════ */
function _gbWatchOwnRequest() {
  if (!_user) return;
  const reqRef = _gbReqRef(_user.uid);
  onValue(reqRef, snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.status === 'accepted') {
      _gbMyBoxNum = d.boxNumber;
      _guestSelfBoxNum = d.boxNumber;
      toast('✅ You are in a guest box! Joining…');
      if (_gbRequestBtn) {
        _gbRequestBtn.disabled = true;
        _gbRequestBtn.querySelector('span:last-child').textContent = 'In Box ' + _gbMyBoxNum;
      }
      off(reqRef);
      /* start capturing local stream + WebRTC signaling to host */
      _guestStartStream(d.boxNumber);
    } else if (d.status === 'declined') {
      toast('❌ Your request was declined.');
      if (_gbRequestBtn) {
        _gbRequestBtn.disabled = false;
        _gbRequestBtn.querySelector('span:last-child').textContent = 'Request Box';
      }
      /* clear the request record */
      remove(reqRef).catch(() => {});
      off(reqRef);
    }
  });
}

/* ════════════════════════════════════════════
   VIEWER — Leave a box
   ════════════════════════════════════════════ */
async function _gbViewerLeave(boxNum) {
  if (!_user || !_roomId) return;
  try {
    await set(_gbBoxRef(boxNum), { status: 'available', guestId: null });
    await remove(_gbReqRef(_user.uid)).catch(() => {});
    _gbMyBoxNum    = null;
    _guestSelfBoxNum = null;
    _guestStopStream(boxNum);
    _gsHideSelfControls();
    if (_gbRequestBtn) {
      _gbRequestBtn.disabled = false;
      _gbRequestBtn.querySelector('span:last-child').textContent = 'Request Box';
    }
    toast('You left the guest box.');
  } catch (_) {
    toast('Could not leave box. Try again.');
  }
}

/* ════════════════════════════════════════════
   CREATOR — Accept pending box request
   ════════════════════════════════════════════ */
async function _gbCreatorAccept(boxNum, data) {
  if (!_roomId) return;
  try {
    await set(_gbBoxRef(boxNum), {
      status:      'occupied',
      guestId:     data.guestId,
      guestName:   data.guestName   || '',
      guestAvatar: data.guestAvatar || '',
      boxNumber:   boxNum,
      joinedAt:    Date.now(),
      liveRoomId:  _roomId,
      hostId:      _user?.uid || '',
    });
    /* update request status so viewer knows they were accepted */
    await set(_gbReqRef(data.guestId), { ...data, status: 'accepted', boxNumber: boxNum });
    /* notify guest */
    await _gbNotifyGuest(data.guestId, 'accepted', boxNum);
    /* host begins watching for guest WebRTC offer */
    _gbHostWatchGuestWebRTC(boxNum);
    toast(`✅ ${data.guestName || 'Guest'} accepted into Box ${boxNum}`);
  } catch (_) {
    toast('Could not accept. Try again.');
  }
}

/* ════════════════════════════════════════════
   CREATOR — Accept next from queue into a box
   ════════════════════════════════════════════ */
async function _gbCreatorAcceptFromQueue(boxNum, queueKey, userData) {
  if (!_roomId) return;
  try {
    await set(_gbBoxRef(boxNum), {
      status:      'occupied',
      guestId:     userData.guestId,
      guestName:   userData.guestName   || '',
      guestAvatar: userData.guestAvatar || '',
      boxNumber:   boxNum,
      joinedAt:    Date.now(),
      liveRoomId:  _roomId,
      hostId:      _user?.uid || '',
    });
    /* update request status */
    await set(_gbReqRef(userData.guestId), { ...userData, status: 'accepted', boxNumber: boxNum, inQueue: false });
    /* remove from queue */
    await remove(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/queue/${queueKey}`)).catch(() => {});
    /* notify guest */
    await _gbNotifyGuest(userData.guestId, 'accepted', boxNum);
    /* host begins watching for guest WebRTC offer */
    _gbHostWatchGuestWebRTC(boxNum);
    toast(`✅ ${userData.guestName || 'Guest'} accepted into Box ${boxNum}`);
  } catch (_) {
    toast('Could not accept. Try again.');
  }
}

/* ════════════════════════════════════════════
   CREATOR — Decline a pending request
   ════════════════════════════════════════════ */
async function _gbCreatorDecline(boxNum, data) {
  if (!_roomId) return;
  try {
    await set(_gbBoxRef(boxNum), { status: 'available', guestId: null });
    await set(_gbReqRef(data.guestId), { ...data, status: 'declined' });
    await _gbNotifyGuest(data.guestId, 'declined', boxNum);
    toast(`Declined ${data.guestName || 'guest'}'s request.`);
  } catch (_) {
    toast('Could not decline. Try again.');
  }
}

/* ════════════════════════════════════════════
   CREATOR — Remove an active guest from a box
   ════════════════════════════════════════════ */
async function _gbCreatorRemove(boxNum, data) {
  if (!_roomId) return;
  try {
    _guestStopStream(boxNum);   // close host-side WebRTC for this box
    await set(_gbBoxRef(boxNum), { status: 'available', guestId: null });
    await remove(_gbReqRef(data.guestId)).catch(() => {});
    await _gbNotifyGuest(data.guestId, 'removed', boxNum);
    toast(`Removed ${data.guestName || 'guest'} from Box ${boxNum}`);
  } catch (_) {
    toast('Could not remove. Try again.');
  }
}

/* ════════════════════════════════════════════
   CREATOR — Close a box (make unavailable then re-open)
   Re-opening simply resets it to available.
   ════════════════════════════════════════════ */
async function _gbCreatorClose(boxNum) {
  if (!_roomId) return;
  try {
    await set(_gbBoxRef(boxNum), { status: 'available', guestId: null });
    toast(`Box ${boxNum} cleared.`);
  } catch (_) {
    toast('Could not close box. Try again.');
  }
}

/* ════════════════════════════════════════════
   NOTIFICATIONS
   ════════════════════════════════════════════ */

/* notify the host when a viewer requests a box */
async function _gbNotifyHost(type, guestName, boxNum) {
  if (!_user || !_roomId) return;
  const hostId = _roomId.split('_')[0].replace(/_/g, '');
  if (!hostId) return;
  try {
    await addDoc(collection(_db, 'notifications', hostId, 'items'), {
      id:        `gb_req_${_user.uid}_${Date.now()}`,
      type:      'guestBox_request',
      fromUid:   _user.uid,
      fromName:  guestName,
      roomId:    _roomId,
      boxNumber: boxNum,
      queueType: type,
      title:     `🎥 ${guestName} wants a guest box`,
      body:      type === 'queue'
        ? `${guestName} is in the queue — open a box!`
        : `${guestName} requests Box ${boxNum}`,
      ts:        Date.now(),
      read:      false,
    });
  } catch (_) {}
}

/* notify a guest about accept / decline / remove */
async function _gbNotifyGuest(guestId, action, boxNum) {
  if (!guestId || !_roomId) return;
  const hostName = _userData?.displayName || 'Host';
  const msgs = {
    accepted: { title: `✅ You are in Box ${boxNum}!`, body: `${hostName} accepted you into guest box ${boxNum}. You are live!` },
    declined: { title: `❌ Request declined`,           body: `${hostName} declined your guest box request.` },
    removed:  { title: `You were removed from Box ${boxNum}`, body: `${hostName} removed you from the guest box.` },
  };
  const m = msgs[action];
  if (!m) return;
  try {
    await addDoc(collection(_db, 'notifications', guestId, 'items'), {
      id:        `gb_${action}_${Date.now()}`,
      type:      `guestBox_${action}`,
      fromUid:   _user?.uid || '',
      fromName:  hostName,
      roomId:    _roomId,
      boxNumber: boxNum,
      title:     m.title,
      body:      m.body,
      ts:        Date.now(),
      read:      false,
    });
  } catch (_) {}
}

/* ════════════════════════════════════════════
   HOST — Mute / unmute guest mic via RTDB flag
   Guest client watches this flag and applies it to their local track
   ════════════════════════════════════════════ */
async function _gbHostToggleGuestMic(boxNum, data) {
  if (!_roomId) return;
  const nowEnabled = data.microphoneEnabled !== false;  // default true
  try {
    await update(_gbBoxRef(boxNum), { microphoneEnabled: !nowEnabled });
    toast(`${data.guestName || 'Guest'} mic ${!nowEnabled ? 'unmuted' : 'muted'} by host`);
  } catch (_) { toast('Could not mute. Try again.'); }
}

async function _gbHostToggleGuestCam(boxNum, data) {
  if (!_roomId) return;
  const nowEnabled = data.cameraEnabled !== false;  // default true
  try {
    await update(_gbBoxRef(boxNum), { cameraEnabled: !nowEnabled });
    toast(`${data.guestName || 'Guest'} camera ${!nowEnabled ? 'enabled' : 'disabled'} by host`);
  } catch (_) { toast('Could not change camera. Try again.'); }
}

/* ════════════════════════════════════════════
   CLEANUP
   ════════════════════════════════════════════ */
function _gbCleanupCreator() {
  if (_gbBoxesUnsub) { try { off(_gbRef('boxes')); } catch (_) {} _gbBoxesUnsub = null; }
  if (_gbQueueUnsub) { try { off(_gbQueueRef());   } catch (_) {} _gbQueueUnsub = null; }
  /* close all guest WebRTC connections */
  for (let i = 1; i <= _GB_MAX_BOXES; i++) _guestStopStream(i);
  /* clear all guestBoxes data from RTDB when host ends the live */
  if (_roomId) {
    try { remove(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes`)).catch(() => {}); } catch (_) {}
  }
  _gsHideStage();
}

function _gbCleanupViewer() {
  if (_gbBoxesUnsub) { try { off(_gbRef('boxes')); } catch (_) {} _gbBoxesUnsub = null; }

  /* if viewer is in a box, clear their slot */
  if (_gbMyBoxNum !== null && _roomId) {
    try { set(_gbBoxRef(_gbMyBoxNum), { status: 'available', guestId: null }).catch(() => {}); } catch (_) {}
    _gbMyBoxNum = null;
  }
  /* stop self stream + cleanup WebRTC */
  if (_guestSelfBoxNum !== null) { _guestStopStream(_guestSelfBoxNum); _guestSelfBoxNum = null; }
  /* if viewer is in the queue, remove their entry */
  if (_gbMyRequestKey && _roomId) {
    try {
      remove(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/queue/${_gbMyRequestKey}`)).catch(() => {});
    } catch (_) {}
    _gbMyRequestKey = null;
  }
  /* clear own request record */
  if (_user && _roomId) {
    try { remove(_gbReqRef(_user.uid)).catch(() => {}); } catch (_) {}
  }
  _gsHideStage();
  _gsHideSelfControls();
}


/* ════════════════════════════════════════════════════════════════════
   GUEST STAGE — multi-participant video area
   Four layout modes: side | grid | floating | equal
   ════════════════════════════════════════════════════════════════════ */

/* ── Populate host tile (creator side) ── */
function _gsPopulateHostTile() {
  if (!_localStream) return;
  const v = D.gsHostVideo;
  if (v) { v.srcObject = _localStream; v.play().catch(() => {}); }
  if (D.gsHostName && _userData) D.gsHostName.textContent = _userData.displayName || 'Host';
  if (D.gsHostAvatar && _userData) {
    const av = _userData.avatar || _userData.profilePicture || '';
    if (av) {
      D.gsHostAvatar.style.backgroundImage = `url('${av}')`;
      D.gsHostAvatar.textContent = '';
    } else {
      D.gsHostAvatar.textContent = (_userData.displayName || 'H')[0].toUpperCase();
    }
  }
}

/* ── Populate host tile (viewer side — shows host name/avatar, no local stream) ── */
function _gsPopulateHostTileViewer(roomData) {
  if (D.gsHostName)   D.gsHostName.textContent = roomData.hostName || 'Host';
  if (D.gsHostAvatar) {
    if (roomData.hostAvatar) {
      D.gsHostAvatar.style.backgroundImage = `url('${roomData.hostAvatar}')`;
      D.gsHostAvatar.textContent = '';
    } else {
      D.gsHostAvatar.textContent = (roomData.hostName || 'H')[0].toUpperCase();
    }
  }
  /* FIX: mirror liveVideo srcObject to gsHostVideo — also re-sync when track arrives */
  const hv = D.gsHostVideo;
  if (!hv) return;
  const _syncHostVid = () => {
    if (D.liveVideo && D.liveVideo.srcObject) {
      hv.srcObject = D.liveVideo.srcObject;
      hv.play().catch(() => {});
    }
  };
  _syncHostVid();
  /* If stream hasn't arrived yet, watch for it via the video element's srcObject */
  if (!hv.srcObject && D.liveVideo) {
    D.liveVideo.addEventListener('loadedmetadata', _syncHostVid, { once: true });
  }
}

/* ── Update a single guest tile when box data changes ── */
function _gsUpdateTile(boxNum, data, role) {
  const tileEl = document.getElementById(`gsTile${boxNum}`);
  if (!tileEl) return;

  const status = data.status || 'available';

  if (status !== 'occupied') {
    tileEl.style.display = 'none';
    _gsRefreshActiveCount();
    _gsActivateIfNeeded();
    return;
  }

  tileEl.style.display = '';

  /* name + avatar */
  const nameEl   = document.getElementById(`gsGuest${boxNum}Name`);
  const avatarEl = document.getElementById(`gsGuest${boxNum}Avatar`);
  if (nameEl)   nameEl.textContent = data.guestName || `Guest ${boxNum}`;
  if (avatarEl) {
    const av = data.guestAvatar || '';
    if (av) {
      avatarEl.style.backgroundImage = `url('${av}')`;
      avatarEl.textContent = '';
    } else {
      avatarEl.style.backgroundImage = '';
      avatarEl.textContent = (data.guestName || 'G')[0].toUpperCase();
    }
  }

  /* cam/mic indicators */
  const camInd  = document.getElementById(`gsGuest${boxNum}Cam`);
  const micInd  = document.getElementById(`gsGuest${boxNum}Mic`);
  const connInd = document.getElementById(`gsGuest${boxNum}Conn`);
  if (camInd)  camInd.classList.toggle('off',  data.cameraEnabled    === false);
  if (micInd)  micInd.classList.toggle('off',  data.microphoneEnabled === false);
  if (connInd) {
    const q = data.connectionQuality || 'good';
    connInd.className = 'gs-ind gs-ind-conn conn-' + q;
  }

  /* cam off overlay in tile */
  const camOffEl = document.getElementById(`gsGuest${boxNum}CamOff`);
  if (camOffEl) {
    camOffEl.style.display = data.cameraEnabled === false ? 'flex' : 'none';
  }

  /* weak conn warning */
  const warnEl = document.getElementById(`gsGuest${boxNum}ConnWarn`);
  if (warnEl) {
    const isWeak = data.connectionQuality === 'weak' || data.connectionQuality === 'bad';
    warnEl.style.display = isWeak ? 'block' : 'none';
  }

  /* if I (viewer/guest) am watching my own hosted stream, apply track state */
  if (role === 'viewer' && data.guestId === _user?.uid && _guestSelfStream) {
    _guestSelfStream.getAudioTracks().forEach(t => {
      t.enabled = data.microphoneEnabled !== false;
    });
    _guestSelfStream.getVideoTracks().forEach(t => {
      t.enabled = data.cameraEnabled !== false;
    });
  }

  _gsRefreshActiveCount();
  /* activate guest stage when at least one guest is live */
  _gsActivateIfNeeded();
}

/* ── Count visible (occupied) tiles + update data-count attribute ── */
function _gsRefreshActiveCount() {
  const stageEl = D.guestStage;
  if (!stageEl) return;
  // Count host tile + visible guest tiles for the grid data-count
  const visibleGuests = stageEl.querySelectorAll('.gs-guest-tile:not([style*="display: none"])');
  // data-count = total participants (1 host + N guests) — drives CSS grid layouts
  stageEl.dataset.count = visibleGuests.length + 1;
}

/* ── Show guest stage (replaces the single liveVideo area) ── */
function _gsActivateIfNeeded() {
  const stageEl = D.guestStage;
  if (!stageEl) return;
  const visibleGuests = stageEl.querySelectorAll('.gs-guest-tile:not([style*="display: none"])');
  if (visibleGuests.length > 0 && !document.body.classList.contains('gs-active')) {
    document.body.classList.add('gs-active');
    stageEl.style.display = '';
    stageEl.classList.add('active');

    /* FIX: for viewer, re-sync host tile video when stage first activates */
    if (_mode === 'viewer' && D.gsHostVideo && D.liveVideo && D.liveVideo.srcObject) {
      D.gsHostVideo.srcObject = D.liveVideo.srcObject;
      D.gsHostVideo.play().catch(() => {});
    }
    /* FIX: for creator, always keep host tile pointing at _localStream */
    if (_mode === 'creator' && D.gsHostVideo && _localStream) {
      D.gsHostVideo.srcObject = _localStream;
      D.gsHostVideo.play().catch(() => {});
    }
  }
  if (visibleGuests.length === 0 && document.body.classList.contains('gs-active')) {
    _gsHideStage();
  }
  /* FIX: Auto-reflow grid only when layout-grid is the active body class.
     Avoids calling _setLayout with a stale mode that triggers camera restarts. */
  if (_layoutMode === 'grid' && document.body.classList.contains('layout-grid')) {
    /* just refresh data-count — CSS grid responds automatically */
  }
}

function _gsHideStage() {
  document.body.classList.remove('gs-active');
  if (D.guestStage) {
    D.guestStage.classList.remove('active');
    D.guestStage.style.display = 'none';
  }
}

function _gsHideSelfControls() {
  if (D.guestSelfControls) D.guestSelfControls.style.display = 'none';
}

/* ════════════════════════════════════════════════════════════════════
   LAYOUT — set layout mode (side | grid | floating | equal)
   ════════════════════════════════════════════════════════════════════ */
function _setLayout(mode, persistToRTDB) {
  const validModes = ['side', 'grid', 'floating', 'equal'];
  if (!validModes.includes(mode)) mode = 'side';
  _layoutMode = mode;

  /* remove all layout classes */
  document.body.classList.remove('layout-side', 'layout-grid', 'layout-floating', 'layout-equal');
  document.body.classList.add('layout-' + mode);

  /* update active button */
  if (D.layoutSwitcher) {
    D.layoutSwitcher.querySelectorAll('.layout-btn').forEach(btn => {
      btn.classList.toggle('layout-btn-active', btn.dataset.layout === mode);
    });
  }

  /* persist to RTDB so viewers follow (creator only, default persistToRTDB = true) */
  if (persistToRTDB !== false && _mode === 'creator' && _roomId) {
    set(_gbRef('layoutMode'), mode).catch(() => {});
  }

  /* enable drag for floating layout */
  if (mode === 'floating') _gsEnableDrag();
}

/* ════════════════════════════════════════════════════════════════════
   DRAG — floating tiles can be repositioned (layout-floating only)
   ════════════════════════════════════════════════════════════════════ */
function _gsEnableDrag() {
  const tiles = document.querySelectorAll('.gs-guest-tile');
  tiles.forEach(tile => {
    if (tile._dragEnabled) return;
    tile._dragEnabled = true;
    let startX, startY, origLeft, origBottom;

    const onDown = (e) => {
      if (!document.body.classList.contains('layout-floating')) return;
      const evt = e.touches ? e.touches[0] : e;
      startX = evt.clientX; startY = evt.clientY;
      const rect = tile.getBoundingClientRect();
      origLeft   = rect.left;
      origBottom = window.innerHeight - rect.bottom;
      tile.style.left    = origLeft   + 'px';
      tile.style.bottom  = origBottom + 'px';
      tile.style.right   = 'auto';
      tile.style.top     = 'auto';
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onUp);
      document.addEventListener('touchmove', onMove, { passive: false });
      document.addEventListener('touchend',  onUp);
    };
    const onMove = (e) => {
      if (e.cancelable) e.preventDefault();
      const evt = e.touches ? e.touches[0] : e;
      const dx = evt.clientX - startX;
      const dy = evt.clientY - startY;
      tile.style.left   = Math.max(0, origLeft   + dx) + 'px';
      tile.style.bottom = Math.max(0, origBottom - dy) + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onUp);
    };
    tile.addEventListener('mousedown',  onDown);
    tile.addEventListener('touchstart', onDown, { passive: true });
  });
}

/* ════════════════════════════════════════════════════════════════════
   GUEST WebRTC — guest captures their stream and signals host
   Architecture:
     Guest → RTDB path: liveRooms/{roomId}/guestBoxes/webrtc/{boxNum}
       guestOffer, guestCandidates
     Host  → RTDB path: same node
       hostAnswer, hostCandidates
   ════════════════════════════════════════════════════════════════════ */

function _gbGuestSignalRef(boxNum) {
  return ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}`);
}

/* ── Guest: start camera/mic stream + create WebRTC offer ── */
async function _guestStartStream(boxNum) {
  /* FIX: clean up any previous stream/PC for this box before starting fresh */
  if (_guestPcs[boxNum]?.pc) {
    try { _guestPcs[boxNum].pc.close(); } catch (_) {}
    delete _guestPcs[boxNum];
  }
  if (_guestSelfStream) {
    _guestSelfStream.getTracks().forEach(t => t.stop());
    _guestSelfStream = null;
  }

  /* acquire camera + mic */
  try {
    _guestSelfStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: true,
    });
  } catch (err) {
    try {
      _guestSelfStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      _guestSelfCamOn = false;
      toast('Camera not available — joining with audio only.');
    } catch (e) {
      toast('Camera & mic access denied. Cannot join box.');
      return;
    }
  }

  /* show self-controls bar */
  if (D.guestSelfControls) D.guestSelfControls.style.display = 'flex';

  /* update RTDB with initial cam/mic state */
  try {
    await update(_gbBoxRef(boxNum), {
      cameraEnabled:    _guestSelfCamOn,
      microphoneEnabled: _guestSelfMicOn,
    });
  } catch (_) {}

  /* show own video in the guest stage tile (mirrored) */
  const selfVid = document.getElementById(`gsGuestVideo${boxNum}`);
  if (selfVid) {
    selfVid.srcObject = _guestSelfStream;
    selfVid.style.transform = 'scaleX(-1)';
    selfVid.play().catch(() => {});
    const tile = document.getElementById(`gsTile${boxNum}`);
    if (tile) tile.style.display = '';
    _gsActivateIfNeeded();
  }

  /* create WebRTC peer connection — guest is the offerer */
  const pc = new RTCPeerConnection(_ICE_SERVERS);
  _guestPcs[boxNum] = { pc, guestId: _user?.uid };

  _guestSelfStream.getTracks().forEach(track => pc.addTrack(track, _guestSelfStream));

  const signalRef = _gbGuestSignalRef(boxNum);
  const pendingCandidates = [];
  let offerWritten = false;

  pc.onicecandidate = async (e) => {
    if (!e.candidate) return;
    if (!offerWritten) { pendingCandidates.push(e.candidate.toJSON()); return; }
    try { await push(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}/guestCandidates`), e.candidate.toJSON()); }
    catch (_) {}
  };

  pc.onconnectionstatechange = () => {
    const state = pc.connectionState;
    const quality = state === 'connected'     ? 'good' :
                    state === 'disconnected'  ? 'weak' :
                    state === 'failed'        ? 'bad'  : 'good';
    if (_roomId) {
      update(_gbBoxRef(boxNum), { connectionQuality: quality }).catch(() => {});
    }
    if (state === 'failed') {
      toast('Connection lost. Trying to reconnect…');
      _guestReconnect(boxNum);
    }
  };

  /* start stats polling for quality reporting */
  _guestStartStatsPolling(boxNum, pc);

  let offer;
  try { offer = await pc.createOffer(); } catch (e) { return; }
  await pc.setLocalDescription(offer);

  try {
    await set(signalRef, {
      guestOffer:       { type: offer.type, sdp: offer.sdp },
      guestCandidates:  {},
      hostAnswer:       null,
      hostCandidates:   {},
    });
    offerWritten = true;
  } catch (e) { return; }

  /* flush buffered candidates */
  for (const cand of pendingCandidates) {
    try { await push(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}/guestCandidates`), cand); } catch (_) {}
  }

  /* watch for host answer */
  let appliedHostCandKeys = new Set();
  onValue(signalRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (d.hostAnswer && pc.remoteDescription === null) {
      try { await pc.setRemoteDescription(new RTCSessionDescription(d.hostAnswer)); } catch (_) {}
    }
    if (pc.remoteDescription && d.hostCandidates) {
      for (const [key, cand] of Object.entries(d.hostCandidates)) {
        if (appliedHostCandKeys.has(key)) continue;
        appliedHostCandKeys.add(key);
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    }
  });
}

/* ── Host: watches each box for guest WebRTC offer and answers ── */
function _gbHostWatchGuestWebRTC(boxNum) {
  if (!_roomId) return;
  const signalRef = _gbGuestSignalRef(boxNum);

  /* FIX: track processed offer SDP so we don't re-create PC on every ICE candidate
     addition (onValue fires on every child change in the signaling node) */
  let _processedOfferSdp = null;

  onValue(signalRef, async snap => {
    if (!snap.exists()) return;
    const d = snap.val();
    if (!d.guestOffer) return;

    /* FIX: skip if we already processed this exact offer */
    if (d.guestOffer.sdp === _processedOfferSdp) return;
    _processedOfferSdp = d.guestOffer.sdp;

    /* clean up old PC for this box if one exists */
    if (_guestPcs[boxNum]?.pc) {
      try { _guestPcs[boxNum].pc.close(); } catch (_) {}
    }

    const pc = new RTCPeerConnection(_ICE_SERVERS);
    _guestPcs[boxNum] = { pc };

    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      const vid = document.getElementById(`gsGuestVideo${boxNum}`);
      if (vid) {
        vid.srcObject = stream;
        vid.play().catch(() => {});
      }
      /* also populate the management panel video */
      const panelVid = document.getElementById(`guestVideo${boxNum}`);
      if (panelVid) { panelVid.srcObject = stream; panelVid.play().catch(() => {}); }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const quality = state === 'connected'    ? 'good' :
                      state === 'disconnected' ? 'weak' :
                      state === 'failed'       ? 'bad'  : 'good';
      update(_gbBoxRef(boxNum), { connectionQuality: quality }).catch(() => {});
    };

    await pc.setRemoteDescription(new RTCSessionDescription(d.guestOffer));

    /* wire ICE before createAnswer */
    const pendingCandidates = [];
    let answerWritten = false;

    pc.onicecandidate = async (e) => {
      if (!e.candidate) return;
      if (!answerWritten) { pendingCandidates.push(e.candidate.toJSON()); return; }
      try { await push(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}/hostCandidates`), e.candidate.toJSON()); }
      catch (_) {}
    };

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    try {
      await update(signalRef, { hostAnswer: { type: answer.type, sdp: answer.sdp } });
      answerWritten = true;
    } catch (e) { return; }

    for (const cand of pendingCandidates) {
      try { await push(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}/hostCandidates`), cand); } catch (_) {}
    }

    /* apply any existing guest ICE candidates */
    const existingCands = d.guestCandidates || {};
    const appliedKeys = new Set(Object.keys(existingCands));
    for (const cand of Object.values(existingCands)) {
      try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
    }

    /* listen for new guest ICE candidates */
    onValue(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}/guestCandidates`), async candSnap => {
      if (!candSnap.exists()) return;
      for (const [key, cand] of Object.entries(candSnap.val())) {
        if (appliedKeys.has(key)) continue;
        appliedKeys.add(key);
        try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
    });
  });
}

/* ── Stop/cleanup a guest's WebRTC for a given box ── */
function _guestStopStream(boxNum) {
  if (_guestPcs[boxNum]) {
    const { pc, statsInterval } = _guestPcs[boxNum];
    if (statsInterval) clearInterval(statsInterval);
    try { pc.close(); } catch (_) {}
    delete _guestPcs[boxNum];
  }
  /* stop self stream if this was the self box */
  if (_guestSelfBoxNum === boxNum && _guestSelfStream) {
    _guestSelfStream.getTracks().forEach(t => t.stop());
    _guestSelfStream = null;
  }
  /* clean up RTDB WebRTC signaling */
  if (_roomId) {
    try { remove(ref(_liveDB, `liveRooms/${_roomId}/guestBoxes/webrtc/${boxNum}`)).catch(() => {}); } catch (_) {}
  }
  /* hide tile */
  const tile = document.getElementById(`gsTile${boxNum}`);
  if (tile) tile.style.display = 'none';
  _gsRefreshActiveCount();
  _gsActivateIfNeeded();
}

/* ── Guest: auto-reconnect on connection failure ── */
async function _guestReconnect(boxNum) {
  await new Promise(r => setTimeout(r, 3000));
  /* FIX: bail if the viewer was removed from the box while waiting */
  if (_guestSelfBoxNum !== boxNum) return;
  /* FIX: only reconnect once — re-entry guard via flag on the state object */
  if (_guestPcs[boxNum]?._reconnecting) return;
  if (!_guestPcs[boxNum]) _guestPcs[boxNum] = {};
  _guestPcs[boxNum]._reconnecting = true;
  await _guestStartStream(boxNum);
  if (_guestPcs[boxNum]) _guestPcs[boxNum]._reconnecting = false;
}

/* ── Quality stats polling: checks packet loss / bandwidth every 5s ── */
function _guestStartStatsPolling(boxNum, pc) {
  const interval = setInterval(async () => {
    if (!pc || pc.connectionState === 'closed') { clearInterval(interval); return; }
    try {
      const stats = await pc.getStats();
      let packetsLost = 0, packetsSent = 0;
      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          packetsLost  += report.packetsLost  || 0;
          packetsSent  += report.packetsSent  || 1;
        }
      });
      const lossRate = packetsLost / (packetsSent || 1);
      const quality  = lossRate > 0.15 ? 'bad' : lossRate > 0.05 ? 'weak' : 'good';

      /* lower quality if connection is bad */
      if (quality !== 'good' && _guestSelfStream) {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          const params = sender.getParameters();
          if (params.encodings?.length) {
            params.encodings[0].maxBitrate = quality === 'bad' ? 100000 : 300000;
            sender.setParameters(params).catch(() => {});
          }
        }
      }

      /* update RTDB with quality */
      if (_roomId) {
        update(_gbBoxRef(boxNum), { connectionQuality: quality }).catch(() => {});
      }
    } catch (_) {}
  }, 5000);

  if (_guestPcs[boxNum]) _guestPcs[boxNum].statsInterval = interval;
}

/* ════════════════════════════════════════════════════════════════════
   GUEST SELF-CONTROLS (viewer in a box)
   ════════════════════════════════════════════════════════════════════ */

function _guestToggleCam() {
  _guestSelfCamOn = !_guestSelfCamOn;
  if (_guestSelfStream) {
    _guestSelfStream.getVideoTracks().forEach(t => t.enabled = _guestSelfCamOn);
  }
  if (D.btnGuestCam) {
    D.btnGuestCam.textContent = _guestSelfCamOn ? '📷 Cam' : '📷 Cam Off';
    D.btnGuestCam.classList.toggle('off', !_guestSelfCamOn);
  }
  /* update RTDB so host can see */
  if (_roomId && _guestSelfBoxNum !== null) {
    update(_gbBoxRef(_guestSelfBoxNum), { cameraEnabled: _guestSelfCamOn }).catch(() => {});
  }
  /* cam-off overlay in tile */
  if (_guestSelfBoxNum !== null) {
    const camOff = document.getElementById(`gsGuest${_guestSelfBoxNum}CamOff`);
    if (camOff) camOff.style.display = _guestSelfCamOn ? 'none' : 'flex';
  }
}

function _guestToggleMic() {
  _guestSelfMicOn = !_guestSelfMicOn;
  if (_guestSelfStream) {
    _guestSelfStream.getAudioTracks().forEach(t => t.enabled = _guestSelfMicOn);
  }
  if (D.btnGuestMic) {
    D.btnGuestMic.textContent = _guestSelfMicOn ? '🎤 Mic' : '🔇 Muted';
    D.btnGuestMic.classList.toggle('off', !_guestSelfMicOn);
  }
  /* update RTDB so host can see */
  if (_roomId && _guestSelfBoxNum !== null) {
    update(_gbBoxRef(_guestSelfBoxNum), { microphoneEnabled: _guestSelfMicOn }).catch(() => {});
  }
}
