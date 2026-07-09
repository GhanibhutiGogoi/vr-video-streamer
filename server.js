#!/usr/bin/env node
'use strict';

/*
 * VR Video Streamer — Mac-side server.
 *
 * Flow:
 *   1. Bookmarklet in Chrome hits  GET /send?url=<page url>
 *   2. yt-dlp resolves the direct stream URL (runs on the Mac -> uses the Mac's VPN)
 *   3. The stream info is pushed to the phone over WebSocket
 *   4. The phone plays  /stream  — the Mac proxies every byte, so the phone
 *      never contacts the video site itself.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execFile, spawn } = require('child_process');

const HTTPS_PORT = Number(process.env.PORT || 8443);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const PUB = path.join(__dirname, 'public');
const CERT_DIR = path.join(__dirname, 'certs');

let WebSocket;
try {
  WebSocket = require('ws');
} catch (e) {
  console.error('Dependencies missing — run ./setup.sh (or `npm install`) first.');
  process.exit(1);
}

let tlsOptions;
try {
  tlsOptions = {
    cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')),
    key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
  };
} catch (e) {
  console.error('No certificate found — run ./setup.sh first to generate certs/.');
  process.exit(1);
}

// The video currently being streamed. Set by /send, consumed by /stream and /proxy.
let current = null; // { streamUrl, headers, title, kind: 'hls' | 'file', info }

// User-selected quality ceiling in pixels of height (0 = auto/best).
// Survives across videos; settable from the phone HUD or GET /quality?h=…
let preferredHeight = 0;

// callbacks queued while a stale stream link is being re-extracted
let refreshWaiters = null;

// Resolution ceiling for the quality menu and auto mode. VR video spreads its
// pixels around a whole sphere, so high source resolution matters double —
// 4K stays available even though it needs a fast connection to keep up.
// Override with MAX_HEIGHT=1440 (etc.) if your network can't sustain it.
const MAX_HEIGHT = Number(process.env.MAX_HEIGHT) || 2160;

// ffmpeg unlocks resolutions that only exist as separate video/audio streams
// (e.g. YouTube above 1080p) by merging them on the fly.
let FFMPEG = false;
execFile('ffmpeg', ['-version'], e => {
  FFMPEG = !e;
  console.log(FFMPEG ? '[init] ffmpeg found — high-resolution merge mode enabled'
                     : '[init] ffmpeg not found — resolutions above muxed formats unavailable (brew install ffmpeg)');
});

// ---------------------------------------------------------------- utilities

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function b64urlEncode(s) { return Buffer.from(s, 'utf8').toString('base64url'); }
function b64urlDecode(s) { return Buffer.from(s, 'base64url').toString('utf8'); }

function localIp() {
  const ifaces = os.networkInterfaces();
  for (const name of ['en0', 'en1']) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

// ------------------------------------------------------------- yt-dlp layer

// Borrow the browser's own cookies so extraction looks like the user's real
// session (defeats bot checks, unlocks age-restricted videos). Falls back to
// cookie-less extraction if the browser's cookie store isn't readable.
const COOKIES_BROWSER = process.env.COOKIES_BROWSER || 'chrome';

// Extraction chain: yt-dlp with the browser's cookies -> yt-dlp plain ->
// fetch the page HTML ourselves and sniff it for video URLs. All three run
// on the Mac, so the Mac's VPN/session applies to every attempt.
function extract(pageUrl, cb) {
  const done = (err, picked) => {
    if (picked) picked.extractedAt = Date.now(); // stream links age badly (throttling/expiry)
    cb(err, picked);
  };
  const base = ['-j', '--no-playlist', '--no-warnings'];
  runYtdlp([...base, '--cookies-from-browser', COOKIES_BROWSER, pageUrl], (err, picked) => {
    if (!err) { console.log('[extract] via yt-dlp (browser cookies)'); return done(null, picked); }
    runYtdlp([...base, pageUrl], (err2, picked2) => {
      if (!err2) { console.log('[extract] via yt-dlp'); return done(null, picked2); }
      sniffPage(pageUrl, (err3, picked3) => {
        if (!err3) { console.log('[extract] via page sniffing'); return done(null, picked3); }
        done(err2); // yt-dlp's error message is the most informative one
      });
    });
  });
}

// Last-resort extractor for sites yt-dlp doesn't know: download the page HTML
// and look for video sources in it.
function sniffPage(pageUrl, cb) {
  upstream(pageUrl, {}, null, (err, resp, finalUrl) => {
    if (err) return cb(err);
    const ct = String(resp.headers['content-type'] || '');
    if (/^(video|audio)\//i.test(ct)) {
      resp.destroy();
      const name = decodeURIComponent((finalUrl.split('/').pop() || 'Video').split('?')[0]);
      return cb(null, { streamUrl: finalUrl, headers: {}, title: name, kind: 'file' });
    }
    if (!/text\/html/i.test(ct)) { resp.destroy(); return cb(new Error('page is not HTML')); }

    let html = '';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const found = findMediaInHtml(html, finalUrl);
      if (!found) return cb(new Error('no video found in page HTML'));
      const t = html.match(/<title[^>]*>\s*([^<]{1,200})/i);
      cb(null, {
        streamUrl: found.url,
        headers: { Referer: finalUrl },
        title: t ? t[1].trim() : 'Video',
        kind: found.kind,
      });
    };
    resp.setEncoding('utf8');
    resp.on('data', c => { html += c; if (html.length > 3e6) resp.destroy(); });
    resp.on('end', finish);
    resp.on('close', finish);
    resp.on('error', finish);
  });
}

function findMediaInHtml(html, baseUrl) {
  const cands = [];
  const push = (raw, weight) => {
    const cleaned = raw.replace(/&amp;/g, '&').replace(/\\\//g, '/');
    try {
      const abs = new URL(cleaned, baseUrl).href;
      if (/^https?:/i.test(abs)) cands.push({ url: abs, weight });
    } catch (e) { /* not a URL */ }
  };
  let m;
  const videoTag = /<(?:video|source)\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = videoTag.exec(html))) push(m[1], 4);
  const metaTag = /<meta\b[^>]*(?:og:video|twitter:player:stream)[^>]*>/gi;
  while ((m = metaTag.exec(html))) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    if (c) push(c[1], 3);
  }
  // bare URLs in scripts/JSON (incl. \/ escaped)
  const urlChar = '(?:[^"\'\\s<>\\\\]|\\\\/)';
  const hlsUrl = new RegExp('https?:\\\\?/\\\\?/' + urlChar + '+?\\.m3u8' + urlChar + '*', 'gi');
  while ((m = hlsUrl.exec(html))) push(m[0], 2);
  const mp4Url = new RegExp('https?:\\\\?/\\\\?/' + urlChar + '+?\\.(?:mp4|webm|mov)\\b' + urlChar + '*', 'gi');
  while ((m = mp4Url.exec(html))) push(m[0], 1);

  if (!cands.length) return null;
  cands.sort((a, b) => b.weight - a.weight);
  // an HLS manifest beats a progressive file of equal standing (adaptive quality)
  const best = cands.find(c => /\.m3u8/i.test(c.url) && c.weight === cands[0].weight) || cands[0];
  return { url: best.url, kind: /\.m3u8/i.test(best.url) ? 'hls' : 'file' };
}

function runYtdlp(args, cb) {
  const pageUrl = args[args.length - 1];
  execFile('yt-dlp', args, { maxBuffer: 200 * 1024 * 1024, timeout: 90000 }, (err, stdout, stderr) => {
    if (err) {
      // Direct link to a media file? No extractor needed.
      if (/\.(mp4|m4v|mov|webm|m3u8)(\?|#|$)/i.test(pageUrl)) {
        const kind = /\.m3u8(\?|#|$)/i.test(pageUrl) ? 'hls' : 'file';
        return cb(null, { streamUrl: pageUrl, headers: {}, title: decodeURIComponent(pageUrl.split('/').pop().split('?')[0]), kind });
      }
      if (err.code === 'ENOENT') {
        return cb(new Error('yt-dlp is not installed. Run: brew install yt-dlp'));
      }
      const detail = String(stderr || err.message).split('\n').filter(Boolean).pop() || 'unknown error';
      return cb(new Error('Could not extract a stream: ' + detail.slice(0, 300)));
    }
    let info;
    try { info = JSON.parse(stdout); } catch (e) { return cb(new Error('Could not parse yt-dlp output')); }
    const picked = chooseFormat(info, preferredHeight);
    if (!picked) return cb(new Error('No directly playable stream found for this page'));
    picked.info = info; // kept so a later quality change can re-pick
    cb(null, picked);
  });
}

// Re-apply the preferred quality to the current video by re-picking from the
// stored yt-dlp info. May switch kinds (e.g. hls 1080p -> merge 4K).
function applyQuality() {
  if (!current || !current.info) return;
  const repick = chooseFormat(current.info, preferredHeight);
  if (repick) {
    repick.info = current.info;
    repick.pageUrl = current.pageUrl;
    repick.extractedAt = current.extractedAt; // repicked URLs are as old as their extraction
    current = repick;
  }
}

// yt-dlp reports per-format cookies as Set-Cookie-style strings; the CDN just
// needs the name=value pairs.
function cookieHeaderFrom(ytdlpCookies) {
  return String(ytdlpCookies)
    .split(/,\s*(?=[A-Za-z0-9_\-]+=)/)
    .map(s => s.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

/*
 * Prefer, in order:
 *   1. A progressive (single file, audio+video) HTTP stream — simplest, seekable.
 *   2. The HLS *master* manifest — Safari's native HLS player handles quality
 *      switching and separate audio tracks.
 *   3. If ffmpeg is available and separate video+audio streams reach a higher
 *      resolution than 1/2 (e.g. YouTube above 1080p), merge them on the fly.
 *      Transcoding (VP9/AV1 -> HEVC via the hardware encoder) is a last resort,
 *      used only when the user explicitly picked such a height.
 */
function chooseFormat(info, maxHeight) {
  const userHeight = maxHeight; // 0 = auto; >0 = the user explicitly picked
  maxHeight = maxHeight ? Math.min(maxHeight, MAX_HEIGHT) : MAX_HEIGHT;
  const fmts = (info.formats || []).filter(f => f && f.url);
  const isHls = f => String(f.protocol || '').includes('m3u8');
  const isHttp = f => String(f.protocol || 'https').startsWith('http');
  const hasV = f => f.vcodec && f.vcodec !== 'none';
  // undefined acodec means "unknown" — treat as present (only an explicit
  // 'none' marks a video-only stream)
  const hasA = f => f.acodec !== 'none';
  const height = f => f.height || 0;
  // codecs iPhone Safari can play natively
  const safariSafe = f => !f.vcodec || /^(avc1|h264|hev1|hvc1|hevc)/.test(f.vcodec);
  const title = info.title || 'Video';
  const headersOf = f => {
    const h = Object.assign({}, info.http_headers || {}, (f && f.http_headers) || {});
    if (f && f.cookies) h['Cookie'] = cookieHeaderFrom(f.cookies);
    return h;
  };

  // every rendition height this video actually offers (for the phone's quality menu)
  const heights = [...new Set(
    fmts.filter(f => hasV(f) && (isHls(f) || isHttp(f)))
        .filter(f => hasA(f) || isHls(f) || FFMPEG)
        .map(height).filter(h => h && h <= MAX_HEIGHT)
  )].sort((a, b) => b - a);

  let prog = fmts.filter(f => hasV(f) && hasA(f) && !isHls(f) && isHttp(f))
    .sort((a, b) => height(b) - height(a)
      || (safariSafe(b) ? 1 : 0) - (safariSafe(a) ? 1 : 0)
      || (b.tbr || 0) - (a.tbr || 0));
  if (maxHeight) {
    const capped = prog.filter(f => height(f) <= maxHeight);
    if (capped.length) prog = capped;
  }

  const hls = fmts.filter(isHls).sort((a, b) => height(b) - height(a));
  const master = hls.find(f => f.manifest_url);
  const hlsHeights = hls.map(height).filter(Boolean);
  let bestHlsHeight = hlsHeights[0] || 0;
  if (maxHeight && hlsHeights.some(h => h <= maxHeight)) {
    bestHlsHeight = Math.max(...hlsHeights.filter(h => h <= maxHeight));
  }

  let pick = null;
  if (prog.length && height(prog[0]) >= bestHlsHeight) {
    pick = { streamUrl: prog[0].url, headers: headersOf(prog[0]), title, kind: 'file', height: height(prog[0]) };
  } else if (master) {
    pick = { streamUrl: master.manifest_url, headers: headersOf(master), title, kind: 'hls', height: bestHlsHeight };
  } else {
    const muxedHls = hls.find(f => hasV(f) && hasA(f));
    if (muxedHls) pick = { streamUrl: muxedHls.url, headers: headersOf(muxedHls), title, kind: 'hls', height: height(muxedHls) };
    else if (prog.length) pick = { streamUrl: prog[0].url, headers: headersOf(prog[0]), title, kind: 'file', height: height(prog[0]) };
  }

  if (FFMPEG) {
    const codecRank = f => /^(avc1|h264)/.test(f.vcodec) ? 3 : /^(hev1|hvc1)/.test(f.vcodec) ? 2 : /^av01/.test(f.vcodec) ? 1 : 0;
    let vOnly = fmts.filter(f => hasV(f) && !hasA(f) && !isHls(f) && isHttp(f))
      .sort((a, b) => height(b) - height(a) || codecRank(b) - codecRank(a) || (b.tbr || 0) - (a.tbr || 0));
    if (maxHeight) {
      const capped = vOnly.filter(f => height(f) <= maxHeight);
      if (capped.length) vOnly = capped;
    }
    const aOnly = fmts.filter(f => hasA(f) && !hasV(f) && !isHls(f) && isHttp(f))
      .sort((a, b) => (/^mp4a/.test(b.acodec) ? 1 : 0) - (/^mp4a/.test(a.acodec) ? 1 : 0) || (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0));
    if (vOnly.length && aOnly.length) {
      const v = vOnly[0], a = aOnly[0];
      const needsTranscode = !/^(avc1|h264|hev1|hvc1)/.test(v.vcodec || '');
      const pickedHeight = pick ? pick.height : 0;
      const explicitlyAskedHigher = userHeight && userHeight > pickedHeight;
      if (height(v) > pickedHeight && (!needsTranscode || explicitlyAskedHigher)) {
        pick = {
          kind: 'merge', title, height: height(v),
          video: { url: v.url, headers: headersOf(v), transcode: needsTranscode },
          audio: { url: a.url, headers: headersOf(a), transcode: !/^mp4a/.test(a.acodec || '') },
        };
      }
    }
  }

  if (!pick && info.url) {
    pick = { streamUrl: info.url, headers: info.http_headers || {}, title, kind: isHls(info) ? 'hls' : 'file', height: 0 };
  }

  // A single-file stream in a codec the iPhone can't decode (AV1/VP9) gets
  // hardware-transcoded to HEVC on the way through.
  if (pick && pick.kind === 'file' && FFMPEG) {
    const src = fmts.find(f => f.url === pick.streamUrl);
    if (src && !safariSafe(src)) pick.kind = 'transcode';
  }

  if (pick) pick.heights = heights;
  return pick;
}

// -------------------------------------------------------------- proxy layer

function upstream(urlStr, extraHeaders, range, cb, depth = 0, timeoutMs = 30000) {
  let u;
  try { u = new URL(urlStr); } catch (e) { return cb(e); }
  const mod = u.protocol === 'http:' ? http : https;
  const headers = { 'Accept-Encoding': 'identity' };
  for (const [k, v] of Object.entries(extraHeaders || {})) headers[k] = v;
  if (!Object.keys(headers).some(k => k.toLowerCase() === 'user-agent')) {
    headers['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  }
  if (range) headers['Range'] = range;

  const req = mod.request(u, { method: 'GET', headers }, resp => {
    const code = resp.statusCode;
    if ([301, 302, 303, 307, 308].includes(code) && resp.headers.location && depth < 6) {
      resp.resume();
      return upstream(new URL(resp.headers.location, u).href, extraHeaders, range, cb, depth + 1, timeoutMs);
    }
    cb(null, resp, u.href);
  });
  req.on('error', cb);
  req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
  req.end();
}

// Quick reachability check (covers TCP connect + first byte). CDN edges can
// be individually dead or blocked while the rest of the site works.
function preflight(url, headers, cb) {
  if (!/^https?:/i.test(url)) return cb(true); // local file
  upstream(url, headers, 'bytes=0-0', (err, up) => {
    if (err) return cb(false);
    up.resume();
    cb(up.statusCode < 400);
  }, 0, 8000);
}

function proxyPath(absUrl) { return '/proxy?u=' + b64urlEncode(absUrl); }

/*
 * Read-ahead chunk cache for direct-file streaming. Safari's range requests
 * are served from memory while the server keeps downloading ahead of the
 * playhead, so playback and seeks don't wait on CDN round-trips.
 */
const CHUNK = 2 * 1024 * 1024;
const PREFETCH_CHUNKS = 5;   // ~10 MB ahead of the playhead
const CACHE_MAX_CHUNKS = 80; // ~160 MB ceiling
let fileCache = null; // { url, headers, size, type, chunks: Map<idx, Buffer|Promise>, lru: [] }

function ensureFileCache() {
  if (!fileCache || fileCache.url !== current.streamUrl) {
    fileCache = { url: current.streamUrl, headers: current.headers, size: 0, type: '', chunks: new Map(), lru: [] };
  }
  return fileCache;
}

function cacheTouch(cache, idx) {
  const i = cache.lru.indexOf(idx);
  if (i !== -1) cache.lru.splice(i, 1);
  cache.lru.push(idx);
  while (cache.lru.length > CACHE_MAX_CHUNKS) {
    const old = cache.lru.shift();
    if (Buffer.isBuffer(cache.chunks.get(old))) cache.chunks.delete(old);
    else cache.lru.push(old); // still downloading — keep and try the next one
    if (cache.lru.length <= CACHE_MAX_CHUNKS) break;
  }
}

function fetchChunk(cache, idx) {
  const existing = cache.chunks.get(idx);
  if (existing) { cacheTouch(cache, idx); return Promise.resolve(existing); }
  const start = idx * CHUNK;
  const end = cache.size ? Math.min(start + CHUNK - 1, cache.size - 1) : start + CHUNK - 1;
  const p = new Promise((resolve, reject) => {
    upstream(cache.url, cache.headers, `bytes=${start}-${end}`, (err, up) => {
      if (err) return reject(err);
      if (up.statusCode >= 400) { up.resume(); return reject(new Error('upstream ' + up.statusCode)); }
      if (!cache.size) {
        const m = String(up.headers['content-range'] || '').match(/\/(\d+)/);
        if (m) cache.size = Number(m[1]);
        const ct = String(up.headers['content-type'] || '');
        cache.type = /octet-stream|^$/.test(ct) ? 'video/mp4' : ct;
      }
      const bufs = [];
      up.on('data', c => bufs.push(c));
      up.on('end', () => resolve(Buffer.concat(bufs)));
      up.on('error', reject);
    });
  });
  cache.chunks.set(idx, p);
  cacheTouch(cache, idx);
  p.then(buf => { if (cache.chunks.get(idx) === p) cache.chunks.set(idx, buf); })
   .catch(() => { if (cache.chunks.get(idx) === p) cache.chunks.delete(idx); });
  return p;
}

function streamFileCached(req, res, onFail) {
  const cache = ensureFileCache();
  const range = req.headers.range;
  let start = 0, endReq = null;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) { start = Number(m[1]); endReq = m[2] ? Number(m[2]) : null; }
  }
  const firstIdx = Math.floor(start / CHUNK);
  fetchChunk(cache, firstIdx).then(() => {
    const size = cache.size;
    if (!size) return onFail(new Error('upstream sent no content-range'));
    if (start >= size) return send(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${size}` });
    const end = endReq !== null ? Math.min(endReq, size - 1) : size - 1;
    const headers = {
      'Content-Type': cache.type || 'video/mp4',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    res.writeHead(range ? 206 : 200, headers);

    let closed = false;
    res.on('close', () => { closed = true; });
    const lastIdx = Math.floor(end / CHUNK);
    (function pump(i) {
      if (closed || i > lastIdx) return res.end();
      for (let k = 1; k <= PREFETCH_CHUNKS; k++) {
        if ((i + k) * CHUNK < size) fetchChunk(cache, i + k).catch(() => {});
      }
      fetchChunk(cache, i).then(buf => {
        if (closed) return;
        const chunkStart = i * CHUNK;
        const slice = buf.slice(Math.max(0, start - chunkStart), Math.min(buf.length, end - chunkStart + 1));
        res.write(slice, () => pump(i + 1));
      }).catch(() => { if (!closed) res.destroy(); });
    })(firstIdx);
  }).catch(onFail);
}

/*
 * Segment prefetch for proxied HLS: while Safari plays segment N, the server
 * already downloads N+1 and N+2 so they're served from memory.
 */
const segCache = new Map(); // absUrl -> Promise<{buf, type}>
let segNext = new Map();    // absUrl -> following segment's absUrl

function fetchSeg(url, headers) {
  if (segCache.has(url)) return segCache.get(url);
  const p = new Promise((resolve, reject) => {
    upstream(url, headers, null, (err, up) => {
      if (err) return reject(err);
      if (up.statusCode >= 400) { up.resume(); return reject(new Error('upstream ' + up.statusCode)); }
      const bufs = [];
      up.on('data', c => bufs.push(c));
      up.on('end', () => resolve({ buf: Buffer.concat(bufs), type: String(up.headers['content-type'] || 'video/mp4') }));
      up.on('error', reject);
    });
  });
  segCache.set(url, p);
  p.catch(() => segCache.delete(url));
  while (segCache.size > 15) segCache.delete(segCache.keys().next().value);
  return p;
}

function clearStreamCaches() {
  fileCache = null;
  segCache.clear();
  segNext = new Map();
}

// Drop HLS master-playlist variants above the preferred height so Safari can
// only pick renditions the user asked for. Variant playlists (no STREAM-INF
// lines) pass through untouched.
function filterMasterVariants(body, maxHeight) {
  if (!/#EXT-X-STREAM-INF/i.test(body)) return body;
  const lines = body.split(/\r?\n/);
  const out = [];
  let keptAny = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^#EXT-X-STREAM-INF/i.test(line)) {
      const m = line.match(/RESOLUTION=\d+x(\d+)/i);
      const h = m ? Number(m[1]) : 0;
      if (h && h > maxHeight) { i++; continue; } // skip this variant + its URI line
      keptAny = true;
      out.push(line, lines[i + 1] || '');
      i++;
      continue;
    }
    out.push(line);
  }
  return keptAny ? out.join('\n') : body; // nothing under the cap -> leave as-is
}

// Rewrite every URI in an HLS manifest to route back through this proxy,
// so segment/key/audio requests also come from the Mac.
function rewriteManifest(body, baseUrl) {
  const segUrls = [];
  const isMedia = body.includes('#EXTINF'); // media playlist (vs master)
  const out = body.split(/\r?\n/).map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (m, uri) => {
        try { return 'URI="' + proxyPath(new URL(uri, baseUrl).href) + '"'; } catch (e) { return m; }
      });
    }
    try {
      const abs = new URL(t, baseUrl).href;
      if (isMedia) segUrls.push(abs);
      return proxyPath(abs);
    } catch (e) { return line; }
  }).join('\n');
  if (isMedia && segUrls.length) {
    segNext = new Map();
    for (let i = 0; i < segUrls.length - 1; i++) segNext.set(segUrls[i], segUrls[i + 1]);
  }
  return out;
}

// Serve the current video's stream, transparently re-extracting once if the
// site's signed URL has expired (the usual cause of upstream 403s).
function streamDirect(req, res, u, attempt) {
  const refresh = why => {
    if (attempt > 0 || !current.pageUrl) return false; // give up
    console.log(`[stream] upstream rejected (${why}) — re-extracting…`);
    extract(current.pageUrl, (err, picked) => {
      if (err) return send(res, 502, 'stream rejected and re-extraction failed: ' + err.message);
      picked.pageUrl = current.pageUrl;
      current = picked;
      applyQuality();
      clearStreamCaches();
      if (current.kind === 'merge' || current.kind === 'transcode') return streamMerged(req, res, u);
      streamDirect(req, res, u, attempt + 1);
    });
    return true; // we own the response now
  };
  if (current.kind === 'file') {
    return streamFileCached(req, res, err => {
      if (!refresh(err.message)) send(res, 502, 'upstream error: ' + err.message);
    });
  }
  proxyTo(req, res, current.streamUrl, current.headers, true, up => refresh('status ' + up.statusCode));
}

function proxyTo(req, res, targetUrl, headers, forceManifest, onUpstreamError) {
  upstream(targetUrl, headers, req.headers.range, (err, up, finalUrl) => {
    if (err) return send(res, 502, 'Upstream error: ' + err.message);
    if (up.statusCode >= 400) {
      console.error(`[proxy] upstream ${up.statusCode} for ${finalUrl.split('?')[0]}`);
      if (onUpstreamError) {
        up.resume();
        if (onUpstreamError(up)) return;
      }
    }

    const ct = String(up.headers['content-type'] || '');
    let pathname = '';
    try { pathname = new URL(finalUrl).pathname; } catch (e) { /* ignore */ }
    const isManifest = forceManifest || /mpegurl/i.test(ct) || /\.m3u8$/i.test(pathname);

    if (isManifest) {
      const chunks = [];
      up.on('data', c => chunks.push(c));
      up.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        if (preferredHeight) body = filterMasterVariants(body, preferredHeight);
        send(res, 200, rewriteManifest(body, finalUrl), { 'Content-Type': 'application/vnd.apple.mpegurl' });
      });
      up.on('error', () => send(res, 502, 'upstream read error'));
      return;
    }

    const passHeaders = { 'Cache-Control': 'no-store' };
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (up.headers[k]) passHeaders[k] = up.headers[k];
    }
    res.writeHead(up.statusCode, passHeaders);
    up.pipe(res);
    res.on('close', () => up.destroy());
  });
}

// ------------------------------------------------------------------- server

function okPage(title) {
  return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>&#10003; Sent to phone</h2><p>${escapeHtml(title)}</p></div><script>setTimeout(function(){window.close()},1200)</script>`;
}

function videoMessage() {
  return {
    type: 'video', title: current.title, kind: current.kind, src: '/stream',
    heights: current.heights || [], quality: preferredHeight,
    duration: (current.info && current.info.duration) || current.localDuration || 0,
  };
}

// ---- local files: paste a path or file:// URL instead of a website ----

function localPathFrom(target) {
  let p = null;
  if (/^file:\/\//i.test(target)) {
    try { p = decodeURIComponent(new URL(target).pathname); } catch (e) { /* not a URL */ }
  } else if (target.startsWith('/')) {
    p = target;
  } else if (target.startsWith('~/')) {
    p = path.join(os.homedir(), target.slice(2));
  }
  try { return p && fs.statSync(p).isFile() ? p : null; } catch (e) { return null; }
}

function sendLocal(file, res) {
  execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], (err, stdout) => {
    let info = null;
    try { info = JSON.parse(stdout); } catch (e) { /* handled below */ }
    if (err || !info) {
      broadcast({ type: 'error', message: 'Could not read local file (is ffmpeg installed?)' });
      return send(res, 500, 'ffprobe failed');
    }
    const v = (info.streams || []).find(s => s.codec_type === 'video');
    const a = (info.streams || []).find(s => s.codec_type === 'audio');
    if (!v) {
      broadcast({ type: 'error', message: 'No video stream in that file' });
      return send(res, 500, 'no video stream');
    }
    const vSafe = /^(h264|hevc)$/.test(v.codec_name);
    const aSafe = !a || /^(aac|mp3)$/.test(a.codec_name);
    const mp4ish = ['.mp4', '.m4v', '.mov'].includes(path.extname(file).toLowerCase());
    const title = path.basename(file);
    const base = {
      streamUrl: file, headers: {}, title, height: v.height || 0, heights: [],
      localDuration: Number((info.format || {}).duration) || 0, pageUrl: null,
    };
    stopHlsSession();
    clearStreamCaches();
    if (vSafe && aSafe && mp4ish) {
      current = Object.assign(base, { kind: 'localfile' });
    } else {
      // wrong codec and/or container: remux or re-encode into HLS on the fly
      current = Object.assign(base, { kind: 'transcode', vTranscode: !vSafe, aTranscode: !aSafe });
    }
    console.log(`[send] ok: "${title}" (local ${current.kind === 'localfile' ? 'direct' : (current.vTranscode ? 're-encode' : 'remux')})`);
    broadcast(videoMessage());
    send(res, 200, okPage(title), { 'Content-Type': 'text/html; charset=utf-8' });
  });
}

function streamLocalFile(req, res) {
  let stat;
  try { stat = fs.statSync(current.streamUrl); } catch (e) { return send(res, 404, 'file no longer exists'); }
  const size = stat.size;
  const range = req.headers.range;
  let start = 0, end = size - 1;
  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    if (start >= size) return send(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${size}` });
  }
  const headers = {
    'Content-Type': path.extname(current.streamUrl).toLowerCase() === '.mov' ? 'video/quicktime' : 'video/mp4',
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  const rs = fs.createReadStream(current.streamUrl, { start, end });
  rs.pipe(res);
  res.on('close', () => rs.destroy());
}

/*
 * ffmpeg-backed playback (merge and transcode kinds) is delivered as LIVE HLS,
 * not a raw MP4 pipe: iPhone Safari refuses progressive MP4 without byte-range
 * support (error code 4), but plays a growing HLS playlist natively. ffmpeg
 * writes playlist + fMP4 segments to a temp dir; /stream serves the playlist,
 * /hls/<file> serves segments.
 */
// Sweep session dirs left behind by previous runs (crashes, force-quits).
// Dirs are stamped with their server's PID so a second instance never
// deletes a still-running server's active session.
try {
  for (const d of fs.readdirSync(os.tmpdir())) {
    const m = d.match(/^vr-hls-(\d+)-/);
    if (!m) continue;
    let alive = false;
    try { process.kill(Number(m[1]), 0); alive = true; } catch (e) { /* dead */ }
    if (!alive) fs.rm(path.join(os.tmpdir(), d), { recursive: true, force: true }, () => {});
  }
} catch (e) { /* best effort */ }
const HLS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-hls-' + process.pid + '-'));
let hlsSession = null; // { key, dir, ff }

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { if (hlsSession) hlsSession.ff.kill('SIGKILL'); } catch (e) { /* gone */ }
    try { fs.rmSync(HLS_ROOT, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    process.exit(0);
  });
}

function sessionKey(t) {
  const src = current.kind === 'merge' ? current.video.url : current.streamUrl;
  return current.kind + '|' + src + '|' + t;
}

function stopHlsSession() {
  if (!hlsSession) return;
  try { hlsSession.ff.kill('SIGKILL'); } catch (e) { /* already gone */ }
  const dir = hlsSession.dir;
  setTimeout(() => fs.rm(dir, { recursive: true, force: true }, () => {}), 2000);
  hlsSession = null;
}

function startHlsSession(t) {
  stopHlsSession();
  const dir = fs.mkdtempSync(path.join(HLS_ROOT, 's-'));
  const headerBlob = h => Object.entries(h || {}).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n';
  const single = current.kind === 'transcode'; // one muxed input vs separate video+audio
  // vTranscode/aTranscode are set for probed local files; remote single-input
  // transcodes re-encode both (codec unknown enough to be here at all)
  const vSrc = single
    ? { url: current.streamUrl, headers: current.headers, transcode: current.vTranscode !== false }
    : current.video;
  const aTranscode = single ? current.aTranscode !== false : current.audio.transcode;

  // for http inputs: fail fast on dead connections, auto-reconnect on drops
  const netFlags = ['-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'];
  const args = ['-hide_banner', '-loglevel', 'error'];
  if (t) args.push('-ss', String(t));
  // hardware decode where possible (falls back to software automatically)
  if (vSrc.transcode) args.push('-hwaccel', 'videotoolbox');
  if (/^https?:/i.test(vSrc.url)) args.push(...netFlags, '-headers', headerBlob(vSrc.headers));
  args.push('-i', vSrc.url);
  if (single) {
    args.push('-map', '0:v:0', '-map', '0:a:0?');
  } else {
    if (t) args.push('-ss', String(t));
    args.push(...netFlags, '-headers', headerBlob(current.audio.headers), '-i', current.audio.url);
    args.push('-map', '0:v:0', '-map', '1:a:0');
  }
  if (vSrc.transcode) {
    // generous bitrates: the re-encode should be visually transparent — the
    // LAN hop to the phone is never the bottleneck
    const bv = current.height >= 2160 ? '36M' : current.height >= 1440 ? '20M' : '12M';
    args.push('-c:v', 'hevc_videotoolbox', '-b:v', bv, '-tag:v', 'hvc1');
  } else {
    args.push('-c:v', 'copy');
  }
  if (aTranscode) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-c:a', 'copy');
  args.push(
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_playlist_type', 'event',
    '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', path.join(dir, 'seg%05d.m4s'),
    path.join(dir, 'index.m3u8')
  );

  console.log(`[stream] ffmpeg ${single ? 'transcode' : 'merge'} ${current.height || '?'}p${vSrc.transcode ? ' -> HEVC' : ''}${t ? ' from ' + t + 's' : ''} (HLS session)`);
  const ff = spawn('ffmpeg', args);
  let errBuf = '';
  ff.stderr.on('data', d => { errBuf += d; });
  ff.on('close', code => {
    if (code && errBuf) console.error('[ffmpeg] exit ' + code + ': ' + errBuf.slice(0, 400));
    if (code && hlsSession && hlsSession.dir === dir) hlsSession.dead = true; // fast-fail waiting playlist requests
  });
  hlsSession = { key: sessionKey(t), dir, ff, dead: false };
}

function streamMerged(req, res, u, attempt) {
  attempt = attempt || 0;
  const t = Math.max(0, Number(u.searchParams.get('t')) || 0);

  const vUrl = current.kind === 'merge' ? current.video.url : current.streamUrl;
  const vHeaders = current.kind === 'merge' ? current.video.headers : current.headers;
  const sessionIsFresh = hlsSession && hlsSession.key === sessionKey(t) && !hlsSession.dead;

  const begin = () => {
    if (!hlsSession || hlsSession.key !== sessionKey(t) || hlsSession.dead) startHlsSession(t);
    const dir = hlsSession.dir;
    const started = Date.now();
    (function waitReady() {
      let body = null;
      try { body = fs.readFileSync(path.join(dir, 'index.m3u8'), 'utf8'); } catch (e) { /* not yet */ }
      if (body && /\.m4s/.test(body)) {
        const out = body.split(/\r?\n/).map(line => {
          const s = line.trim();
          if (!s) return line;
          if (s.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, uri) => 'URI="/hls/' + uri + '"');
          return '/hls/' + s;
        }).join('\n');
        return send(res, 200, out, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      }
      if (!hlsSession || hlsSession.dir !== dir) return send(res, 409, 'session replaced');
      if (hlsSession.dead) return retryOrFail('transcoder died while starting');
      if (Date.now() - started > 30000) { stopHlsSession(); return send(res, 502, 'transcoder did not start in time'); }
      setTimeout(waitReady, 300);
    })();
  };

  const retryOrFail = why => {
    if (attempt < 2 && current.pageUrl) {
      console.log(`[stream] ${why} — re-extracting for a fresh CDN link (attempt ${attempt + 1})…`);
      broadcast({ type: 'status', message: 'Video source unreachable — trying a fresh link…' });
      return extract(current.pageUrl, (err, picked) => {
        if (err) {
          broadcast({ type: 'error', message: 'Video source unreachable (check the Mac’s network/VPN)' });
          return send(res, 502, 'source unreachable and re-extraction failed');
        }
        picked.pageUrl = current.pageUrl;
        current = picked;
        applyQuality();
        clearStreamCaches();
        stopHlsSession();
        if (current.kind === 'merge' || current.kind === 'transcode') return streamMerged(req, res, u, attempt + 1);
        return streamDirect(req, res, u, 0);
      });
    }
    broadcast({ type: 'error', message: 'Video source unreachable (check the Mac’s network/VPN)' });
    return send(res, 502, 'video source unreachable');
  };

  if (sessionIsFresh) return begin(); // already running — just serve the playlist
  preflight(vUrl, vHeaders, ok => (ok ? begin() : retryOrFail('CDN not responding')));
}

function requestHandler(req, res) {
  const u = new URL(req.url, 'https://x');
  const p = u.pathname;

  if (p === '/send') {
    const target = u.searchParams.get('url');
    if (!target) return send(res, 400, 'missing url');
    console.log('[send] ' + target);
    const local = localPathFrom(target);
    if (local) return sendLocal(local, res);
    broadcast({ type: 'status', message: 'Extracting stream…' });
    extract(target, (err, picked) => {
      if (err) {
        console.error('[send] FAILED: ' + err.message);
        broadcast({ type: 'error', message: err.message });
        return send(res, 500, err.message);
      }
      picked.pageUrl = target;
      stopHlsSession(); // the previous video's transcoder is obsolete
      clearStreamCaches();
      current = picked;
      console.log(`[send] ok: "${picked.title}" (${picked.kind}${picked.height ? ', ' + picked.height + 'p' : ''})`);
      broadcast(videoMessage());
      send(res, 200, okPage(picked.title), { 'Content-Type': 'text/html; charset=utf-8' });
    });
    return;
  }

  if (p === '/quality') {
    preferredHeight = Number(u.searchParams.get('h')) || 0;
    applyQuality();
    stopHlsSession();
    clearStreamCaches();
    if (current) broadcast(videoMessage());
    return send(res, 200, 'ok');
  }

  if (p === '/stream') {
    if (!current) return send(res, 404, 'no video sent yet');
    const dispatch = () => {
      if (current.kind === 'localfile') return streamLocalFile(req, res);
      if (current.kind === 'merge' || current.kind === 'transcode') return streamMerged(req, res, u);
      return streamDirect(req, res, u, 0);
    };
    // CDNs throttle or expire aged signed URLs — grab a fresh link when a
    // stream starts more than a few minutes after extraction
    const STALE_MS = 5 * 60 * 1000;
    if (!current.pageUrl || Date.now() - (current.extractedAt || 0) < STALE_MS) return dispatch();
    if (refreshWaiters) { refreshWaiters.push(dispatch); return; }
    console.log('[stream] link is stale — re-extracting a fresh one…');
    refreshWaiters = [dispatch];
    extract(current.pageUrl, (err, picked) => {
      if (!err) {
        picked.pageUrl = current.pageUrl;
        current = picked;
        applyQuality();
      } else {
        console.error('[stream] refresh failed (' + err.message + ') — trying the old link');
      }
      const waiting = refreshWaiters;
      refreshWaiters = null;
      waiting.forEach(fn => fn());
    });
    return;
  }

  if (p.startsWith('/hls/')) {
    if (!hlsSession) return send(res, 404, 'no active session');
    const f = path.basename(p); // basename only — no traversal
    const abs = path.join(hlsSession.dir, f);
    if (!fs.existsSync(abs)) return send(res, 404, 'not found');
    const type = f.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4';
    return send(res, 200, fs.readFileSync(abs), { 'Content-Type': type });
  }

  if (p === '/proxy') {
    const enc = u.searchParams.get('u');
    if (!enc) return send(res, 400, 'missing u');
    let target;
    try { target = b64urlDecode(enc); } catch (e) { return send(res, 400, 'bad u'); }
    const headers = current ? current.headers : {};
    // known media segment: serve from the prefetch cache and warm the next two
    if (segNext.has(target) || segCache.has(target)) {
      const nxt = segNext.get(target);
      if (nxt) {
        fetchSeg(nxt, headers).catch(() => {});
        const nxt2 = segNext.get(nxt);
        if (nxt2) fetchSeg(nxt2, headers).catch(() => {});
      }
      return fetchSeg(target, headers)
        .then(seg => send(res, 200, seg.buf, { 'Content-Type': seg.type }))
        .catch(e => send(res, 502, 'segment fetch failed: ' + e.message));
    }
    return proxyTo(req, res, target, headers, false);
  }

  if (p === '/remote') {
    const host = req.headers.host || `${localIp()}:${HTTPS_PORT}`;
    const html = fs.readFileSync(path.join(PUB, 'remote.html'), 'utf8').replace(/{{HOST}}/g, host);
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
  }

  // static player files
  let file = p === '/' ? '/index.html' : p;
  const abs = path.join(PUB, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (abs.startsWith(PUB) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
    return send(res, 200, fs.readFileSync(abs), { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
  }
  send(res, 404, 'not found');
}

const httpsServer = https.createServer(tlsOptions, requestHandler);
const wss = new WebSocket.Server({ server: httpsServer, path: '/ws' });

function broadcast(obj) {
  const s = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}

wss.on('connection', ws => {
  console.log('[ws] phone connected');
  ws.send(JSON.stringify({ type: 'hello' }));
  if (current) ws.send(JSON.stringify(videoMessage()));
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg.type === 'quality') {
      preferredHeight = Number(msg.height) || 0;
      console.log('[quality] max height set to ' + (preferredHeight || 'auto'));
      applyQuality();
      stopHlsSession();
      clearStreamCaches();
      if (current) broadcast(videoMessage());
    } else if (msg.type === 'control' || msg.type === 'state') {
      // relay between the Mac remote page and the phone player
      broadcast(msg);
    }
  });
  ws.on('close', () => console.log('[ws] phone disconnected'));
});

// Plain-HTTP helper: lets the iPhone download the certificate before it can
// trust the HTTPS server.
const httpServer = http.createServer((req, res) => {
  const p = (req.url || '/').split('?')[0];
  if (p === '/cert' || p === '/cert.pem') {
    res.writeHead(200, {
      'Content-Type': 'application/x-x509-ca-cert',
      'Content-Disposition': 'attachment; filename="vr-streamer.crt"',
    });
    return res.end(tlsOptions.cert);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="font-family:system-ui;max-width:34em;margin:2em auto;padding:0 1em;line-height:1.5">
<h1>&#127918; VR Streamer &mdash; one-time iPhone setup</h1>
<ol>
<li><a href="/cert"><b>Download the certificate</b></a> (tap Allow)</li>
<li>Open <b>Settings</b> &rsaquo; <b>Profile Downloaded</b> &rsaquo; Install</li>
<li>Then <b>Settings</b> &rsaquo; <b>General</b> &rsaquo; <b>About</b> &rsaquo; <b>Certificate Trust Settings</b> &rsaquo; turn ON full trust for &ldquo;VR Video Streamer&rdquo;</li>
<li>Open <a href="https://${localIp()}:${HTTPS_PORT}"><b>https://${localIp()}:${HTTPS_PORT}</b></a> in Safari &mdash; that&rsquo;s the VR player</li>
</ol></body>`);
});

httpsServer.listen(HTTPS_PORT, () => {
  const ip = localIp();
  console.log('');
  console.log('  VR Video Streamer running');
  console.log('  ─────────────────────────');
  console.log(`  iPhone player (Safari):   https://${ip}:${HTTPS_PORT}`);
  console.log(`  Mac remote + bookmarklet: https://${ip}:${HTTPS_PORT}/remote`);
  console.log(`  iPhone first-time setup:  http://${ip}:${HTTP_PORT}`);
  try {
    const hn = os.hostname().replace(/\.$/, '');
    console.log(`  (hostname alternative:    https://${hn.split('.')[0]}.local:${HTTPS_PORT})`);
  } catch (e) { /* ignore */ }
  console.log('');
});
httpServer.listen(HTTP_PORT);
