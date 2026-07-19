/**
 * Shadow Nexus — webrtc.js
 * WebRTC engine for 1-creator-to-many-viewers live streaming.
 *
 * Signaling schema (Firestore):
 *   liveConnections/{liveId}
 *     ├── offer             : { type, sdp }
 *     ├── answer            : { type, sdp }          (viewer writes)
 *     ├── creatorCandidates : [ {candidate,…}, … ]   (creator appends)
 *     └── viewerCandidates  : [ {candidate,…}, … ]   (viewer appends)
 */

/* ── LiveKit server ─────────────────────────────────────────────────── */
// API key + secret live in the Cloudflare Worker as encrypted secrets.
// Fetch a short-lived token from: POST https://yellow-term-11e6.nthntjrn.workers.dev/livekit-token
export const LIVEKIT_URL        = 'wss://chris-oxi8fwap.livekit.cloud';
export const LIVEKIT_TOKEN_URL  = 'https://yellow-term-11e6.nthntjrn.workers.dev/livekit-token';

/* ── ICE server config ──────────────────────────────────────────────── */
export const ICE_SERVERS = {
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

/* ── Local media helpers ────────────────────────────────────────────── */

let _localStream = null;
let _facingMode  = 'user';
let _camEnabled  = true;
let _micEnabled  = true;

/** Acquire camera + mic. Returns the MediaStream (or null on failure). */
export async function getLocalStream(video = true, audio = true) {
  const constraints = {
    video: video ? { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    audio,
  };
  try {
    _localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return _localStream;
  } catch (err) {
    console.warn('[WebRTC] getUserMedia failed, trying audio-only:', err.message);
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      return _localStream;
    } catch (e) {
      console.error('[WebRTC] Media access denied:', e.message);
      return null;
    }
  }
}

/** Stop all local tracks and release the stream. */
export function stopLocalStream() {
  if (_localStream) {
    _localStream.getTracks().forEach(t => t.stop());
    _localStream = null;
  }
}

/** Toggle camera track on/off. */
export function toggleCamera(enabled) {
  _camEnabled = enabled;
  if (_localStream) _localStream.getVideoTracks().forEach(t => (t.enabled = enabled));
  return _camEnabled;
}

/** Toggle microphone track on/off. */
export function toggleMic(enabled) {
  _micEnabled = enabled;
  if (_localStream) _localStream.getAudioTracks().forEach(t => (t.enabled = enabled));
  return _micEnabled;
}

/** Flip front/back camera by re-acquiring with opposite facingMode. */
export async function flipCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const old = _localStream;
  const next = await getLocalStream(true, _micEnabled);
  if (old) old.getTracks().forEach(t => t.stop());
  return next;
}

export function getLocalStreamRef() { return _localStream; }
export function isCamEnabled()      { return _camEnabled; }
export function isMicEnabled()      { return _micEnabled; }

/* ── RTCPeerConnection factory ──────────────────────────────────────── */

/**
 * Create a configured RTCPeerConnection with local tracks attached.
 * @param {Function} onTrack   - (stream) → void, called when remote track arrives
 * @param {Function} onIce     - (candidate JSON) → void, called with local ICE candidates
 * @param {Function} onState   - (state string) → void, called on connection state change
 */
export function createPeerConnection(onTrack, onIce, onState) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  // Attach local tracks (creator: sends video+audio; viewer: recv-only via transceivers)
  if (_localStream) {
    _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));
  }

  pc.ontrack = (e) => {
    const stream = (e.streams && e.streams[0]) ? e.streams[0] : new MediaStream([e.track]);
    if (onTrack) onTrack(stream);
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && onIce) onIce(e.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (onState) onState(pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[WebRTC] ICE state:', pc.iceConnectionState);
  };

  return pc;
}

/* ── Network quality probe ──────────────────────────────────────────── */
export async function probeNetwork() {
  if (!navigator.connection) return 'unknown';
  const mb = navigator.connection.downlink || 0;
  if (mb >= 5) return 'good';
  if (mb >= 1) return 'medium';
  return 'poor';
}

/* ── Grid layout helper (kept for any future multi-peer UI) ─────────── */
export function gridLayout(count) {
  switch (count) {
    case 1:  return 'repeat(1,1fr) / repeat(1,1fr)';
    case 2:  return 'repeat(1,1fr) / repeat(2,1fr)';
    case 3:
    case 4:  return 'repeat(2,1fr) / repeat(2,1fr)';
    case 5:
    case 6:  return 'repeat(2,1fr) / repeat(3,1fr)';
    case 7:
    case 8:  return 'repeat(2,1fr) / repeat(4,1fr)';
    default: return 'repeat(2,1fr) / repeat(4,1fr)';
  }
}
