/*
 * HomeHub service worker (V6.3). Its ONLY jobs: make the app installable as a real standalone PWA and
 * show a small offline page when a navigation fails. It deliberately caches NOTHING, so an installed app
 * can never be stranded on stale code: every request still goes to the network exactly as before
 * (hosting already sends `Cache-Control: no-cache` for JS/CSS). Firestore / Auth / fonts / YouTube are
 * never touched — only same-origin page navigations are handled.
 */
const SW_VERSION = '6.4.1-a';
// V6.3.0.1: only caches whose name starts with this prefix belong to HomeHub (none are created today).
const OWN_CACHE_PREFIX = 'homehub-';

self.addEventListener('install', () => { self.skipWaiting(); });

self.addEventListener('activate', (event) => {
  // Drop only HomeHub-owned caches left by an older worker (never another app's / library's cache on this
  // origin), then take control of open windows.
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith(OWN_CACHE_PREFIX)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const OFFLINE = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HomeHub</title><body style="font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">
<main><h1 style="font-size:1.25rem">HomeHub</h1><p>لا يوجد اتصال بالإنترنت.<br>You're offline.</p>
<button onclick="location.reload()" style="padding:.6rem 1.2rem;border-radius:.6rem;border:0;background:#2563eb;color:#fff;font-size:1rem">إعادة المحاولة · Retry</button></main></body></html>`;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate' || new URL(req.url).origin !== self.location.origin) return;   // everything else: browser default
  event.respondWith(fetch(req).catch(() => new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })));
});

self.addEventListener('message', (event) => { if (event.data === 'homehub:version' && event.source) event.source.postMessage({ sw: SW_VERSION }); });
