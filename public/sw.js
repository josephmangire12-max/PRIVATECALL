// SwiftChat service worker: arifa za push (FCM) + hifadhi ya mafaili kwenye simu
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js','https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
firebase.initializeApp({apiKey:"AIzaSyCAvvJNv4jZWbSD_rjmPXrFKh2Qxcl30A4",authDomain:"project-93be748e-5db2-4856-ac5.firebaseapp.com",projectId:"project-93be748e-5db2-4856-ac5",storageBucket:"project-93be748e-5db2-4856-ac5.firebasestorage.app",messagingSenderId:"1037898544372",appId:"1:1037898544372:web:88aba05335c3e8f71e5aa1"});
firebase.messaging();

const C = 'sc-media-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || !u.pathname.startsWith('/api/media/')) return;
  e.respondWith(serve(r, u));
});
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
