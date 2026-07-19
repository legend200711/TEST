/**
 * Shadow Nexus — webrtc.js
 * WebRTC engine for multi-peer live streaming (1 host + up to 7 guests).
 *
 * Architecture:
 *  - Host: creates an RTCPeerConnection per guest. Sends its local stream to
 *    each guest and receives the guest's stream.
 *  - Guest: creates ONE RTCPeerConnection to the host. Sends its local stream
 *    and receives the host stream.
 *
 * Signaling is done via Firebase Firestore (see live.js).
 */

/* ── ICE server config (STUN only; add TURN for production) ─────────── */
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

/* ── Max guests per room (host = 1, guests = 7, total 8 boxes) ───────── */
export const MAX_GUESTS = 7;

/* ═══════════════════════════════════════════════
   LOCAL MEDIA
════════════════════════════════════════════════ */

let _localStream = null;
let _facingMode  = 'user'; // 'user' | 'environment'
let _camEnabled  = true;
let _micEnabled  = true;

/** Acquire camera + mic. Returns the MediaStream. */
export async function getLocalStream(video = true, audio = true) {
  const constraints = {
    video: video ? { facingMode: _facingMode, width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    audio: audio
  };
  try {
    _localStream = await navigator.mediaDevices.getUserMedia(constraints);
    return _localStream;
  } catch (err) {
    console.warn('[WebRTC] getUserMedia failed, trying audio-only:', err.message);
    // Fallback: audio only
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
  if (_localStream) {
    _localStream.getVideoTracks().forEach(t => (t.enabled = enabled));
  }
  return _camEnabled;
}

/** Toggle microphone track on/off. */
export function toggleMic(enabled) {
  _micEnabled = enabled;
  if (_localStream) {
    _localStream.getAudioTracks().forEach(t => (t.enabled = enabled));
  }
  return _micEnabled;
}

/** Flip front/back camera by re-acquiring with opposite facingMode. */
export async function flipCamera() {
  _facingMode = _facingMode === 'user' ? 'environment' : 'user';
  const oldStream = _localStream;
  const newStream = await getLocalStream(true, _micEnabled);
  if (oldStream) oldStream.getTracks().forEach(t => t.stop());
  return newStream;
}

export function getLocalStreamRef() { return _localStream; }
export function isCamEnabled()      { return _camEnabled; }
export function isMicEnabled()      { return _micEnabled; }

/* ═══════════════════════════════════════════════
   PEER CONNECTION FACTORY
════════════════════════════════════════════════ */

/**
 * Create a new RTCPeerConnection with our local stream attached.
 * @param {Function} onTrack  - called with (stream, peerId) when remote track arrives
 * @param {Function} onIce    - called with (candidate) when local ICE candidate is ready
 * @param {Function} onState  - called with (state) on connection state change
 * @param {string}   peerId   - identifier for the remote peer (guestUid or 'host')
 */
export function createPeerConnection(onTrack, onIce, onState, peerId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  /* Attach local tracks */
  if (_localStream) {
    _localStream.getTracks().forEach(track => pc.addTrack(track, _localStream));
  }

  /* Receive remote tracks */
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    if (stream && onTrack) onTrack(stream, peerId);
  };

  /* ICE candidate collection */
  pc.onicecandidate = (e) => {
    if (e.candidate && onIce) onIce(e.candidate.toJSON());
  };

  /* Connection state changes */
  pc.onconnectionstatechange = () => {
    if (onState) onState(pc.connectionState, peerId);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[WebRTC][${peerId}] ICE state: ${pc.iceConnectionState}`);
  };

  return pc;
}

/* ═══════════════════════════════════════════════
   HOST SIDE — manages up to 7 guest connections
════════════════════════════════════════════════ */

export class HostPeerManager {
  constructor({ onGuestStream, onGuestLeave, onIceForGuest, onStateChange }) {
    this._peers        = {};   // guestUid → RTCPeerConnection
    this._onGuestStream = onGuestStream;
    this._onGuestLeave  = onGuestLeave;
    this._onIceForGuest = onIceForGuest;
    this._onStateChange = onStateChange;
  }

  get peerCount() { return Object.keys(this._peers).length; }

  /**
   * Called when a new guest sends an offer.
   * Creates a peer connection, sets remote desc, creates answer.
   */
  async handleGuestOffer(guestUid, offerSdp) {
    if (this._peers[guestUid]) return; // already connected
    if (this.peerCount >= MAX_GUESTS) {
      console.warn('[HostPeer] Room full, ignoring guest:', guestUid);
      return;
    }

    const pc = createPeerConnection(
      (stream) => this._onGuestStream(stream, guestUid),
      (cand)   => this._onIceForGuest(guestUid, cand),
      (state)  => {
        this._onStateChange(state, guestUid);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
          this._cleanup(guestUid);
          this._onGuestLeave(guestUid);
        }
      },
      guestUid
    );

    this._peers[guestUid] = pc;

    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    return answer.sdp;
  }

  /** Add ICE candidate sent by a specific guest. */
  async addGuestIce(guestUid, candidate) {
    const pc = this._peers[guestUid];
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('[HostPeer] addIceCandidate failed:', e.message); }
    }
  }

  /** Forcibly close a guest's connection (kick). */
  kickGuest(guestUid) {
    this._cleanup(guestUid);
    this._onGuestLeave(guestUid);
  }

  /** Close all connections. */
  closeAll() {
    Object.keys(this._peers).forEach(uid => this._cleanup(uid));
  }

  _cleanup(guestUid) {
    const pc = this._peers[guestUid];
    if (pc) { try { pc.close(); } catch (_) {} }
    delete this._peers[guestUid];
  }
}

/* ═══════════════════════════════════════════════
   GUEST SIDE — single connection to host
════════════════════════════════════════════════ */

export class GuestPeerManager {
  constructor({ onHostStream, onIceForHost, onStateChange }) {
    this._pc             = null;
    this._onHostStream   = onHostStream;
    this._onIceForHost   = onIceForHost;
    this._onStateChange  = onStateChange;
  }

  /**
   * Guest creates an offer to send to the host.
   * Returns the offer SDP string.
   */
  async createOffer() {
    this._pc = createPeerConnection(
      (stream) => this._onHostStream(stream),
      (cand)   => this._onIceForHost(cand),
      (state)  => {
        this._onStateChange(state);
        if (state === 'failed') this._tryReconnect();
      },
      'host'
    );

    const offer = await this._pc.createOffer();
    await this._pc.setLocalDescription(offer);
    return offer.sdp;
  }

  /** Host sends back an answer — set it as remote description. */
  async handleHostAnswer(answerSdp) {
    if (!this._pc) return;
    await this._pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  /** Add ICE candidate received from host. */
  async addHostIce(candidate) {
    if (this._pc && candidate) {
      try { await this._pc.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (e) { console.warn('[GuestPeer] addIceCandidate failed:', e.message); }
    }
  }

  close() {
    if (this._pc) { try { this._pc.close(); } catch (_) {} this._pc = null; }
  }

  _tryReconnect() {
    /* Simple back-off retry after 3 s */
    console.warn('[GuestPeer] Connection failed — will retry in 3 s');
    setTimeout(() => {
      this.close();
      this.createOffer().then(sdp => {
        if (this._onReconnectOffer) this._onReconnectOffer(sdp);
      });
    }, 3000);
  }

  /** Optionally set a callback for reconnect offers. */
  onReconnectOffer(cb) { this._onReconnectOffer = cb; }
}

/* ═══════════════════════════════════════════════
   LAYOUT HELPER — 8-box grid
════════════════════════════════════════════════ */

/**
 * Return the CSS grid-template string for N visible boxes (1-8).
 * Chooses the most cinematic layout for each count.
 */
export function gridLayout(count) {
  switch (count) {
    case 1: return 'repeat(1,1fr) / repeat(1,1fr)';
    case 2: return 'repeat(1,1fr) / repeat(2,1fr)';
    case 3: return 'repeat(2,1fr) / repeat(2,1fr)'; // 2+1 with span
    case 4: return 'repeat(2,1fr) / repeat(2,1fr)';
    case 5: return 'repeat(2,1fr) / repeat(3,1fr)'; // 3+2
    case 6: return 'repeat(2,1fr) / repeat(3,1fr)';
    case 7: return 'repeat(3,1fr) / repeat(3,1fr)'; // 3+3+1
    case 8: return 'repeat(2,1fr) / repeat(4,1fr)';
    default: return 'repeat(2,1fr) / repeat(4,1fr)';
  }
}

/* ─── Network quality probe ─────────────────────────────────────────── */
export async function probeNetwork() {
  if (!navigator.connection) return 'unknown';
  const c = navigator.connection;
  const mb = c.downlink || 0;
  if (mb >= 5) return 'good';
  if (mb >= 1) return 'medium';
  return 'poor';
}
