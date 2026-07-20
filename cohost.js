/**
 * Shadow Nexus Live — cohost.js  (v2)
 *
 * Co-Host feature — completely self-contained.
 * Does NOT touch live.js internals, chat, comments, feed, guest boxes,
 * notifications, stories, or any existing Firebase path.
 *
 * ─── Architecture ────────────────────────────────────────────────────────────
 *
 *  Firestore:
 *    /coHostRequests/{liveId}_{guestId}
 *      liveId, hostId, guestId, status: 'pending'|'accepted'|'declined', createdAt
 *
 *    /users/{uid}
 *      .friends[]       — host reads to build friend list
 *      .allowCoHostInvites (bool, default true)
 *      .onlineStatus   — 'online'|'away'|'offline' (optional, read-only)
 *
 *  Realtime Database (cohosts/ namespace — no overlap with live system):
 *    cohosts/{liveId}/active/{uid}
 *      uid, name, avatar, role:'cohost', joinedAt
 *    cohosts/{liveId}/settings
 *      allowCohosts, whoCanCohost
 *    cohosts/{liveId}/removed/{uid}
 *      ts
 *
 *  RTDB presence (same project):
 *    presence/{uid}
 *      online: bool, lastSeen: number  (written by live.js or script.js)
 *
 * ─── UI flow ─────────────────────────────────────────────────────────────────
 *
 *  Host:
 *    1. Taps "Co-Host Settings" button in bottom bar → hidden panel opens.
 *    2. Panel shows friends list with Online / Available / Busy / Offline status.
 *    3. Host taps "Invite" next to an online friend.
 *    4. System validates → writes coHostRequests document.
 *    5. Host sees specific error if something fails.
 *
 *  Friend (viewer):
 *    1. Receives "Invitation to join as co-host" card with Accept / Decline.
 *    2. Accept → writes to cohosts/{liveId}/active/, updates request status.
 *    3. Decline → updates request status, host is notified.
 *
 * ─── To disable entirely ────────────────────────────────────────────────────
 *    Remove <script src="cohost.js"> and <link href="cohost.css"> from live.html.
 */

'use strict';

(function () {

  // ── Firebase handles (provided by live.js via snxLiveReady event) ──────────
  let _db     = null;   // Firestore
  let _liveDB = null;   // Realtime Database
  let _auth   = null;
  let _user   = null;
  let _userData = null;
  let _roomId   = null;
  let _isHost   = false;
  let _isCohostOfRoom = null;

  // ── Live RTDB listeners ────────────────────────────────────────────────────
  let _activeUnsub      = null;   // cohosts/{room}/active
  let _inviteInboxUnsub = null;   // coHostRequests listener (invitee)
  let _hostDeclineUnsub = null;   // coHostRequests listener (host watching all)
  let _pendingInvites   = {};     // guestId → requestId  (sent this session)
  let _friendsCache     = [];     // [{uid, displayName, username, avatar, status}]
  let _panelOpen        = false;

  // ── Settings defaults ──────────────────────────────────────────────────────
  let _cohostSettings = {
    allowCohosts: true,
    whoCanCohost: 'friends',   // 'friends' | 'approved' | 'nobody'
  };

  // ── Current pending invite data (invitee side) ─────────────────────────────
  let _pendingInviteData = null;

  /* ═══════════════════════════════════════════════════════════════════════════
     INIT — called once by the snxLiveReady event
     ═══════════════════════════════════════════════════════════════════════════ */
  function _init(db, liveDB, auth, user, userData, roomId, isHost) {
    _db       = db;
    _liveDB   = liveDB;
    _auth     = auth;
    _user     = user;
    _userData = userData || {};
    _roomId   = roomId;
    _isHost   = isHost;

    _injectUI();
    _wireEvents();

    if (_isHost) {
      _loadSettings();
      _subscribeActiveCohosts();
      _subscribeDeclineNotifications();
      // Announce self as available in presence
      _writePresence('online');
    } else {
      _watchForInvite();
      _writePresence('online');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     RTDB PRESENCE — write own presence so friends can see us
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _writePresence(status) {
    if (!_liveDB || !_user) return;
    try {
      const { ref: rtRef, set: rtSet, onDisconnect: rtOnDisconnect } = await _importRTDB();
      const presRef = rtRef(_liveDB, `presence/${_user.uid}`);
      await rtSet(presRef, { online: status === 'online', lastSeen: Date.now() });
      rtOnDisconnect(presRef).set({ online: false, lastSeen: Date.now() });
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     UI INJECTION — all DOM built here, nothing hard-coded in live.html
     ═══════════════════════════════════════════════════════════════════════════ */
  function _injectUI() {
    _injectButton();
    _injectSettingsPanel();
    _injectInviteCard();
    if (_isHost) {
      _injectSettingsSection();
    }
  }

  /* ── "Co-Host Settings" button — only visible to host, in bottom bar ── */
  function _injectButton() {
    if (document.getElementById('btnCoHost')) return;
    const btn = document.createElement('button');
    btn.id        = 'btnCoHost';
    btn.className = 'live-ctrl-btn';
    btn.title     = 'Co-Host Settings';
    btn.setAttribute('aria-label', 'Open co-host settings');
    btn.textContent = '🎙️';
    const endBtn = document.getElementById('btnEndLive');
    if (endBtn && endBtn.parentNode) {
      endBtn.parentNode.insertBefore(btn, endBtn);
    }
  }

  /* ── Co-Host Settings Panel — hidden by default ── */
  function _injectSettingsPanel() {
    if (document.getElementById('cohostPanel')) return;
    const panel = document.createElement('div');
    panel.id = 'cohostPanel';
    panel.setAttribute('aria-label', 'Co-Host Settings');
    panel.innerHTML = `
      <button class="cohost-popup-close" id="cohostPanelClose" aria-label="Close co-host panel">✕</button>
      <div class="cohost-popup-title">🎙️ Co-Host Settings</div>

      <!-- Current co-hosts -->
      <div class="cohost-section-label">Current Co-Hosts</div>
      <div id="cohostActiveList" class="cohost-user-list">
        <div class="cohost-empty">No active co-hosts.</div>
      </div>

      <hr class="cohost-divider">

      <!-- Friends list -->
      <div class="cohost-section-label">Friends</div>
      <div id="cohostFriendsList" class="cohost-user-list">
        <div class="cohost-empty">Loading friends…</div>
      </div>
    `;
    const videoWrap = document.querySelector('.live-video-wrap');
    (videoWrap || document.body).appendChild(panel);
  }

  /* ── Invite card shown to the invitee ── */
  function _injectInviteCard() {
    if (document.getElementById('cohostInviteCard')) return;
    const card = document.createElement('div');
    card.id = 'cohostInviteCard';
    card.innerHTML = `
      <div class="cohost-invite-icon">🎥</div>
      <div class="cohost-invite-title">Co-host Invite</div>
      <div class="cohost-invite-sub" id="cohostInviteSub">Someone wants you to join as a co-host.</div>
      <div class="cohost-invite-actions">
        <button class="cohost-invite-accept" id="cohostAcceptBtn">ACCEPT</button>
        <button class="cohost-invite-deny"   id="cohostDenyBtn">DENY</button>
      </div>
    `;
    document.body.appendChild(card);
  }

  /* ── Co-Host settings section inside Live Settings panel ── */
  function _injectSettingsSection() {
    if (document.getElementById('cohostSettingsSection')) return;
    const panel = document.getElementById('liveSettingsPanel');
    if (!panel) return;
    const section = document.createElement('div');
    section.id = 'cohostSettingsSection';
    section.innerHTML = `
      <hr class="cohost-divider" style="margin:14px 0 10px;">
      <div class="lsp-row">
        <div class="lsp-label">
          <div class="lsp-label-name">🎙️ Allow Co-Hosts</div>
          <div class="lsp-label-desc">Let others join as co-host</div>
        </div>
        <label class="lsp-toggle" aria-label="Allow co-hosts toggle">
          <input type="checkbox" id="toggleAllowCohost" checked>
          <span class="lsp-slider"></span>
        </label>
      </div>
      <div class="lsp-row" style="flex-direction:column;align-items:flex-start;">
        <div class="lsp-label">
          <div class="lsp-label-name">Who Can Co-Host</div>
          <div class="lsp-label-desc">Who is eligible to receive an invite</div>
        </div>
        <div class="cohost-select-wrap" style="margin-top:6px;">
          <select id="selectWhoCanCohost" class="cohost-select">
            <option value="friends">🤝 Friends</option>
            <option value="approved">✅ Approved Users</option>
            <option value="nobody">🚫 Nobody</option>
          </select>
        </div>
      </div>
    `;
    panel.appendChild(section);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     EVENT WIRING
     ═══════════════════════════════════════════════════════════════════════════ */
  function _wireEvents() {
    // Co-Host button (host only — hidden via CSS for viewers)
    const btn = document.getElementById('btnCoHost');
    if (btn) btn.addEventListener('click', _togglePanel);

    // Panel close
    const closeBtn = document.getElementById('cohostPanelClose');
    if (closeBtn) closeBtn.addEventListener('click', _closePanel);

    // Accept / Decline invite (invitee side)
    const acceptBtn = document.getElementById('cohostAcceptBtn');
    const denyBtn   = document.getElementById('cohostDenyBtn');
    if (acceptBtn) acceptBtn.addEventListener('click', _acceptInvite);
    if (denyBtn)   denyBtn.addEventListener('click',   _declineInvite);

    // Settings toggles (host only)
    if (_isHost) {
      const toggleAllow = document.getElementById('toggleAllowCohost');
      if (toggleAllow) toggleAllow.addEventListener('change', e => {
        _cohostSettings.allowCohosts = e.target.checked;
        _saveSettings();
      });
      const selectWho = document.getElementById('selectWhoCanCohost');
      if (selectWho) selectWho.addEventListener('change', e => {
        _cohostSettings.whoCanCohost = e.target.value;
        _saveSettings();
      });
    }

    // Close panel on outside click
    document.addEventListener('click', e => {
      if (!_panelOpen) return;
      const panel = document.getElementById('cohostPanel');
      const btn   = document.getElementById('btnCoHost');
      if (!panel || !btn) return;
      if (!panel.contains(e.target) && !btn.contains(e.target)) _closePanel();
    }, true);
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PANEL OPEN / CLOSE
     ═══════════════════════════════════════════════════════════════════════════ */
  function _togglePanel() { _panelOpen ? _closePanel() : _openPanel(); }

  function _openPanel() {
    const panel = document.getElementById('cohostPanel');
    const btn   = document.getElementById('btnCoHost');
    if (!panel) return;
    panel.classList.add('visible');
    btn && btn.classList.add('cohost-active');
    _panelOpen = true;
    // Load friends list every time the panel opens
    _loadFriendsList();
  }

  function _closePanel() {
    const panel = document.getElementById('cohostPanel');
    const btn   = document.getElementById('btnCoHost');
    if (!panel) return;
    panel.classList.remove('visible');
    btn && btn.classList.remove('cohost-active');
    _panelOpen = false;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     FRIENDS LIST — load host's friends, fetch their presence + cohost status
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _loadFriendsList() {
    const el = document.getElementById('cohostFriendsList');
    if (!el) return;
    el.innerHTML = '<div class="cohost-empty">Loading friends…</div>';

    if (!_db || !_user) {
      el.innerHTML = '<div class="cohost-empty">Not connected.</div>';
      return;
    }

    try {
      const { doc: fsDoc, getDoc: fsGetDoc } = await _importFirestore();

      // Load host's own profile to get friends list
      const hostSnap = await fsGetDoc(fsDoc(_db, 'users', _user.uid));
      if (!hostSnap.exists()) {
        el.innerHTML = '<div class="cohost-empty">Could not load profile.</div>';
        return;
      }
      const hostData = hostSnap.data();
      const friendIds = hostData.friends || [];

      if (!friendIds.length) {
        el.innerHTML = '<div class="cohost-empty">No friends found. Add friends to invite co-hosts.</div>';
        return;
      }

      // Load friend profiles (batch by 10 — Firestore in() limit)
      const { collection: fsCol, query: fsQuery, where: fsWhere, getDocs: fsGetDocs } =
        await _importFirestore();

      const friends = [];
      // Chunk into groups of 10
      const chunks = [];
      for (let i = 0; i < friendIds.length; i += 10) {
        chunks.push(friendIds.slice(i, i + 10));
      }
      for (const chunk of chunks) {
        try {
          const q = fsQuery(fsCol(_db, 'users'), fsWhere('__name__', 'in', chunk));
          const snap = await fsGetDocs(q);
          snap.forEach(d => {
            if (d.id !== _user.uid) {
              friends.push({ uid: d.id, ...d.data() });
            }
          });
        } catch (_) {}
      }

      if (!friends.length) {
        el.innerHTML = '<div class="cohost-empty">No friends found.</div>';
        return;
      }

      // Determine co-host availability for each friend.
      //
      // Source of truth for "is this person online right now":
      //   f.status field on the Firestore user doc — written as 'online' / 'offline'
      //   by index.html on login and on browser unload.  This is what the whole app
      //   uses for the green-dot presence system.
      //
      // RTDB presence/{uid} is a secondary check only written by cohost.js when a
      // user is on the live page — treat it as a bonus signal, not a gate.
      const { ref: rtRef, get: rtGet } = await _importRTDB();
      const withStatus = await Promise.all(friends.map(async f => {
        // If the user has explicitly disabled co-host invites → busy
        if (f.allowCoHostInvites === false) return { ...f, status: 'busy' };

        // Use the Firestore status field (set by index.html) as primary signal
        const fsStatus = f.status; // 'online' | 'offline' | undefined
        if (fsStatus === 'offline') return { ...f, status: 'offline' };

        // fsStatus === 'online' or undefined (new accounts / never updated)
        // Check RTDB presence as secondary — if they're actively on live.html
        // we can show 'available' (green) instead of just 'online' (blue)
        let cohostStatus = (fsStatus === 'online') ? 'online' : 'online'; // assume online

        try {
          const presSnap = await rtGet(rtRef(_liveDB, `presence/${f.uid}`));
          if (presSnap.exists()) {
            const p = presSnap.val();
            const freshEnough = (Date.now() - (p.lastSeen || 0)) < 10 * 60 * 1000; // <10 min
            if (p.online && freshEnough) {
              // On live page right now — mark as available
              cohostStatus = 'available';
            }
          }
        } catch (_) {}

        return { ...f, status: cohostStatus };
      }));

      _friendsCache = withStatus;
      _renderFriendsList(withStatus);

    } catch (e) {
      console.error('[CoHost] loadFriendsList error:', e);
      el.innerHTML = '<div class="cohost-empty">Could not load friends.</div>';
    }
  }

  /* ── Status label + CSS class helper ── */
  function _statusInfo(status) {
    switch (status) {
      case 'available': return { label: 'Available', cls: 'cohost-status-available' };
      case 'busy':      return { label: 'Busy',      cls: 'cohost-status-busy' };
      case 'online':    return { label: 'Online',    cls: 'cohost-status-online' };
      default:          return { label: 'Offline',   cls: 'cohost-status-offline' };
    }
  }

  function _renderFriendsList(friends) {
    const el = document.getElementById('cohostFriendsList');
    if (!el) return;
    if (!friends.length) {
      el.innerHTML = '<div class="cohost-empty">No friends found.</div>';
      return;
    }

    // Sort: available first, then online, busy, offline
    const order = { available: 0, online: 1, busy: 2, offline: 3 };
    const sorted = [...friends].sort((a, b) => (order[a.status] ?? 3) - (order[b.status] ?? 3));

    el.innerHTML = '';
    sorted.forEach(f => {
      const isSent   = !!_pendingInvites[f.uid];
      const canInvite = (f.status === 'available' || f.status === 'online') && !isSent;
      const { label: statusLabel, cls: statusCls } = _statusInfo(f.status);
      const initials  = (f.displayName || f.username || '?')[0].toUpperCase();
      const avatarBg  = (f.avatar || f.profilePicture)
        ? `background-image:url('${_esc(f.avatar || f.profilePicture)}');background-size:cover;background-position:center;`
        : '';

      const row = document.createElement('div');
      row.className = 'cohost-user-row';
      row.innerHTML = `
        <div class="cohost-user-avatar" style="${avatarBg}">${avatarBg ? '' : initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="cohost-user-name">${_esc(f.displayName || f.username || 'User')}</div>
          <div class="cohost-user-status">
            <span class="cohost-status-dot ${statusCls}"></span>
            <span class="cohost-status-label">${statusLabel}</span>
          </div>
        </div>
        ${isSent
          ? `<button class="cohost-invite-btn sent" disabled>✓ Sent</button>`
          : `<button class="cohost-invite-btn${canInvite ? '' : ' disabled'}"
               data-uid="${f.uid}"
               ${canInvite ? '' : 'disabled title="Friend is not available"'}
             >Invite</button>`
        }
      `;
      if (canInvite) {
        row.querySelector('.cohost-invite-btn').addEventListener('click', () => _sendInvite(f));
      }
      el.appendChild(row);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SEND INVITE
     Primary path : RTDB  coHostInvites/{friendUID}/{myUID}
     Secondary    : Firestore coHostInvites/{friendUID}/{myUID} (subcollection)
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _sendInvite(friend) {
    // ── Pre-flight checks ──────────────────────────────────────────────────
    if (!_isHost) {
      _liveToast('Only the host can send co-host invites.');
      return;
    }
    if (!_cohostSettings.allowCohosts) {
      _liveToast('Co-hosts are disabled in your settings.');
      return;
    }
    if (_cohostSettings.whoCanCohost === 'nobody') {
      _liveToast('Co-hosting is set to Nobody. Change it in Live Settings.');
      return;
    }
    if (!friend || !friend.uid) {
      _liveToast('User not found.');
      return;
    }
    if (!_db || !_liveDB || !_roomId || !_user) {
      _liveToast('Connection error. Please try again.');
      return;
    }
    if (_user.isAnonymous) {
      _liveToast('Permission denied. Sign in to send co-host invites.');
      return;
    }

    // Disable button immediately to prevent double-tap
    const btns = document.querySelectorAll(`.cohost-invite-btn[data-uid="${friend.uid}"]`);
    btns.forEach(b => { b.disabled = true; b.textContent = 'Sending…'; });

    try {
      const { ref: rtRef, get: rtGet, set: rtSet } = await _importRTDB();

      // ── Check: live room still exists ──
      const roomSnap = await rtGet(rtRef(_liveDB, `liveRooms/${_roomId}`));
      if (!roomSnap.exists() || roomSnap.val().status !== 'live') {
        _liveToast('Live room not found. Are you still live?');
        _resetInviteBtn(btns);
        return;
      }

      const fromName = _userData.displayName || _user.email?.split('@')[0] || 'Host';

      // ── PRIMARY: write to RTDB coHostInvites/{friendUID}/{myUID} ──
      // This is the real-time delivery channel — listener fires immediately.
      await rtSet(rtRef(_liveDB, `coHostInvites/${friend.uid}/${_user.uid}`), {
        from:   fromName,
        status: 'pending',
        time:   Date.now(),
        roomId: _roomId,
      });

      // ── SECONDARY: write to Firestore coHostInvites/{friendUID}/senders/{myUID} ──
      const { doc: fsDoc, setDoc: fsSetDoc, serverTimestamp: fsST } = await _importFirestore();
      try {
        // Path: coHostInvites → doc(receiverUID) → subcollection 'senders' → doc(senderUID)
        await fsSetDoc(fsDoc(_db, 'coHostInvites', friend.uid, 'senders', _user.uid), {
          from:   fromName,
          status: 'pending',
          time:   fsST(),
          roomId: _roomId,
        });
      } catch (fsErr) {
        // Firestore write non-fatal — RTDB already delivered the invite.
        console.warn('[CoHost] Firestore coHostInvites write failed (non-fatal):', fsErr?.code, fsErr?.message);
      }

      // Mark as sent locally
      _pendingInvites[friend.uid] = `${friend.uid}/${_user.uid}`;
      btns.forEach(b => { b.disabled = true; b.textContent = '✓ Sent'; b.classList.add('sent'); });
      _liveToast(`🎥 Invite sent to ${friend.displayName || 'user'}!`);

    } catch (e) {
      console.error('[CoHost] sendInvite error — code:', e?.code, '| message:', e?.message, '| full:', e);
      const code = e?.code || '';
      if (code === 'permission-denied' || code === 'PERMISSION_DENIED') {
        _liveToast('Permission denied. Check Firebase rules for coHostInvites/.');
      } else if (code === 'unavailable' || code === 'network-request-failed') {
        _liveToast('Connection error. Check your internet and try again.');
      } else {
        _liveToast(`Invite error: ${e?.message || 'unknown — check console'}`);
      }
      _resetInviteBtn(btns);
    }
  }

  function _resetInviteBtn(btns, canRetry = true) {
    btns.forEach(b => {
      b.disabled = !canRetry;
      b.textContent = 'Invite';
    });
  }

  /** Update a single friend's displayed status in the panel */
  function _updateFriendStatus(uid, status) {
    const idx = _friendsCache.findIndex(f => f.uid === uid);
    if (idx !== -1) {
      _friendsCache[idx].status = status;
      _renderFriendsList(_friendsCache);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HOST — subscribe to active co-hosts list
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _subscribeActiveCohosts() {
    if (!_liveDB || !_roomId) return;
    const { ref: rtRef, onValue: rtOnValue } = await _importRTDB();
    _activeUnsub = rtOnValue(rtRef(_liveDB, `cohosts/${_roomId}/active`), snap => {
      const data = snap.val() || {};
      _renderActiveList(Object.entries(data).map(([uid, v]) => ({ uid, ...v })));
    });
  }

  function _renderActiveList(list) {
    const el = document.getElementById('cohostActiveList');
    if (!el) return;
    if (!list.length) {
      el.innerHTML = '<div class="cohost-empty">No active co-hosts.</div>';
      return;
    }
    el.innerHTML = '';
    list.forEach(co => {
      const initials  = (co.name || '?')[0].toUpperCase();
      const avatarBg  = co.avatar ? `background-image:url('${co.avatar}');background-size:cover;` : '';
      const row = document.createElement('div');
      row.className = 'cohost-active-row';
      row.innerHTML = `
        <div class="cohost-user-avatar" style="${avatarBg}">${avatarBg ? '' : initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="cohost-active-name">${_esc(co.name || 'Co-Host')}</div>
          <div class="cohost-active-status">
            <span class="cohost-status-dot cohost-status-available"></span>
            <span>Active</span>
          </div>
        </div>
        <button class="cohost-remove-btn" data-uid="${co.uid}">Remove</button>
      `;
      row.querySelector('.cohost-remove-btn')
         .addEventListener('click', () => _removeCohost(co.uid, co.name));
      el.appendChild(row);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HOST — remove a co-host
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _removeCohost(uid, name) {
    if (!_liveDB || !_roomId) return;
    const { ref: rtRef, remove: rtRemove, set: rtSet } = await _importRTDB();
    try {
      await rtRemove(rtRef(_liveDB, `cohosts/${_roomId}/active/${uid}`));
      await rtSet(rtRef(_liveDB, `cohosts/${_roomId}/removed/${uid}`), { ts: Date.now() });
      // Clean up Firestore request too
      if (_db) {
        const { doc: fsDoc, updateDoc: fsUpdate } = await _importFirestore();
        try {
          await fsUpdate(fsDoc(_db, 'coHostRequests', `${_roomId}_${uid}`), { status: 'declined' });
        } catch (_) {}
      }
      _liveToast(`${name || 'Co-host'} removed.`);
    } catch (_) {
      _liveToast('Could not remove co-host. Try again.');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HOST — watch for deny notifications from guests
     Listens on RTDB coHostInvites/{myUID} for any child with status 'denied'.
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _subscribeDeclineNotifications() {
    if (!_liveDB || !_user) return;
    const { ref: rtRef, onValue: rtOnValue, remove: rtRemove } = await _importRTDB();
    const _notifiedSet = new Set();   // track which UIDs we already toasted

    // Watch coHostInvites/{myUID} for any denied replies
    rtOnValue(rtRef(_liveDB, `coHostInvites/${_user.uid}`), snap => {
      if (!snap.exists()) return;
      const data = snap.val() || {};
      Object.entries(data).forEach(([receiverUID, invite]) => {
        if (invite.status === 'denied' && !_notifiedSet.has(receiverUID)) {
          _notifiedSet.add(receiverUID);
          _liveToast(`${invite.from || 'User'} denied the co-host invite.`);
          // Clean up the denied invite from RTDB
          rtRemove(rtRef(_liveDB, `coHostInvites/${_user.uid}/${receiverUID}`)).catch(() => {});
        }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     INVITEE (VIEWER) — watch for incoming invite
     Listens on RTDB coHostInvites/{myUID}  for any child with status 'pending'.
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _watchForInvite() {
    if (!_liveDB || !_user) return;
    const { ref: rtRef, onValue: rtOnValue, off: rtOff } = await _importRTDB();

    // Watch RTDB coHostInvites/{myUID} — fires when any sender writes an invite
    const inboxRef = rtRef(_liveDB, `coHostInvites/${_user.uid}`);
    _inviteInboxUnsub = rtOnValue(inboxRef, snap => {
      if (!snap.exists()) return;
      const invites = snap.val() || {};
      // Show the first pending invite we find (most recent by time)
      const pending = Object.entries(invites)
        .filter(([, v]) => v.status === 'pending')
        .sort(([, a], [, b]) => (b.time || 0) - (a.time || 0));
      if (pending.length && !_pendingInviteData) {
        const [senderUID, data] = pending[0];
        _pendingInviteData = { ...data, senderUID };
        _showInviteCard(_pendingInviteData);
      }
    });

    // Watch removal signal (existing RTDB cohosts path for host-initiated removal)
    if (_roomId) {
      const removedRef = rtRef(_liveDB, `cohosts/${_roomId}/removed/${_user.uid}`);
      rtOnValue(removedRef, snap => {
        if (!snap.exists()) return;
        _isCohostOfRoom = null;
        _clearCohostBadge();
        _liveToast('You have been removed as co-host.');
        rtOff(removedRef);
      });
    }
  }

  /* ── Show invite card ── */
  function _showInviteCard(data) {
    const card = document.getElementById('cohostInviteCard');
    const sub  = document.getElementById('cohostInviteSub');
    if (!card) return;
    // data.from is the sender's display name (string)
    const senderName = data.from || data.fromName || 'Someone';
    if (sub) sub.textContent = `${_esc(senderName)} wants you to join as a co-host`;
    card.dataset.inviteFrom      = data.senderUID || data.from || '';
    card.dataset.inviteSenderUID = data.senderUID || '';
    card.dataset.inviteRoomId    = data.roomId    || _roomId   || '';
    card.classList.add('visible');
  }

  function _hideInviteCard() {
    const card = document.getElementById('cohostInviteCard');
    if (card) { card.classList.remove('visible'); }
    _pendingInviteData = null;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     ACCEPT CO-HOST INVITE
     1. Update RTDB coHostInvites/{myUID}/{senderUID} → status: 'accepted'
     2. Write Firestore coHosts/{myUID} → { coHost: true }
     3. Also write cohosts/{roomId}/active/ (host's real-time list)
     4. Delete the invite from RTDB (cleanup)
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _acceptInvite() {
    if (!_liveDB || !_user) {
      _liveToast('Connection error. Please try again.');
      return;
    }

    const inviteData = _pendingInviteData;
    _hideInviteCard();

    const roomId    = inviteData?.roomId    || _roomId;
    const senderUID = inviteData?.senderUID || '';

    if (!roomId) {
      _liveToast('Live room not found.');
      return;
    }

    const { ref: rtRef, set: rtSet, update: rtUpdate, remove: rtRemove } = await _importRTDB();

    try {
      // ── 1. Update RTDB invite status to 'accepted' ──
      if (senderUID) {
        await rtUpdate(rtRef(_liveDB, `coHostInvites/${_user.uid}/${senderUID}`), {
          status: 'accepted',
        });
      }

      // ── 2. Write Firestore coHosts/{myUID} → { coHost: true } ──
      if (_db) {
        const { doc: fsDoc, setDoc: fsSetDoc } = await _importFirestore();
        try {
          await fsSetDoc(fsDoc(_db, 'coHosts', _user.uid), { coHost: true }, { merge: true });
        } catch (_) {}
      }

      // ── 3. Add to cohosts/{roomId}/active/ (host sees in real time) ──
      await rtSet(rtRef(_liveDB, `cohosts/${roomId}/active/${_user.uid}`), {
        uid:      _user.uid,
        name:     _userData.displayName || _user.email?.split('@')[0] || 'Co-Host',
        avatar:   _userData.avatar || _userData.profilePicture || '',
        role:     'cohost',
        joinedAt: Date.now(),
      });

      // ── 4. Delete the invite from RTDB (cleanup) ──
      if (senderUID) {
        await rtRemove(rtRef(_liveDB, `coHostInvites/${_user.uid}/${senderUID}`));
      }

      _isCohostOfRoom = roomId;
      _showCohostBadge();
      _liveToast('🎥 You are now a co-host!');
    } catch (e) {
      console.error('[CoHost] acceptInvite error:', e);
      _liveToast('Could not accept invite. Please try again.');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     DENY CO-HOST INVITE
     1. Update RTDB coHostInvites/{myUID}/{senderUID} → status: 'denied'
     2. Delete the invite from RTDB (cleanup)
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _declineInvite() {
    const inviteData = _pendingInviteData;
    _hideInviteCard();
    if (!_liveDB || !_user) return;

    const senderUID = inviteData?.senderUID || '';
    if (!senderUID) return;

    const { ref: rtRef, update: rtUpdate, remove: rtRemove } = await _importRTDB();
    try {
      // ── 1. Set status to 'denied' (host notified via RTDB listener) ──
      await rtUpdate(rtRef(_liveDB, `coHostInvites/${_user.uid}/${senderUID}`), {
        status: 'denied',
      });

      // ── 2. Delete invite from RTDB after a short delay ──
      setTimeout(async () => {
        try {
          await rtRemove(rtRef(_liveDB, `coHostInvites/${_user.uid}/${senderUID}`));
        } catch (_) {}
      }, 3000);
    } catch (_) {}
    _liveToast('Co-host invite denied.');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CO-HOST BADGE — shown to the co-host in the top bar area
     ═══════════════════════════════════════════════════════════════════════════ */
  function _showCohostBadge() {
    if (document.getElementById('_cohostActiveBadge')) return;
    const badge = document.createElement('div');
    badge.id        = '_cohostActiveBadge';
    badge.className = 'cohost-badge-pill';
    badge.textContent = '🎙️ Co-Host';
    badge.style.cssText =
      'position:absolute;top:calc(env(safe-area-inset-top,0) + 10px);left:50%;' +
      'transform:translateX(-50%);z-index:30;pointer-events:none;';
    const videoWrap = document.querySelector('.live-video-wrap');
    if (videoWrap) videoWrap.appendChild(badge);
  }

  function _clearCohostBadge() {
    const badge = document.getElementById('_cohostActiveBadge');
    if (badge) badge.remove();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SETTINGS — load / save to RTDB cohosts/{roomId}/settings
     ═══════════════════════════════════════════════════════════════════════════ */
  async function _loadSettings() {
    if (!_liveDB || !_roomId) return;
    const { ref: rtRef, get: rtGet } = await _importRTDB();
    try {
      const snap = await rtGet(rtRef(_liveDB, `cohosts/${_roomId}/settings`));
      if (snap.exists()) {
        const s = snap.val();
        _cohostSettings.allowCohosts = s.allowCohosts !== false;
        _cohostSettings.whoCanCohost = s.whoCanCohost || 'friends';
      }
    } catch (_) {}
    const toggleAllow = document.getElementById('toggleAllowCohost');
    if (toggleAllow) toggleAllow.checked = _cohostSettings.allowCohosts;
    const selectWho = document.getElementById('selectWhoCanCohost');
    if (selectWho) selectWho.value = _cohostSettings.whoCanCohost;
  }

  async function _saveSettings() {
    if (!_liveDB || !_roomId) return;
    const { ref: rtRef, set: rtSet } = await _importRTDB();
    try {
      await rtSet(rtRef(_liveDB, `cohosts/${_roomId}/settings`), {
        allowCohosts: _cohostSettings.allowCohosts,
        whoCanCohost: _cohostSettings.whoCanCohost,
        updatedAt:    Date.now(),
      });
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     CLEANUP — called when the live session ends
     ═══════════════════════════════════════════════════════════════════════════ */
  function _cleanup() {
    if (_activeUnsub)      { try { _activeUnsub();      } catch(_){} _activeUnsub      = null; }
    if (_inviteInboxUnsub) { try { _inviteInboxUnsub(); } catch(_){} _inviteInboxUnsub = null; }
    if (_hostDeclineUnsub) { try { _hostDeclineUnsub(); } catch(_){} _hostDeclineUnsub = null; }
    _closePanel();
    _hideInviteCard();
    _clearCohostBadge();
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════════════════════════════ */
  function _esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _liveToast(msg) {
    const t = document.getElementById('liveToast');
    if (!t) { console.log('[CoHost]', msg); return; }
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(t._cohostTimer);
    t._cohostTimer = setTimeout(() => t.classList.remove('visible'), 3500);
  }

  async function _importRTDB() {
    return await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
  }

  async function _importFirestore() {
    return await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     BOOTSTRAP — wait for live.js to fire snxLiveReady
     ═══════════════════════════════════════════════════════════════════════════ */
  window.addEventListener('snxLiveReady', e => {
    const { db, liveDB, auth, user, userData, roomId, isHost } = e.detail || {};
    if (!db || !liveDB || !auth || !user || !roomId) {
      console.error('[CoHost] snxLiveReady missing required data:', {
        db: !!db, liveDB: !!liveDB, auth: !!auth, user: !!user, roomId
      });
      return;
    }
    _init(db, liveDB, auth, user, userData, roomId, isHost);
  });

  // Expose cleanup so live.js can call it on endLive
  window._cohostCleanup = _cleanup;

})();
