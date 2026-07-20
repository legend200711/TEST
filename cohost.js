/**
 * Shadow Nexus Live — cohost.js
 *
 * Co-Host feature — completely self-contained.
 * Uses ONLY:  cohosts/{roomId}/...  in Realtime Database
 *             notifications/{uid}/items  in Firestore (write-only — same path live.js uses)
 *
 * Does NOT touch:
 *   messages/, posts/, comments/, users/, chat/, feed/,
 *   liveRooms/, liveConnections/, liveGuests/, guestRequests/, guestSignaling/
 *
 * To disable the entire feature: remove the <script> tag for cohost.js
 * and the <link> tag for cohost.css from live.html.
 */

'use strict';

/* ══════════════════════════════════════════════════════
   MODULE BOOTSTRAP
   Wait for live.js to expose _cohostBoot() dependencies
   via a custom event or fall back to a polling guard.
   ══════════════════════════════════════════════════════ */

(function () {

  /* ── All Firebase handles are pulled from the window object
        that live.js intentionally publishes for add-on modules. ── */
  let _db     = null;   // Firestore
  let _liveDB = null;   // Realtime Database
  let _auth   = null;   // Firebase Auth

  /* ── Runtime state ── */
  let _user     = null;
  let _userData = null;
  let _roomId   = null;
  let _isHost   = false;
  let _isCohostOfRoom = null;   // roomId this viewer is a co-host of (if any)

  let _inviteUnsub        = null;   // RTDB listener: host watching for status changes
  let _inviteInboxUnsub   = null;   // RTDB listener: invitee watching for invite
  let _activeUnsub        = null;   // RTDB listener: live list of active co-hosts
  let _pendingInvites     = {};     // uid → true  (invites we already sent this session)
  let _popupOpen          = false;
  let _searchResults      = [];

  /* ── Settings defaults ── */
  let _cohostSettings = {
    allowCohosts: true,
    whoCanCohost: 'friends',   // 'friends' | 'approved' | 'nobody'
  };

  /* ═══════════════════════════════════════════════════
     INIT — called once Firebase is ready
     ═══════════════════════════════════════════════════ */
  function _init(db, liveDB, auth, user, userData, roomId, isHost) {
    _db     = db;
    _liveDB = liveDB;
    _auth   = auth;
    _user   = user;
    _userData = userData || {};
    _roomId = roomId;
    _isHost = isHost;

    _injectUI();
    _wireEvents();

    if (_isHost) {
      _loadSettings();
      _subscribeActiveCohosts();
    } else {
      // Viewer — watch for co-host invites addressed to them
      _watchForInvite();
    }
  }

  /* ═══════════════════════════════════════════════════
     UI INJECTION
     All DOM is created here — nothing is hard-coded in live.html
     except the single <script> tag.
     ═══════════════════════════════════════════════════ */
  function _injectUI() {
    _injectStyles();
    _injectButton();
    _injectPopup();
    _injectInviteCard();
    _injectSettingsSection();
  }

  /* Link the stylesheet */
  function _injectStyles() {
    if (document.getElementById('_cohostCSS')) return;
    const link = document.createElement('link');
    link.id  = '_cohostCSS';
    link.rel = 'stylesheet';
    link.href = 'cohost.css';
    document.head.appendChild(link);
  }

  /* 🎙️ Co-Host button — appended before END LIVE in the bottom bar */
  function _injectButton() {
    if (document.getElementById('btnCoHost')) return;
    const btn = document.createElement('button');
    btn.id          = 'btnCoHost';
    btn.className   = 'live-ctrl-btn';
    btn.title       = 'Co-Host';
    btn.setAttribute('aria-label', 'Co-Host center');
    btn.textContent = '🎙️';

    const endBtn = document.getElementById('btnEndLive');
    if (endBtn && endBtn.parentNode) {
      endBtn.parentNode.insertBefore(btn, endBtn);
    }
  }

  /* Co-Host Center popup */
  function _injectPopup() {
    if (document.getElementById('cohostPopup')) return;
    const popup = document.createElement('div');
    popup.id        = 'cohostPopup';
    popup.innerHTML = `
      <button class="cohost-popup-close" id="cohostPopupClose" aria-label="Close co-host center">✕</button>
      <div class="cohost-popup-title">🎙️ Co-Host Center</div>

      <!-- Search friends -->
      <div class="cohost-section-label">Search Friends</div>
      <div class="cohost-search-row">
        <input
          id="cohostSearchInput"
          class="cohost-search-input"
          type="text"
          placeholder="Search by name or @handle…"
          maxlength="50"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
        >
        <button id="cohostSearchBtn" class="cohost-search-btn">Search</button>
      </div>
      <div id="cohostSearchResults" class="cohost-user-list">
        <div class="cohost-empty">Search for a friend to invite as co-host.</div>
      </div>

      <hr class="cohost-divider">

      <!-- Approved / Active co-hosts -->
      <div class="cohost-section-label">Current Co-Hosts</div>
      <div id="cohostActiveList" class="cohost-user-list">
        <div class="cohost-empty">No active co-hosts.</div>
      </div>
    `;

    // Append inside the live-video-wrap so z-index stacking is correct
    const videoWrap = document.querySelector('.live-video-wrap');
    (videoWrap || document.body).appendChild(popup);
  }

  /* Co-Host invite card shown to the invitee */
  function _injectInviteCard() {
    if (document.getElementById('cohostInviteCard')) return;
    const card = document.createElement('div');
    card.id = 'cohostInviteCard';
    card.innerHTML = `
      <div class="cohost-invite-icon">🎙️</div>
      <div class="cohost-invite-title">Co-Host Request</div>
      <div class="cohost-invite-sub" id="cohostInviteSub">Someone wants you to join their live.</div>
      <div class="cohost-invite-actions">
        <button class="cohost-invite-accept" id="cohostAcceptBtn">Accept</button>
        <button class="cohost-invite-deny"   id="cohostDenyBtn">Deny</button>
      </div>
    `;
    document.body.appendChild(card);
  }

  /* Co-Host settings — injected inside the existing Live Settings panel */
  function _injectSettingsSection() {
    if (document.getElementById('cohostSettingsSection')) return;
    const panel = document.getElementById('liveSettingsPanel');
    if (!panel) return;

    const section = document.createElement('div');
    section.id = 'cohostSettingsSection';
    section.innerHTML = `
      <hr class="cohost-divider" style="margin:14px 0 10px;">

      <!-- Allow Co-Hosts toggle -->
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

      <!-- Who can co-host select -->
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

  /* ═══════════════════════════════════════════════════
     EVENT WIRING
     ═══════════════════════════════════════════════════ */
  function _wireEvents() {
    // Co-Host button toggle
    const btn = document.getElementById('btnCoHost');
    if (btn) btn.addEventListener('click', _togglePopup);

    // Popup close
    const closeBtn = document.getElementById('cohostPopupClose');
    if (closeBtn) closeBtn.addEventListener('click', _closePopup);

    // Search
    const searchInput = document.getElementById('cohostSearchInput');
    const searchBtn   = document.getElementById('cohostSearchBtn');
    if (searchBtn)   searchBtn.addEventListener('click',   _doSearch);
    if (searchInput) {
      searchInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); _doSearch(); }
      });
    }

    // Accept / Deny buttons on invite card
    const acceptBtn = document.getElementById('cohostAcceptBtn');
    const denyBtn   = document.getElementById('cohostDenyBtn');
    if (acceptBtn) acceptBtn.addEventListener('click', _acceptInvite);
    if (denyBtn)   denyBtn.addEventListener('click',   _denyInvite);

    // Settings toggles (only for host)
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

    // Close popup when clicking outside
    document.addEventListener('click', e => {
      if (!_popupOpen) return;
      const popup = document.getElementById('cohostPopup');
      const btn   = document.getElementById('btnCoHost');
      if (!popup || !btn) return;
      if (!popup.contains(e.target) && !btn.contains(e.target)) {
        _closePopup();
      }
    }, true);
  }

  /* ═══════════════════════════════════════════════════
     POPUP OPEN / CLOSE
     ═══════════════════════════════════════════════════ */
  function _togglePopup() {
    _popupOpen ? _closePopup() : _openPopup();
  }
  function _openPopup() {
    const popup = document.getElementById('cohostPopup');
    const btn   = document.getElementById('btnCoHost');
    if (!popup) return;
    popup.classList.add('visible');
    btn && btn.classList.add('cohost-active');
    _popupOpen = true;
    _refreshActiveList();
  }
  function _closePopup() {
    const popup = document.getElementById('cohostPopup');
    const btn   = document.getElementById('btnCoHost');
    if (!popup) return;
    popup.classList.remove('visible');
    btn && btn.classList.remove('cohost-active');
    _popupOpen = false;
  }

  /* ═══════════════════════════════════════════════════
     SEARCH — query Firestore 'users' by displayName or username
     ═══════════════════════════════════════════════════ */
  async function _doSearch() {
    if (!_db) return;
    const input = document.getElementById('cohostSearchInput');
    const query = (input?.value || '').trim();
    if (!query) return;

    const resultsEl = document.getElementById('cohostSearchResults');
    if (resultsEl) resultsEl.innerHTML = '<div class="cohost-empty">Searching…</div>';

    try {
      /* Query by displayName prefix — Firestore range query */
      const { collection, query: fsQuery, where, orderBy, limit, getDocs } =
        await _importFirestore();

      const end = query + '\uf8ff';
      const q = fsQuery(
        collection(_db, 'users'),
        where('displayName', '>=', query),
        where('displayName', '<=', end),
        orderBy('displayName'),
        limit(15)
      );
      const snap = await getDocs(q);
      _searchResults = [];
      snap.forEach(d => {
        if (d.id !== _user.uid) {
          _searchResults.push({ uid: d.id, ...d.data() });
        }
      });
    } catch (_) {
      _searchResults = [];
    }

    _renderSearchResults();
  }

  function _renderSearchResults() {
    const el = document.getElementById('cohostSearchResults');
    if (!el) return;
    if (!_searchResults.length) {
      el.innerHTML = '<div class="cohost-empty">No users found.</div>';
      return;
    }
    el.innerHTML = '';
    _searchResults.forEach(u => {
      const isSent = !!_pendingInvites[u.uid];
      const row = document.createElement('div');
      row.className = 'cohost-user-row';
      const initials = (u.displayName || u.username || '?')[0].toUpperCase();
      const avatarStyle = u.avatar || u.profilePicture
        ? `background-image:url('${u.avatar || u.profilePicture}');`
        : '';
      row.innerHTML = `
        <div class="cohost-user-avatar" style="${avatarStyle}">${avatarStyle ? '' : initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="cohost-user-name">${_esc(u.displayName || u.username || 'Unknown')}</div>
          ${u.username ? `<div class="cohost-user-handle">@${_esc(u.username)}</div>` : ''}
        </div>
        <button
          class="cohost-invite-btn${isSent ? ' sent' : ''}"
          data-uid="${u.uid}"
        >${isSent ? '✓ Sent' : 'Invite'}</button>
      `;
      const inviteBtn = row.querySelector('.cohost-invite-btn');
      if (inviteBtn && !isSent) {
        inviteBtn.addEventListener('click', () => _sendInvite(u));
      }
      el.appendChild(row);
    });
  }

  /* ═══════════════════════════════════════════════════
     SEND INVITE
     Writes to:  cohosts/{roomId}/invites/{targetUid}
     ═══════════════════════════════════════════════════ */
  async function _sendInvite(targetUser) {
    if (!_liveDB || !_roomId || !_user) return;
    if (!_cohostSettings.allowCohosts) {
      _liveToast('Co-hosts are currently disabled in your settings.');
      return;
    }
    if (_cohostSettings.whoCanCohost === 'nobody') {
      _liveToast('Co-hosting is set to Nobody in your settings.');
      return;
    }

    const { ref: rtRef, set: rtSet } = await _importRTDB();
    const inviteRef = rtRef(_liveDB, `cohosts/${_roomId}/invites/${targetUser.uid}`);

    try {
      await rtSet(inviteRef, {
        fromUid:    _user.uid,
        fromName:   _userData.displayName || _user.email?.split('@')[0] || 'Host',
        fromAvatar: _userData.avatar || _userData.profilePicture || '',
        toUid:      targetUser.uid,
        toName:     targetUser.displayName || targetUser.username || 'User',
        roomId:     _roomId,
        status:     'pending',
        sentAt:     Date.now(),
      });

      // Mark as sent in local state + re-render
      _pendingInvites[targetUser.uid] = true;
      _renderSearchResults();
      _liveToast(`🎙️ Co-host invite sent to ${targetUser.displayName || targetUser.username || 'user'}!`);
    } catch (e) {
      _liveToast('Could not send invite. Please try again.');
    }
  }

  /* ═══════════════════════════════════════════════════
     HOST — subscribe to active co-hosts list
     Path:  cohosts/{roomId}/active/
     ═══════════════════════════════════════════════════ */
  async function _subscribeActiveCohosts() {
    if (!_liveDB || !_roomId) return;
    const { ref: rtRef, onValue: rtOnValue } = await _importRTDB();
    const activeRef = rtRef(_liveDB, `cohosts/${_roomId}/active`);

    _activeUnsub = rtOnValue(activeRef, snap => {
      const data = snap.val() || {};
      // Build array of active co-hosts
      const list = Object.entries(data).map(([uid, v]) => ({ uid, ...v }));
      _renderActiveList(list);
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
      const row = document.createElement('div');
      row.className = 'cohost-active-row';
      const initials = (co.name || '?')[0].toUpperCase();
      const avatarStyle = co.avatar ? `background-image:url('${co.avatar}');` : '';
      row.innerHTML = `
        <div class="cohost-user-avatar" style="${avatarStyle}">${avatarStyle ? '' : initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="cohost-active-name">${_esc(co.name || 'Co-Host')}</div>
          <div class="cohost-active-status">● Active</div>
        </div>
        <button class="cohost-remove-btn" data-uid="${co.uid}">Remove</button>
      `;
      row.querySelector('.cohost-remove-btn').addEventListener('click', () => _removeCohost(co.uid, co.name));
      el.appendChild(row);
    });
  }

  /* Refresh is called each time the popup opens */
  function _refreshActiveList() {
    if (!_activeUnsub) {
      // Not subscribed yet (popup was opened before subscription completed) — re-trigger
      _subscribeActiveCohosts();
    }
  }

  /* ═══════════════════════════════════════════════════
     HOST — remove a co-host
     ═══════════════════════════════════════════════════ */
  async function _removeCohost(uid, name) {
    if (!_liveDB || !_roomId) return;
    const { ref: rtRef, remove: rtRemove, set: rtSet } = await _importRTDB();
    try {
      // Remove from active list
      await rtRemove(rtRef(_liveDB, `cohosts/${_roomId}/active/${uid}`));
      // Write a removed signal so the co-host's client clears their badge
      await rtSet(rtRef(_liveDB, `cohosts/${_roomId}/removed/${uid}`), { ts: Date.now() });
      _liveToast(`${name || 'Co-host'} removed.`);
    } catch (_) {
      _liveToast('Could not remove co-host. Try again.');
    }
  }

  /* ═══════════════════════════════════════════════════
     INVITEE (VIEWER) — watch for incoming invite
     Path:  cohosts/{roomId}/invites/{myUid}
     ═══════════════════════════════════════════════════ */
  async function _watchForInvite() {
    if (!_liveDB || !_roomId || !_user) return;
    const { ref: rtRef, onValue: rtOnValue, off: rtOff } = await _importRTDB();
    const inviteRef = rtRef(_liveDB, `cohosts/${_roomId}/invites/${_user.uid}`);

    _inviteInboxUnsub = rtOnValue(inviteRef, snap => {
      if (!snap.exists()) return;
      const data = snap.val();
      if (data.status !== 'pending') return;
      _showInviteCard(data);
    });

    // Also watch if this user was removed as co-host
    const removedRef = rtRef(_liveDB, `cohosts/${_roomId}/removed/${_user.uid}`);
    rtOnValue(removedRef, snap => {
      if (!snap.exists()) return;
      _isCohostOfRoom = null;
      _clearCohostBadge();
      _liveToast('You have been removed as co-host.');
      rtOff(removedRef);
    });
  }

  /* ── Show the invite card ── */
  function _showInviteCard(data) {
    const card = document.getElementById('cohostInviteCard');
    const sub  = document.getElementById('cohostInviteSub');
    if (!card) return;
    if (sub) sub.textContent = `${data.fromName || 'The host'} wants you to join their live as co-host.`;
    card.dataset.inviteFrom = data.fromUid || '';
    card.classList.add('visible');
  }

  function _hideInviteCard() {
    const card = document.getElementById('cohostInviteCard');
    if (card) card.classList.remove('visible');
  }

  /* ── Accept ── */
  async function _acceptInvite() {
    if (!_liveDB || !_roomId || !_user) return;
    _hideInviteCard();

    const { ref: rtRef, set: rtSet, remove: rtRemove } = await _importRTDB();

    try {
      // Write co-host entry to active list
      await rtSet(rtRef(_liveDB, `cohosts/${_roomId}/active/${_user.uid}`), {
        uid:      _user.uid,
        name:     _userData.displayName || _user.email?.split('@')[0] || 'Co-Host',
        avatar:   _userData.avatar || _userData.profilePicture || '',
        joinedAt: Date.now(),
      });

      // Update invite status
      await rtSet(rtRef(_liveDB, `cohosts/${_roomId}/invites/${_user.uid}/status`), 'accepted');

      _isCohostOfRoom = _roomId;
      _showCohostBadge();
      _liveToast('🎙️ You are now a co-host!');
    } catch (_) {
      _liveToast('Could not accept. Please try again.');
    }
  }

  /* ── Deny ── */
  async function _denyInvite() {
    if (!_liveDB || !_roomId || !_user) return;
    _hideInviteCard();

    const { ref: rtRef, remove: rtRemove } = await _importRTDB();
    try {
      // Remove the invite entirely so the card can't reappear
      await rtRemove(rtRef(_liveDB, `cohosts/${_roomId}/invites/${_user.uid}`));
    } catch (_) {}
  }

  /* ═══════════════════════════════════════════════════
     CO-HOST BADGE — shown in top bar for the co-host
     ═══════════════════════════════════════════════════ */
  function _showCohostBadge() {
    if (document.getElementById('_cohostActiveBadge')) return;
    const badge = document.createElement('div');
    badge.id        = '_cohostActiveBadge';
    badge.className = 'cohost-badge-pill';
    badge.textContent = '🎙️ Co-Host';
    badge.style.cssText = `
      position:absolute; top:calc(env(safe-area-inset-top,0) + 10px); left:50%;
      transform:translateX(-50%); z-index:30;
    `;
    const videoWrap = document.querySelector('.live-video-wrap');
    if (videoWrap) videoWrap.appendChild(badge);
  }

  function _clearCohostBadge() {
    const badge = document.getElementById('_cohostActiveBadge');
    if (badge) badge.remove();
  }

  /* ═══════════════════════════════════════════════════
     SETTINGS — load / save to RTDB cohosts/{roomId}/settings
     ═══════════════════════════════════════════════════ */
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

    // Reflect in UI
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

  /* ═══════════════════════════════════════════════════
     CLEANUP — called when the live session ends
     ═══════════════════════════════════════════════════ */
  function _cleanup() {
    if (_activeUnsub)      { try { _activeUnsub();      } catch(_){} _activeUnsub      = null; }
    if (_inviteInboxUnsub) { try { _inviteInboxUnsub(); } catch(_){} _inviteInboxUnsub = null; }
    if (_inviteUnsub)      { try { _inviteUnsub();      } catch(_){} _inviteUnsub      = null; }
    _closePopup();
    _hideInviteCard();
  }

  /* ═══════════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════════ */
  function _esc(str) {
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  /* Reuse the existing live.js toast if available, else fallback */
  function _liveToast(msg) {
    const t = document.getElementById('liveToast');
    if (!t) { console.log('[CoHost]', msg); return; }
    t.textContent = msg;
    t.classList.add('visible');
    clearTimeout(t._cohostTimer);
    t._cohostTimer = setTimeout(() => t.classList.remove('visible'), 3200);
  }

  /* Lazy-load Firebase RTDB module (already loaded by live.js — just grab from importmap) */
  async function _importRTDB() {
    return await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js');
  }

  /* Lazy-load Firestore module */
  async function _importFirestore() {
    return await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
  }

  /* ═══════════════════════════════════════════════════
     BOOTSTRAP — wait for live.js to fire the ready event
     ═══════════════════════════════════════════════════ */
  window.addEventListener('snxLiveReady', e => {
    const { db, liveDB, auth, user, userData, roomId, isHost } = e.detail || {};
    if (!db || !liveDB || !auth || !user || !roomId) return;
    _init(db, liveDB, auth, user, userData, roomId, isHost);
  });

  /* Also expose cleanup so live.js can call it on endLive */
  window._cohostCleanup = _cleanup;

})();
