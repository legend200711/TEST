/**
 * Shadow Nexus Live — live.js
 *
 * Architecture (WebRTC + Firebase Firestore signaling):
 *
 *  CREATOR:
 *    1. Captures local camera + mic via getUserMedia.
 *    2. Creates a liveRooms/{roomId} Firestore doc (status: 'live').
 *    3. Creates one RTCPeerConnection, adds tracks, creates an SDP offer.
 *    4. Writes offer to liveConnections/{roomId}.
 *    5. Listens on liveConnections/{roomId} for viewer answers +
 *       viewerCandidates arrays.  Applies them as they arrive.
 *
 *  VIEWER:
 *    1. Reads liveRooms/{roomId} to confirm stream is live.
 *    2. Reads liveConnections/{roomId} for the creator's offer.
 *    3. Creates one RTCPeerConnection with recvonly transceivers.
 *    4. Sets remote description (creator offer), creates answer.
 *    5. Writes answer + viewerCandidates to liveConnections/{roomId}.
 *    6. Receives remote tracks → displays video.
 *
 *  Chat + Likes:
 *    Stored in Firestore sub-collections under liveRooms/{roomId}.
 *
 *  Signaling collection:  liveConnections/{liveId}
 *    ├── offer             : { type, sdp }
 *    ├── answer            : { type, sdp }
 *    ├── creatorCandidates : [ … ]
 *    └── viewerCandidates  : [ … ]
 */

'use strict';

/* ── Firebase config (same project as index.html) ── */
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

/* ── ICE servers ── */
const ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls:       'turn:openrelay.metered.ca:80',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls:       'turn:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls:       'turns:openrelay.metered.ca:443',
      username:   'openrelayproject',
      credential: 'openrelayproject',
    },
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

// WebRTC — one PeerConnection for creator, one for viewer
let _creatorPc    = null;   // creator's single RTCPeerConnection
let _connUnsub    = null;   // Firestore listener on liveConnections doc

let _viewerPc     = null;   // viewer's single RTCPeerConnection
let _viewerUnsubs = [];     // cleanup handles for viewer

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
      // Not logged in — redirect
      _hideLoading();
      window.location.href = 'index.html';
      return;
    }
    _user = user;
    _loadUserData().then(() => {
      // Re-enable Go Live now that auth is confirmed
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

/* ── Decide mode from URL hash or localStorage intent ── */
async function _resolveMode() {
  const hash   = location.hash;  // e.g. #watch=abc123
  const intent = localStorage.getItem('snx_live_intent');
  localStorage.removeItem('snx_live_intent');

  if (hash.startsWith('#watch=')) {
    _roomId = decodeURIComponent(hash.slice(7));
    _mode   = 'viewer';
    document.body.classList.add('is-viewer');
    await _startViewer();
  } else {
    // Creator mode
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

  // Acquire camera
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
    // Fallback: try audio only
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
    D.setupCamBtn.querySelector('.setup-ctrl-icon').textContent = _camOn ? '📷' : '📷';
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
  // Auth must be resolved before we can go live
  if (!_user) {
    toast('⚠️ Please wait — still signing in…');
    return;
  }
  // Block anonymous sign-ins from hosting (matches Firestore rule)
  if (_user.isAnonymous) {
    toast('⚠️ You must be signed in with a real account to go live.');
    return;
  }
  // Ensure we actually have a media stream before creating a room
  if (!_localStream || !_localStream.getTracks().length) {
    toast('⚠️ No camera/mic available. Check browser permissions and refresh.');
    return;
  }

  const titleVal = (D.setupTitle?.value || '').trim();
  if (D.goLiveBtn) { D.goLiveBtn.disabled = true; D.goLiveBtn.textContent = 'Going Live…'; }

  // Generate room ID
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
    if (D.goLiveBtn) { D.goLiveBtn.disabled = false; D.goLiveBtn.textContent = '🔴 Start Live'; }
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

  // Start the creator WebRTC offer + listen for viewer answer
  await _startCreatorConnection();

  // Start chat listener
  _subscribeChat();

  // Keep viewer count updated
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

/* ═══════════════════════════════════════════════════
   CREATOR — Create offer, write to liveConnections,
             listen for viewer answer + candidates
   ═══════════════════════════════════════════════════ */
async function _startCreatorConnection() {
  // Clean up any previous connection
  _cleanupCreatorPc();

  if (!_localStream) {
    console.warn('[Creator] No local stream — cannot create WebRTC offer');
    return;
  }

  // Write the connection doc BEFORE creating the offer so ICE candidates have a target
  try {
    await setDoc(doc(_db, 'liveConnections', _roomId), {
      offer:             null,
      answer:            null,
      creatorCandidates: [],
      viewerCandidates:  [],
      createdAt:         serverTimestamp(),
    });
  } catch (e) {
    console.error('[Creator] Could not create liveConnections doc:', e.message);
    return;
  }

  _creatorPc = new RTCPeerConnection(ICE);

  // Add all local tracks so the viewer receives video + audio
  _localStream.getTracks().forEach(track => _creatorPc.addTrack(track, _localStream));

  // Collect and persist creator ICE candidates via arrayUnion
  _creatorPc.onicecandidate = async e => {
    if (!e.candidate) return;
    try {
      await updateDoc(doc(_db, 'liveConnections', _roomId), {
        creatorCandidates: arrayUnion(e.candidate.toJSON()),
      });
    } catch (err) {
      console.warn('[Creator] Failed to write ICE candidate:', err.message);
    }
  };

  _creatorPc.onconnectionstatechange = () => {
    const st = _creatorPc?.connectionState;
    console.log('[Creator] connection state:', st);
  };

  _creatorPc.oniceconnectionstatechange = () => {
    console.log('[Creator] ICE state:', _creatorPc?.iceConnectionState);
  };

  // Create offer
  let offer;
  try {
    offer = await _creatorPc.createOffer();
    await _creatorPc.setLocalDescription(offer);
  } catch (e) {
    console.error('[Creator] createOffer failed:', e.message);
    return;
  }

  // Write the offer to Firestore so viewer can read it
  try {
    await updateDoc(doc(_db, 'liveConnections', _roomId), {
      offer: { type: offer.type, sdp: offer.sdp },
    });
  } catch (e) {
    console.error('[Creator] Could not write offer:', e.message);
    return;
  }

  console.log('[Creator] Offer written to liveConnections/' + _roomId);

  // Track how many viewer candidates we have already applied
  let _appliedViewerCandCount = 0;
  let _answerApplied = false;
  const _pendingViewerCandidates = [];

  // Listen on the connection doc for answer + viewerCandidates
  _connUnsub = onSnapshot(doc(_db, 'liveConnections', _roomId), async snap => {
    if (!snap.exists() || !_creatorPc) return;
    const d = snap.data();

    // Apply the viewer's answer once
    if (!_answerApplied && d.answer && d.answer.sdp) {
      _answerApplied = true;
      try {
        await _creatorPc.setRemoteDescription({ type: 'answer', sdp: d.answer.sdp });
        console.log('[Creator] Remote description (answer) applied');
        // Now drain any pending viewer candidates
        for (const cand of _pendingViewerCandidates) {
          _creatorPc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
        }
        _pendingViewerCandidates.length = 0;
      } catch (e) {
        console.warn('[Creator] setRemoteDescription failed:', e.message);
        _answerApplied = false;
        return;
      }
    }

    // Buffer or apply viewer ICE candidates
    const viewerCands = d.viewerCandidates || [];
    for (let i = _appliedViewerCandCount; i < viewerCands.length; i++) {
      if (_answerApplied) {
        _creatorPc.addIceCandidate(new RTCIceCandidate(viewerCands[i])).catch(() => {});
      } else {
        _pendingViewerCandidates.push(viewerCands[i]);
      }
    }
    _appliedViewerCandCount = viewerCands.length;
  }, () => {});
}

function _cleanupCreatorPc() {
  if (_connUnsub) { _connUnsub(); _connUnsub = null; }
  if (_creatorPc) { try { _creatorPc.close(); } catch (_) {} _creatorPc = null; }
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
    // Replace the video track on the creator's active peer connection
    const videoTrack = newStream.getVideoTracks()[0];
    if (videoTrack && _creatorPc) {
      const sender = _creatorPc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) sender.replaceTrack(videoTrack).catch(() => {});
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
  // Clean up creator peer connection and signaling listener
  _cleanupCreatorPc();
  if (_chatUnsub)        { _chatUnsub();         _chatUnsub        = null; }
  if (_viewerCountUnsub) { _viewerCountUnsub();  _viewerCountUnsub = null; }

  // Stop local tracks
  if (_localStream) { _localStream.getTracks().forEach(t => t.stop()); _localStream = null; }

  // Mark room as ended in Firestore (isLive: false for feed queries)
  try {
    await updateDoc(doc(_db, 'liveRooms', _roomId), {
      status:  'ended',
      isLive:  false,
      endedAt: serverTimestamp(),
    });
  } catch (_) {}

  // Clear live status from user doc so rings/badges disappear
  try {
    await updateDoc(doc(_db, 'users', _user.uid), {
      isLive:     deleteField(),
      liveRoomId: deleteField(),
    });
  } catch (_) {}

  // Delete the primary live feed post (type='live') from the main feed
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

  // Delete the liveConnections signaling doc so viewers can't use stale offer
  try { await deleteDoc(doc(_db, 'liveConnections', _roomId)); } catch (_) {}

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

// Story doc ID — deterministic so we can delete it reliably
function _liveStoryId() {
  return `live_${_user.uid}`;
}

async function _createLiveStory(creatorData) {
  if (!_user || !_roomId) return;
  const now = Date.now();
  // Expires in 12 hours; the stream will have ended long before then
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
   Send a push-queue notification to every follower
   ═══════════════════════════════════════════════════ */

async function _notifyFollowersLive(creatorData) {
  if (!_user) return;
  try {
    // Fetch creator's own profile doc to get followers list
    const snap = await getDoc(doc(_db, 'users', _user.uid));
    if (!snap.exists()) return;
    const followers = snap.data().followers || [];
    if (!followers.length) return;

    const notif = {
      id:        `live_${_user.uid}_${Date.now()}`,
      type:      'live',
      fromUid:   _user.uid,
      fromName:  creatorData.hostName     || '',
      fromAvatar: creatorData.hostAvatar  || '',
      roomId:    _roomId,
      roomTitle: creatorData.title        || 'Shadow Nexus LIVE',
      title:     '🔴 ' + (creatorData.hostName || 'Someone') + ' is Live',
      body:      `${creatorData.hostName || 'Someone'} is live: ${creatorData.title || 'Shadow Nexus LIVE'}`,
      url:       'live.html#watch=' + _roomId,
      ts:        Date.now(),
      read:      false,
    };

    // Write notification items and push-queue entries for every follower concurrently.
    // Uses arrayUnion for the pushQueue so no read-modify-write race condition.
    const batches = followers.map(async fUid => {
      // Notification centre subcollection
      try {
        await addDoc(collection(_db, 'notifications', fUid, 'items'), notif);
      } catch (_) {}
      // In-app push queue — arrayUnion appends without a read
      try {
        await updateDoc(doc(_db, 'users', fUid), {
          pushQueue: arrayUnion(notif),
        });
      } catch (_) {}
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
  // Verify room is live
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

  await _connectToHost(roomData);

  // Decrement viewer count on leave
  window.addEventListener('beforeunload', _viewerLeave);
  window.addEventListener('pagehide',     _viewerLeave);
}

async function _viewerLeave() {
  // Guard: only execute once even if both beforeunload + pagehide fire (mobile)
  if (_viewerLeftFlag || !_roomId) return;
  _viewerLeftFlag = true;

  // Tear down peer connection and Firestore listeners
  _viewerUnsubs.forEach(fn => fn()); _viewerUnsubs = [];
  if (_viewerPc) { try { _viewerPc.close(); } catch (_) {} _viewerPc = null; }

  try { await updateDoc(doc(_db, 'liveRooms', _roomId), { viewers: increment(-1) }); } catch (_) {}
}

function _setupViewerControls(roomData) {
  // Profile button — links to creator's profile
  if (D.profileBtn) {
    D.profileBtn.style.display = 'flex';
    D.profileBtn.onclick = () => {
      window.open('index.html#profile=' + roomData.hostId, '_blank');
    };
  }
}

async function _connectToHost(roomData) {
  _showConnBanner('Connecting…', 'Establishing connection with ' + roomData.hostName);

  // Close any previous peer connection
  _viewerUnsubs.forEach(fn => fn());
  _viewerUnsubs = [];
  if (_viewerPc) { try { _viewerPc.close(); } catch (_) {} _viewerPc = null; }

  // Wait for the creator's offer via onSnapshot (reactive, single-fire)
  let _offerReceived = false;
  const offerUnsub = onSnapshot(doc(_db, 'liveConnections', _roomId), async snap => {
    if (_offerReceived) return;  // prevent double-fire on reconnect
    if (!snap.exists() || !snap.data().offer?.sdp) {
      _showConnBanner('⏳ Waiting for creator…', 'Stream offer not ready yet…');
      return;
    }
    _offerReceived = true;
    offerUnsub();  // stop listening once we have the offer

    const connData = snap.data();

    _viewerPc = new RTCPeerConnection(ICE);

    // Add recvonly transceivers so the answer SDP contains media sections
    _viewerPc.addTransceiver('video', { direction: 'recvonly' });
    _viewerPc.addTransceiver('audio', { direction: 'recvonly' });

    // When we receive the creator's video/audio tracks — display them
    _viewerPc.ontrack = e => {
      console.log('[Viewer] ontrack fired, streams:', e.streams.length);
      const stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
      if (D.liveVideo) {
        D.liveVideo.srcObject   = stream;
        D.liveVideo.muted       = true;   // required for autoplay
        D.liveVideo.autoplay    = true;
        D.liveVideo.playsInline = true;
        D.liveVideo.play().catch(err => console.warn('[Viewer] video.play():', err.message));
        _showUnmutePrompt();
      }
      _hideConnBanner();
    };

    // Viewer ICE candidates → append to liveConnections via arrayUnion
    _viewerPc.onicecandidate = async e => {
      if (!e.candidate) return;
      try {
        await updateDoc(doc(_db, 'liveConnections', _roomId), {
          viewerCandidates: arrayUnion(e.candidate.toJSON()),
        });
      } catch (err) {
        console.warn('[Viewer] Failed to write ICE candidate:', err.message);
      }
    };

    let _retryScheduled = false;
    _viewerPc.onconnectionstatechange = () => {
      const st = _viewerPc?.connectionState;
      console.log('[Viewer] connection state:', st);
      if (st === 'connected')    { _retryScheduled = false; _hideConnBanner(); }
      if (st === 'disconnected') _showConnBanner('📡 Reconnecting…', 'Connection dropped. Trying to reconnect…');
      if (st === 'failed' && !_retryScheduled) {
        _retryScheduled = true;
        _showConnBanner('⚠️ Failed', 'Could not reach stream. Retrying…');
        setTimeout(() => {
          if (_mode === 'viewer' && _roomId) _connectToHost(roomData);
        }, 4000);
      }
    };

    _viewerPc.oniceconnectionstatechange = () => {
      const s = _viewerPc?.iceConnectionState;
      console.log('[Viewer] ICE state:', s);
      if (s === 'checking')     _showConnBanner('Checking…', 'Finding connection path…');
      if (s === 'connected')    _hideConnBanner();
      if (s === 'completed')    _hideConnBanner();
      if (s === 'disconnected') _showConnBanner('📡 Reconnecting…', 'Connection dropped…');
      if (s === 'failed')       _showConnBanner('⚠️ Failed', 'No route to stream found. Retrying…');
    };

    // Set creator offer as remote description
    try {
      await _viewerPc.setRemoteDescription({ type: 'offer', sdp: connData.offer.sdp });
    } catch (e) {
      _showConnBanner('⚠️ SDP Error', 'Could not read stream offer: ' + e.message);
      return;
    }

    // Apply any creator ICE candidates that are already stored
    let _appliedCreatorCandCount = 0;
    const applyCreatorCands = (cands) => {
      for (let i = _appliedCreatorCandCount; i < cands.length; i++) {
        _viewerPc?.addIceCandidate(new RTCIceCandidate(cands[i])).catch(() => {});
      }
      _appliedCreatorCandCount = cands.length;
    };
    applyCreatorCands(connData.creatorCandidates || []);

    // Create and write answer (do NOT touch viewerCandidates — arrayUnion handles append)
    let answer;
    try {
      answer = await _viewerPc.createAnswer();
      await _viewerPc.setLocalDescription(answer);
    } catch (e) {
      _showConnBanner('⚠️ SDP Error', 'Could not create answer: ' + e.message);
      return;
    }

    try {
      await updateDoc(doc(_db, 'liveConnections', _roomId), {
        answer: { type: 'answer', sdp: answer.sdp },
      });
      console.log('[Viewer] Answer written to liveConnections/' + _roomId);
    } catch (e) {
      _showConnBanner('⚠️ Connection Error', e.message);
      return;
    }

    // Listen for new creator ICE candidates that trickle in after the answer
    const connUnsub = onSnapshot(doc(_db, 'liveConnections', _roomId), snap => {
      if (!snap.exists()) return;
      applyCreatorCands(snap.data().creatorCandidates || []);
    }, () => {});
    _viewerUnsubs.push(connUnsub);
  }, err => {
    console.error('[Viewer] onSnapshot error:', err.message);
    _showConnBanner('⚠️ Connection Error', err.message);
  });

  _viewerUnsubs.push(offerUnsub);
}

/* ═══════════════════════════════════════════════════
   CHAT
   ═══════════════════════════════════════════════════ */
function _subscribeChat() {
  if (!_roomId) return;
  // orderBy('createdAt') requires the messages to have a server timestamp.
  // Use limit(100) to keep the initial load fast.
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
    // If ordering fails (e.g. pending write with null ts), fall back to unordered
    console.warn('[Live] chat subscribe error:', err.message);
  });
}

function _appendChatMsg(data) {
  if (!D.chatMessages) return;
  // The host UID is the portion of the roomId before the first underscore
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

  // Auto-scroll
  D.chatMessages.scrollTop = D.chatMessages.scrollHeight;

  // Trim if too many
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

  // Burst animation
  _spawnHeartBurst();

  try {
    await updateDoc(doc(_db, 'liveRooms', _roomId), { likes: increment(1) });
  } catch (_) {}

  // Reset after 5 s to allow liking again
  setTimeout(() => {
    _hasLiked = false;
    if (D.likeBtn) D.likeBtn.classList.remove('liked');
  }, 5000);
}

function _spawnHeartBurst() {
  const stage = D.stage;
  if (!stage) return;
  const el   = document.createElement('div');
  el.className = 'like-burst';
  el.textContent = '❤️';
  // Random position near the like button (bottom-right area)
  const rect = stage.getBoundingClientRect();
  el.style.left   = (rect.width  * 0.75 + (Math.random() - 0.5) * 60) + 'px';
  el.style.bottom = (80 + Math.random() * 60) + 'px';
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
  // Also unmute on any tap anywhere on stage
  if (D.stage) D.stage.addEventListener('click', _unmute, { once: true });
}

function _showEndedOverlay(wasCreator, title, sub) {
  if (!D.ended) return;
  if (D.endedTitle) D.endedTitle.textContent = title || (wasCreator ? '✅ Stream Ended' : '⚫ Stream Ended');
  if (D.endedSub)   D.endedSub.textContent   = sub   || (wasCreator
    ? 'Your live stream has ended. Thanks for going live!'
    : 'The creator has ended this live stream.');
  D.ended.classList.add('visible');
  // Clean up viewer PC
  if (_viewerPc) { _viewerPc.close(); _viewerPc = null; }
  _viewerUnsubs.forEach(fn => fn()); _viewerUnsubs = [];
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

/* ── Share modal ── */
function _openShareModal() {
  // Remove any stale modal
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

  // Copy link
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

  // Share to Feed — post a share card
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

  // Native share / copy to apps
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

  // Close
  modal.querySelector('#_snxShareClose').addEventListener('click', _closeShareModal);
  modal.addEventListener('click', e => { if (e.target === modal) _closeShareModal(); });
}

function _closeShareModal() {
  const m = document.getElementById('_snxShareModal');
  if (m) m.remove();
}

function _shareFallbackPrompt(url) {
  window.prompt('Copy this link to share your live stream:', url);
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
