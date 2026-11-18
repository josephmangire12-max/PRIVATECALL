// Ukaguzi wa viungo: SSRF guard, ufuatiliaji wa redirects, heuristics, na Google Safe Browsing (hiari)
const dns = require('dns').promises;
const net = require('net');

const SHORT = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'ow.ly', 'rebrand.ly', 'shorturl.at', 'tiny.cc', 'rb.gy', 'buff.ly', 'lnkd.in']);
const BADTLD = /\.(zip|mov|tk|ml|ga|cf|gq|top|click|work|loan|icu|rest|monster|xyz)$/i;
const KW = /(login|signin|log-in|verify|secure|update|password|bank|mpesa|m-pesa|tigopesa|tigo-pesa|airtel|halopesa|wallet|bonus|zawadi|ushindi|prize|winner|claim|giveaway|crypto)/i;
const EXE = /\.(apk|exe|msi|scr|bat|cmd|jar|vbs|ps1|dmg|pkg)(\?|#|$)/i;
const ARC = /\.(zip|rar|7z|iso)(\?|#|$)/i;
const BADCT = /application\/(vnd\.android\.package-archive|x-msdownload|x-dosexec|x-msi|java-archive)/i;
const reg = h => h.split('.').slice(-2).join('.');

function privIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9') || x.startsWith('fea') || x.startsWith('feb')) return true;
  if (x.startsWith('::ffff:')) { const t = x.slice(7); return net.isIPv4(t) ? privIP(t) : true; }
  return false;
}
async function safeHost(h) {
  h = h.replace(/^\[|\]$/g, '');
  if (net.isIP(h)) return !privIP(h);
  const a = await dns.lookup(h, { all: true });
  return a.length > 0 && a.every(x => !privIP(x.address));
}
async function readN(body, n) {
  const rd = body.getReader(), dec = new TextDecoder();
  let s = '', len = 0;
  try { while (len < n) { const { done, value } = await rd.read(); if (done) break; len += value.length; s += dec.decode(value, { stream: true }); } } catch (e) {}
  try { rd.cancel(); } catch (e) {}
  return s;
}
async function trace(start) {
  const hops = [];
  let cur = start;
  for (let i = 0; i < 6; i++) {
    const url = new URL(cur);
    if (!/^https?:$/.test(url.protocol)) throw new Error('scheme');
    let ok = false;
    try { ok = await safeHost(url.hostname); } catch (e) { return { final: cur, error: true, hops }; }
    hops.push(cur);
    if (!ok) return { final: cur, blocked: true, hops };
    const ac = new AbortController(), tm = setTimeout(() => ac.abort(), 6000);
    let r;
    try {
      r = await fetch(cur, { method: 'GET', redirect: 'manual', signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SwiftChatLinkCheck/1.0)', Range: 'bytes=0-65535', Accept: 'text/html,*/*' } });
    } catch (e) { clearTimeout(tm); return { final: cur, error: true, hops }; }
    clearTimeout(tm);
    const loc = r.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(r.status) && loc) {
      try { r.body && r.body.cancel(); } catch (e) {}
      cur = new URL(loc, cur).href;
      continue;
    }
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    let title = '';
    if (ct.includes('text/html') && r.body) {
      const txt = await readN(r.body, 65536);
      const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(txt);
      title = m ? m[1].replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    } else { try { r.body && r.body.cancel(); } catch (e) {} }
    return { final: cur, status: r.status, ct, title, hops, disp: r.headers.get('content-disposition') || '' };
  }
  return { final: cur, tooMany: true, hops };
}
function assess(orig, t, sb) {
  const flags = []; let score = 0;
  const add = (c, w) => { flags.push(c); score += w; };
  const o = new URL(orig), f = new URL(t.final || orig);
  const oh = o.hostname.replace(/^www\./, ''), fh = f.hostname.replace(/^www\./, '');
  if (o.protocol !== 'https:' || f.protocol !== 'https:') add('http', 1);
  if (net.isIP(fh.replace(/^\[|\]$/g, '')) || net.isIP(oh.replace(/^\[|\]$/g, ''))) add('ip', 2);
  if (/xn--/i.test(fh) || /xn--/i.test(oh) || /[^\x00-\x7f]/.test(o.hostname)) add('idn', 3);
  if (o.username || o.password) add('userinfo', 3);
  if (SHORT.has(oh)) add('short', 1);
  if (reg(oh) !== reg(fh)) add('redir', 1);
  if (fh.split('.').length >= 5) add('sub', 1);
  if (BADTLD.test(fh)) add('tld', 1);
  if (KW.test(fh)) add('kw', 1); else if (KW.test(f.pathname)) add('kwp', 1);
  if (EXE.test(f.pathname) || EXE.test(o.pathname) || BADCT.test(t.ct || '')) add('exe', 5);
  else if (ARC.test(f.pathname) || /attachment/i.test(t.disp || '')) add('arc', 2);
  if (t.blocked) add('private', 5);
  if (t.error) add('down', 1);
  if (t.tooMany) add('loop', 2);
  if (sb) add('sb', 10);
  const level = score >= 5 ? 'danger' : score >= 2 ? 'warn' : 'safe';
  return { level, flags, final: t.final || orig, title: t.title || '', host: fh, status: t.status || 0, hops: (t.hops || []).length };
}
async function sbCheck(urls, key) {
  if (!key) return false;
  try {
    const r = await fetch('https://safebrowsing.googleapis.com/v4/threatMatches:find?key=' + encodeURIComponent(key), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client: { clientId: 'swiftchat', clientVersion: '1.0' },
        threatInfo: { threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE', 'POTENTIALLY_HARMFUL_APPLICATION'], platformTypes: ['ANY_PLATFORM'], threatEntryTypes: ['URL'], threatEntries: urls.map(url => ({ url })) }
      })
    });
    const d = await r.json();
    return !!(d && d.matches && d.matches.length);
  } catch (e) { return false; }
}
async function check(url, sbKey) {
  let t;
  try { t = await trace(url); } catch (e) { t = { final: url, error: true, hops: [url] }; }
  const sb = await sbCheck([url, t.final], sbKey);
  return assess(url, t, sb);
}
module.exports = { check, assess, privIP };
