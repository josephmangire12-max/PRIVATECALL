const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const { Readable } = require('stream');
const linkcheck = require('./linkcheck');

let pushReady = false;
try {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  pushReady = true;
} catch (e) {
  console.warn('FIREBASE_SERVICE_ACCOUNT haijawekwa au si sahihi: push imezimwa.');
  admin.initializeApp({ projectId: 'project-93be748e-5db2-4856-ac5' }); // inatosha kuthibitisha token za watumiaji
}

// ---- Hifadhi (hifadhi ya faili) ----
const HF = (process.env.HIFADHI_BASE_URL || 'https://safi-space-manager.lovable.app').replace(/\/$/, '');
const HK = process.env.HIFADHI_API_KEY; // SIRI: weka Railway Variables tu
const MAX_BYTES = 300 * 1024 * 1024;
const hmsg = (s, d) => d.error || d.message || (s === 401 ? 'Server haijaunganishwa vizuri na Hifadhi (angalia HIFADHI_API_KEY)' : s === 409 ? 'Hifadhi imejaa au kuna mgongano wa faili' : s === 413 ? 'Faili ni kubwa mno' : s === 422 ? 'Hifadhi imekataa faili hili' : s === 503 ? 'Hifadhi haipatikani kwa sasa, jaribu tena' : 'Hifadhi imekataa ombi (' + s + ')');
const hitsL = new Map();
const limitedL = uid => { const n = Date.now(), a = (hitsL.get(uid) || []).filter(x => n - x < 3600e3); a.push(n); hitsL.set(uid, a); return a.length > 150; };
const linkCache = new Map();
const hits = new Map();
const mediaCache = new Map();
const limited = uid => { const n = Date.now(), a = (hits.get(uid) || []).filter(x => n - x < 3600e3); a.push(n); hits.set(uid, a); return a.length > 200; };
async function authed(req, res) {
  try {
    const t = (req.headers.authorization || '').replace('Bearer ', '');
    return (await admin.auth().verifyIdToken(t)).uid;
  } catch (e) { res.sendStatus(401); return null; }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '20kb' }));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});

app.post('/api/notify', async (req, res) => {
  if (!pushReady) return res.status(503).json({ error: 'push disabled' });
  try {
    const idToken = (req.headers.authorization || '').replace('Bearer ', '');
    const me = await admin.auth().verifyIdToken(idToken);
    const { type, to, cid, callId, fromName, text, video } = req.body || {};
    const db = admin.firestore();
    let targets = [];
    if (type === 'message') {
      const ids = String(cid || '').split('_');
      if (!ids.includes(me.uid) || !ids.includes(to) || to === me.uid) return res.sendStatus(403);
      targets = [to];
    } else if (type === 'call') {
      const d = await db.collection('calls').doc(String(callId || 'x')).get();
      const members = d.exists ? d.data().members : [];
      if (!members.includes(me.uid)) return res.sendStatus(403);
      targets = members.filter(u => u !== me.uid);
    } else return res.sendStatus(400);

    const name = String(fromName || 'Mtu').slice(0, 40);
    const title = type === 'call' ? name + ' anapiga ' + (video ? 'video' : 'sauti') : name;
    const body = type === 'call' ? 'Fungua Unganisha kujibu' : String(text || 'Ujumbe mpya').slice(0, 120);

    for (const u of targets) {
      const ud = (await db.collection('users').doc(u).get()).data() || {};
      if ((ud.muted || []).includes(me.uid) || (ud.blocked || []).includes(me.uid)) continue;
      const snap = await db.collection('users').doc(u).collection('tokens').get();
      const tokens = snap.docs.map(d => d.id);
      if (!tokens.length) continue;
      const r = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: { headers: { Urgency: 'high', TTL: type === 'call' ? '60' : '3600' }, fcmOptions: { link: '/' } }
      });
      r.responses.forEach((x, i) => {
        const code = (x.error && x.error.code) || '';
        if (!x.success && /not-registered|invalid-argument|invalid-registration/.test(code)) snap.docs[i].ref.delete();
      });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

app.post('/api/upload/prepare', async (req, res) => {
  try {
    if (!HK) return res.status(503).json({ error: 'HIFADHI_API_KEY haijawekwa kwenye server' });
    const uid = await authed(req, res); if (!uid) return;
    if (limited(uid)) return res.status(429).json({ error: 'Umepakia mara nyingi, jaribu baadaye' });
    const { name, size, mime } = req.body || {};
    if (!name || !Number.isInteger(size) || size <= 0 || size > MAX_BYTES)
      return res.status(400).json({ error: 'Faili si sahihi au ni kubwa mno (kikomo 300 MB)' });
    const r = await fetch(HF + '/api/public/v1/files', {
      method: 'POST',
      headers: { 'x-api-key': HK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(name).slice(0, 120), size_bytes: size, mime_type: String(mime || 'application/octet-stream') })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 401 ? 502 : r.status).json({ error: hmsg(r.status, d) });
    res.json({ upload_id: d.upload_id, upload_url: d.upload_url, upload_headers: d.upload_headers, mime_type: d.mime_type || mime });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

app.post('/api/upload/complete', async (req, res) => {
  try {
    if (!HK) return res.status(503).json({ error: 'HIFADHI_API_KEY haijawekwa kwenye server' });
    const uid = await authed(req, res); if (!uid) return;
    const id = String((req.body || {}).upload_id || '');
    if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'upload_id si sahihi' });
    let r, d;
    for (let a = 0; a < 3; a++) {
      r = await fetch(HF + '/api/public/v1/uploads/' + id, { method: 'POST', headers: { 'x-api-key': HK } });
      d = await r.json().catch(() => ({}));
      if (r.ok && d.file) break;
      if (r.status !== 409 && r.status < 500) break;
      await new Promise(x => setTimeout(x, 1000 * (a + 1)));
    }
    if (!r.ok || !d.file) return res.status(r.ok ? 502 : r.status).json({ error: hmsg(r.status, d) });
    res.json({ id: d.file.id, name: d.file.name, category: d.file.category, url: '/api/media/' + d.file.id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

// Ukaguzi wa viungo vinavyotumwa kwenye chat
app.post('/api/link/check', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    if (limitedL(uid)) return res.status(429).json({ error: 'Maombi mengi sana, jaribu baadaye' });
    let u;
    try { u = new URL(String((req.body || {}).url || '').trim().slice(0, 2000)); } catch (e) { return res.status(400).json({ error: 'Kiungo si sahihi' }); }
    if (!/^https?:$/.test(u.protocol)) return res.status(400).json({ error: 'Kiungo si sahihi' });
    const hit = linkCache.get(u.href);
    if (hit && hit.exp > Date.now()) return res.json(hit.v);
    const v = await linkcheck.check(u.href, process.env.SAFE_BROWSING_KEY);
    if (linkCache.size > 2000) linkCache.clear();
    linkCache.set(u.href, { v, exp: Date.now() + 3600e3 });
    res.json(v);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

// Kiungo cha kudumu: server inapitisha faili (inasaidia Range kwa video/sauti, na ?dl=1 kupakua)
async function signedUrl(id, force) {
  let c = mediaCache.get(id);
  if (!force && c && c.exp > Date.now()) return c.url;
  const r = await fetch(HF + '/api/public/v1/files?id=' + id, { headers: { 'x-api-key': HK } });
  if (!r.ok) return null;
  const d = await r.json();
  const f = d.file || (d.files && d.files[0]) || d;
  if (!f || !f.url) return null;
  if (mediaCache.size > 5000) mediaCache.clear();
  mediaCache.set(id, { url: f.url, exp: Date.now() + 4 * 3600e3 });
  return f.url;
}
app.get('/api/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!HK || !/^[0-9a-f-]{36}$/i.test(id)) return res.sendStatus(400);
    let url = await signedUrl(id, false);
    if (!url) return res.sendStatus(404);
    const h = {};
    if (req.headers.range) h.Range = req.headers.range;
    let r = await fetch(url, { headers: h });
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      url = await signedUrl(id, true);
      if (!url) return res.sendStatus(404);
      r = await fetch(url, { headers: h });
    }
    res.status(r.status);
    ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'].forEach(k => {
      const x = r.headers.get(k); if (x) res.set(k, x);
    });
    if (r.status < 400) res.set('Cache-Control', 'private, max-age=31536000, immutable');
    if (req.query.dl) {
      const n = String(req.query.n || 'file').replace(/[\r\n"\\\/]+/g, '_').slice(0, 100);
      res.set('Content-Disposition', 'attachment; filename="' + n.replace(/[^\x20-\x7e]/g, '_') + "\"; filename*=UTF-8''" + encodeURIComponent(n));
    }
    if (!r.body) return res.end();
    const body = Readable.fromWeb(r.body);
    req.on('close', () => { try { r.body.cancel(); } catch (e) {} });
    body.on('error', () => res.end());
    body.pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) res.sendStatus(500); else res.end(); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, push: pushReady, storage: !!HK }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Unganisha inaendesha port ' + port));
