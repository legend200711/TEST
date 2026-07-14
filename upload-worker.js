/**
 * Shadow Nexus Social — Cloudflare R2 Upload + Serve Worker
 * Handles both uploading files TO R2 (POST) and serving them FROM R2 (GET).
 */

const MAX_SIZE = 200 * 1024 * 1024; // 200MB

const ALLOWED_ORIGINS = [
  'https://legend200711.github.io',
  'http://localhost',
  'http://127.0.0.1'
];

// Check if a MIME type is allowed — uses startsWith so codec suffixes are handled
function isAllowedType(mime) {
  if (!mime) return false;
  const m = mime.toLowerCase().split(';')[0].trim(); // strip codec info e.g. "video/mp4; codecs=avc1"
  return (
    m.startsWith('image/') ||
    m.startsWith('video/') ||
    m.startsWith('audio/') ||
    m === 'application/octet-stream' // fallback for some mobile browsers
  );
}

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

// Guess MIME from file extension as fallback when browser sends wrong type
function mimeFromExt(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    // images
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif',  webp: 'image/webp', svg: 'image/svg+xml',
    // videos
    mp4: 'video/mp4',  mov: 'video/quicktime',
    avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
    // audio (webm is listed here as audio because that's the common recording format)
    mp3: 'audio/mpeg', m4a: 'audio/mp4',  aac: 'audio/aac',
    ogg: 'audio/ogg',  wav: 'audio/wav',  flac: 'audio/flac',
    opus: 'audio/ogg', webm: 'audio/webm',
  };
  return map[ext] || null;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const cors   = corsHeaders(origin);
    const url    = new URL(request.url);

    // ── Preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    // ── GET: serve a file from R2 ──
    if (request.method === 'GET') {
      const key = url.pathname.slice(1);
      if (!key) return new Response('Shadow Nexus Upload Worker — OK', { status: 200, headers: cors });

      try {
        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response('Not found', { status: 404, headers: cors });

        const headers = new Headers(cors);
        headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        headers.set('Accept-Ranges', 'bytes');
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);

        return new Response(obj.body, { status: 200, headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Fetch error: ' + e.message }), {
          status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
        });
      }
    }

    // ── POST: upload a file to R2 ──
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }

    let formData;
    try { formData = await request.formData(); }
    catch (e) {
      return new Response(JSON.stringify({ error: 'Invalid form data: ' + e.message }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const file    = formData.get('file');
    const userUid = (formData.get('uid') || 'anonymous').replace(/[^a-zA-Z0-9_-]/g, '');

    if (!file || typeof file === 'string') {
      return new Response(JSON.stringify({ error: 'No file received' }), {
        status: 400, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Determine MIME — use extension fallback if browser sends wrong type
    // Some mobile browsers report video/webm for audio recordings, so we
    // override based on extension when the reported MIME looks wrong.
    let mime = file.type || '';
    const extMime = mimeFromExt(file.name);
    if (!mime || mime === 'application/octet-stream') {
      mime = extMime || mime;
    } else if (extMime && mime.startsWith('video/') && extMime.startsWith('audio/')) {
      // Browser reported video/* but extension says it's audio — trust the extension
      mime = extMime;
    }

    if (!isAllowedType(mime)) {
      return new Response(JSON.stringify({ error: `File type not supported: ${file.type} (${file.name})` }), {
        status: 415, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > MAX_SIZE) {
      return new Response(JSON.stringify({ error: 'File too large (max 200MB)' }), {
        status: 413, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // Use clean MIME (strip codec info) for storage
    const cleanMime = mime.split(';')[0].trim();
    const ext = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '');
    const key = `${userUid}/${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`;

    try {
      await env.BUCKET.put(key, buffer, {
        httpMetadata: { contentType: cleanMime },
        customMetadata: { uploaderUid: userUid, originalName: file.name }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: 'R2 upload failed: ' + e.message }), {
        status: 500, headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const publicUrl = `https://yellow-term-11e6.nthntjrn.workers.dev/${key}`;
    return new Response(JSON.stringify({ url: publicUrl, key }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
};
