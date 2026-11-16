const express = require('express');
const path = require('path');
const admin = require('firebase-admin');

let pushReady = false;
try {
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
  pushReady = true;
} catch (e) {
  console.warn('FIREBASE_SERVICE_ACCOUNT haijawekwa au si sahihi: push imezimwa.');
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

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, push: pushReady }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log('Unganisha inaendesha port ' + port));
