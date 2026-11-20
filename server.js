const express = require('express');
const path = require('path');
const admin = require('firebase-admin');
const { Readable } = require('stream');
const linkcheck = require('./linkcheck');
const ai = require('./ai');

// Usiache server ianguke kwa hitilafu zisizotarajiwa (mfano mteja kukata muunganisho)
process.on('unhandledRejection', e => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', e => console.error('uncaughtException:', e && e.message));

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
app.use(express.json({ limit: '64kb' }));
app.use((req, res, next) => {
  res.set('Permissions-Policy', 'camera=(self), microphone=(self)');
  next();
});

app.post('/api/notify', async (req, res) => {
  if (!pushReady) return res.status(503).json({ error: 'push disabled' });
  try {
    const idToken = (req.headers.authorization || '').replace('Bearer ', '');
    const me = await admin.auth().verifyIdToken(idToken);
    const { type, to, cid, callId, fromName, text, video, gid } = req.body || {};
    const db = admin.firestore();
    let targets = [], gname = '';
    if (type === 'message') {
      const ids = String(cid || '').split('_');
      if (!ids.includes(me.uid) || !ids.includes(to) || to === me.uid) return res.sendStatus(403);
      targets = [to];
    } else if (type === 'call') {
      const d = await db.collection('calls').doc(String(callId || 'x')).get();
      const members = d.exists ? d.data().members : [];
      if (!members.includes(me.uid)) return res.sendStatus(403);
      targets = members.filter(u => u !== me.uid);
    } else if (type === 'group') {
      const d = await db.collection('groups').doc(String(gid || 'x')).get();
      const gd = d.exists ? d.data() : null;
      if (!gd || !(gd.members || []).includes(me.uid)) return res.sendStatus(403);
      gname = String(gd.name || 'Kundi').slice(0, 40);
      targets = (gd.members || []).filter(u => u !== me.uid);
    } else return res.sendStatus(400);

    const name = String(fromName || 'Mtu').slice(0, 40);
    const title = type === 'call' ? name + ' anapiga ' + (video ? 'video' : 'sauti') : type === 'group' ? gname : name;
    const body = type === 'call' ? 'Fungua Unganisha kujibu' : (type === 'group' ? name + ': ' : '') + String(text || 'Ujumbe mpya').slice(0, 120);

    for (const u of targets) {
      const ud = (await db.collection('users').doc(u).get()).data() || {};
      if ((ud.muted || []).includes(me.uid) || (ud.blocked || []).includes(me.uid) || (type === 'group' && (ud.muted || []).includes('g:' + gid))) continue;
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

// ---- Gemini AI (majibu kwa siku), sticker za AI, na GIF ----
const LIM_CHAT = +process.env.AI_DAILY_LIMIT || 3;
const LIM_STK = +process.env.AI_STICKER_LIMIT || 5;
const memQ = new Map();
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // saa za Afrika Mashariki
// delta: 0 = soma, 1 = tumia, -1 = rudisha. Inatumia Firestore ikiwa FIREBASE_SERVICE_ACCOUNT ipo, vinginevyo kumbukumbu ya server.
async function quota(uid, kind, limit, delta) {
  const day = today(), id = uid + '_' + kind;
  if (pushReady) {
    const fs = admin.firestore(), ref = fs.collection('aiq').doc(id);
    return fs.runTransaction(async t => {
      const s = await t.get(ref), n0 = s.exists && s.data().d === day ? s.data().n : 0;
      if (delta > 0 && n0 >= limit) return { ok: false, left: 0 };
      const n = Math.max(0, n0 + delta);
      if (delta) t.set(ref, { d: day, n, uid });
      return { ok: true, left: Math.max(0, limit - n) };
    });
  }
  const m = memQ.get(id), n0 = m && m.d === day ? m.n : 0;
  if (delta > 0 && n0 >= limit) return { ok: false, left: 0 };
  const n = Math.max(0, n0 + delta);
  if (delta) memQ.set(id, { d: day, n });
  return { ok: true, left: Math.max(0, limit - n) };
}
app.get('/api/ai/status', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    const [c, s] = await Promise.all([quota(uid, 'chat', LIM_CHAT, 0), quota(uid, 'stk', LIM_STK, 0)]);
    res.json({ ai: !!process.env.GEMINI_API_KEY, gif: !!process.env.GIPHY_API_KEY, chatLeft: c.left, chatLimit: LIM_CHAT, stkLeft: s.left, stkLimit: LIM_STK });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});
app.post('/api/ai/chat', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini haijawekwa kwenye server (GEMINI_API_KEY).' });
    if (pushReady) {
      const ud = (await admin.firestore().collection('users').doc(uid).get()).data() || {};
      if (!(ud.me && ud.me.phone)) return res.status(403).json({ error: 'Unganisha namba yako ya simu kwanza.' });
    }
    const msgs = (Array.isArray((req.body || {}).messages) ? req.body.messages : []).slice(-8)
      .map(m => ({ r: m.r === 'a' ? 'a' : 'u', t: String(m.t || '').slice(0, 1500) })).filter(m => m.t);
    if (!msgs.length || msgs[msgs.length - 1].r !== 'u') return res.status(400).json({ error: 'Ujumbe si sahihi' });
    const q = await quota(uid, 'chat', LIM_CHAT, 1);
    if (!q.ok) return res.status(429).json({ error: 'Umefikia kikomo cha leo. Jaribu tena kesho.', left: 0 });
    try {
      const reply = await ai.chat(msgs, req.body.lang);
      res.json({ reply, left: q.left });
    } catch (e) {
      await quota(uid, 'chat', LIM_CHAT, -1).catch(() => {});
      console.error('gemini chat:', e.message);
      res.status(e.code === 'blocked' ? 422 : 502).json({ error: e.code === 'blocked' ? 'Gemini haikuweza kujibu swali hilo. Jaribu kuuliza tofauti.' : ai.hint(e), detail: e.code === 'blocked' ? '' : String(e.message || '').slice(0, 200), left: q.left + 1 });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});
app.post('/api/ai/sticker', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    if (!process.env.GEMINI_API_KEY) return res.status(503).json({ error: 'Gemini haijawekwa kwenye server (GEMINI_API_KEY).' });
    const prompt = String((req.body || {}).prompt || '').trim();
    if (prompt.length < 2) return res.status(400).json({ error: 'Eleza sticker unayotaka.' });
    const q = await quota(uid, 'stk', LIM_STK, 1);
    if (!q.ok) return res.status(429).json({ error: 'Umefikia kikomo cha sticker za AI cha leo. Jaribu tena kesho.' });
    try {
      const img = await ai.sticker(prompt);
      res.json({ mime: img.mime, data: img.data, left: q.left, limit: LIM_STK });
    } catch (e) {
      await quota(uid, 'stk', LIM_STK, -1).catch(() => {});
      console.error('gemini sticker:', e.message);
      res.status(e.code === 'blocked' ? 422 : 502).json({ error: e.code === 'blocked' ? 'Gemini haikuweza kutengeneza sticker hiyo. Jaribu maelezo mengine.' : ai.hint(e), detail: e.code === 'blocked' ? '' : String(e.message || '').slice(0, 200) });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});
app.get('/api/ai/diag', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    if (limitedL(uid)) return res.status(429).json({ error: 'Maombi mengi sana' });
    res.json(await ai.diag());
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

// ICE servers kwa simu (STUN + TURN). TURN inahitajika kwenye mitandao mingi ya simu ili sauti ipite.
app.get('/api/turn', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    const T = process.env, out = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    let kind = 'public';
    try {
      if (T.TURN_URLS) {
        out.push({ urls: T.TURN_URLS.split(',').map(x => x.trim()).filter(Boolean), username: T.TURN_USERNAME || '', credential: T.TURN_CREDENTIAL || '' });
        kind = 'own';
      } else if (T.METERED_DOMAIN && T.METERED_API_KEY) {
        const r = await fetch('https://' + T.METERED_DOMAIN + '/api/v1/turn/credentials?apiKey=' + encodeURIComponent(T.METERED_API_KEY));
        const a = r.ok ? await r.json() : null;
        if (Array.isArray(a) && a.length) { a.forEach(x => out.push(x)); kind = 'own'; }
      } else if (T.CF_TURN_KEY_ID && T.CF_TURN_API_TOKEN) {
        const r = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(T.CF_TURN_KEY_ID) + '/credentials/generate-ice-servers', {
          method: 'POST', headers: { Authorization: 'Bearer ' + T.CF_TURN_API_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 })
        });
        const d = r.ok ? await r.json() : null;
        const l = d && d.iceServers ? [].concat(d.iceServers) : [];
        if (l.length) { l.forEach(x => out.push(x)); kind = 'own'; }
      }
    } catch (e) { console.error('turn:', e.message); }
    if (kind === 'public') {
      // Seva ya umma ya majaribio (Open Relay). Ni ya pamoja na ina kikomo; weka TURN yako mwenyewe kwa uhakika zaidi.
      out.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ iceServers: out, kind });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Hitilafu ya server' }); }
});

app.get('/api/gif/search', async (req, res) => {
  try {
    const uid = await authed(req, res); if (!uid) return;
    const k = process.env.GIPHY_API_KEY;
    if (!k) return res.status(503).json({ error: 'nokey' });
    if (limitedL(uid)) return res.status(429).json({ error: 'Maombi mengi sana' });
    const q = String(req.query.q || '').trim().slice(0, 60);
    const url = q
      ? 'https://api.giphy.com/v1/gifs/search?api_key=' + encodeURIComponent(k) + '&q=' + encodeURIComponent(q) + '&limit=24&rating=pg-13'
      : 'https://api.giphy.com/v1/gifs/trending?api_key=' + encodeURIComponent(k) + '&limit=24&rating=pg-13';
    const r = await fetch(url), d = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(502).json({ error: 'GIF hazipatikani kwa sasa' });
    res.json((d.data || []).map(g => ({ id: g.id, u: (g.images.fixed_height || g.images.original).url, p: (g.images.fixed_width_small || g.images.fixed_height || g.images.original).url })));
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
    res.on('close', () => body.destroy());
    body.on('error', () => { try { res.end(); } catch (e) {} });
    body.pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) res.sendStatus(500); else res.end(); }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, push: pushReady, storage: !!HK }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Unganisha inaendesha port ' + port));
