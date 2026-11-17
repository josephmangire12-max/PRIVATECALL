const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

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
const MAX_BYTES = 100 * 1024 * 1024;
const hits = new Map();
const mediaCache = new Map();
const limited = uid => { const n = Date.now(), a = (hits.get(uid) || []).filter(x => n - x < 3600e3); a.push(n); hits.set(uid, a); return a.length > 60; };
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
      const snap = await db.collection('users').doc(u).collection('tokens').get();
      const tokens = snap.docs.map(d => d.id);
      if (!tokens.length) continue;
      const r = await admin.messaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: { headers: { Urgency: 'high', TTL: type === 'call' ? '45' : '3600' }, fcmOptions: { link: '/' } }
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
      return res.status(400).json({ error: 'Faili si sahihi au ni kubwa mno (kikomo 100 MB)' });
    const r = await fetch(HF + '/api/public/v1/files', {
      method: 'POST',
      headers: { 'x-api-key': HK, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: String(name).slice(0, 120), size_bytes: size, mime_type: String(mime || 'application/octet-stream') })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status === 401 ? 502 : r.status).json({ error: d.error || 'Hifadhi imekataa ombi' });
    res.json({ upload_id: d.upload_id, upload_url: d.upload_url, upload_headers: d.upload_headers, mime_type: d.mime_type || mime });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

app.post('/api/upload/complete', async (req, res) => {
  try {
    if (!HK) return res.status(503).json({ error: 'HIFADHI_API_KEY haijawekwa kwenye server' });
    const uid = await authed(req, res); if (!uid) return;
    const id = String((req.body || {}).upload_id || '');
    if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'upload_id si sahihi' });
    const r = await fetch(HF + '/api/public/v1/uploads/' + id, { method: 'POST', headers: { 'x-api-key': HK } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.file) return res.status(r.status || 502).json({ error: d.error || 'Imeshindikana kuhifadhi taarifa' });
    res.json({ id: d.file.id, name: d.file.name, category: d.file.category, url: '/api/media/' + d.file.id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

// Kiungo cha kudumu: kinaelekeza kwenye signed URL mpya (Hifadhi inatoa ya masaa 6)
app.get('/api/media/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!HK || !/^[0-9a-f-]{36}$/i.test(id)) return res.sendStatus(400);
    let c = mediaCache.get(id);
    if (!c || c.exp < Date.now()) {
      const r = await fetch(HF + '/api/public/v1/files?id=' + id, { headers: { 'x-api-key': HK } });
      if (!r.ok) return res.sendStatus(404);
      const d = await r.json();
      const f = d.file || (d.files && d.files[0]) || d;
      if (!f || !f.url) return res.sendStatus(404);
      if (mediaCache.size > 5000) mediaCache.clear();
      c = { url: f.url, exp: Date.now() + 5 * 3600e3 };
      mediaCache.set(id, c);
    }
    res.set('Cache-Control', 'private, max-age=1800');
    res.redirect(302, c.url);
  } catch (e) { console.error(e); res.sendStatus(500); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, push: pushReady, storage: !!HK }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Unganisha inaendesha port ' + port));
