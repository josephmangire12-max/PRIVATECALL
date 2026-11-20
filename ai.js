// Gemini AI: majibu ya maandishi na sticker. API key iko kwenye Railway Variables (GEMINI_API_KEY), si kwenye app.
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const key = () => process.env.GEMINI_API_KEY;
const TEXT_MODEL = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const IMG_MODEL = () => process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

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
    if (!r.ok) { const e = new Error((d.error && d.error.message) || ('Gemini ' + r.status)); e.status = r.status; throw e; }
    return d;
  } finally { clearTimeout(tm); }
}
const parts = d => (d && d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts) || [];

async function chat(messages, lang) {
  const sys = 'Wewe ni Gemini, msaidizi rafiki ndani ya app ya mawasiliano SwiftChat. Jibu kwa lugha ambayo mtumiaji anaitumia ' +
    '(Kiswahili au Kiingereza; lugha ya app sasa ni ' + (lang === 'en' ? 'Kiingereza' : 'Kiswahili') + '). Jibu kwa ufupi na kwa lugha rahisi, ' +
    'sentensi chache. Usitoe maelekezo ya kudhuru watu.';
  const d = await call(TEXT_MODEL(), {
    systemInstruction: { parts: [{ text: sys }] },
    contents: messages.map(m => ({ role: m.r === 'a' ? 'model' : 'user', parts: [{ text: m.t }] })),
    generationConfig: { maxOutputTokens: 500, temperature: 0.7 }
  }, 40000);
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
module.exports = { chat, sticker };
