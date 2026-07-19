/* ═══════════════════════════════════════════════════════════════
   SHADOW NEXUS SOCIAL — Profile Photo Album
   album.js  ·  Loaded after Firebase is ready

   Collections used:
     /albumPhotos/{photoId}
       ownerUid, url, type ('profile'|'cover'|'album'),
       caption, uploadedAt, privacy, feedPostId (optional),
       albumId, savedToWall

   Feed posts for album photos follow the same /posts/{postId} schema.
   They include  albumPhotoId  so the album badge can deeplink back.

   48-hour expiry is enforced on the feed post (expiresAt field),
   but the albumPhoto document itself is NEVER deleted automatically.

   Upload flow (strict, per spec):
     1. File selected → preview shown
     2. R2 upload → Cloudflare returns public URL  (abort on failure)
     3. Firestore save /albumPhotos/                (abort on failure)
     4. Optional: create /posts/ feed entry         (non-fatal)
     5. Optional: mirror to /users/{uid}/profileWall (non-fatal)
     6. Reload album grid                           (always)
     7. Only show "Upload Successful" after ALL mandatory steps pass.
   ═══════════════════════════════════════════════════════════════ */

(function () {
    'use strict';

    /* ── Wait until Firebase + auth are ready ────────────────── */
    function waitForReady(cb) {
        const MAX = 80; // 8 s (80 × 100 ms)
        let tries = 0;
        const t = setInterval(() => {
            tries++;
            // Wait for Firestore AND auth to be resolved before initialising.
            // _snxAuthResolved is set true in onAuthStateChanged only after the
            // current user is fully confirmed — avoids a race where _snxCurrentUser
            // is set but the UID token hasn't been validated yet.
            if (window._snxDb && window._snxFirestore && window._snxCurrentUser && window._snxAuthResolved) {
                clearInterval(t);
                cb();
            } else if (tries >= MAX) {
                clearInterval(t);
                console.warn('[Album] Firebase not ready after 8 s — album module disabled');
            }
        }, 100);
    }

    waitForReady(init);

    /* ═══════════════════════════════════════════════════════════
       STATE
       ═══════════════════════════════════════════════════════════ */
    let db, currentUser;
    let collection, addDoc, getDocs, getDoc, doc, updateDoc,
        deleteDoc, query, where, orderBy, serverTimestamp, setDoc,
        increment, arrayUnion, arrayRemove;

    // Viewer state
    let _viewerPhotos   = [];
    let _viewerIdx      = 0;
    let _slideshowTimer = null;
    let _slideshowActive = false;

    // Touch-swipe state
    let _touchStartX = 0;
    let _touchStartY = 0;

    // Current album owner uid & filter
    let _albumOwnerUid = null;
    let _activeFilter  = 'all';
    let _allPhotos     = [];

    /* ═══════════════════════════════════════════════════════════
       INIT
       ═══════════════════════════════════════════════════════════ */
    /* ── Always read the live auth user — never rely on a stale capture ── */
    function liveUser() {
        // Pull the freshest version on every call so a silent token refresh
        // or re-login is always honoured and the UID never drifts out of sync.
        return window._snxCurrentUser || null;
    }

    function init() {
        db          = window._snxDb;
        currentUser = window._snxCurrentUser;
        ({ collection, addDoc, getDocs, getDoc, doc, updateDoc,
           deleteDoc, query, where, orderBy, serverTimestamp, setDoc,
           increment, arrayUnion, arrayRemove }
            = window._snxFirestore);

        // Keep currentUser in sync — always overwrite so a token refresh is picked up
        setInterval(() => {
            currentUser = window._snxCurrentUser || currentUser;
        }, 2000);

        injectHTML();
        bindEvents();
        exposePublicAPI();

        // Hook into viewProfile so album tab shows correct data
        const _origView = window.viewProfile;
        if (typeof _origView === 'function') {
            window.viewProfile = async function (uid) {
                const result = await _origView.apply(this, arguments);
                _albumOwnerUid = uid;
                const tab = document.getElementById('tabContentAlbum');
                if (tab && tab.style.display !== 'none') {
                    loadAlbumTab(uid);
                }
                return result;
            };
        }

        patchAvatarAndBannerUploads();
    }

    /* ═══════════════════════════════════════════════════════════
       INJECT HTML
       ═══════════════════════════════════════════════════════════ */
    function injectHTML() {
        /* 1 ── Album tab button — inject only if missing */
        const tabsRow = document.querySelector('.profile-tabs');
        if (tabsRow && !document.getElementById('tabAlbumLink')) {
            const btn = document.createElement('button');
            btn.className = 'tab-btn';
            btn.id = 'tabAlbumLink';
            btn.textContent = '📸 Photo Album';
            btn.onclick = () => window.switchProfileTab('album');
            tabsRow.appendChild(btn);
        }

        /* 2 ── Album tab content panel */
        const albumPanel = document.getElementById('tabContentAlbum');
        if (albumPanel) {
            if (!albumPanel.innerHTML.trim()) {
                albumPanel.innerHTML = buildAlbumPanelHTML();
            }
        } else {
            const newPanel = document.createElement('div');
            newPanel.id    = 'tabContentAlbum';
            newPanel.style.display = 'none';
            newPanel.innerHTML = buildAlbumPanelHTML();
            const ref = document.getElementById('tabContentMessages');
            if (ref) ref.insertAdjacentElement('afterend', newPanel);
            else {
                const p = document.getElementById('profile');
                if (p) p.appendChild(newPanel);
            }
        }

        /* 3 ── Upload modal */
        if (!document.getElementById('snxAlbumUploadModal')) {
            const modal = document.createElement('div');
            modal.id    = 'snxAlbumUploadModal';
            modal.innerHTML = buildUploadModalHTML();
            document.body.appendChild(modal);
        }

        /* 4 ── Photo Viewer modal */
        if (!document.getElementById('snxAlbumViewer')) {
            const viewer = document.createElement('div');
            viewer.id    = 'snxAlbumViewer';
            viewer.innerHTML = buildViewerHTML();
            document.body.appendChild(viewer);
        }
    }

    function buildAlbumPanelHTML() {
        return `
        <div class="section-card" style="padding:14px 14px 16px;">

            <!-- Header -->
            <div class="snx-album-header">
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span class="snx-album-title">📸 Photo Album</span>
                    <span class="snx-album-privacy-badge" id="snxAlbumPrivacyBadge"
                          title="Click to change album privacy (owner only)">🌐 Public</span>
                </div>
                <div class="snx-album-header-btns">
                    <button id="snxAlbumUploadBtn" style="display:none;"
                            onclick="window.snxAlbum.openUploadModal()">📤 Upload Photos</button>
                    <button id="snxAlbumSlideshowBtn"
                            onclick="window.snxAlbum.startSlideshow()">▶ Slideshow</button>
                </div>
            </div>

            <!-- Filter chips -->
            <div class="snx-album-filters" id="snxAlbumFilters">
                <button class="snx-album-filter-chip active" data-filter="all"
                        onclick="window.snxAlbum.filterAlbum('all')">🖼 All Photos</button>
                <button class="snx-album-filter-chip" data-filter="profile"
                        onclick="window.snxAlbum.filterAlbum('profile')">👤 Profile Pics</button>
                <button class="snx-album-filter-chip" data-filter="cover"
                        onclick="window.snxAlbum.filterAlbum('cover')">🖼 Cover Photos</button>
                <button class="snx-album-filter-chip" data-filter="album"
                        onclick="window.snxAlbum.filterAlbum('album')">📸 Album Photos</button>
            </div>

            <!-- Photo grid -->
            <div class="snx-album-grid" id="snxAlbumGrid">
                <div class="snx-album-empty">
                    <div class="snx-album-empty-icon">📷</div>
                    Loading album…
                </div>
            </div>
        </div>`;
    }

    function buildUploadModalHTML() {
        return `
        <div class="snx-aum-card" role="dialog" aria-modal="true" aria-label="Upload Photos to Album">
            <button class="snx-aum-close" onclick="window.snxAlbum.closeUploadModal()" aria-label="Close">✕</button>
            <h3 class="snx-aum-title">📤 Upload to Photo Album</h3>

            <!-- Gallery picker button — opens the OS photo library (no camera) -->
            <div class="snx-aum-pick-row" id="snxAumPickRow">
                <button class="snx-aum-pick-btn snx-aum-pick-btn--gallery" type="button"
                        onclick="document.getElementById('snxAumFileInput').click()"
                        aria-label="Choose photos from your gallery">
                    🖼<span class="snx-aum-pick-label">Choose from Gallery</span>
                </button>
            </div>

            <div class="snx-aum-dropzone" id="snxAumDropzone"
                 tabindex="0"
                 ondragover="event.preventDefault();this.classList.add('drag-over')"
                 ondragleave="this.classList.remove('drag-over')"
                 ondrop="window.snxAlbum._handleDrop(event)"
                 onclick="document.getElementById('snxAumFileInput').click()"
                 onkeydown="if(event.key==='Enter'||event.key===' ')document.getElementById('snxAumFileInput').click()">
                <div class="snx-aum-dropzone-icon">📁</div>
                <div class="snx-aum-dropzone-text">Drag &amp; drop photos here</div>
                <div class="snx-aum-dropzone-hint">JPG · PNG · WEBP · GIF &nbsp;·&nbsp; Up to 10 at once</div>
            </div>

            <!-- Gallery picker — no capture attribute, shows OS photo library on Android & iOS -->
            <input type="file" id="snxAumFileInput" accept="image/*" multiple
                   style="display:none;" onchange="window.snxAlbum._handleFileSelect(this)">

            <div class="snx-aum-selected" id="snxAumPreviews"></div>

            <div class="snx-aum-caption-wrap">
                <label for="snxAumCaption">Caption (optional)</label>
                <textarea id="snxAumCaption" rows="2" maxlength="200"
                    placeholder="Add a caption for these photos…"></textarea>
            </div>

            <div class="snx-aum-privacy-row">
                <label for="snxAumPrivacy">Privacy</label>
                <select id="snxAumPrivacy">
                    <option value="public">🌐 Public</option>
                    <option value="followers">👥 Followers Only</option>
                    <option value="friends">🦋 Friends Only</option>
                    <option value="private">🔒 Private</option>
                </select>
            </div>

            <!-- Save to Profile Wall toggle -->
            <label class="snx-aum-wall-row" id="snxAumWallRow">
                <input type="checkbox" id="snxAumSaveToWall">
                <span class="snx-aum-wall-check"></span>
                <span class="snx-aum-wall-text">📌 Also save to my Profile Wall</span>
            </label>

            <div class="snx-aum-progress" id="snxAumProgress">
                <div class="snx-aum-progress-bar" id="snxAumProgressBar"></div>
            </div>
            <div class="snx-aum-status" id="snxAumStatus"></div>

            <button class="snx-aum-submit" id="snxAumSubmit"
                    onclick="window.snxAlbum.submitUpload()" disabled>
                📸 Save to Album
            </button>
        </div>`;
    }

    function buildViewerHTML() {
        return `
        <button class="snx-av-close" onclick="window.snxAlbum.closeViewer()" aria-label="Close viewer">✕</button>

        <button class="snx-av-nav snx-av-prev" onclick="window.snxAlbum.viewerNav(-1)" aria-label="Previous photo">‹</button>
        <button class="snx-av-nav snx-av-next" onclick="window.snxAlbum.viewerNav(1)"  aria-label="Next photo">›</button>

        <div class="snx-av-img-wrap" id="snxAvImgWrap">
            <img id="snxAvImg" src="" alt="Album photo" draggable="false">
        </div>

        <div class="snx-av-footer">
            <div class="snx-av-progress"><div class="snx-av-progress-bar" id="snxAvProgressBar"></div></div>
            <span class="snx-av-counter" id="snxAvCounter">1 of 1</span>
            <span class="snx-av-caption" id="snxAvCaption"></span>
            <span class="snx-av-date"    id="snxAvDate"></span>

            <!-- Viewer social actions (like, comment, share, report) -->
            <div class="snx-av-social-bar" id="snxAvSocialBar">
                <button class="snx-av-social-btn snx-av-like-btn" id="snxAvLikeBtn"
                        onclick="window.snxAlbum.togglePhotoLike()"
                        aria-label="Like this photo">
                    <span class="snx-av-like-icon">❤️</span>
                    <span class="snx-av-like-count" id="snxAvLikeCount">0</span>
                </button>
                <button class="snx-av-social-btn" id="snxAvCommentBtn"
                        onclick="window.snxAlbum.toggleCommentPanel()"
                        aria-label="Comment on this photo">
                    💬 <span id="snxAvCommentCount">0</span>
                </button>
                <button class="snx-av-social-btn" id="snxAvShareBtn"
                        onclick="window.snxAlbum.shareCurrentPhoto()"
                        aria-label="Share this photo">
                    📤 Share
                </button>
                <button class="snx-av-social-btn snx-av-report-btn" id="snxAvReportBtn"
                        onclick="window.snxAlbum.reportCurrentPhoto()"
                        aria-label="Report this photo">
                    🚩 Report
                </button>
            </div>

            <!-- Inline comment panel -->
            <div class="snx-av-comment-panel" id="snxAvCommentPanel" style="display:none;">
                <div class="snx-av-comment-list" id="snxAvCommentList"></div>
                <div class="snx-av-comment-input-row">
                    <input id="snxAvCommentInput" type="text" maxlength="200"
                           placeholder="Add a comment…" autocomplete="off"
                           onkeydown="if(event.key==='Enter')window.snxAlbum.submitPhotoComment()">
                    <button onclick="window.snxAlbum.submitPhotoComment()">Send</button>
                </div>
            </div>

            <!-- Caption edit (owner only) -->
            <div class="snx-av-caption-edit" id="snxAvCaptionEdit">
                <textarea id="snxAvCaptionInput" rows="2" maxlength="200"
                          placeholder="Edit caption…"></textarea>
                <div class="snx-av-caption-edit-btns">
                    <button onclick="window.snxAlbum.cancelCaptionEdit()">Cancel</button>
                    <button class="save" onclick="window.snxAlbum.saveCaptionEdit()">Save</button>
                </div>
            </div>

            <div class="snx-av-owner-actions" id="snxAvOwnerActions" style="display:none;">
                <button onclick="window.snxAlbum.openCaptionEdit()">✏️ Edit Caption</button>
                <button onclick="window.snxAlbum.setAsProfilePic()">👤 Set as Profile Pic</button>
                <button onclick="window.snxAlbum.setAsCoverPhoto()">🖼 Set as Cover</button>
                <button class="danger" onclick="window.snxAlbum.deleteCurrentPhoto()">🗑 Delete</button>
            </div>

            <div class="snx-av-slideshow-bar" id="snxAvSlideshowBar" style="display:none;">
                <button id="snxAvSlideshowToggle"
                        onclick="window.snxAlbum.toggleSlideshow()">▶ Play</button>
                <button onclick="window.snxAlbum.closeViewer()">✕ Exit</button>
            </div>
        </div>`;
    }

    /* ═══════════════════════════════════════════════════════════
       EVENT BINDINGS
       ═══════════════════════════════════════════════════════════ */
    function bindEvents() {
        // Close upload modal on backdrop click
        document.addEventListener('click', (e) => {
            const modal = document.getElementById('snxAlbumUploadModal');
            if (modal && e.target === modal) closeUploadModal();
        });

        // Keyboard nav in viewer
        document.addEventListener('keydown', (e) => {
            const viewer = document.getElementById('snxAlbumViewer');
            if (!viewer || !viewer.classList.contains('open')) return;
            if (e.key === 'Escape')     { e.preventDefault(); closeViewer(); }
            if (e.key === 'ArrowLeft')  { e.preventDefault(); viewerNav(-1); }
            if (e.key === 'ArrowRight') { e.preventDefault(); viewerNav(1);  }
        });

        // Touch swipe in viewer
        const viewer = document.getElementById('snxAlbumViewer');
        if (viewer) {
            viewer.addEventListener('touchstart', (e) => {
                _touchStartX = e.touches[0].clientX;
                _touchStartY = e.touches[0].clientY;
            }, { passive: true });
            viewer.addEventListener('touchend', (e) => {
                const dx = e.changedTouches[0].clientX - _touchStartX;
                const dy = e.changedTouches[0].clientY - _touchStartY;
                if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
                    viewerNav(dx < 0 ? 1 : -1);
                }
            });
        }

        // Pinch-to-zoom on viewer image (mobile)
        const imgWrap = document.getElementById('snxAvImgWrap');
        if (imgWrap) {
            let initialDist = null;
            let currentScale = 1;
            imgWrap.addEventListener('touchstart', (e) => {
                if (e.touches.length === 2) {
                    initialDist = Math.hypot(
                        e.touches[1].clientX - e.touches[0].clientX,
                        e.touches[1].clientY - e.touches[0].clientY
                    );
                }
            }, { passive: true });
            imgWrap.addEventListener('touchmove', (e) => {
                if (e.touches.length === 2 && initialDist !== null) {
                    e.preventDefault();
                    const dist = Math.hypot(
                        e.touches[1].clientX - e.touches[0].clientX,
                        e.touches[1].clientY - e.touches[0].clientY
                    );
                    currentScale = Math.min(4, Math.max(1, dist / initialDist));
                    const img = document.getElementById('snxAvImg');
                    if (img) img.style.transform = `scale(${currentScale})`;
                }
            }, { passive: false });
            imgWrap.addEventListener('touchend', () => {
                if (currentScale === 1) {
                    const img = document.getElementById('snxAvImg');
                    if (img) img.style.transform = '';
                }
                initialDist = null;
            });
        }
    }

    /* ═══════════════════════════════════════════════════════════
       PATCH AVATAR + BANNER UPLOADS (Steps 6 & 7)
       Auto-saves a copy to the album whenever profile pic or
       cover photo is successfully uploaded to R2.
       ═══════════════════════════════════════════════════════════ */
    function patchAvatarAndBannerUploads() {
        // Intercept after the original handleAvatarPick / handleBannerPick
        // set editAvatar.value / editBanner.value.  We wrap those functions
        // globally so the album entry is added the moment the URL is known,
        // before the user even clicks "Save Profile".
        const origAvatar = window.handleAvatarPick;
        window.handleAvatarPick = async function (input) {
            if (typeof origAvatar === 'function') await origAvatar.call(this, input);
            // At this point editAvatar.value holds the new R2 URL (if upload succeeded)
            const url = (document.getElementById('editAvatar')?.value || '').trim();
            if (url && currentUser) {
                await ensureAlbumEntry(url, 'profile', '');
            }
        };

        const origBanner = window.handleBannerPick;
        window.handleBannerPick = async function (input) {
            if (typeof origBanner === 'function') await origBanner.call(this, input);
            const url = (document.getElementById('editBanner')?.value || '').trim();
            if (url && currentUser) {
                await ensureAlbumEntry(url, 'cover', '');
            }
        };

        // Also cover the "paste URL" pathway: when the user saves the profile
        // form with a URL typed directly into editAvatar / editBanner.
        const saveBtn = document.getElementById('btnSaveProfile');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                // Give the existing handler a moment to finish writing to Firestore
                await new Promise(r => setTimeout(r, 900));
                const avatarUrl = (document.getElementById('editAvatar')?.value || '').trim();
                const bannerUrl = (document.getElementById('editBanner')?.value || '').trim();
                if (!currentUser) return;
                if (avatarUrl) await ensureAlbumEntry(avatarUrl, 'profile', '');
                if (bannerUrl) await ensureAlbumEntry(bannerUrl, 'cover',   '');
            }, true); // capture phase
        }
    }

    /* ── Deduplicate-safe album entry creator ──────────────────── */
    async function ensureAlbumEntry(url, type, caption) {
        // Always get the freshest auth user — never use a potentially stale capture.
        const user = liveUser();
        if (!user || !user.uid || !url) return;
        const uid = user.uid;
        try {
            const q = query(
                collection(db, 'albumPhotos'),
                where('ownerUid', '==', uid),
                where('url',      '==', url),
                where('type',     '==', type)
            );
            const snap = await getDocs(q);
            if (!snap.empty) return; // already saved

            await addDoc(collection(db, 'albumPhotos'), {
                ownerUid:    uid,   // must match request.auth.uid in Firestore rule
                url,
                type,
                caption:     caption || '',
                privacy:     'public',
                uploadedAt:  Date.now(),
                albumId:     uid + '_album',
                feedPostId:  null,
                savedToWall: false
            });
        } catch (e) {
            // Log the full error so permission-denied is immediately visible in devtools
            console.warn('[Album] ensureAlbumEntry failed:', e.code || e.message, e);
        }
    }

    /* ═══════════════════════════════════════════════════════════
       LOAD ALBUM TAB  (Step 4 — refresh after upload)
       ═══════════════════════════════════════════════════════════ */
    async function loadAlbumTab(ownerUid) {
        _albumOwnerUid = ownerUid;
        _activeFilter  = 'all';

        // Reset filter chip UI
        document.querySelectorAll('.snx-album-filter-chip').forEach(c => {
            c.classList.toggle('active', c.dataset.filter === 'all');
        });

        // Always use the live user for owner comparisons — not a stale variable
        const _liveU = liveUser();

        // Show / hide upload button (owner only)
        const uploadBtn = document.getElementById('snxAlbumUploadBtn');
        if (uploadBtn) {
            uploadBtn.style.display = (_liveU && _liveU.uid === ownerUid) ? '' : 'none';
        }

        // Privacy badge — owner can click to change; visitors see read-only
        const privBadge = document.getElementById('snxAlbumPrivacyBadge');
        if (privBadge) {
            if (_liveU && _liveU.uid === ownerUid) {
                privBadge.style.cursor = 'pointer';
                privBadge.title = 'Click to change album privacy';
                privBadge.onclick = openAlbumPrivacyPicker;
            } else {
                privBadge.style.cursor = 'default';
                privBadge.onclick = null;
            }
        }

        const grid = document.getElementById('snxAlbumGrid');
        if (!grid) return;
        grid.innerHTML = '<div class="snx-album-empty"><div class="snx-album-empty-icon">⏳</div>Loading…</div>';

        try {
            const q = query(
                collection(db, 'albumPhotos'),
                where('ownerUid', '==', ownerUid),
                orderBy('uploadedAt', 'desc')
            );
            const snap = await getDocs(q);
            let photos = [];
            snap.forEach(d => photos.push({ id: d.id, ...d.data() }));

            // Privacy filter for visitors
            const isSelf = _liveU && _liveU.uid === ownerUid;
            if (!isSelf) {
                photos = photos.filter(p => {
                    const priv = p.privacy || 'public';
                    return priv !== 'private';
                    // TODO: server-side followers/friends enforcement
                });
            }
            _allPhotos = photos;

            // Update privacy badge — read album privacy from owner's user doc
            if (privBadge && isSelf) {
                try {
                    const userSnap = await getDoc(doc(db, 'users', ownerUid));
                    const albumPrivacy = userSnap.data()?.albumPrivacy || 'public';
                    const privLabels = {
                        public: '🌐 Public', followers: '👥 Followers',
                        friends: '🦋 Friends', private: '🔒 Private'
                    };
                    privBadge.textContent = privLabels[albumPrivacy] || '🌐 Public';
                } catch (_) { /* best-effort */ }
            }

            renderGrid(_allPhotos, grid);
        } catch (e) {
            console.error('[Album] loadAlbumTab error:', e);
            grid.innerHTML = '<div class="snx-album-empty"><div class="snx-album-empty-icon">⚠️</div>Could not load album.</div>';
        }
    }

    /* ═══════════════════════════════════════════════════════════
       RENDER GRID
       ═══════════════════════════════════════════════════════════ */
    function renderGrid(photos, grid) {
        if (!grid) return;
        if (!photos || photos.length === 0) {
            const isSelf = currentUser && currentUser.uid === _albumOwnerUid;
            grid.innerHTML = `
                <div class="snx-album-empty">
                    <div class="snx-album-empty-icon">📷</div>
                    No photos here yet.${isSelf ? '<br><small>Tap <b>Upload Photos</b> to add your first photo!</small>' : ''}
                </div>`;
            return;
        }
        const isSelf = currentUser && currentUser.uid === _albumOwnerUid;
        grid.innerHTML = photos.map((p, i) => {
            const typeLabel = { profile: '👤 Profile', cover: '🖼 Cover', album: '📸 Album' }[p.type] || '';
            const typeCls   = { profile: 'type-profile', cover: 'type-cover', album: 'type-album' }[p.type] || '';
            return `
            <div class="snx-album-thumb" onclick="window.snxAlbum.openViewer(${i})"
                 title="${esc(p.caption || '')}">
                <img src="${esc(p.url)}" alt="album photo" loading="lazy"
                     onerror="this.parentElement.style.background='#071428';this.style.display='none'">
                <span class="snx-album-thumb-type ${typeCls}">${typeLabel}</span>
                ${isSelf ? `<button class="snx-album-thumb-del" title="Delete photo"
                    onclick="event.stopPropagation();window.snxAlbum.deletePhoto('${esc(p.id)}')">✕</button>` : ''}
            </div>`;
        }).join('');
    }

    /* ═══════════════════════════════════════════════════════════
       FILTER  (Step 5 — type-based filtering)
       ═══════════════════════════════════════════════════════════ */
    function filterAlbum(filter) {
        _activeFilter = filter;
        document.querySelectorAll('.snx-album-filter-chip').forEach(c => {
            c.classList.toggle('active', c.dataset.filter === filter);
        });
        const filtered = filter === 'all' ? _allPhotos : _allPhotos.filter(p => p.type === filter);
        renderGrid(filtered, document.getElementById('snxAlbumGrid'));
        _viewerPhotos = filtered;
    }

    /* ═══════════════════════════════════════════════════════════
       UPLOAD MODAL  (Steps 1–10 + 15)
       ═══════════════════════════════════════════════════════════ */
    let _pendingFiles = [];

    function openUploadModal() {
        // Always pull the freshest auth user before opening the modal
        currentUser = liveUser();
        if (!currentUser || !currentUser.uid) {
            toast('You must be signed in to upload photos.');
            return;
        }
        _pendingFiles = [];
        const modal = document.getElementById('snxAlbumUploadModal');
        if (!modal) return;
        document.getElementById('snxAumPreviews').innerHTML = '';
        document.getElementById('snxAumCaption').value = '';
        document.getElementById('snxAumStatus').textContent = '';
        document.getElementById('snxAumProgress').style.display = 'none';
        document.getElementById('snxAumProgressBar').style.width = '0%';
        document.getElementById('snxAumSubmit').disabled = true;
        const wallChk = document.getElementById('snxAumSaveToWall');
        if (wallChk) wallChk.checked = false;
        modal.classList.add('open');
    }

    function closeUploadModal() {
        const modal = document.getElementById('snxAlbumUploadModal');
        if (modal) modal.classList.remove('open');
        _pendingFiles = [];
    }

    function _handleFileSelect(input) {
        const files = Array.from(input.files || []).filter(f => f.type.startsWith('image/'));
        if (!files.length) return;
        _pendingFiles = files.slice(0, 10);
        renderPreviews(_pendingFiles);
        document.getElementById('snxAumSubmit').disabled = false;
        input.value = '';
    }

    function _handleDrop(event) {
        event.preventDefault();
        const dropZone = document.getElementById('snxAumDropzone');
        if (dropZone) dropZone.classList.remove('drag-over');
        const files = Array.from(event.dataTransfer?.files || []).filter(f => f.type.startsWith('image/'));
        if (!files.length) return;
        _pendingFiles = files.slice(0, 10);
        renderPreviews(_pendingFiles);
        document.getElementById('snxAumSubmit').disabled = false;
    }

    function renderPreviews(files) {
        const container = document.getElementById('snxAumPreviews');
        if (!container) return;
        container.innerHTML = '';
        files.forEach(f => {
            const url = URL.createObjectURL(f);
            const img = document.createElement('img');
            img.src = url;
            img.className = 'snx-aum-thumb-preview';
            img.title = f.name;
            container.appendChild(img);
        });
    }

    /* ── SUBMIT UPLOAD — strict success-only flow (Step 15) ────── */
    async function submitUpload() {
        // ── AUTH GUARD: always re-read the live user at submit time ──────────
        // This catches sessions that expired or were refreshed since the modal
        // was opened, preventing a UID mismatch that would cause permission-denied.
        currentUser = liveUser();
        if (!currentUser || !currentUser.uid) {
            toast('❌ You must be signed in to upload photos. Please log in and try again.');
            return;
        }
        if (!_pendingFiles.length) { toast('No photos selected.'); return; }

        const submitBtn  = document.getElementById('snxAumSubmit');
        const statusEl   = document.getElementById('snxAumStatus');
        const progressWr = document.getElementById('snxAumProgress');
        const progressBr = document.getElementById('snxAumProgressBar');
        const caption    = (document.getElementById('snxAumCaption')?.value || '').trim().substring(0, 200);
        const privacy    = document.getElementById('snxAumPrivacy')?.value || 'public';
        const saveToWall = document.getElementById('snxAumSaveToWall')?.checked === true;

        submitBtn.disabled = true;
        progressWr.style.display = 'block';
        statusEl.textContent = '';

        // Capture UID once — used for ownerUid in every write below.
        // Must match request.auth.uid in Firestore rules exactly.
        const ownerUid = currentUser.uid;
        const totalFiles = _pendingFiles.length;

        /* ─── STEP 1–2: Upload every file to Cloudflare R2 ─────── */
        const uploadedUrls = [];
        for (let i = 0; i < totalFiles; i++) {
            const file = _pendingFiles[i];
            statusEl.style.color = '';
            statusEl.textContent = `Uploading photo ${i + 1} of ${totalFiles} to Cloudflare…`;
            progressBr.style.width = Math.round((i / totalFiles) * 60) + '%';

            let url;
            try {
                url = await uploadFileToR2(file, (pct) => {
                    // Map individual file progress into the 0–60% band
                    const base    = Math.round((i / totalFiles) * 60);
                    const segment = Math.round((1 / totalFiles) * 60);
                    progressBr.style.width = Math.min(60, base + Math.round(pct * segment / 100)) + '%';
                });
            } catch (e) {
                // ── STEP 15: Cloudflare upload failed — do NOT show success ──
                statusEl.style.color = '#ff5577';
                statusEl.textContent = `❌ Upload failed for photo ${i + 1}: ${e.message}`;
                toast(`❌ Upload failed: ${e.message}`);
                submitBtn.disabled = false;
                return; // abort entire batch
            }

            // ── STEP 2: Verify we received a valid URL ──────────────
            if (!url || !url.startsWith('http')) {
                statusEl.style.color = '#ff5577';
                statusEl.textContent = `❌ Cloudflare did not return a valid URL for photo ${i + 1}.`;
                toast('❌ Upload error: no URL returned from Cloudflare.');
                submitBtn.disabled = false;
                return;
            }

            uploadedUrls.push(url);
        }

        progressBr.style.width = '65%';
        statusEl.textContent = 'Saving photos to Firebase…';

        /* ─── STEP 3: Save each photo to Firebase /albumPhotos/ ─── */
        // Re-verify auth is still valid before touching Firestore.
        // Firebase can silently lose the session; catching it here gives a
        // clear message instead of a raw "permission-denied" error.
        currentUser = liveUser();
        if (!currentUser || currentUser.uid !== ownerUid) {
            statusEl.style.color = '#ff5577';
            statusEl.textContent = '❌ Your login session changed — please log in again and retry.';
            toast('❌ Session error — please log in again.');
            submitBtn.disabled = false;
            return;
        }

        const now      = Date.now();
        const albumId  = ownerUid + '_album';
        const photoIds = [];

        for (const url of uploadedUrls) {
            let docRef;
            try {
                docRef = await addDoc(collection(db, 'albumPhotos'), {
                    ownerUid,             // must equal request.auth.uid per Firestore rule
                    url,
                    type:        'album', // Step 5: album uploads are type 'album'
                    caption,
                    privacy,
                    uploadedAt:  now,
                    albumId,
                    feedPostId:  null,
                    savedToWall: saveToWall
                });
            } catch (e) {
                // ── STEP 15: Firebase save failed — do NOT show success ──
                statusEl.style.color = '#ff5577';
                const isDenied = e.code === 'permission-denied' || (e.message || '').includes('permission');
                statusEl.textContent = isDenied
                    ? '❌ Permission denied — make sure you are logged in with your account and try again.'
                    : `❌ Could not save photo to Firebase: ${e.message}`;
                toast(isDenied ? '❌ Permission denied. Please log out, log back in, and retry.' : '❌ Firebase save failed — photo not recorded.');
                submitBtn.disabled = false;
                return;
            }
            photoIds.push({ id: docRef.id, url });
        }

        progressBr.style.width = '80%';
        statusEl.textContent = 'Creating feed posts…';

        /* ─── STEP 8: Create feed post for each photo (48-hr TTL) ─ */
        const userData = window._snxUserData || {};
        for (const { id: photoId, url } of photoIds) {
            try {
                const expiresAt = now + 48 * 60 * 60 * 1000;
                const postRef = await addDoc(collection(db, 'posts'), {
                    uid:             ownerUid,   // use the captured ownerUid, not currentUser.uid
                    authorName:      userData.displayName || '',
                    authorHandle:    userData.username    || '',
                    authorAvatar:    userData.avatar      || '',
                    authorBadges:    userData.badges      || [],
                    authorRole:      userData.role        || 'member',
                    authorMoodType:  userData.profileCustom?.moodType  || '',
                    authorMoodValue: userData.profileCustom?.moodValue || '',
                    text:            caption ? `📸 ${caption}` : '📸 Added a photo to their album',
                    mediaUrl:        url,
                    mediaUrls:       [url],
                    albumPhotoId:    photoId,
                    isAlbumPost:     true,
                    savedToWall:     saveToWall,
                    timestamp:       now,
                    createdAt:       now,
                    expiresAt,           // ── Step 9: feed post auto-expires after 48 h ──
                    likes:           0,
                    likedBy:         [],
                    comments:        [],
                    repostCount:     0,
                    taggedUsers:     []
                });
                // Link the albumPhoto back to its feed post
                await updateDoc(doc(db, 'albumPhotos', photoId), { feedPostId: postRef.id });

                /* ─── STEP 10: Profile Wall (permanent copy) ─────── */
                if (saveToWall) {
                    try {
                        await setDoc(
                            doc(db, 'users', ownerUid, 'profileWall', postRef.id),
                            {
                                postId:       postRef.id,
                                uid:          ownerUid,
                                authorName:   userData.displayName || '',
                                authorHandle: userData.username    || '',
                                authorAvatar: userData.avatar      || '',
                                authorBadges: userData.badges      || [],
                                authorRole:   userData.role        || 'member',
                                text:         caption ? `📸 ${caption}` : '📸 Added a photo to their album',
                                mediaUrl:     url,
                                mediaUrls:    [url],
                                albumPhotoId: photoId,
                                isAlbumPost:  true,
                                savedAt:      now,
                                createdAt:    now
                            }
                        );
                    } catch (we) {
                        console.warn('[Album] profileWall mirror failed:', we);
                    }
                }
            } catch (e) {
                console.warn('[Album] Feed post creation failed (non-fatal):', e);
                // Non-fatal — the photo is already saved; feed post failure is acceptable.
            }
        }

        progressBr.style.width = '100%';

        /* ─── STEP 4: Refresh album grid immediately ─────────────── */
        // Optimistically prepend new photos to _allPhotos so the grid
        // updates without waiting for a full Firestore re-read.
        const newEntries = photoIds.map(({ id, url }) => ({
            id,
            ownerUid,
            url,
            type:       'album',
            caption,
            privacy,
            uploadedAt: now,
            albumId,
            feedPostId: null,
            savedToWall: saveToWall
        }));
        _allPhotos = [...newEntries, ..._allPhotos];

        const grid = document.getElementById('snxAlbumGrid');
        renderGrid(
            _activeFilter === 'all' ? _allPhotos : _allPhotos.filter(p => p.type === _activeFilter),
            grid
        );

        /* ─── STEP 15: Only NOW show success ─────────────────────── */
        statusEl.style.color = '#39FF14';
        statusEl.textContent = `✅ ${uploadedUrls.length} photo${uploadedUrls.length > 1 ? 's' : ''} uploaded successfully!`;
        toast(`📸 ${uploadedUrls.length} photo${uploadedUrls.length > 1 ? 's' : ''} saved to your album!`);

        // Update Photos stat counter on profile header immediately
        _updatePhotoCountStat();

        setTimeout(() => {
            closeUploadModal();
            // Full Firestore reload to confirm persisted data
            if (_albumOwnerUid) loadAlbumTab(_albumOwnerUid);
        }, 1200);
    }

    /* ── R2 upload helper — XHR with real progress ─────────────── */
    function uploadFileToR2(file, onProgress) {
        const R2_URL = 'https://yellow-term-11e6.nthntjrn.workers.dev';
        // Always use the live UID so the Cloudflare worker receives the correct owner.
        const uid    = (liveUser() || currentUser)?.uid || 'guest';
        const MAX_RETRIES = 3;

        function attempt(retryNum) {
            return new Promise((resolve, reject) => {
                const fd = new FormData();
                fd.append('file', file);
                fd.append('uid',  uid);

                const xhr = new XMLHttpRequest();
                xhr.open('POST', R2_URL);

                // Real upload progress
                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable && typeof onProgress === 'function') {
                        onProgress(Math.round((e.loaded / e.total) * 100));
                    }
                };

                xhr.onload = () => {
                    if (xhr.status === 200) {
                        try {
                            const res = JSON.parse(xhr.responseText);
                            if (res.url) {
                                if (typeof onProgress === 'function') onProgress(100);
                                resolve(res.url);
                            } else {
                                reject(new Error(res.error || 'Cloudflare returned no URL'));
                            }
                        } catch (_) {
                            reject(new Error('Invalid response from Cloudflare'));
                        }
                    } else {
                        let msg = `HTTP ${xhr.status}`;
                        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (_) {}
                        reject(new Error(msg));
                    }
                };

                xhr.onerror = () => {
                    if (retryNum < MAX_RETRIES) {
                        const delay = Math.pow(2, retryNum - 1) * 1000;
                        setTimeout(() => attempt(retryNum + 1).then(resolve).catch(reject), delay);
                    } else {
                        reject(new Error('Network error — check your connection'));
                    }
                };

                xhr.send(fd);
            });
        }

        return attempt(1);
    }

    /* ═══════════════════════════════════════════════════════════
       PHOTO VIEWER  (Steps 12 + 14)
       ═══════════════════════════════════════════════════════════ */
    function openViewer(idx, photos) {
        const photoList = photos || (
            _activeFilter === 'all' ? _allPhotos : _allPhotos.filter(p => p.type === _activeFilter)
        );
        _viewerPhotos = photoList;
        _viewerIdx    = Math.max(0, Math.min(idx, photoList.length - 1));

        const viewer = document.getElementById('snxAlbumViewer');
        if (!viewer) return;

        const ssBar = document.getElementById('snxAvSlideshowBar');
        if (ssBar) ssBar.style.display = 'flex';

        viewer.classList.add('open');
        document.body.style.overflow = 'hidden';
        renderViewerPhoto();
    }

    function closeViewer() {
        stopSlideshow();
        const viewer = document.getElementById('snxAlbumViewer');
        if (viewer) viewer.classList.remove('open');
        document.body.style.overflow = '';
        const img = document.getElementById('snxAvImg');
        if (img) img.style.transform = '';
    }

    function renderViewerPhoto() {
        const photo = _viewerPhotos[_viewerIdx];
        if (!photo) return;

        const img         = document.getElementById('snxAvImg');
        const counter     = document.getElementById('snxAvCounter');
        const captionEl   = document.getElementById('snxAvCaption');
        const dateEl      = document.getElementById('snxAvDate');
        const ownerActs   = document.getElementById('snxAvOwnerActions');
        const progressBar = document.getElementById('snxAvProgressBar');

        if (img)     { img.src = photo.url; img.style.transform = ''; }
        if (counter) counter.textContent = `${_viewerIdx + 1} of ${_viewerPhotos.length}`;
        if (captionEl) captionEl.textContent = photo.caption || '';
        if (dateEl && photo.uploadedAt) {
            const d = new Date(photo.uploadedAt);
            dateEl.textContent = d.toLocaleDateString('en-GB', {
                day: 'numeric', month: 'long', year: 'numeric'
            });
        }
        if (ownerActs) {
            const isSelf = currentUser && currentUser.uid === (photo.ownerUid || _albumOwnerUid);
            ownerActs.style.display = isSelf ? 'flex' : 'none';
        }
        // Progress bar for slideshow
        if (progressBar) {
            progressBar.style.transition = 'none';
            progressBar.style.width = '0%';
            if (_slideshowActive) {
                requestAnimationFrame(() => {
                    progressBar.style.transition = 'width 5s linear';
                    progressBar.style.width = '100%';
                });
            }
        }
        // Hide caption editor + comment panel when navigating
        const editPanel = document.getElementById('snxAvCaptionEdit');
        if (editPanel) editPanel.classList.remove('visible');
        const commPanel = document.getElementById('snxAvCommentPanel');
        if (commPanel) commPanel.style.display = 'none';

        // Load social data (likes + comments) for the newly shown photo
        _loadPhotoSocialData(photo.id);
    }

    function viewerNav(dir) {
        if (!_viewerPhotos.length) return;
        _viewerIdx = (_viewerIdx + dir + _viewerPhotos.length) % _viewerPhotos.length;
        renderViewerPhoto();
        if (_slideshowActive) resetSlideshowTimer();
    }

    /* ── Caption editing  (Step 11) ────────────────────────────── */
    function openCaptionEdit() {
        const photo = _viewerPhotos[_viewerIdx];
        if (!photo) return;
        const panel = document.getElementById('snxAvCaptionEdit');
        const input = document.getElementById('snxAvCaptionInput');
        if (!panel || !input) return;
        input.value = photo.caption || '';
        panel.classList.add('visible');
        input.focus();
    }

    function cancelCaptionEdit() {
        const panel = document.getElementById('snxAvCaptionEdit');
        if (panel) panel.classList.remove('visible');
    }

    async function saveCaptionEdit() {
        const photo = _viewerPhotos[_viewerIdx];
        if (!photo) return;
        const input = document.getElementById('snxAvCaptionInput');
        const newCaption = (input?.value || '').trim().substring(0, 200);
        try {
            await updateDoc(doc(db, 'albumPhotos', photo.id), { caption: newCaption });
            photo.caption = newCaption;
            const p2 = _allPhotos.find(p => p.id === photo.id);
            if (p2) p2.caption = newCaption;
            const captionEl = document.getElementById('snxAvCaption');
            if (captionEl) captionEl.textContent = newCaption;
            cancelCaptionEdit();
            toast('✅ Caption saved!');
        } catch (e) {
            toast('Failed to save caption: ' + e.message);
        }
    }

    /* ── Set as profile pic  (Step 11) ─────────────────────────── */
    async function setAsProfilePic() {
        const photo = _viewerPhotos[_viewerIdx];
        const user = liveUser();
        if (!photo || !user) return;
        try {
            await updateDoc(doc(db, 'users', user.uid), { avatar: photo.url });
            if (window._snxUserData) window._snxUserData.avatar = photo.url;
            await ensureAlbumEntry(photo.url, 'profile', photo.caption || '');
            toast('✅ Profile picture updated!');
        } catch (e) {
            toast('Failed: ' + e.message);
        }
    }

    /* ── Set as cover photo  (Step 11) ─────────────────────────── */
    async function setAsCoverPhoto() {
        const photo = _viewerPhotos[_viewerIdx];
        const user = liveUser();
        if (!photo || !user) return;
        try {
            await updateDoc(doc(db, 'users', user.uid), { banner: photo.url });
            if (window._snxUserData) window._snxUserData.banner = photo.url;
            await ensureAlbumEntry(photo.url, 'cover', photo.caption || '');
            toast('✅ Cover photo updated!');
        } catch (e) {
            toast('Failed: ' + e.message);
        }
    }

    /* ── Delete photo  (Step 11 — owner only) ──────────────────── */
    async function deletePhoto(photoId) {
        if (!liveUser()) return;
        if (!confirm('Delete this photo from your album? This cannot be undone.')) return;

        try {
            const photoRef = doc(db, 'albumPhotos', photoId);
            const snap     = await getDoc(photoRef);
            if (!snap.exists()) return;
            const data = snap.data();
            if (data.ownerUid !== liveUser()?.uid) { toast('Not your photo.'); return; }

            await deleteDoc(photoRef);

            // Also delete the associated feed post (non-fatal)
            if (data.feedPostId) {
                try { await deleteDoc(doc(db, 'posts', data.feedPostId)); } catch (_) {}
            }

            // Remove from local state
            _allPhotos    = _allPhotos.filter(p => p.id !== photoId);
            _viewerPhotos = _viewerPhotos.filter(p => p.id !== photoId);

            toast('🗑 Photo deleted.');
            renderGrid(
                _activeFilter === 'all' ? _allPhotos : _allPhotos.filter(p => p.type === _activeFilter),
                document.getElementById('snxAlbumGrid')
            );
            // Update photo count stat on profile header
            _updatePhotoCountStat();
        } catch (e) {
            toast('Delete failed: ' + e.message);
        }
    }

    async function deleteCurrentPhoto() {
        const photo = _viewerPhotos[_viewerIdx];
        if (!photo) return;
        closeViewer();
        await deletePhoto(photo.id);
    }

    /* ═══════════════════════════════════════════════════════════
       PHOTO SOCIAL FEATURES — Like, Comment, Share, Report
       ═══════════════════════════════════════════════════════════ */

    /* ── Load like/comment counts for the current photo ─────── */
    async function _loadPhotoSocialData(photoId) {
        if (!photoId) return;
        const likeCountEl    = document.getElementById('snxAvLikeCount');
        const likeBtn        = document.getElementById('snxAvLikeBtn');
        const commentCountEl = document.getElementById('snxAvCommentCount');

        // Likes — stored as a field on the albumPhoto doc for speed
        try {
            const snap = await getDoc(doc(db, 'albumPhotos', photoId));
            if (!snap.exists()) return;
            const d = snap.data();
            const likes   = d.likeCount || 0;
            const likedBy = d.likedBy   || [];
            if (likeCountEl) likeCountEl.textContent = likes;
            if (likeBtn) {
                const myUid  = liveUser()?.uid;
                const liked  = myUid && likedBy.includes(myUid);
                likeBtn.classList.toggle('liked', !!liked);
            }
            // Comment count from sub-collection length (cached on doc)
            if (commentCountEl) commentCountEl.textContent = d.commentCount || 0;
        } catch (_) {}
    }

    /* ── Toggle like on current photo ──────────────────────── */
    async function togglePhotoLike() {
        const photo = _viewerPhotos[_viewerIdx];
        const user  = liveUser();
        if (!photo || !user) { toast('Sign in to like photos.'); return; }

        const photoRef  = doc(db, 'albumPhotos', photo.id);
        const likeBtn   = document.getElementById('snxAvLikeBtn');
        const myUid     = user.uid;
        const isNowLiked = likeBtn && !likeBtn.classList.contains('liked');

        try {
            if (isNowLiked) {
                await updateDoc(photoRef, {
                    likeCount: increment(1),
                    likedBy:   arrayUnion(myUid),
                });
            } else {
                await updateDoc(photoRef, {
                    likeCount: increment(-1),
                    likedBy:   arrayRemove(myUid),
                });
            }
            if (likeBtn) likeBtn.classList.toggle('liked', isNowLiked);
            const likeCountEl = document.getElementById('snxAvLikeCount');
            if (likeCountEl) {
                likeCountEl.textContent = Math.max(0, parseInt(likeCountEl.textContent || '0') + (isNowLiked ? 1 : -1));
            }
        } catch (e) {
            toast('Could not update like: ' + e.message);
        }
    }

    /* ── Toggle comment panel visibility ───────────────────── */
    async function toggleCommentPanel() {
        const panel = document.getElementById('snxAvCommentPanel');
        if (!panel) return;
        const isOpen = panel.style.display === 'block';
        panel.style.display = isOpen ? 'none' : 'block';
        if (!isOpen) {
            const photo = _viewerPhotos[_viewerIdx];
            if (photo) await _loadPhotoComments(photo.id);
        }
    }

    /* ── Load comments for a photo ─────────────────────────── */
    async function _loadPhotoComments(photoId) {
        const list = document.getElementById('snxAvCommentList');
        if (!list) return;
        list.innerHTML = '<div style="color:#4a7a9a;font-size:12px;padding:6px 0;">Loading…</div>';
        try {
            const q    = query(
                collection(db, 'albumPhotos', photoId, 'comments'),
                orderBy('createdAt', 'asc')
            );
            const snap = await getDocs(q);
            if (snap.empty) {
                list.innerHTML = '<div style="color:#4a7a9a;font-size:12px;padding:6px 0;">No comments yet. Be the first!</div>';
                return;
            }
            list.innerHTML = '';
            snap.forEach(d => {
                const c  = d.data();
                const el = document.createElement('div');
                el.className = 'snx-av-comment-item';
                const ts = c.createdAt ? new Date(c.createdAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' }) : '';
                el.innerHTML = `
                    <span class="snx-av-comment-author">${esc(c.authorName || 'Guest')}</span>
                    <span class="snx-av-comment-text">${esc(c.text)}</span>
                    <span class="snx-av-comment-ts">${ts}</span>`;
                list.appendChild(el);
            });
            list.scrollTop = list.scrollHeight;
        } catch (e) {
            list.innerHTML = `<div style="color:#ff5577;font-size:12px;">${esc(e.message)}</div>`;
        }
    }

    /* ── Submit a comment on the current photo ─────────────── */
    async function submitPhotoComment() {
        const photo = _viewerPhotos[_viewerIdx];
        const user  = liveUser();
        if (!photo || !user) { toast('Sign in to comment.'); return; }

        const input = document.getElementById('snxAvCommentInput');
        const text  = (input?.value || '').trim();
        if (!text) return;

        const userData = window._snxUserData || {};
        try {
            await addDoc(collection(db, 'albumPhotos', photo.id, 'comments'), {
                authorUid:  user.uid,
                authorName: userData.displayName || user.email?.split('@')[0] || 'Guest',
                text,
                createdAt:  Date.now(),
            });
            // Increment comment count on the photo doc
            await updateDoc(doc(db, 'albumPhotos', photo.id), {
                commentCount: increment(1),
            });
            if (input) input.value = '';
            const countEl = document.getElementById('snxAvCommentCount');
            if (countEl) countEl.textContent = parseInt(countEl.textContent || '0') + 1;
            // Reload comments list
            await _loadPhotoComments(photo.id);
        } catch (e) {
            toast('Could not post comment: ' + e.message);
        }
    }

    /* ── Share the current photo ────────────────────────────── */
    function shareCurrentPhoto() {
        const photo = _viewerPhotos[_viewerIdx];
        if (!photo) return;
        const url   = photo.url;
        const title = photo.caption || 'Check out this photo on Shadow Nexus!';
        if (navigator.share) {
            navigator.share({ title, url }).catch(() => {});
        } else if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.writeText(url)
                .then(() => toast('📋 Photo link copied!'))
                .catch(() => window.prompt('Copy photo link:', url));
        } else {
            window.prompt('Copy photo link:', url);
        }
    }

    /* ── Report the current photo ───────────────────────────── */
    async function reportCurrentPhoto() {
        const photo = _viewerPhotos[_viewerIdx];
        const user  = liveUser();
        if (!photo || !user) return;

        if (!confirm('Report this photo as inappropriate? This will be reviewed by moderators.')) return;

        const userData = window._snxUserData || {};
        try {
            await addDoc(collection(db, 'reports'), {
                type:        'albumPhoto',
                targetId:    photo.id,
                targetUrl:   photo.url,
                ownerUid:    photo.ownerUid || _albumOwnerUid,
                reportedBy:  user.uid,
                reporterName: userData.displayName || '',
                reason:      'Inappropriate content',
                status:      'pending',
                createdAt:   Date.now(),
            });
            toast('🚩 Report submitted. Thank you.');
        } catch (e) {
            toast('Could not submit report: ' + e.message);
        }
    }

    /* ── Update the Photos count stat on the profile header ── */
    function _updatePhotoCountStat() {
        const el = document.getElementById('cntPhotos');
        if (!el || !_albumOwnerUid) return;
        getDocs(query(collection(db, 'albumPhotos'), where('ownerUid', '==', _albumOwnerUid)))
            .then(s => { el.textContent = s.size; })
            .catch(() => {});
    }

    /* ═══════════════════════════════════════════════════════════
       SLIDESHOW  (Step 12)
       ═══════════════════════════════════════════════════════════ */
    function startSlideshow() {
        const photos = _activeFilter === 'all'
            ? _allPhotos
            : _allPhotos.filter(p => p.type === _activeFilter);
        if (!photos.length) { toast('No photos to display.'); return; }
        openViewer(0, photos);
        _slideshowActive = true;
        updateSlideshowUI();
        resetSlideshowTimer();
    }

    function toggleSlideshow() {
        if (_slideshowActive) {
            stopSlideshow();
        } else {
            _slideshowActive = true;
            updateSlideshowUI();
            resetSlideshowTimer();
        }
    }

    function stopSlideshow() {
        _slideshowActive = false;
        if (_slideshowTimer) { clearTimeout(_slideshowTimer); _slideshowTimer = null; }
        updateSlideshowUI();
        const pb = document.getElementById('snxAvProgressBar');
        if (pb) { pb.style.transition = 'none'; pb.style.width = '0%'; }
    }

    function resetSlideshowTimer() {
        if (_slideshowTimer) clearTimeout(_slideshowTimer);
        if (!_slideshowActive) return;
        _slideshowTimer = setTimeout(() => { viewerNav(1); }, 5000);
    }

    function updateSlideshowUI() {
        const btn = document.getElementById('snxAvSlideshowToggle');
        if (btn) {
            btn.textContent = _slideshowActive ? '⏸ Pause' : '▶ Play';
            btn.classList.toggle('active', _slideshowActive);
        }
        // Restart or cancel the progress bar animation
        renderViewerPhoto();
    }

    /* ═══════════════════════════════════════════════════════════
       ALBUM PRIVACY PICKER  (Step 13)
       ═══════════════════════════════════════════════════════════ */
    function openAlbumPrivacyPicker() {
        const _cu = liveUser();
        if (!_cu || !_albumOwnerUid || _cu.uid !== _albumOwnerUid) return;
        const opts = [
            { val: 'public',    label: '🌐 Public — everyone can see' },
            { val: 'followers', label: '👥 Followers Only' },
            { val: 'friends',   label: '🦋 Friends Only' },
            { val: 'private',   label: '🔒 Private — only you' }
        ];
        const menu = document.createElement('div');
        menu.style.cssText = `
            position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
            background:#060d1e;border:1px solid rgba(0,140,255,0.45);border-radius:14px;
            padding:16px;z-index:10000;min-width:240px;
            box-shadow:0 0 40px rgba(0,80,200,0.3);`;
        menu.innerHTML =
            `<div style="font-size:13px;font-weight:700;color:#00AEEF;margin-bottom:10px;">🔒 Album Privacy</div>` +
            opts.map(o => `
                <button onclick="window.snxAlbum._setAlbumPrivacy('${o.val}',this.closest('div[style]'))"
                    style="display:block;width:100%;padding:9px 12px;margin-bottom:5px;border-radius:8px;
                           border:1px solid rgba(0,174,239,0.3);background:rgba(0,20,50,0.7);
                           color:#b8d4f0;font-size:12px;cursor:pointer;text-align:left;font-family:inherit;">
                    ${o.label}</button>`).join('') +
            `<button onclick="this.closest('div[style]').remove()"
                style="display:block;width:100%;padding:7px;border-radius:8px;
                       border:1px solid rgba(255,255,255,0.1);background:transparent;
                       color:#6a90b8;font-size:12px;cursor:pointer;font-family:inherit;">
                Cancel</button>`;
        document.body.appendChild(menu);
    }

    async function _setAlbumPrivacy(val, menuEl) {
        if (menuEl) menuEl.remove();
        const user = liveUser();
        if (!user) return;
        const privLabels = {
            public: '🌐 Public', followers: '👥 Followers',
            friends: '🦋 Friends', private: '🔒 Private'
        };
        try {
            await updateDoc(doc(db, 'users', user.uid), { albumPrivacy: val });

            // Also bulk-update all this user's albumPhoto privacy fields
            const q    = query(collection(db, 'albumPhotos'), where('ownerUid', '==', user.uid));
            const snap = await getDocs(q);
            const updates = [];
            snap.forEach(d => updates.push(updateDoc(d.ref, { privacy: val })));
            await Promise.all(updates);

            const badge = document.getElementById('snxAlbumPrivacyBadge');
            if (badge) badge.textContent = privLabels[val] || '🌐 Public';
            _allPhotos.forEach(p => p.privacy = val);
            toast('🔒 Album privacy updated!');
        } catch (e) {
            toast('Failed: ' + e.message);
        }
    }

    /* ═══════════════════════════════════════════════════════════
       UTILITIES
       ═══════════════════════════════════════════════════════════ */
    function toast(msg) {
        if (typeof window.toastNotification === 'function') {
            window.toastNotification(msg);
        } else {
            console.log('[Album Toast]', msg);
        }
    }

    function esc(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /* ═══════════════════════════════════════════════════════════
       PUBLIC API
       ═══════════════════════════════════════════════════════════ */
    function exposePublicAPI() {
        window.snxAlbum = {
            loadAlbumTab,
            openUploadModal,
            closeUploadModal,
            submitUpload,
            filterAlbum,
            openViewer,
            closeViewer,
            viewerNav,
            openCaptionEdit,
            cancelCaptionEdit,
            saveCaptionEdit,
            setAsProfilePic,
            setAsCoverPhoto,
            deletePhoto,
            deleteCurrentPhoto,
            startSlideshow,
            toggleSlideshow,
            stopSlideshow,
            openAlbumPrivacyPicker,
            ensureAlbumEntry,
            // Social features
            togglePhotoLike,
            toggleCommentPanel,
            submitPhotoComment,
            shareCurrentPhoto,
            reportCurrentPhoto,
            // Internal helpers exposed for HTML onclick usage
            _handleFileSelect,
            _handleDrop,
            _setAlbumPrivacy,
        };
    }

})();
