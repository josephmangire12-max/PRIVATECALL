// Gemini AI: majibu ya maandishi na sticker. API key iko kwenye Railway Variables (GEMINI_API_KEY), si kwenye app.
// Model hazijafungwa kwenye msimbo: server inauliza Google orodha ya model zinazopatikana na kuchagua mpya zaidi.
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const key = () => process.env.GEMINI_API_KEY;
const clean = m => String(m || '').split(key() || '\u0000').join('***').slice(0, 240);

async function call(model, body, ms) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(API + '/' + model + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key() },
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(clean((d.error && d.error.message) || ('Gemini ' + r.status))); e.status = r.status; e.model = model; throw e; }
    return d;
  } finally { clearTimeout(tm); }
}
const parts = d => (d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];

// ---- ugunduzi wa model ----
const ver = n => { const m = /gemini-(\d+(?:\.\d+)?)/.exec(n); return m ? parseFloat(m[1]) : 0; };
const BAD = /image|tts|live|audio|embed|aqa|imagen|veo|robot|computer|learn|research|gemma|exp|thinking|vision/i;
const names = ms => ms.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name).replace(/^models\//, '')).filter(n => /^gemini-/.test(n));
function pickText(ms) {
  return names(ms).filter(n => /flash/.test(n) && !BAD.test(n))
    .sort((a, b) => ver(b) - ver(a) || (/lite/.test(a) ? 1 : 0) - (/lite/.test(b) ? 1 : 0) || (/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0) || a.length - b.length);
}
function pickImage(ms) {
  return names(ms).filter(n => /image/.test(n) && !/live|tts|audio|embed/i.test(n))
    .sort((a, b) => ver(b) - ver(a) || (/preview/.test(a) ? 1 : 0) - (/preview/.test(b) ? 1 : 0) || a.length - b.length);
}
async function listModels() {
  const out = []; let tok = '';
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + '?pageSize=200' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''), { headers: { 'x-goog-api-key': key() } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(clean((d.error && d.error.message) || ('Gemini ' + r.status))); e.status = r.status; throw e; }
    (d.models || []).forEach(m => out.push(m));
    tok = d.nextPageToken; if (!tok) break;
  }
  return out;
}
let mc = { t: 0, text: [], image: [] };
async function discover(force) {
  if (!force && mc.t && Date.now() - mc.t < 6 * 3600e3) return mc;
  try { const ms = await listModels(); mc = { t: Date.now(), text: pickText(ms), image: pickImage(ms) }; }
  catch (e) { if (e.status === 400 || e.status === 403) throw e; mc = { t: Date.now() - 5 * 3600e3, text: mc.text, image: mc.image }; } // jaribu tena baada ya saa 1
  return mc;
}
const uniq = a => [...new Set(a.filter(Boolean))];
const textList = d => uniq([process.env.GEMINI_MODEL, ...d.text.slice(0, 3), 'gemini-flash-latest']);
const imageList = d => uniq([process.env.GEMINI_IMAGE_MODEL, ...d.image.slice(0, 3), 'gemini-2.5-flash-image']);
// Jaribu model moja baada ya nyingine; 404 = model haipo, endelea. Ripoti kosa la kwanza (lenye maana zaidi).
async function withModels(listFn, run) {
  for (let pass = 0; pass < 2; pass++) {
    const d = await discover(pass === 1);
    let first = null;
    for (const model of listFn(d)) {
      try { return await run(model); }
      catch (e) { if (e.status !== 404) throw e; first = first || e; }
    }
    if (pass === 1 && first) throw first;
  }
}

async function chat(messages, lang) {
  const sys = 'Wewe ni Gemini, msaidizi rafiki ndani ya app ya mawasiliano SwiftChat. Jibu kwa lugha ambayo mtumiaji anaitumia ' +
    '(Kiswahili au Kiingereza; lugha ya app sasa ni ' + (lang === 'en' ? 'Kiingereza' : 'Kiswahili') + '). Jibu kwa ufupi na kwa lugha rahisi, ' +
    'sentensi chache. Usitoe maelekezo ya kudhuru watu.';
  const d = await withModels(textList, model => {
    const gc = { maxOutputTokens: 1024, temperature: 0.7 };
    if (/2\.5/.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
    return call(model, {
      systemInstruction: { parts: [{ text: sys }] },
      contents: messages.map(m => ({ role: m.r === 'a' ? 'model' : 'user', parts: [{ text: m.t }] })),
      generationConfig: gc
    }, 40000);
  });
  const text = parts(d).map(p => p.text || '').join('').trim();
  if (!text) { const e = new Error('blocked'); e.code = 'blocked'; throw e; }
  return text.slice(0, 3000);
}

async function sticker(prompt) {
  const p = String(prompt || '').trim().slice(0, 200);
  const text = 'Create a die-cut sticker illustration: ' + p + '. Style: cute, bold clean outlines, vibrant flat colors, ' +
    'single centered subject, thick white border around it, plain solid white background, no text unless it is requested.';
  const d = await withModels(imageList, model => call(model, {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  }, 60000));
  const img = parts(d).find(x => x.inlineData || x.inline_data);
  const id = img && (img.inlineData || img.inline_data);
  if (!id || !id.data) { const e = new Error('blocked'); e.code = 'blocked'; throw e; }
  return { mime: id.mimeType || id.mime_type || 'image/png', data: id.data };
}

function hint(e) {
  const s = e && e.status, m = (e && e.message) || '';
  if (e && e.name === 'AbortError') return 'Gemini imechelewa kujibu, jaribu tena.';
  if (s === 400 && /api key/i.test(m)) return 'API key si sahihi. Angalia GEMINI_API_KEY kwenye Railway.';
  if (s === 400 && /location|region/i.test(m)) return 'Gemini haipatikani kwenye eneo la server hii.';
  if (s === 400) return 'Gemini imekataa ombi.';
  if (s === 401 || s === 403) return 'API key haina ruhusa, au Generative Language API haijawashwa kwenye project ya key.';
  if (s === 404) return 'Hakuna model ya Gemini inayopatikana kwenye key hii. Weka GEMINI_MODEL sahihi.';
  if (s === 429) return 'Kikomo cha Gemini (quota) kimefikiwa. Jaribu tena baadaye, au angalia billing ya key.';
  return 'Gemini haipatikani kwa sasa, jaribu tena.';
}
async function diag() {
  const out = { key: !!key() };
  if (!out.key) return out;
  try {
    const d = await discover(true);
    out.textModels = textList(d).slice(0, 3); out.imageModels = imageList(d).slice(0, 2);
    let used = '';
    await withModels(textList, async model => { const r = await call(model, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 16 } }, 15000); used = model; return r; });
    out.textModel = used; out.text = { ok: true };
  } catch (e) { out.text = { ok: false, status: e.status || 0, detail: e.message, hint: hint(e) }; }
  return out;
}
module.exports = { chat, sticker, hint, diag, pickText, pickImage };
