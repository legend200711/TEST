/**
 * Shadow Nexus Social — Cloudflare R2 Upload + Serve Worker
 *
 * Cloudflare handles ALL media storage for Shadow Nexus Social:
 *   - Profile pictures
 *   - Post images, videos, music files
 *   - Message media attachments
 *
 * Firebase stores only the public URL + file metadata.
 *
 * Routes:
 *   GET  /{key}  — serves a file from R2 with CDN caching
 *   POST /       — uploads a file to R2, returns public URL
 *
 * Security:
 *   - Origin whitelist (ALLOWED_ORIGINS)
 *   - MIME type allowlist (images / video / audio only)
 *   - 200 MB max file size
 *   - User UID scoped storage paths
 *   - Security response headers on every response
 *   - Rate-limit hint headers (enforce limits in Cloudflare dashboard)
 */

const MAX_SIZE = 200 * 1024 * 1024; // 200MB

const ALLOWED_ORIGINS = [
  'https://legend200711.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

// ── MIME type allowlist ───────────────────────────────────────────────────────
function isAllowedType(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0].trim();
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m === 'application/octet-stream' // fallback for some mobile browsers
  );
}

// ── CORS headers ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.some(o => origin && origin.startsWith(o))
    ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin':  allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-User-UID',
    'Access-Control-Max-Age':       '86400',
  };
}

// ── Security headers added to every response ──────────────────────────────────
function securityHeaders() {
  return {
    // Prevent MIME sniffing
    'X-Content-Type-Options': 'nosniff',
    // Block pages from being embedded in iframes (clickjacking)
    'X-Frame-Options': 'DENY',
    // XSS protection for older browsers
    'X-XSS-Protection': '1; mode=block',
    // Rate-limit hint (actual limits enforced via Cloudflare dashboard WAF rules)
    'X-RateLimit-Limit':     '100',
    'X-RateLimit-Window':    '60',
    // CDN hint — vary caching per origin
    'Vary': 'Origin',
    // Strict-Transport-Security (HTTPS only)
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    // Referrer policy
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  };
}

// ── Merge multiple header objects ─────────────────────────────────────────────
function mergeHeaders(...objs) {
  return Object.assign({}, ...objs);
}

// ── Extension → MIME fallback ─────────────────────────────────────────────────
function mimeFromExt(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    mp4: 'video/mp4',  mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
    mp3: 'audio/mpeg', m4a: 'audio/mp4',  aac: 'audio/aac',
    ogg: 'audio/ogg',  wav: 'audio/wav',  flac: 'audio/flac',
    opus: 'audio/ogg', webm: 'audio/webm',
  };
  return map[ext] || null;
}

// ── LiveKit JWT token generator ───────────────────────────────────────────────
// Signs an access token using the LiveKit API key + secret stored as Worker secrets.
// POST /livekit-token   body: { roomName, participantName, canPublish }
async function handleLiveKitToken(request, env, cors, sec) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: mergeHeaders(cors, sec) });
  }

  const apiKey    = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;

  if (!apiKey || !apiSecret) {
    return new Response(JSON.stringify({ error: 'LiveKit credentials not configured' }), {
      status: 500,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  let body;
  try { body = await request.json(); }
  catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  const { roomName, participantName, canPublish = false } = body;
  if (!roomName || !participantName) {
    return new Response(JSON.stringify({ error: 'roomName and participantName are required' }), {
      status: 400,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }

  // Build LiveKit access token (JWT HS256)
  const now   = Math.floor(Date.now() / 1000);
  const exp   = now + 6 * 3600; // 6-hour expiry

  const header  = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss:  apiKey,
    sub:  participantName,
    iat:  now,
    exp,
    nbf:  now,
    name: participantName,
    video: {
      room:          roomName,
      roomJoin:      true,
      canPublish,
      canSubscribe:  true,
      canPublishData: true,
    },
  };

  const b64url = s => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const enc    = s => b64url(unescape(encodeURIComponent(s)));

  const headerB64  = enc(JSON.stringify(header));
  const payloadB64 = enc(JSON.stringify(payload));
  const sigInput   = `${headerB64}.${payloadB64}`;

  // HMAC-SHA256 via Web Crypto
  const keyData  = new TextEncoder().encode(apiSecret);
  const msgData  = new TextEncoder().encode(sigInput);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);
  const sigB64    = btoa(String.fromCharCode(...new Uint8Array(sigBuffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const token = `${sigInput}.${sigB64}`;

  return new Response(JSON.stringify({ token, url: env.LIVEKIT_URL }), {
    status: 200,
    headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);
    const sec    = securityHeaders();
    const url    = new URL(request.url);

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: mergeHeaders(cors, sec)
      });
    }

    // ── LiveKit token endpoint ──
    if (url.pathname === '/livekit-token') {
      return handleLiveKitToken(request, env, cors, sec);
    }

    // ── GET: serve a file from R2 (CDN delivery) ──────────────────────────────
    if (request.method === 'GET') {
      const key = url.pathname.slice(1);
      if (!key) {
        return new Response('Shadow Nexus Upload Worker — OK ⚡', {
          status: 200,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'text/plain' })
        });
      }

      try {
        const obj = await env.BUCKET.get(key);
        if (!obj) {
          return new Response('Not found', {
            status: 404,
            headers: mergeHeaders(cors, sec)
          });
        }

        const headers = new Headers(mergeHeaders(cors, sec));
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        // Long-lived immutable cache for media files (files are content-addressed)
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('Accept-Ranges', 'bytes');
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        // Bot protection hint (actual blocking via Cloudflare Bot Management)
        headers.set('X-Robots-Tag', 'noindex, nofollow');

        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fetch error: ' + e.message }), {
          status: 500,
          headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
        });
      }
    }

    // ── POST: upload a file to R2 ─────────────────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method not allowed', {
        status: 405,
        headers: mergeHeaders(cors, sec)
      });
    }

    let formData;
    try { formData = await request.formData(); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const file    = formData.get('file');
    const userUid = (formData.get('uid') || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file received' }), {
        status: 400,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── MIME determination ────────────────────────────────────────────────────
    // Some mobile browsers report video/webm for audio recordings;
    // override based on file extension when that happens.
    let mime = file.type || '';
    const extMime = mimeFromExt(file.name);
    if (!mime || mime === 'application/octet-stream') {
      mime = extMime || mime;
    } else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) {
      mime = extMime;
    }

    if (!isAllowedType(mime)) {
      return new Response(JSON.stringify({ error: `File type not supported: ${file.type} (${file.name})` }), {
        status: 415,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'File too large (max 200MB)' }), {
        status: 413,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Store in R2 under userUid/timestamp-random.ext ────────────────────────
    const cleanMime = mime.split(';')[0].trim();
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${userUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata:   { contentType: cleanMime },
        customMetadata: { uploaderUid: userUid, originalName: file.name }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
        status: 500,
        headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
      });
    }

    // ── Return public CDN URL (stored in Firebase, served via Cloudflare CDN) ──
    const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key }), {
      status: 200,
      headers: mergeHeaders(cors, sec, { 'Content-Type': 'application/json' })
    });
  }
};
