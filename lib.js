// All News BD Admin – বিশুদ্ধ সহায়ক ফাংশন (DOM/Firebase ছাড়া, তাই আলাদাভাবে টেস্ট করা যায়)

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const bn = (n) => Number(n).toLocaleString('bn-BD');
export const sameId = (a, b) => a != null && b != null && String(a) === String(b);

/* Firestore Timestamp / Date / ISO স্ট্রিং / মিলিসেকেন্ড – সব থেকে Date */
export function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v instanceof Date) return v;
  if (typeof v === 'object' && typeof v.seconds === 'number') return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
export function fmtDate(v) {
  const d = toDate(v);
  if (!d) return '';
  try { return d.toLocaleString('bn-BD', { dateStyle: 'medium', timeStyle: 'short' }); } catch { return d.toISOString(); }
}
export const isoDate = (v) => { const d = toDate(v); return d ? d.toISOString() : ''; };
export const millis = (v) => { const d = toDate(v); return d ? d.getTime() : 0; };

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}
export const safeHref = (url) => (/^https?:\/\//i.test(url || '') ? url : '#');
export const isHttpUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());

/* URL যাচাই + স্বাভাবিক রূপ। http হলে https করে দেয়। */
export function normalizeUrl(raw, label = 'ওয়েবসাইটের URL') {
  let u = String(raw || '').trim();
  if (!u) return { error: `${label} দিন।` };
  if (/\s/.test(u)) return { error: 'URL-এর ভেতরে ফাঁকা জায়গা থাকতে পারবে না।' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  let url;
  try { url = new URL(u); } catch { return { error: 'URL ঠিক নয়। উদাহরণ: https://www.example.com' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { error: 'শুধু https:// লিংক দেওয়া যাবে।' };
  if (!url.hostname.includes('.')) return { error: 'URL ঠিক নয়। উদাহরণ: https://www.example.com' };
  let upgraded = false;
  if (url.protocol === 'http:') { url.protocol = 'https:'; upgraded = true; }
  const value = url.origin + (url.pathname === '/' ? '' : url.pathname) + url.search + url.hash;
  return { value, upgraded };
}

/* ডুপ্লিকেট চেনার কী: www ও শেষের / বাদ, ছোট হাতের */
export function dupKey(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '').toLowerCase() + u.pathname.replace(/\/$/, '').toLowerCase();
  } catch { return String(url).toLowerCase(); }
}

/* লেখায় বাংলা অক্ষর থাকলে bn, নইলে en */
export const hasBangla = (t) => /[\u0980-\u09FF]/.test(String(t || ''));
export const detectLang = (text) => (hasBangla(text) ? 'bn' : 'en');

export const csvCell = (v) => {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // এক্সেল ফর্মুলা ইনজেকশন ঠেকাতে
  return '"' + t.replace(/"/g, '""') + '"';
};
const cleanTxt = (t) => String(t ?? '').replace(/[|\r\n\t]+/g, ' ').trim();

/* =============== এক্সপোর্ট ===============
   rows: { id, name, url, category, category_en, category_id, logo_url, is_active, sort_order, created_at } */
export function buildExport(rows, format, day) {
  if (format === 'csv') {
    const head = ['id', 'name', 'url', 'category', 'category_en', 'category_id', 'logo_url', 'is_active', 'sort_order', 'created_at'];
    const body = rows.map((r) => head.map((h) => csvCell(r[h])).join(','));
    return { filename: `allnewsbd-sites-${day}.csv`, mime: 'text/csv', text: '\ufeff' + [head.join(','), ...body].join('\r\n') };
  }
  if (format === 'json') {
    return { filename: `allnewsbd-sites-${day}.json`, mime: 'application/json', text: JSON.stringify(rows, null, 2) };
  }
  if (format === 'txt-logo') {
    return {
      filename: `allnewsbd-sites-logo-${day}.txt`, mime: 'text/plain',
      text: rows.map((r) => `${cleanTxt(r.name)} | ${r.url} | ${cleanTxt(r.category)} | ${cleanTxt(r.logo_url)}`).join('\n'),
    };
  }
  return {
    filename: `allnewsbd-sites-${day}.txt`, mime: 'text/plain',
    text: rows.map((r) => `${cleanTxt(r.name)} | ${r.url} | ${cleanTxt(r.category)}`).join('\n'),
  };
}

/* =============== বাল্ক ইমপোর্ট পার্সার ===============
   ফরম্যাট: নাম | URL | ক্যাটাগরি | লোগো URL
   পুরোনো: নাম | URL | ক্যাটাগরি  এবং  নাম | URL | লোগো URL | (ক্যাটাগরি)
   ক্যাটাগরি মিলানো হয় বাংলা নাম, ইংরেজি নাম বা id দিয়ে।
   রিটার্ন: [{ line, raw, status: 'ok'|'dup'|'invalid', reason, row }] */
export function parseBulk(text, cats, existingKeys) {
  const catMap = new Map();
  cats.forEach((c) => {
    if (c.name) catMap.set(String(c.name).trim().toLowerCase(), String(c.id));
    if (c.name_en) catMap.set(String(c.name_en).trim().toLowerCase(), String(c.id));
    catMap.set(String(c.id).toLowerCase(), String(c.id));
  });
  const seen = new Set(existingKeys);
  const out = [];
  String(text || '').split(/\r?\n/).forEach((line, idx) => {
    const raw = line.trim();
    if (!raw || raw.startsWith('#')) return;
    const n = idx + 1;
    const parts = (raw.includes('\t') ? raw.split('\t') : raw.split('|')).map((p) => p.trim());
    const bad = (reason) => out.push({ line: n, raw, status: 'invalid', reason });
    const [name, urlRaw] = parts;
    if (!name) return bad('নাম নেই');
    if (!urlRaw) return bad('URL নেই');
    if (name.length > 120) return bad('নাম ১২০ অক্ষরের বেশি');
    const u = normalizeUrl(urlRaw);
    if (u.error) return bad('URL ঠিক নয়');

    const thirdIsLogo = isHttpUrl(parts[2]);
    const logoRaw = thirdIsLogo ? parts[2] : parts[3];
    const catRaw = thirdIsLogo ? parts[3] : parts[2];

    let category_id = null;
    if (catRaw) {
      const id = catMap.get(catRaw.toLowerCase());
      if (id == null) return bad(`ক্যাটাগরি মেলেনি: "${catRaw}"`);
      category_id = id;
    }
    let logo_url = null;
    if (logoRaw) {
      const l = normalizeUrl(logoRaw, 'লোগোর URL');
      if (l.error || !isHttpUrl(logoRaw)) return bad('লোগোর URL ঠিক নয়');
      logo_url = l.value;
    }
    const key = dupKey(u.value);
    if (seen.has(key)) return out.push({ line: n, raw, status: 'dup', reason: 'এই URL আগেই আছে (বা তালিকায় দুবার)' });
    seen.add(key);
    out.push({ line: n, raw, status: 'ok', reason: '', row: { name, url: u.value, category_id, logo_url, is_active: true } });
  });
  return out;
}

/* =============== সাজানোর সহায়ক =============== */
export function bySiteOrder(a, b) {
  const x = Number.isFinite(Number(a.sort_order)) && a.sort_order != null ? Number(a.sort_order) : 1e9;
  const y = Number.isFinite(Number(b.sort_order)) && b.sort_order != null ? Number(b.sort_order) : 1e9;
  return x - y || String(a.name).localeCompare(String(b.name));
}

/* তালিকা থেকে id নিয়ে অবস্থান বদলায়। dir: top | up | down | bottom */
export function moveInList(ids, id, dir) {
  const arr = [...ids];
  const i = arr.findIndex((x) => sameId(x, id));
  if (i < 0) return arr;
  arr.splice(i, 1);
  const to = dir === 'top' ? 0 : dir === 'bottom' ? arr.length : dir === 'up' ? i - 1 : i + 1;
  arr.splice(Math.max(0, Math.min(arr.length, to)), 0, id);
  return arr;
}

/* অ্যাপের ক্রম বজায় রেখে পরের sort_order */
export function nextOrder(items, field = 'sort_order') {
  return items.reduce((m, x) => Math.max(m, Number(x[field]) || 0), 0) + 1;
}

/* বড় তালিকাকে n-টি করে ভাগ (Firestore ব্যাচ সীমা ৫০০) */
export function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* =============== নোটিশ: স্বয়ংক্রিয় ভাষা শনাক্তকরণ ===============
   ভুল ঘরে অন্য ভাষা লিখলে (বাংলা ঘরে ইংরেজি বা উল্টো) সঠিক ঘরে সরিয়ে দেয়।
   f = { title_bn, title_en, description_bn, description_en } → { fields, moved } */
export function fixNoticeLangs(f) {
  const t = (v) => String(v ?? '').trim();
  let bnT = t(f.title_bn), enT = t(f.title_en), bnD = t(f.description_bn), enD = t(f.description_en);
  const bnSide = `${bnT} ${bnD}`.trim();
  const enSide = `${enT} ${enD}`.trim();
  let moved = false;
  if (bnSide && !hasBangla(bnSide) && enSide && hasBangla(enSide)) {
    [bnT, enT] = [enT, bnT]; [bnD, enD] = [enD, bnD]; moved = true; // দুটোই উল্টো ঘরে
  } else if (bnSide && !hasBangla(bnSide) && !enSide) {
    enT = bnT; enD = bnD; bnT = ''; bnD = ''; moved = true; // শুধু বাংলা ঘরে ইংরেজি
  } else if (enSide && hasBangla(enSide) && !bnSide) {
    bnT = enT; bnD = enD; enT = ''; enD = ''; moved = true; // শুধু ইংরেজি ঘরে বাংলা
  }
  return { fields: { title_bn: bnT, title_en: enT, description_bn: bnD, description_en: enD }, moved };
}
