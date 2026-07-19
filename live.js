/**
 * Shadow Nexus Live — live.js
 *
 * Architecture (Firebase Firestore + WebRTC — no third-party streaming service):
 *
 *  CREATOR:
 *    1. Captures local camera + mic via getUserMedia.
 *    2. Creates a liveRooms/{roomId} Firestore doc (status: 'live').
 *    3. Creates RTCPeerConnection, writes SDP offer to liveConnections/{roomId}.
 *    4. Waits for viewer answer + ICE, then streams directly via WebRTC.
 *
 *  VIEWER:
 *    1. Reads liveRooms/{roomId} to confirm stream is live.
 *    2. Reads SDP offer from liveConnections/{roomId}.
 *    3. Creates RTCPeerConnection, sends answer + ICE back to Firestore.
 *    4. Receives creator tracks via WebRTC ontrack.
 *
 *  Chat + Likes:
 *    Stored in Firestore sub-collections under liveRooms/{roomId}.
 */

'use strict';

/* ── Firebase imports ── */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js';
import {
  getAuth, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc,
  collection, query, orderBy, limit, onSnapshot,
  serverTimestamp, increment, where, deleteField, arrayUnion
} from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';

const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _app  = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(_CFG);
const _auth = getAuth(_app);
const _db   = getFirestore(_app);

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
let _rtcSignalUnsub  = null;   // Firestore listener for signaling

let _chatUnsub        = null;
let _viewerCountUnsub = null;
let _toastTimer       = null;
let _viewerLeftFlag   = false;  // guard: prevent double-decrement on mobile

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
  };

  // Disable Go Live until Firebase auth resolves (prevents null _user crash)
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

  // Close/back button on live stage
  document.getElementById('liveCloseBtn') &&
    document.getElementById('liveCloseBtn').addEventListener('click', onCloseBtn);

  // Tap stage to show/hide controls (creator only)
  D.stage && D.stage.addEventListener('click', e => {
    if (_mode !== 'creator') return;
    const ignore = ['.live-ctrl-btn','#btnEndLive','.live-chat-input','.live-chat-send',
                    '.live-close-btn','.live-creator-pill','.live-badge'];
    if (ignore.some(s => e.target.closest(s))) return;
    D.stage.classList.toggle('live-controls-hidden');
  });

  // Wait for Firebase auth
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
  const hash = location.hash;  // e.g. #watch=abc123
  localStorage.removeItem('snx_live_intent');

  if (hash.startsWith('#watch=')) {
    _roomId = decodeURIComponent(hash.slice(7));
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
      toast('📷 Camera not available — audio only');
    } catch (e) {
      toast('⚠️ Camera & mic access denied. Check browser permissions.');
    }
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
    toast('⚠️ Please wait — still signing in…');
    return;
  }
  if (_user.isAnonymous) {
    toast('⚠️ You must be signed in with a real account to go live.');
    return;
  }
  if (!_localStream || !_localStream.getTracks().length) {
    toast('⚠️ No camera/mic available. Check browser permissions and refresh.');
    return;
  }

  const titleVal = (D.setupTitle?.value || '').trim();
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; D.goLiveBtn.textContent = 'Going Live…'; }

  _roomId = `${_user.uid}_${Date.now().toString(36)}`;

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
    createdAt:    serverTimestamp(),
  };

  try {
    await setDoc(doc(_db, 'liveRooms', _roomId), creatorData);
  } catch (e) {
    toast('⚠️ Could not start live: ' + e.message);
    if (D.goLiveBtn) { D.goLiveBtn.disabled = false; D.goLiveBtn.textContent = 'Start Live'; }
    return;
  }

  // Stamp the user's own doc so the feed shows the live ring + LIVE NOW badge
  try {
    await updateDoc(doc(_db, 'users', _user.uid), {
      isLive:     true,
      liveRoomId: _roomId,
    });
  } catch (_) {}

  // Create a feed post so the main feed shows a LIVE card
  await _createLiveFeedPost(creatorData);

  // Create a live story entry so the story bar shows a LIVE bubble
  _createLiveStory(creatorData);

  // Notify all followers that the creator is live
  _notifyFollowersLive(creatorData);

  // Transition from setup to stage
  if (D.setup) D.setup.style.display = 'none';
  _showStage();
  _attachLocalVideoToStage();
  _populateCreatorInfo(creatorData);

  // Start WebRTC as creator
  await _startCreatorWebRTC();

  // Start chat listener + viewer count
  _subscribeChat();
  _subscribeViewerCount();

  toast('🔴 You are LIVE!');
}

function _attachLocalVideoToStage() {
  if (!D.liveVideo || !_localStream) return;
  D.liveVideo.srcObject = _localStream;
  D.liveVideo.play().catch(() => {});
  D.camOffOverlay && D.camOffOverlay.classList.toggle('visible', !_camOn);
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

/* ── Subscribe to viewer count from Firestore ── */
function _subscribeViewerCount() {
  _viewerCountUnsub = onSnapshot(doc(_db, 'liveRooms', _roomId), snap => {
    if (!snap.exists()) return;
    const d = snap.data();
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + (d.viewers || 0);
    if (D.likeCount)   D.likeCount.textContent   = '❤️ ' + (d.likes   || 0);
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
  toast(_micOn ? '🎤 Mic on' : '🔇 Mic muted');
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
    // Replace the video track in the existing RTCPeerConnection
    if (_rtcPc && newStream.getVideoTracks()[0]) {
      const newVideoTrack = newStream.getVideoTracks()[0];
      const sender = _rtcPc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        await sender.replaceTrack(newVideoTrack).catch(() => {});
      }
    }
  } catch (e) {
    toast('⚠️ Could not flip camera: ' + e.message);
  }
}

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

async function endLive() {
  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalUnsub) { _rtcSignalUnsub(); _rtcSignalUnsub = null; }
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountUnsub) { _viewerCountUnsub();  _viewerCountUnsub = null; }

  // Clean up WebRTC signaling doc from Firestore
  if (_roomId) {
    try { await deleteDoc(doc(_db, 'liveConnections', _roomId)); } catch (_) {}
  }

  // Stop local tracks
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }

  // Mark room as ended in Firestore
  try {
    await updateDoc(doc(_db, 'liveRooms', _roomId), {
      status:  'ended',
      isLive:  false,
      endedAt: serverTimestamp(),
    });
  } catch (_) {}

  // Clear live status from user doc
  try {
    await updateDoc(doc(_db, 'users', _user.uid), {
      isLive:     deleteField(),
      liveRoomId: deleteField(),
    });
  } catch (_) {}

  // Delete the primary live feed post
  if (_feedPostId) {
    try { await deleteDoc(doc(_db, 'posts', _feedPostId)); } catch (_) {}
    _feedPostId = null;
  }

  // Mark any share posts for this room as ended
  try {
    const shareQ = query(
      collection(_db, 'posts'),
      where('liveRoomId', '==', _roomId),
      where('type', '==', 'live_share')
    );
    const shareSnap = await getDocs(shareQ);
    shareSnap.forEach(async shareDoc => {
      try { await updateDoc(shareDoc.ref, { isLive: false }); } catch (_) {}
    });
  } catch (_) {}

  // Remove the live story bubble
  _deleteLiveStory();

  // Show ended overlay
  _showEndedOverlay(true);
}

/* ═══════════════════════════════════════════════════
   LIVE FEED POST — create / delete in 'posts' collection
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
  } catch (e) {
    console.warn('[Live] Could not create feed post:', e.message);
  }
}

/* ═══════════════════════════════════════════════════
   LIVE STORY — create / delete a story-bar bubble
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
  } catch (e) {
    console.warn('[Live] Could not create live story:', e.message);
  }
}

async function _deleteLiveStory() {
  if (!_user) return;
  try {
    await deleteDoc(doc(_db, 'stories', _liveStoryId()));
  } catch (_) {}
}

/* ═══════════════════════════════════════════════════
   FOLLOWER LIVE NOTIFICATIONS
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
  } catch (e) {
    console.warn('[Live] Could not notify followers:', e.message);
  }
}

/* ═══════════════════════════════════════════════════
   VIEWER — join a live stream
   ═══════════════════════════════════════════════════ */
async function _startViewer() {
  let roomData = null;
  try {
    const snap = await getDoc(doc(_db, 'liveRooms', _roomId));
    if (!snap.exists() || snap.data().status !== 'live') {
      _hideLoading();
      _showEndedOverlay(false, '⚫ Stream Not Found', 'This live stream has ended or does not exist.');
      return;
    }
    roomData = snap.data();
  } catch (e) {
    _hideLoading();
    toast('⚠️ Could not connect: ' + e.message);
    return;
  }

  _hideLoading();
  _showStage();
  _populateCreatorInfo(roomData);
  _setupViewerControls(roomData);
  _subscribeChat();

  // Increment viewer count
  try {
    await updateDoc(doc(_db, 'liveRooms', _roomId), { viewers: increment(1) });
  } catch (_) {}

  // Watch for stream ending
  onSnapshot(doc(_db, 'liveRooms', _roomId), snap => {
    if (!snap.exists() || snap.data().status === 'ended') {
      _showEndedOverlay(false, '⚫ Stream Ended', `${roomData.hostName} has ended the live stream.`);
    }
    const d = snap.data() || {};
    if (D.viewerCount) D.viewerCount.textContent = '👁 ' + (d.viewers || 0);
    if (D.likeCount)   D.likeCount.textContent   = '❤️ ' + (d.likes   || 0);
  });

  await _startViewerWebRTC(roomData);

  // Decrement viewer count on leave
  window.addEventListener('beforeunload', _viewerLeave);
  window.addEventListener('pagehide',     _viewerLeave);
}

async function _viewerLeave() {
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalUnsub) { _rtcSignalUnsub(); _rtcSignalUnsub = null; }

  try { await updateDoc(doc(_db, 'liveRooms', _roomId), { viewers: increment(-1) }); } catch (_) {}
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
   Creates offer, writes to Firestore, listens for answer.
   ═══════════════════════════════════════════════════ */
async function _startCreatorWebRTC() {
  console.log('[Creator WebRTC] Starting. roomId =', _roomId);
  console.log('[Creator WebRTC] Auth uid =', _user?.uid, '| anonymous =', _user?.isAnonymous);

  if (!_localStream) {
    toast('⚠️ No local stream for WebRTC');
    console.error('[Creator WebRTC] ABORT — no local stream');
    return;
  }

  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);
  console.log('[Creator WebRTC] RTCPeerConnection created');

  // Attach local tracks
  _localStream.getTracks().forEach(track => {
    _rtcPc.addTrack(track, _localStream);
    console.log('[Creator WebRTC] Track added to PC:', track.kind, track.label);
  });

  _rtcPc.onconnectionstatechange = () => {
    console.log('[Creator WebRTC] Connection state →', _rtcPc.connectionState);
    if (_rtcPc.connectionState === 'connected') {
      toast('🟢 Viewer connected via WebRTC');
    }
  };

  _rtcPc.oniceconnectionstatechange = () => {
    console.log('[Creator WebRTC] ICE connection state →', _rtcPc.iceConnectionState);
  };

  _rtcPc.onicegatheringstatechange = () => {
    console.log('[Creator WebRTC] ICE gathering state →', _rtcPc.iceGatheringState);
  };

  // Create offer and set local description FIRST
  const offer = await _rtcPc.createOffer();
  await _rtcPc.setLocalDescription(offer);
  console.log('[Creator WebRTC] Local description set (offer). SDP length =', offer.sdp.length);

  // Write the offer doc to Firestore — this MUST complete before ICE writes
  console.log('[Creator WebRTC] Writing offer to liveConnections/' + _roomId + ' …');
  try {
    await setDoc(doc(_db, 'liveConnections', _roomId), {
      offer:             { type: offer.type, sdp: offer.sdp },
      creatorCandidates: [],
      viewerCandidates:  [],
    });
    console.log('[Creator WebRTC] ✅ Offer written to Firestore successfully');
  } catch (e) {
    console.error('[Creator WebRTC] ❌ Firestore write FAILED:', e.code, e.message);
    toast('⚠️ Could not write offer: ' + e.message);
    return;
  }

  // NOW wire up ICE — the doc already exists so arrayUnion is safe
  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) {
      console.log('[Creator WebRTC] ICE gathering complete (null candidate)');
      return;
    }
    console.log('[Creator WebRTC] New ICE candidate:', e.candidate.type, e.candidate.protocol);
    try {
      await updateDoc(doc(_db, 'liveConnections', _roomId), {
        creatorCandidates: arrayUnion(e.candidate.toJSON()),
      });
    } catch (err) {
      console.warn('[Creator WebRTC] ICE write error:', err.code, err.message);
    }
  };

  // Track which viewer ICE candidates we have already applied
  let _appliedViewerCandCount = 0;

  // Listen for viewer answer + new ICE candidates
  _rtcSignalUnsub = onSnapshot(doc(_db, 'liveConnections', _roomId), async snap => {
    if (!snap.exists()) return;
    const d = snap.data();

    // Apply answer exactly once
    if (d.answer && _rtcPc.remoteDescription === null) {
      console.log('[Creator WebRTC] Answer arrived — setting remote description');
      try {
        await _rtcPc.setRemoteDescription(new RTCSessionDescription(d.answer));
        console.log('[Creator WebRTC] ✅ Remote description set (answer)');
      } catch (err) {
        console.warn('[Creator WebRTC] setRemoteDescription error:', err.message);
      }
    }

    // Only apply viewer ICE candidates we haven't processed yet
    const cands = d.viewerCandidates || [];
    if (_rtcPc.remoteDescription && cands.length > _appliedViewerCandCount) {
      const newCands = cands.slice(_appliedViewerCandCount);
      console.log('[Creator WebRTC] Applying', newCands.length, 'new viewer ICE candidate(s)');
      for (const cand of newCands) {
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
      _appliedViewerCandCount = cands.length;
    }
  });

  toast('📡 Waiting for viewers…');
}

/* ═══════════════════════════════════════════════════
   WebRTC — VIEWER
   Reads offer, creates answer, exchanges ICE.
   ═══════════════════════════════════════════════════ */
async function _startViewerWebRTC(roomData) {
  console.log('[Viewer WebRTC] Starting. roomId =', _roomId);
  console.log('[Viewer WebRTC] Auth uid =', _user?.uid, '| anonymous =', _user?.isAnonymous);

  _showConnBanner('Connecting…', 'Establishing connection with ' + roomData.hostName);

  // Read offer from Firestore BEFORE creating RTCPeerConnection.
  // If the offer isn't there yet, poll without allocating a PC — no orphan connections.
  let connSnap;
  console.log('[Viewer WebRTC] Reading liveConnections/' + _roomId + ' …');
  try {
    connSnap = await getDoc(doc(_db, 'liveConnections', _roomId));
  } catch (e) {
    console.error('[Viewer WebRTC] ❌ Firestore read FAILED:', e.code, e.message);
    _showConnBanner('⚠️ Signaling error', 'Could not read offer: ' + e.message);
    return;
  }

  if (!connSnap.exists() || !connSnap.data().offer) {
    console.log('[Viewer WebRTC] No offer yet in liveConnections/' + _roomId + ' — polling…');
    _showConnBanner('⏳ Waiting for stream…', 'No offer yet — retrying…');
    // Poll every 2 s — no RTCPeerConnection allocated until an offer exists
    const pollInterval = setInterval(async () => {
      try {
        const retry = await getDoc(doc(_db, 'liveConnections', _roomId));
        if (retry.exists() && retry.data().offer) {
          console.log('[Viewer WebRTC] Offer found on poll — proceeding');
          clearInterval(pollInterval);
          _startViewerWebRTC(roomData);
        }
      } catch (err) {
        console.warn('[Viewer WebRTC] Poll read error:', err.code, err.message);
      }
    }, 2000);
    return;
  }

  console.log('[Viewer WebRTC] ✅ Offer found in Firestore. Fields:',
    Object.keys(connSnap.data()).join(', '));

  // Offer is available — now create the peer connection
  if (_rtcPc) { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  _rtcPc = new RTCPeerConnection(_ICE_SERVERS);
  console.log('[Viewer WebRTC] RTCPeerConnection created');

  // When remote track arrives, attach to <video>
  _rtcPc.ontrack = (e) => {
    console.log('[Viewer WebRTC] ✅ Track received:', e.track.kind, e.track.label);
    if (!D.liveVideo) return;
    const stream = e.streams[0] || new MediaStream([e.track]);
    D.liveVideo.srcObject = stream;
    D.liveVideo.muted = true;
    D.liveVideo.play().catch(err => console.warn('[Viewer WebRTC] play() error:', err.message));
    _showUnmutePrompt();
    _hideConnBanner();
  };

  _rtcPc.onconnectionstatechange = () => {
    console.log('[Viewer WebRTC] Connection state →', _rtcPc.connectionState);
    if (_rtcPc.connectionState === 'connected') {
      _hideConnBanner();
      toast('🟢 Connected to live stream');
    } else if (_rtcPc.connectionState === 'disconnected' || _rtcPc.connectionState === 'failed') {
      _showConnBanner('⚠️ Connection lost', 'WebRTC connection failed');
    }
  };

  _rtcPc.oniceconnectionstatechange = () => {
    console.log('[Viewer WebRTC] ICE connection state →', _rtcPc.iceConnectionState);
  };

  _rtcPc.onicegatheringstatechange = () => {
    console.log('[Viewer WebRTC] ICE gathering state →', _rtcPc.iceGatheringState);
  };

  const offer = connSnap.data().offer;
  console.log('[Viewer WebRTC] Setting remote description (offer)…');
  try {
    await _rtcPc.setRemoteDescription(new RTCSessionDescription(offer));
    console.log('[Viewer WebRTC] ✅ Remote description set');
  } catch (e) {
    console.error('[Viewer WebRTC] ❌ setRemoteDescription failed:', e.message);
    _showConnBanner('⚠️ Offer error', 'Could not set offer: ' + e.message);
    return;
  }

  // Create answer
  const answer = await _rtcPc.createAnswer();
  await _rtcPc.setLocalDescription(answer);
  console.log('[Viewer WebRTC] Local description set (answer). SDP length =', answer.sdp.length);

  // Wire up ICE — doc already exists so updateDoc is safe
  _rtcPc.onicecandidate = async (e) => {
    if (!e.candidate) {
      console.log('[Viewer WebRTC] ICE gathering complete (null candidate)');
      return;
    }
    console.log('[Viewer WebRTC] New ICE candidate:', e.candidate.type, e.candidate.protocol);
    try {
      await updateDoc(doc(_db, 'liveConnections', _roomId), {
        viewerCandidates: arrayUnion(e.candidate.toJSON()),
      });
    } catch (err) {
      console.warn('[Viewer WebRTC] ICE write error:', err.code, err.message);
    }
  };

  // Write answer to Firestore
  console.log('[Viewer WebRTC] Writing answer to Firestore…');
  try {
    await updateDoc(doc(_db, 'liveConnections', _roomId), {
      answer: { type: answer.type, sdp: answer.sdp },
    });
    console.log('[Viewer WebRTC] ✅ Answer written to Firestore');
  } catch (e) {
    console.error('[Viewer WebRTC] ❌ Answer write FAILED:', e.code, e.message);
    _showConnBanner('⚠️ Answer write error', e.message);
    return;
  }

  // Apply creator ICE candidates already present in the snapshot
  let _appliedCreatorCandCount = 0;
  const existingCands = connSnap.data().creatorCandidates || [];
  console.log('[Viewer WebRTC] Applying', existingCands.length, 'existing creator ICE candidate(s)');
  for (const cand of existingCands) {
    try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
  }
  _appliedCreatorCandCount = existingCands.length;

  // Listen for new creator ICE candidates — only apply ones we haven't seen yet
  _rtcSignalUnsub = onSnapshot(doc(_db, 'liveConnections', _roomId), async snap => {
    if (!snap.exists()) return;
    const d = snap.data();
    const cands = d.creatorCandidates || [];
    if (cands.length > _appliedCreatorCandCount) {
      const newCands = cands.slice(_appliedCreatorCandCount);
      console.log('[Viewer WebRTC] Applying', newCands.length, 'new creator ICE candidate(s)');
      for (const cand of newCands) {
        try { await _rtcPc.addIceCandidate(new RTCIceCandidate(cand)); } catch (_) {}
      }
      _appliedCreatorCandCount = cands.length;
    }
  });

  _showConnBanner('🔄 Completing handshake…', 'Answer sent — connecting…');
}

/* ═══════════════════════════════════════════════════
   CHAT
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
  }, err => {
    console.warn('[Live] chat subscribe error:', err.message);
  });
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

async function sendChat() {
  if (!_user || !_roomId) return;
  const text = (D.chatInput?.value || '').trim();
  if (!text || text.length > 200) return;
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
    toast('Could not send message: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════════
   LIKES
   ═══════════════════════════════════════════════════ */
let _hasLiked = false;

async function sendLike() {
  if (!_user || !_roomId || _hasLiked) return;
  _hasLiked = true;
  if (D.likeBtn)      D.likeBtn.classList.add('liked');
  if (D.likeBtnCount) D.likeBtnCount.textContent = '❤️';

  _spawnHeartBurst();

  try {
    await updateDoc(doc(_db, 'liveRooms', _roomId), { likes: increment(1) });
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
  if (D.endedTitle) D.endedTitle.textContent = title || (wasCreator ? '✅ Stream Ended' : '⚫ Stream Ended');
  if (D.endedSub)   D.endedSub.textContent   = sub   || (wasCreator
    ? 'Your live stream has ended. Thanks for going live!'
    : 'The creator has ended this live stream.');
  D.ended.classList.add('visible');
  if (_rtcPc)  { try { _rtcPc.close(); } catch (_) {} _rtcPc = null; }
  if (_rtcSignalUnsub) { _rtcSignalUnsub(); _rtcSignalUnsub = null; }
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
  if (!_roomId) { toast('⚠️ Start the live first before sharing.'); return; }
  _openShareModal();
}

function _buildLiveUrl() {
  const base = window.location.origin + window.location.pathname.replace('live.html', '');
  return base + 'live.html#watch=' + encodeURIComponent(_roomId);
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
      toast('⚠️ Could not share: ' + e.message);
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
