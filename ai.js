// Gemini AI: majibu ya maandishi na sticker. API key iko kwenye Railway Variables (GEMINI_API_KEY), si kwenye app.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const key = () => process.env.GEMINI_API_KEY;
const TEXT_MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const IMG_MODEL = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const clean = m => String(m || '').split(key() || '\u0000').join('***').slice(0, 240);
async function call(model, body, ms) {
  const ac = new AbortController(), tm = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(BASE + model + ':generateContent', {
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

async function chat(messages, lang) {
  const sys = 'Wewe ni Gemini, msaidizi rafiki ndani ya app ya mawasiliano SwiftChat. Jibu kwa lugha ambayo mtumiaji anaitumia ' +
    '(Kiswahili au Kiingereza; lugha ya app sasa ni ' + (lang === 'en' ? 'Kiingereza' : 'Kiswahili') + '). Jibu kwa ufupi na kwa lugha rahisi, ' +
    'sentensi chache. Usitoe maelekezo ya kudhuru watu.';
  let d, lastErr;
  for (const model of [...new Set([TEXT_MODEL(), 'gemini-2.0-flash'])]) {
    const gc = { maxOutputTokens: 600, temperature: 0.7 };
    if (/2\.5/.test(model)) gc.thinkingConfig = { thinkingBudget: 0 };
    try {
      d = await call(model, {
        systemInstruction: { parts: [{ text: sys }] },
        contents: messages.map(m => ({ role: m.r === 'a' ? 'model' : 'user', parts: [{ text: m.t }] })),
        generationConfig: gc
      }, 40000);
      break;
    } catch (e) { lastErr = e; if (e.status !== 404) throw e; }
  }
  if (!d) throw lastErr;
  const text = parts(d).map(p => p.text || '').join('').trim();
  if (!text) { const e = new Error('blocked'); e.code = 'blocked'; throw e; }
  return text.slice(0, 3000);
}

async function sticker(prompt) {
  const p = String(prompt || '').trim().slice(0, 200);
  const text = 'Create a die-cut sticker illustration: ' + p + '. Style: cute, bold clean outlines, vibrant flat colors, ' +
    'single centered subject, thick white border around it, plain solid white background, no text unless it is requested.';
  const d = await call(IMG_MODEL(), {
    contents: [{ parts: [{ text }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  }, 60000);
  const img = parts(d).find(x => x.inlineData || x.inline_data);
  const id = img && (img.inlineData || img.inline_data);
  if (!id || !id.data) { const e = new Error('blocked'); e.code = 'blocked'; throw e; }
  return { mime: id.mimeType || id.mime_type || 'image/png', data: id.data };
}
// Maelezo ya kosa kwa mtumiaji (bila kufichua key)
function hint(e) {
  const s = e && e.status, m = (e && e.message) || '';
  if (e && e.name === 'AbortError') return 'Gemini imechelewa kujibu, jaribu tena.';
  if (s === 400 && /api key/i.test(m)) return 'API key si sahihi. Angalia GEMINI_API_KEY kwenye Railway.';
  if (s === 400 && /location|region/i.test(m)) return 'Gemini haipatikani kwenye eneo la server hii.';
  if (s === 400) return 'Gemini imekataa ombi.';
  if (s === 401 || s === 403) return 'API key haina ruhusa, au Generative Language API haijawashwa kwenye project ya key.';
  if (s === 404) return 'Model "' + ((e && e.model) || '') + '" haipatikani. Weka GEMINI_MODEL au GEMINI_IMAGE_MODEL sahihi.';
  if (s === 429) return 'Kikomo cha Gemini (quota) kimefikiwa. Jaribu tena baadaye, au angalia billing ya key.';
  return 'Gemini haipatikani kwa sasa, jaribu tena.';
}
async function diag() {
  const out = { key: !!key(), textModel: TEXT_MODEL(), imageModel: IMG_MODEL() };
  if (!out.key) return out;
  try {
    await call(TEXT_MODEL(), { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 10 } }, 15000);
    out.text = { ok: true };
  } catch (e) { out.text = { ok: false, status: e.status || 0, detail: e.message, hint: hint(e) }; }
  return out;
}
module.exports = { chat, sticker, hint, diag };
