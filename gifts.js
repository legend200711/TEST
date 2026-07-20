/**
 * Shadow Nexus — Gift & Coin System (gifts.js)
 * ─────────────────────────────────────────────────────────────────────────────
 * Firebase Firestore collections used:
 *
 *   /userCoins/{uid}            — coin balance per user
 *   /giftTransactions/{txId}    — gift send records (immutable)
 *   /coinPurchases/{txId}       — coin purchase records (PayPal)
 *   /creatorEarnings/{uid}      — aggregated creator earnings
 *   /payoutRequests/{requestId} — creator cash-out requests (Cloud Function)
 *
 * Payment flow (real PayPal):
 *   1. Client calls Cloud Function createPayPalOrder → gets orderId
 *   2. PayPal JS SDK renders a button; user approves
 *   3. Client calls Cloud Function capturePayPalOrder → coins credited
 *
 * Payout flow:
 *   Creator enters PayPal email + amount → calls Cloud Function requestPayout
 *   → Cloud Function sends PayPal Payout → earnings decremented
 *
 * 90/10 split: creator 90%, platform 10% — enforced in both client + Cloud Function.
 */

'use strict';

/* ── Firebase imports ── */
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc, getDoc, setDoc, updateDoc, addDoc,
  collection, query, orderBy, limit, onSnapshot,
  serverTimestamp, increment, where, getDocs,
  runTransaction
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import {
  getFunctions, httpsCallable
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';

/* ── Firebase config ── */
const _CFG = {
  apiKey:            'AIzaSyByZRmp6R9HY17T2_WdJUFWeeaLNOP6y2Y',
  authDomain:        'horr-a08f4.firebaseapp.com',
  databaseURL:       'https://horr-a08f4-default-rtdb.firebaseio.com',
  projectId:         'horr-a08f4',
  storageBucket:     'horr-a08f4.firebasestorage.app',
  messagingSenderId: '933810617818',
  appId:             '1:933810617818:web:efb24f123337dd987c14e3',
};

const _giftApp  = getApps().find(a => a.name === '[DEFAULT]') || initializeApp(_CFG);
const _giftAuth = getAuth(_giftApp);
const _giftDb   = getFirestore(_giftApp);
const _giftFns  = getFunctions(_giftApp);

/* ── Cloud Function callables ── */
const _fnCreateOrder  = httpsCallable(_giftFns, 'createPayPalOrder');
const _fnCaptureOrder = httpsCallable(_giftFns, 'capturePayPalOrder');
const _fnRequestPayout = httpsCallable(_giftFns, 'requestPayout');

/* ── PayPal Sandbox Client ID ── */
// Replace with your real PayPal Client ID from developer.paypal.com
// Sandbox: use for testing with anthonytijerinachris@gmail.com
// ⚠️  REPLACE THIS VALUE before going live — do not ship the placeholder.
const PAYPAL_CLIENT_ID = 'YOUR_PAYPAL_SANDBOX_CLIENT_ID';
// Set to false when you go live with a real PayPal Business account
const PAYPAL_SANDBOX = true;

/* Internal flag so SDK load failures don't hang retry calls */
let _paypalLoadFailed = false;

/* ─────────────────────────────────────────────
   GIFT CATALOGUE
   ───────────────────────────────────────────── */
export const GIFTS = [
  {
    id:        'heart',
    name:      'Heart',
    emoji:     '❤️',
    coins:     5,
    color:     '#ff4466',
    animClass: 'gift-anim-heart',
  },
  {
    id:        'blue_flame',
    name:      'Blue Flame',
    emoji:     '🔥',
    coins:     20,
    color:     '#00aaff',
    animClass: 'gift-anim-flame',
  },
  {
    id:        'shadow_wolf',
    name:      'Shadow Wolf',
    emoji:     '🐺',
    coins:     100,
    color:     '#8855ff',
    animClass: 'gift-anim-wolf',
  },
  {
    id:        'grim_reaper',
    name:      'Grim Reaper',
    emoji:     '💀',
    coins:     500,
    color:     '#aaaaaa',
    animClass: 'gift-anim-reaper',
  },
  {
    id:        'black_rose',
    name:      'Black Rose',
    emoji:     '🖤',
    coins:     1000,
    color:     '#cc44aa',
    animClass: 'gift-anim-rose',
  },
];

/* ── Coin packages (must match Cloud Function COIN_PACKAGES) ── */
export const COIN_PACKAGES = [
  { id: 'coins_100',  coins: 100,  price: 0.99,  label: '100 Coins',   badge: '' },
  { id: 'coins_500',  coins: 500,  price: 3.99,  label: '500 Coins',   badge: 'Popular' },
  { id: 'coins_1000', coins: 1000, price: 6.99,  label: '1,000 Coins', badge: 'Best Value' },
  { id: 'coins_5000', coins: 5000, price: 29.99, label: '5,000 Coins', badge: '' },
];

export const CREATOR_SPLIT  = 0.90;
export const PLATFORM_SPLIT = 0.10;
const COIN_VALUE_USD = 0.01;   // 1 coin = $0.01 when cashing out
const PAYOUT_MIN_COINS = 500;  // minimum $5.00 to cash out

/* ── State ── */
let _currentUser     = null;
let _coinBalance     = 0;
let _balanceUnsub    = null;
let _liveRoomId      = null;
let _creatorUid      = null;
let _creatorName     = '';
let _onBalanceChange = null;
let _onGiftReceived  = null;
let _paypalLoaded    = false;
let _paypalLoading   = false;

/* ─────────────────────────────────────────────
   INIT — call once after auth resolves
   ───────────────────────────────────────────── */
export function giftSystemInit(opts = {}) {
  _liveRoomId      = opts.liveRoomId      || null;
  _creatorUid      = opts.creatorUid      || null;
  _creatorName     = opts.creatorName     || '';
  _onBalanceChange = opts.onBalanceChange || null;
  _onGiftReceived  = opts.onGiftReceived  || null;

  onAuthStateChanged(_giftAuth, user => {
    _currentUser = user;
    if (user) {
      _subscribeBalance(user.uid);
    } else {
      _coinBalance = 0;
    }
  });
}

/* ── Balance listener ── */
function _subscribeBalance(uid) {
  if (_balanceUnsub) { _balanceUnsub(); _balanceUnsub = null; }
  _balanceUnsub = onSnapshot(doc(_giftDb, 'userCoins', uid), snap => {
    _coinBalance = snap.exists() ? (snap.data().coins || 0) : 0;
    _renderBalance();
    if (_onBalanceChange) _onBalanceChange(_coinBalance);
  });
}

export function getCoinBalance() { return _coinBalance; }

/* ─────────────────────────────────────────────
   SEND GIFT
   ───────────────────────────────────────────── */
export async function sendGift(giftId) {
  if (!_currentUser)              { _toast('Please sign in to send gifts.'); return; }
  if (_currentUser.isAnonymous)   { _toast('Sign in to send gifts.'); return; }

  const gift = GIFTS.find(g => g.id === giftId);
  if (!gift) return;

  if (_coinBalance < gift.coins) {
    _toast(`You need ${gift.coins} coins. Buy more Shadow Coins!`);
    openBuyCoinsPanel();
    return;
  }
  if (!_creatorUid) { _toast('Cannot identify stream host.'); return; }
  if (!_liveRoomId) { _toast('Not in a live room.'); return; }

  const creatorEarnings = Math.floor(gift.coins * CREATOR_SPLIT);
  const platformFee     = gift.coins - creatorEarnings;

  try {
    await runTransaction(_giftDb, async tx => {
      const senderRef  = doc(_giftDb, 'userCoins', _currentUser.uid);
      const senderSnap = await tx.get(senderRef);
      const currentBal = senderSnap.exists() ? (senderSnap.data().coins || 0) : 0;
      if (currentBal < gift.coins) throw new Error('Insufficient coins');

      tx.update(senderRef, {
        coins:     increment(-gift.coins),
        updatedAt: serverTimestamp(),
      });

      const creatorRef = doc(_giftDb, 'creatorEarnings', _creatorUid);
      tx.set(creatorRef, {
        totalCoins:   increment(creatorEarnings),
        pendingCoins: increment(creatorEarnings),
        updatedAt:    serverTimestamp(),
      }, { merge: true });
    });

    await addDoc(collection(_giftDb, 'giftTransactions'), {
      senderId:       _currentUser.uid,
      senderName:     _currentUser.displayName || _currentUser.email?.split('@')[0] || 'User',
      receiverId:     _creatorUid,
      receiverName:   _creatorName,
      giftId:         gift.id,
      giftName:       gift.name,
      giftEmoji:      gift.emoji,
      coins:          gift.coins,
      creatorEarnings,
      platformFee,
      liveRoomId:     _liveRoomId,
      createdAt:      serverTimestamp(),
    });

    /* Write gift event to live chat so all viewers see it */
    await addDoc(collection(_giftDb, 'liveRooms', _liveRoomId, 'liveMessages'), {
      type:      'gift',
      userId:    _currentUser.uid,
      userName:  _currentUser.displayName || _currentUser.email?.split('@')[0] || 'User',
      giftId:    gift.id,
      giftName:  gift.name,
      giftEmoji: gift.emoji,
      giftCoins: gift.coins,
      createdAt: serverTimestamp(),
    });

    _closeGiftPanel();
    _showGiftAnimation(gift, _currentUser.displayName || 'User');

  } catch (err) {
    if (err.message === 'Insufficient coins') {
      _toast('Not enough coins. Buy more!');
      openBuyCoinsPanel();
    } else {
      _toast('Gift failed. Try again.');
      console.error('[gifts] sendGift error:', err);
    }
  }
}

/* ─────────────────────────────────────────────
   BUY COINS — PayPal real payment flow
   ───────────────────────────────────────────── */
export async function initiateCoinPurchase(packageId) {
  if (!_currentUser) { _toast('Please sign in to buy coins.'); return; }
  if (_currentUser.isAnonymous) { _toast('Sign in to buy coins.'); return; }

  // Catch unconfigured placeholder before hitting the network
  if (!PAYPAL_CLIENT_ID || PAYPAL_CLIENT_ID.startsWith('YOUR_')) {
    _toast('❌ Payment not configured. Contact support.');
    console.error('[gifts] PAYPAL_CLIENT_ID is still the placeholder value. Set a real Client ID in gifts.js.');
    return;
  }

  const pkg = COIN_PACKAGES.find(p => p.id === packageId);
  if (!pkg) return;

  /* 1. Create a pending Firestore purchase record */
  let purchaseRef;
  try {
    purchaseRef = await addDoc(collection(_giftDb, 'coinPurchases'), {
      uid:         _currentUser.uid,
      displayName: _currentUser.displayName || '',
      coins:       pkg.coins,
      amount:      Math.round(pkg.price * 100),
      packageId:   pkg.id,
      status:      'pending',
      createdAt:   serverTimestamp(),
    });
  } catch (e) {
    const code = e?.code || '';
    if (code === 'permission-denied') {
      _toast('❌ Permission denied creating purchase. Check Firestore rules.');
    } else {
      _toast('❌ Could not start purchase. Check your connection and try again.');
    }
    console.error('[gifts] coinPurchases addDoc error:', e);
    return;
  }

  /* 2. Ask Cloud Function to create a PayPal order */
  _toast('Opening PayPal…');
  try {
    const result = await _fnCreateOrder({
      packageId,
      purchaseDocId: purchaseRef.id,
    });
    const { orderId } = result.data;
    if (!orderId) throw new Error('No orderId returned from createPayPalOrder');

    /* 3. Open PayPal approval modal */
    _openPayPalApprovalModal(pkg, purchaseRef.id, orderId);
  } catch (err) {
    const code = err?.code || err?.details?.code || '';
    if (code === 'unauthenticated') {
      _toast('❌ Sign in required to buy coins.');
    } else if (code === 'permission-denied') {
      _toast('❌ Permission denied. Sign in with a non-anonymous account.');
    } else if (code === 'unavailable' || code === 'internal') {
      _toast('❌ Payment service unavailable. Try again in a moment.');
    } else {
      _toast('❌ PayPal setup failed. Check console for details.');
    }
    console.error('[gifts] createPayPalOrder error — code:', code, '| full:', err);
  }
}

/* ─────────────────────────────────────────────
   PAYPAL APPROVAL MODAL
   Loads the PayPal JS SDK and renders the button
   ───────────────────────────────────────────── */
function _openPayPalApprovalModal(pkg, purchaseDocId, orderId) {
  _closePayPalModal();

  const modal = document.createElement('div');
  modal.id = 'snxPayPalModal';
  modal.className = 'snx-modal-overlay';
  modal.innerHTML = `
    <div class="snx-modal-box">
      <div class="snx-modal-title">🪙 Complete Purchase</div>
      <div class="snx-modal-summary">
        <div class="snx-modal-row">
          <span>Package</span><strong>🪙 ${pkg.label}</strong>
        </div>
        <div class="snx-modal-row">
          <span>Amount</span><strong>$${pkg.price.toFixed(2)} USD</strong>
        </div>
        <div class="snx-modal-row">
          <span>Payment</span><strong>🅿️ PayPal</strong>
        </div>
      </div>
      <div id="snxPayPalBtnContainer" style="min-height:48px;display:flex;align-items:center;justify-content:center;">
        <div class="snx-paypal-loading">Loading PayPal…</div>
      </div>
      <div id="snxPayPalStatus" style="font-size:13px;text-align:center;color:#6a90b8;min-height:20px;"></div>
      <button class="snx-modal-cancel" id="snxPayPalCancel">Cancel</button>
      <p class="snx-modal-note" style="font-size:10px;color:#4a6a8a;text-align:center;line-height:1.5;">
        🔒 Payments secured by PayPal. Shadow Coins are non-refundable.
      </p>
    </div>
  `;

  document.body.appendChild(modal);
  modal.querySelector('#snxPayPalCancel').addEventListener('click', _closePayPalModal);

  /* Load PayPal SDK (once) and render button */
  _loadPayPalSDK().then(() => {
    const container = modal.querySelector('#snxPayPalBtnContainer');
    if (!container || !modal.isConnected) return;
    container.innerHTML = '';

    window.paypal.Buttons({
      style: {
        layout: 'vertical',
        color:  'blue',
        shape:  'rect',
        label:  'pay',
        height: 45,
      },
      /* Use the order already created by the Cloud Function */
      createOrder: () => orderId,

      onApprove: async (data) => {
        const statusEl = modal.querySelector('#snxPayPalStatus');
        if (statusEl) statusEl.textContent = 'Confirming payment…';
        try {
          const result = await _fnCaptureOrder({
            orderId:       data.orderID,
            purchaseDocId,
          });
          const { coins, already } = result.data;
          _closePayPalModal();
          _closeBuyCoinsPanel();
          _toast(`✅ +${coins.toLocaleString()} Shadow Coins added!`);
          if (already) _toast('Payment was already processed.');
        } catch (err) {
          if (statusEl) statusEl.textContent = '❌ Payment confirmation failed. Contact support.';
          console.error('[gifts] capturePayPalOrder error:', err);
        }
      },

      onError: (err) => {
        const statusEl = modal.querySelector('#snxPayPalStatus');
        if (statusEl) statusEl.textContent = '❌ PayPal error. Please try again.';
        console.error('[gifts] PayPal button error:', err);
      },

      onCancel: () => {
        _closePayPalModal();
        openBuyCoinsPanel();
      },
    }).render('#snxPayPalBtnContainer');

  }).catch((loadErr) => {
    console.error('[gifts] PayPal SDK load error:', loadErr?.message || loadErr);
    const container = modal.querySelector('#snxPayPalBtnContainer');
    if (container) container.innerHTML = '<span style="color:#ff8888;font-size:13px;">Failed to load PayPal. Check your internet connection and try again.</span>';
    _toast('❌ Could not load PayPal. Check your connection.');
  });
}

function _closePayPalModal() {
  const m = document.getElementById('snxPayPalModal');
  if (m) m.remove();
}

/* Load the PayPal JS SDK script once */
function _loadPayPalSDK() {
  if (_paypalLoaded) return Promise.resolve();
  // If a previous load attempt failed, reject immediately — don't hang.
  if (_paypalLoadFailed) return Promise.reject(new Error('PayPal SDK failed to load previously'));
  if (_paypalLoading) {
    // Poll until the in-flight load resolves or fails
    return new Promise((resolve, reject) => {
      const check = setInterval(() => {
        if (_paypalLoaded)      { clearInterval(check); resolve(); }
        else if (_paypalLoadFailed) { clearInterval(check); reject(new Error('PayPal SDK load failed')); }
      }, 100);
    });
  }
  _paypalLoading = true;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    const mode = PAYPAL_SANDBOX ? '&buyer-country=US' : '';
    s.src = `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=USD${mode}`;
    s.onload  = () => { _paypalLoaded = true;  _paypalLoading = false; resolve(); };
    s.onerror = () => { _paypalLoadFailed = true; _paypalLoading = false; reject(new Error('PayPal SDK load failed — check your PAYPAL_CLIENT_ID')); };
    document.head.appendChild(s);
  });
}

/* ─────────────────────────────────────────────
   CREATOR PAYOUT (Cash Out)
   ───────────────────────────────────────────── */
export async function requestCashOut(paypalEmail, amountCoins) {
  if (!_currentUser) { _toast('Sign in required.'); return false; }
  if (_currentUser.isAnonymous) { _toast('Sign in to cash out.'); return false; }

  if (!paypalEmail || !paypalEmail.includes('@')) {
    _toast('Enter a valid PayPal email.'); return false;
  }
  if (!amountCoins || amountCoins < PAYOUT_MIN_COINS) {
    _toast(`Minimum cash out is ${PAYOUT_MIN_COINS} coins ($${(PAYOUT_MIN_COINS * COIN_VALUE_USD).toFixed(2)}).`);
    return false;
  }

  const uid = _currentUser.uid;
  const earningsSnap = await getDoc(doc(_giftDb, 'creatorEarnings', uid)).catch(() => null);
  const pending = earningsSnap?.exists() ? (earningsSnap.data().pendingCoins || 0) : 0;

  if (amountCoins > pending) {
    _toast(`Not enough earnings. You have ${pending} coins available.`);
    return false;
  }

  try {
    const result = await _fnRequestPayout({ paypalEmail, amountCoins });
    const { amountUsd } = result.data;
    _toast(`✅ $${amountUsd} sent to ${paypalEmail}!`);
    return true;
  } catch (err) {
    _toast(err.message || 'Cash out failed. Try again.');
    console.error('[gifts] requestPayout error:', err);
    return false;
  }
}

/* ─────────────────────────────────────────────
   CREATOR DASHBOARD DATA
   ───────────────────────────────────────────── */
export async function getCreatorDashboard(uid) {
  uid = uid || (_currentUser ? _currentUser.uid : null);
  if (!uid) return null;

  const [earningsSnap, txSnap, payoutSnap] = await Promise.all([
    getDoc(doc(_giftDb, 'creatorEarnings', uid)),
    getDocs(query(
      collection(_giftDb, 'giftTransactions'),
      where('receiverId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(50)
    )),
    getDocs(query(
      collection(_giftDb, 'payoutRequests'),
      where('uid', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(10)
    )).catch(() => ({ docs: [] })),
  ]);

  const earnings     = earningsSnap.exists() ? earningsSnap.data() : { totalCoins: 0, pendingCoins: 0, withdrawnCoins: 0 };
  const transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const payouts      = payoutSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { earnings, transactions, payouts };
}

/* ─────────────────────────────────────────────
   RENDER BALANCE
   ───────────────────────────────────────────── */
function _renderBalance() {
  document.querySelectorAll('.snx-coin-balance-val').forEach(el => {
    el.textContent = _coinBalance.toLocaleString();
  });
}

/* ─────────────────────────────────────────────
   TOAST
   ───────────────────────────────────────────── */
let _toastTimer2 = null;
function _toast(msg) {
  let el = document.getElementById('liveToast') || document.getElementById('snxGiftToast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'snxGiftToast';
    el.style.cssText = [
      'position:fixed','bottom:80px','left:50%','transform:translateX(-50%)',
      'background:rgba(10,20,45,0.95)','color:#fff','padding:10px 20px',
      'border-radius:22px','font-size:13px','z-index:9999',
      'border:1px solid rgba(0,174,239,0.4)','pointer-events:none',
      'white-space:nowrap','max-width:90vw',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  if (_toastTimer2) clearTimeout(_toastTimer2);
  _toastTimer2 = setTimeout(() => { el.style.display = 'none'; }, 3200);
}

/* ─────────────────────────────────────────────
   GIFT ANIMATION
   ───────────────────────────────────────────── */
function _showGiftAnimation(gift, senderName) {
  const container = document.querySelector('.live-video-wrap') || document.body;
  const el = document.createElement('div');
  el.className = `snx-gift-burst ${gift.animClass}`;
  el.innerHTML = `
    <span class="snx-gift-burst-emoji">${gift.emoji}</span>
    <span class="snx-gift-burst-label">${senderName} sent ${gift.name}!</span>
  `;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3200);
  if (_onGiftReceived) _onGiftReceived({ gift, senderName });
}

export function renderGiftEvent(giftId, senderName) {
  const gift = GIFTS.find(g => g.id === giftId);
  if (!gift) return;
  _showGiftAnimation(gift, senderName);
}

/* ─────────────────────────────────────────────
   GIFT PANEL
   ───────────────────────────────────────────── */
export function openGiftPanel() {
  let panel = document.getElementById('snxGiftPanel');
  if (!panel) panel = _buildGiftPanel();
  panel.style.display = 'flex';
  panel.classList.add('snx-panel-open');
  _renderBalance();
}

function _closeGiftPanel() {
  const p = document.getElementById('snxGiftPanel');
  if (p) { p.style.display = 'none'; p.classList.remove('snx-panel-open'); }
}

function _buildGiftPanel() {
  const panel = document.createElement('div');
  panel.id = 'snxGiftPanel';
  panel.className = 'snx-bottom-panel';
  panel.innerHTML = `
    <div class="snx-panel-header">
      <span class="snx-panel-title">🎁 Send a Gift</span>
      <div class="snx-coin-balance-chip">
        <span class="snx-coin-icon">🪙</span>
        <span class="snx-coin-balance-val">${_coinBalance.toLocaleString()}</span>
        <button class="snx-buy-btn-inline" id="snxBuyInline">+</button>
      </div>
      <button class="snx-panel-close" id="snxGiftClose">✕</button>
    </div>
    <div class="snx-gift-grid">
      ${GIFTS.map(g => `
        <button class="snx-gift-item" data-gift="${g.id}" style="--gift-color:${g.color}">
          <span class="snx-gift-emoji">${g.emoji}</span>
          <span class="snx-gift-name">${g.name}</span>
          <span class="snx-gift-price">🪙 ${g.coins}</span>
        </button>
      `).join('')}
    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('#snxGiftClose').addEventListener('click', _closeGiftPanel);
  panel.querySelector('#snxBuyInline').addEventListener('click', () => { _closeGiftPanel(); openBuyCoinsPanel(); });
  panel.querySelectorAll('.snx-gift-item').forEach(btn => {
    btn.addEventListener('click', () => sendGift(btn.dataset.gift));
  });
  return panel;
}

/* ─────────────────────────────────────────────
   BUY COINS PANEL
   ───────────────────────────────────────────── */
export function openBuyCoinsPanel() {
  let panel = document.getElementById('snxBuyCoinsPanel');
  if (!panel) panel = _buildBuyCoinsPanel();
  panel.style.display = 'flex';
  panel.classList.add('snx-panel-open');
  _renderBalance();
}

function _closeBuyCoinsPanel() {
  const p = document.getElementById('snxBuyCoinsPanel');
  if (p) { p.style.display = 'none'; p.classList.remove('snx-panel-open'); }
}

function _buildBuyCoinsPanel() {
  const panel = document.createElement('div');
  panel.id = 'snxBuyCoinsPanel';
  panel.className = 'snx-bottom-panel';
  panel.innerHTML = `
    <div class="snx-panel-header">
      <span class="snx-panel-title">🪙 Buy Shadow Coins</span>
      <div class="snx-coin-balance-chip">
        <span class="snx-coin-icon">🪙</span>
        <span class="snx-coin-balance-val">${_coinBalance.toLocaleString()}</span>
      </div>
      <button class="snx-panel-close" id="snxBuyClose">✕</button>
    </div>
    <div class="snx-package-grid">
      ${COIN_PACKAGES.map(p => `
        <button class="snx-pkg-item${p.badge ? ' snx-pkg-badge' : ''}"
                data-pkg="${p.id}"
                ${p.badge ? `data-badge="${p.badge}"` : ''}>
          <span class="snx-pkg-coins">🪙 ${p.label}</span>
          <span class="snx-pkg-price">$${p.price.toFixed(2)}</span>
        </button>
      `).join('')}
    </div>
    <p class="snx-pay-note">Payments processed securely by PayPal. Shadow Coins are non-refundable.</p>
  `;
  document.body.appendChild(panel);
  panel.querySelector('#snxBuyClose').addEventListener('click', _closeBuyCoinsPanel);
  panel.querySelectorAll('.snx-pkg-item').forEach(btn => {
    btn.addEventListener('click', () => {
      _closeBuyCoinsPanel();
      initiateCoinPurchase(btn.dataset.pkg);
    });
  });
  return panel;
}

/* ─────────────────────────────────────────────
   CREATOR DASHBOARD PANEL
   ───────────────────────────────────────────── */
export async function openCreatorDashboard(uid) {
  let panel = document.getElementById('snxCreatorDash');
  if (panel) panel.remove();

  panel = document.createElement('div');
  panel.id = 'snxCreatorDash';
  panel.className = 'snx-modal-overlay';
  panel.innerHTML = `
    <div class="snx-modal-box" style="max-height:82vh;overflow-y:auto;">
      <div class="snx-modal-title">📊 Creator Dashboard</div>
      <div id="snxDashContent" style="padding:0 2px;">Loading…</div>
      <button class="snx-modal-cancel" id="snxDashClose" style="margin-top:12px;">Close</button>
    </div>
  `;
  document.body.appendChild(panel);
  panel.querySelector('#snxDashClose').addEventListener('click', () => panel.remove());

  const data = await getCreatorDashboard(uid);
  const content = panel.querySelector('#snxDashContent');
  if (!data) { content.textContent = 'No data found.'; return; }

  const { earnings, transactions, payouts } = data;
  const totalUsd    = ((earnings.totalCoins    || 0) * COIN_VALUE_USD).toFixed(2);
  const pendingUsd  = ((earnings.pendingCoins  || 0) * COIN_VALUE_USD).toFixed(2);
  const withdrawnUsd = ((earnings.withdrawnCoins || 0) * COIN_VALUE_USD).toFixed(2);
  const pendingCoins = earnings.pendingCoins || 0;

  content.innerHTML = `
    <div class="snx-dash-stats">
      <div class="snx-dash-stat">
        <span class="snx-dash-stat-val">🪙 ${(earnings.totalCoins || 0).toLocaleString()}</span>
        <span class="snx-dash-stat-lbl">Total Coins Received</span>
      </div>
      <div class="snx-dash-stat snx-dash-green">
        <span class="snx-dash-stat-val">$${pendingUsd}</span>
        <span class="snx-dash-stat-lbl">Available to Cash Out</span>
      </div>
      <div class="snx-dash-stat">
        <span class="snx-dash-stat-val">$${totalUsd}</span>
        <span class="snx-dash-stat-lbl">Lifetime Earnings</span>
      </div>
      <div class="snx-dash-stat">
        <span class="snx-dash-stat-val">$${withdrawnUsd}</span>
        <span class="snx-dash-stat-lbl">Withdrawn</span>
      </div>
    </div>

    <div class="snx-dash-split-note">
      💡 You receive <strong>90%</strong> of all gift values. Shadow Nexus keeps 10%.
    </div>

    <!-- ── Cash Out Section ── -->
    <div class="snx-dash-section">💸 Cash Out via PayPal</div>
    <div class="snx-cashout-form">
      <input
        id="snxPayoutEmail"
        class="snx-card-input"
        type="email"
        placeholder="Your PayPal email"
        value=""
        style="margin-bottom:8px;"
      >
      <input
        id="snxPayoutCoins"
        class="snx-card-input"
        type="number"
        placeholder="Coins to cash out (min ${PAYOUT_MIN_COINS})"
        min="${PAYOUT_MIN_COINS}"
        max="${pendingCoins}"
        value="${pendingCoins >= PAYOUT_MIN_COINS ? pendingCoins : ''}"
        style="margin-bottom:4px;"
      >
      <p style="font-size:10px;color:#6a90b8;margin:0 0 8px;">
        ${pendingCoins} coins available = $${pendingUsd} USD
      </p>
      <button class="snx-modal-confirm" id="snxCashOutBtn"
              ${pendingCoins < PAYOUT_MIN_COINS ? 'disabled style="opacity:0.5;"' : ''}>
        💸 Cash Out Now
      </button>
      <p style="font-size:10px;color:#4a6a8a;text-align:center;margin-top:6px;line-height:1.5;">
        Minimum $${(PAYOUT_MIN_COINS * COIN_VALUE_USD).toFixed(2)} (${PAYOUT_MIN_COINS} coins).
        PayPal sends within minutes.
      </p>
    </div>

    <!-- ── Payout History ── -->
    ${payouts.length > 0 ? `
      <div class="snx-dash-section" style="margin-top:16px;">Payout History</div>
      <div class="snx-dash-tx-list">
        ${payouts.map(p => {
          const statusColor = p.status === 'sent' || p.status === 'completed' ? '#44ff99' : p.status === 'failed' ? '#ff6688' : '#ffd700';
          return `
            <div class="snx-dash-tx">
              <span class="snx-dash-tx-emoji">💸</span>
              <div class="snx-dash-tx-info">
                <span class="snx-dash-tx-sender">${p.paypalEmail || '—'}</span>
                <span class="snx-dash-tx-name">${p.amountCoins?.toLocaleString()} coins</span>
              </div>
              <div class="snx-dash-tx-earn">
                <span class="snx-dash-tx-coins" style="color:${statusColor};">$${p.amountUsd || '0.00'}</span>
                <span class="snx-dash-tx-pct">${p.status || '?'}</span>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    ` : ''}

    <!-- ── Recent Gifts ── -->
    <div class="snx-dash-section" style="margin-top:16px;">Recent Gifts Received</div>
    ${transactions.length === 0
      ? '<p style="color:#6a90b8;font-size:13px;text-align:center;padding:12px;">No gifts yet.</p>'
      : `<div class="snx-dash-tx-list">
          ${transactions.slice(0, 20).map(tx => `
            <div class="snx-dash-tx">
              <span class="snx-dash-tx-emoji">${tx.giftEmoji}</span>
              <div class="snx-dash-tx-info">
                <span class="snx-dash-tx-sender">${tx.senderName}</span>
                <span class="snx-dash-tx-name">${tx.giftName}</span>
              </div>
              <div class="snx-dash-tx-earn">
                <span class="snx-dash-tx-coins">+🪙 ${tx.creatorEarnings}</span>
                <span class="snx-dash-tx-pct">90%</span>
              </div>
            </div>
          `).join('')}
        </div>`
    }
  `;

  /* Wire cashout button */
  const cashOutBtn = panel.querySelector('#snxCashOutBtn');
  if (cashOutBtn && pendingCoins >= PAYOUT_MIN_COINS) {
    cashOutBtn.addEventListener('click', async () => {
      const email  = panel.querySelector('#snxPayoutEmail')?.value?.trim();
      const coins  = parseInt(panel.querySelector('#snxPayoutCoins')?.value || '0', 10);
      cashOutBtn.disabled = true;
      cashOutBtn.textContent = 'Processing…';
      const ok = await requestCashOut(email, coins);
      if (ok) {
        panel.remove();
        openCreatorDashboard(uid);  // refresh
      } else {
        cashOutBtn.disabled = false;
        cashOutBtn.textContent = '💸 Cash Out Now';
      }
    });
  }
}

/* ─────────────────────────────────────────────
   SET LIVE CONTEXT (called from live.js)
   ───────────────────────────────────────────── */
export function setLiveContext(roomId, creatorUid, creatorName) {
  _liveRoomId  = roomId;
  _creatorUid  = creatorUid;
  _creatorName = creatorName || '';
}
