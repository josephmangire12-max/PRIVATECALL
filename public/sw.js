// SwiftChat service worker: app inafunguka bila mtandao + arifa za push (FCM) + mafaili ya chat kwenye simu
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyCAvvJNv4jZWbSD_rjmPXrFKh2Qxcl30A4",authDomain:"project-93be748e-5db2-4856-ac5.firebaseapp.com",projectId:"project-93be748e-5db2-4856-ac5",storageBucket:"project-93be748e-5db2-4856-ac5.firebasestorage.app",messagingSenderId:"1037898544372",appId:"1:1037898544372:web:88aba05335c3e8f71e5aa1"});
firebase.messaging();

const A = 'sc-app-v1';      // app shell (index.html, firebase SDK, icons)
const C = 'sc-media-v1';    // mafaili ya chat
const FB_JS = ['app', 'auth', 'firestore', 'storage', 'messaging'].map(n => 'https://www.gstatic.com/firebasejs/10.12.2/firebase-' + n + '-compat.js');
const SHELL = ['/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil((async () => {
    const c = await caches.open(A);
    try { const r = await fetch('/', { cache: 'reload' }); if (r.ok) await c.put('/index.html', r); } catch (_) {}
    await Promise.allSettled(SHELL.map(u => c.add(u)));
    await Promise.allSettled(FB_JS.map(async u => {
      if (await c.match(u)) return;
      await c.put(u, await fetch(new Request(u, { mode: 'no-cors' })));
    }));
  })());
});
self.addEventListener('activate', e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith('sc-app-') && k !== A) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url), same = u.origin === self.location.origin;
  if (r.method !== 'GET') return;
  if (r.mode === 'navigate' && same && (u.pathname === '/' || u.pathname === '/index.html')) return e.respondWith(shell(r));
  if (u.hostname === 'www.gstatic.com' && u.pathname.includes('/firebasejs/')) return e.respondWith(cacheFirst(r));
  if (same && SHELL.includes(u.pathname)) return e.respondWith(cacheFirst(r));
  if (same && u.pathname.startsWith('/api/media/')) return e.respondWith(serve(r, u));
});

async function shell(r) {
  const c = await caches.open(A);
  try {
    const res = await Promise.race([fetch(r), new Promise((_, no) => setTimeout(() => no(new Error('t')), 4000))]);
    if (res && res.ok) { c.put('/index.html', res.clone()); return res; }
  } catch (_) {}
  return (await c.match('/index.html')) || fetch(r);
}
async function cacheFirst(r) {
  const c = await caches.open(A);
  const hit = await c.match(r.url);
  if (hit) return hit;
  const res = await fetch(r);
  if (res && (res.ok || res.type === 'opaque')) c.put(r.url, res.clone());
  return res;
}
async function serve(r, u) {
  try {
    const c = await caches.open(C);
    const hit = await c.match(u.origin + u.pathname);
    if (!hit) return fetch(r);
    const blob = await hit.blob();
    const type = hit.headers.get('Content-Type') || blob.type || 'application/octet-stream';
    const dl = u.searchParams.get('dl');
    const h = { 'Content-Type': type, 'Accept-Ranges': 'bytes' };
    if (dl) {
      const n = (u.searchParams.get('n') || 'file').replace(/[\r\n"\\\/]+/g, '_');
      h['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(n);
    }
    const rg = r.headers.get('Range');
    const m = rg && /bytes=(\d*)-(\d*)/.exec(rg);
    if (m && !dl) {
      let s, e;
      if (m[1] === '') { s = Math.max(0, blob.size - (+m[2])); e = blob.size - 1; }
      else { s = +m[1]; e = m[2] === '' ? blob.size - 1 : Math.min(+m[2], blob.size - 1); }
      if (s >= blob.size) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + blob.size } });
      h['Content-Range'] = 'bytes ' + s + '-' + e + '/' + blob.size;
      h['Content-Length'] = String(e - s + 1);
      return new Response(blob.slice(s, e + 1), { status: 206, headers: h });
    }
    h['Content-Length'] = String(blob.size);
    return new Response(blob, { status: 200, headers: h });
  } catch (err) { return fetch(r); }
}
