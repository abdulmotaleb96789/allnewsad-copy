/* =====================================================================
   All News BD – এডমিন প্যানেল (Firebase সংস্করণ)
   ---------------------------------------------------------------------
   Backend: Firebase Authentication + Cloud Firestore (+ Cloud Functions, ঐচ্ছিক)
   ১) কোনো গোপন কী এখানে নেই। আসল সুরক্ষা firestore.rules-এ।
   ২) এডমিন কি না তা Firestore-এর admins/{uid} ডকুমেন্ট দিয়ে যাচাই হয়।
   ৩) লোগো শুধু URL আকারে জমা হয়। কোনো ফাইল আপলোড বা Storage নেই।
   ===================================================================== */

import {
  auth, db, functions, isConfigured, persistenceReady,
  onAuthStateChanged, signInWithEmailAndPassword, signOut,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch,
  serverTimestamp, Timestamp, httpsCallable,
} from './firebase-config.js';
import {
  esc, bn, sameId, toDate, fmtDate, isoDate, millis, hostOf, safeHref, isHttpUrl,
  normalizeUrl, dupKey, buildExport, parseBulk, bySiteOrder, moveInList, nextOrder, chunk, fixNoticeLangs,
} from './lib.js';

const PAGE_SIZE = 50;
const BATCH = 400; // Firestore ব্যাচে সর্বোচ্চ ৫০০টি লেখা; নিরাপদ সীমা ৪০০
const ADMIN_ROLES = ['admin', 'super_admin'];

/* ---------- সহায়ক ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const state = {
  me: null,
  cats: [], sites: [], users: [], admins: new Map(), menu: [], notices: [],
  loading: { core: false, users: false, menu: false, notices: false },
  err: { core: null, users: null, menu: null, notices: null },
  tab: 'dashboard',
  q: '', cat: 'all', status: 'all', shown: PAGE_SIZE,
  sel: new Set(),
  editingSiteId: null, editingCatId: null, editingMenuId: null, editingNoticeId: null,
  bulkItems: [], orderIds: [], orderCat: null,
  us: { q: '', filter: 'all', shown: PAGE_SIZE },
};

/* ---------- টোস্ট ---------- */
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'err' ? ' err' : '');
  el.textContent = msg;
  $('#toast-region').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6500 : 3500);
}

/* ---------- Firebase এরর → বাংলা বার্তা ---------- */
function errText(e) {
  const code = String(e?.code || '');
  const msg = String(e?.message || '');
  const m = msg.toLowerCase();
  if (code.startsWith('auth/')) return authErrText(e);
  switch (code.replace(/^functions\//, '')) {
    case 'permission-denied':
      return 'অনুমতি নেই। এডমিন অ্যাকাউন্টে লগইন আছে কি না এবং Firestore Rules ডিপ্লয় হয়েছে কি না দেখুন।';
    case 'unauthenticated':
      return 'সেশন শেষ হয়েছে, আবার লগইন করুন।';
    case 'unavailable':
      return 'সার্ভারে পৌঁছানো যাচ্ছে না। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।';
    case 'deadline-exceeded':
      return 'সময় শেষ হয়ে গেছে, আবার চেষ্টা করুন।';
    case 'not-found':
      return code.startsWith('functions/')
        ? 'Cloud Function পাওয়া যায়নি। আগে functions ডিপ্লয় করুন (গাইড দেখুন)।'
        : 'ডকুমেন্টটি পাওয়া যায়নি (হয়তো অন্য জায়গা থেকে মুছে গেছে)। তালিকা রিফ্রেশ করুন।';
    case 'already-exists':
      return 'এই তথ্য আগেই আছে।';
    case 'resource-exhausted':
      return 'Firebase-এর দৈনিক সীমা বা কোটা শেষ হয়েছে। পরে চেষ্টা করুন।';
    case 'failed-precondition':
      return m.includes('index') ? 'Firestore-এ প্রয়োজনীয় ইনডেক্স নেই। firestore.indexes.json ডিপ্লয় করুন।' : (msg || 'শর্ত পূরণ হয়নি।');
    case 'invalid-argument':
      return msg || 'তথ্য ঠিক নয়।';
    case 'internal':
      return 'সার্ভারে সমস্যা হয়েছে। একটু পরে আবার চেষ্টা করুন।';
    default:
  }
  if (m.includes('failed to fetch') || m.includes('network') || m.includes('offline')) return 'ইন্টারনেট সংযোগ নেই, আবার চেষ্টা করুন।';
  return msg || 'সমস্যা হয়েছে, আবার চেষ্টা করুন।';
}

function authErrText(e) {
  switch (e?.code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-login-credentials':
      return 'ইমেইল বা পাসওয়ার্ড ভুল।';
    case 'auth/invalid-email': return 'ইমেইল ঠিকানাটি সঠিক নয়।';
    case 'auth/user-disabled': return 'এই অ্যাকাউন্টটি বন্ধ করা আছে।';
    case 'auth/too-many-requests': return 'অনেকবার চেষ্টা হয়েছে, কিছুক্ষণ পরে আবার চেষ্টা করুন।';
    case 'auth/network-request-failed': return 'ইন্টারনেট সংযোগ নেই, আবার চেষ্টা করুন।';
    case 'auth/operation-not-allowed': return 'Firebase Authentication-এ Email/Password সাইন-ইন চালু নেই। কনসোলে চালু করুন।';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid.-please-pass-a-valid-api-key.':
      return 'firebase-config.js-এর apiKey ঠিক নয়।';
    case 'auth/unauthorized-domain': return 'এই ডোমেইন Firebase Authentication-এর Authorized domains-এ যোগ করা নেই।';
    default: return e?.message || 'লগইন করা যায়নি।';
  }
}

/* সেশন হারালে স্বয়ংক্রিয় লগআউট; বাকি এরর ওপরে ছেড়ে দেয় */
async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e?.code === 'unauthenticated' || e?.code === 'functions/unauthenticated') {
      loginNotice = 'সেশন শেষ হয়েছে, আবার লগইন করুন।';
      await signOut(auth).catch(() => {});
    }
    throw e;
  }
}

const snapList = (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id }));
/* বাটন ব্যস্ত অবস্থায় বন্ধ রাখে ও লেখা বদলায়; শেষে আগের লেখা ফিরিয়ে দেয় */
function setBusy(btn, busy, label) {
  if (busy) {
    if (btn.dataset.label == null) btn.dataset.label = btn.textContent;
    btn.disabled = true;
    if (label) btn.textContent = label;
  } else {
    btn.disabled = false;
    if (btn.dataset.label != null) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  }
}

/* =====================================================================
   লগইন / লগআউট / সেশন
   ===================================================================== */
let loginNotice = null;
let entering = false;

function showLogin(msg) {
  $('#boot').hidden = true;
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
  document.body.classList.remove('has-bulkbar');
  const el = $('#login-error');
  el.textContent = msg || '';
  el.hidden = !msg;
  $('#login-btn').disabled = !isConfigured;
  $('#login-btn').textContent = 'লগইন';
}

function showApp() {
  $('#boot').hidden = true;
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
}

function clearData() {
  Object.assign(state, { cats: [], sites: [], users: [], admins: new Map(), menu: [], notices: [], me: null });
  state.sel.clear();
  closeSidebar();
}

async function verifyAdmin(user) {
  const snap = await getDoc(doc(db, 'admins', user.uid));
  if (!snap.exists()) return null;
  const role = snap.data().role;
  return ADMIN_ROLES.includes(role) ? { uid: user.uid, email: user.email || '', role } : null;
}

async function enterApp(user) {
  let me;
  try {
    me = await verifyAdmin(user);
  } catch (e) {
    loginNotice = errText(e);
    await signOut(auth);
    return;
  }
  if (!me) {
    loginNotice = 'এই অ্যাকাউন্টে এডমিন অনুমতি নেই।';
    await signOut(auth);
    return;
  }
  state.me = me;
  $('#who-email').textContent = me.email;
  $('#login-pass').value = '';
  showApp();
  applyRoute();
  loadAll();
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const email = $('#login-email').value.trim();
  const password = $('#login-pass').value;
  const errEl = $('#login-error');
  errEl.hidden = true;
  if (!isConfigured) return showLogin('আগে firebase-config.js-এ আপনার Firebase কনফিগ বসান।');
  if (!email || !password) {
    errEl.textContent = 'ইমেইল ও পাসওয়ার্ড দিন।';
    errEl.hidden = false;
    return;
  }
  const btn = $('#login-btn');
  btn.disabled = true;
  btn.textContent = 'লগইন হচ্ছে…';
  try {
    await persistenceReady;
    await signInWithEmailAndPassword(auth, email, password);
    // বাকি কাজ onAuthStateChanged-এ (এডমিন যাচাই → ড্যাশবোর্ড)
  } catch (e) {
    showLogin(authErrText(e));
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await signOut(auth); } catch (e) { toast(errText(e), 'err'); }
});

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    clearData();
    const msg = loginNotice || (isConfigured ? null : 'আগে firebase-config.js-এ আপনার Firebase কনফিগ বসান।');
    loginNotice = null;
    showLogin(msg);
    return;
  }
  if (state.me && state.me.uid === user.uid) return; // টোকেন রিফ্রেশ
  if (entering) return;
  entering = true;
  try { await enterApp(user); } finally { entering = false; }
});

/* =====================================================================
   ডেটা লোড (সরাসরি Cloud Firestore থেকে)
   ===================================================================== */
async function loadCore() {
  state.loading.core = true; state.err.core = null;
  renderAll();
  try {
    const [cs, ws] = await guard(() => Promise.all([getDocs(collection(db, 'categories')), getDocs(collection(db, 'websites'))]));
    state.cats = snapList(cs).sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.name).localeCompare(String(b.name)));
    state.sites = snapList(ws).sort((a, b) => millis(b.created_at) - millis(a.created_at));
  } catch (e) {
    state.err.core = errText(e);
  }
  state.loading.core = false;
  renderAll();
}

async function loadUsers() {
  state.loading.users = true; state.err.users = null;
  renderUsers(); renderStats();
  try {
    const us = await guard(() => getDocs(collection(db, 'users')));
    state.users = snapList(us).sort((a, b) => millis(b.created_at) - millis(a.created_at));
    try {
      const ad = await getDocs(collection(db, 'admins'));
      state.admins = new Map(ad.docs.map((d) => [d.id, d.data()]));
    } catch { state.admins = new Map(state.me ? [[state.me.uid, { role: state.me.role }]] : []); }
  } catch (e) {
    state.users = [];
    state.err.users = errText(e);
  }
  state.loading.users = false;
  renderUsers(); renderStats();
}

/* পুরোনো (Supabase-ধাঁচের) ও নতুন দুই রকম ডকুমেন্টই পড়া যায় */
function normMenu(d) {
  const type = d.type || d.action_type || 'url';
  const valueByType = { url: d.url, email: d.email, share: d.share_text, dialog: d.dialog_content };
  return {
    ...d,
    item_key: d.item_key || d.id,
    type,
    group: Number(d.group ?? d.group_no ?? 1) || 1,
    sort_order: Number(d.sort_order) || 0,
    value: valueByType[type] || d.value || '',
  };
}
async function loadMenu() {
  state.loading.menu = true; state.err.menu = null;
  renderMenu(); renderStats();
  try {
    state.menu = snapList(await guard(() => getDocs(collection(db, 'more_menu')))).map(normMenu);
  } catch (e) { state.menu = []; state.err.menu = errText(e); }
  state.loading.menu = false;
  renderMenu(); renderStats();
}

function normNotice(d) {
  const isBn = d.lang === 'bn';
  return {
    ...d,
    title_bn: d.title_bn ?? (isBn ? d.title : '') ?? '',
    title_en: d.title_en ?? (!isBn && d.title ? d.title : '') ?? '',
    description_bn: d.description_bn ?? (isBn ? d.message : '') ?? '',
    description_en: d.description_en ?? (!isBn && d.message ? d.message : '') ?? '',
    details_url: d.details_url ?? d.link_url ?? null,
  };
}
async function loadNotices() {
  state.loading.notices = true; state.err.notices = null;
  renderNotices(); renderStats();
  try {
    state.notices = snapList(await guard(() => getDocs(collection(db, 'notices'))))
      .map(normNotice).sort((a, b) => millis(b.created_at) - millis(a.created_at));
  } catch (e) { state.notices = []; state.err.notices = errText(e); }
  state.loading.notices = false;
  renderNotices(); renderStats();
}

function loadAll() {
  return Promise.all([loadCore(), loadUsers(), loadMenu(), loadNotices()]);
}

/* =====================================================================
   নেভিগেশন (সাইডবার + #hash)
   ===================================================================== */
const TITLES = { dashboard: 'ড্যাশবোর্ড', websites: 'ওয়েবসাইট', categories: 'ক্যাটাগরি', menu: 'More মেনু', notices: 'নোটিশ', users: 'ইউজার' };

function showTab(tab) {
  if (!TITLES[tab]) tab = 'dashboard';
  state.tab = tab;
  Object.keys(TITLES).forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#page-title').textContent = TITLES[tab];
  document.title = `${TITLES[tab]} – All News BD এডমিন`;
  closeSidebar();
  updateBulkBar();
  window.scrollTo(0, 0);
}
function applyRoute() { showTab(location.hash.replace('#', '')); }
window.addEventListener('hashchange', () => { if (state.me) applyRoute(); });
function go(tab) {
  if (location.hash === '#' + tab) showTab(tab); else location.hash = tab;
}

$$('#nav button').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
  $('#burger').setAttribute('aria-expanded', 'false');
}
$('#burger').addEventListener('click', () => {
  const open = !$('#sidebar').classList.contains('open');
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
  $('#burger').setAttribute('aria-expanded', String(open));
});
$('#scrim').addEventListener('click', closeSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidebar(); });

$$('.stat[data-go]').forEach((card) => card.addEventListener('click', () => {
  const { go: tab, goStatus, goFilter } = card.dataset;
  if (tab === 'websites') {
    state.status = goStatus || 'all'; state.cat = 'all'; state.q = ''; state.shown = PAGE_SIZE;
    $('#f-status').value = state.status; $('#f-search').value = '';
    renderCatFilter(); renderSites();
  }
  if (tab === 'users') {
    state.us.filter = goFilter || 'all'; state.us.shown = PAGE_SIZE;
    $('#us-filter').value = state.us.filter; renderUsers();
  }
  go(tab);
}));
$('#dash-reload').addEventListener('click', async () => {
  await loadAll();
  const errs = Object.values(state.err).filter(Boolean);
  if (errs.length) toast(errs[0], 'err'); else toast('সব তথ্য রিফ্রেশ হয়েছে');
});

/* =====================================================================
   ডায়ালগ সহায়ক
   ===================================================================== */
$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

function confirmBox({ title, message, okText = 'মুছুন', danger = true }) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-confirm');
    $('#cf-title').textContent = title;
    $('#cf-msg').textContent = message;
    const ok = $('#cf-ok');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
    dlg.showModal();
  });
}

function setError(sel, msg) {
  const el = $(sel);
  el.textContent = msg || '';
  el.hidden = !msg;
}

function fillCatSelect(sel, current, withNone = true, exclude = null) {
  sel.innerHTML =
    (withNone ? '<option value="">ক্যাটাগরি ছাড়া</option>' : '') +
    state.cats.filter((c) => !sameId(c.id, exclude)).map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = current != null ? String(current) : '';
}

const loadingRow = '<li class="loading-row"><span class="spinner" aria-hidden="true"></span> লোড হচ্ছে…</li>';
const emptyBox = (text, actionHtml = '') => `<li class="empty"><svg class="ic"><use href="#i-inbox"/></svg>${text}${actionHtml}</li>`;
const errBox = (text, retryId) => `<li class="empty err">${esc(text)}<br><button class="btn ghost small" type="button" id="${retryId}">আবার চেষ্টা করুন</button></li>`;

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* নিচের ফলব্যাক */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ছবি লোড না হলে নামের প্রথম অক্ষর (শুধু তালিকার আইকনে) */
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img && img.tagName === 'IMG' && img.dataset.letter) img.parentElement.textContent = img.dataset.letter;
}, true);

/* Firestore-এ লেখার সময় ব্যাচে ভাগ করে চালায়; সফল সংখ্যা ফেরত দেয় */
async function runBatches(items, apply) {
  let done = 0;
  for (const part of chunk(items, BATCH)) {
    const batch = writeBatch(db);
    part.forEach((it) => apply(batch, it));
    await guard(() => batch.commit());
    done += part.length;
  }
  return done;
}

/* =====================================================================
   রেন্ডার: ড্যাশবোর্ড, ওয়েবসাইট, ক্যাটাগরি
   ===================================================================== */
const catById = (id) => (id == null || id === '' ? null : state.cats.find((x) => sameId(x.id, id)) || null);
const catName = (id) => catById(id)?.name || '';

function renderStats() {
  const set = (id, val, err) => { $(id).textContent = err ? '–' : bn(val); };
  const active = state.sites.filter((s) => s.is_active).length;
  set('#st-total', state.sites.length, state.err.core);
  set('#st-active', active, state.err.core);
  set('#st-inactive', state.sites.length - active, state.err.core);
  set('#st-cats', state.cats.length, state.err.core);
  set('#st-users', state.users.length, state.err.users);
  set('#st-banned', state.users.filter((u) => u.is_banned).length, state.err.users);
  set('#st-notices', state.notices.length, state.err.notices);
  set('#st-menu', state.menu.length, state.err.menu);
  const errs = [state.err.core, state.err.users, state.err.menu, state.err.notices].filter(Boolean);
  const el = $('#dash-error');
  el.textContent = errs.length ? `কিছু তথ্য লোড হয়নি: ${errs[0]}` : '';
  el.hidden = !errs.length;
}

function renderCatFilter() {
  const sel = $('#f-cat');
  const keep = state.cat;
  sel.innerHTML =
    '<option value="all">সব ক্যাটাগরি</option><option value="none">ক্যাটাগরি ছাড়া</option>' +
    state.cats.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  sel.value = Array.from(sel.options).some((o) => o.value === keep) ? keep : 'all';
  state.cat = sel.value;
}

/* একই ক্যাটাগরির সাইট (category null = ক্যাটাগরি ছাড়া) */
const inCat = (s, catId) => (catId == null ? s.category_id == null || s.category_id === '' : sameId(s.category_id, catId));
const nextSiteOrder = (catId, extra = []) => nextOrder([...state.sites.filter((s) => inCat(s, catId)), ...extra]);

function filteredSites() {
  const q = state.q.trim().toLowerCase();
  const specific = state.cat !== 'all' && state.cat !== 'none';
  const out = state.sites.filter((s) => {
    if (state.cat === 'none') { if (!inCat(s, null)) return false; }
    else if (state.cat !== 'all' && !sameId(s.category_id, state.cat)) return false;
    if (state.status === 'active' && !s.is_active) return false;
    if (state.status === 'inactive' && s.is_active) return false;
    if (q && !(String(s.name).toLowerCase().includes(q) || String(s.url).toLowerCase().includes(q))) return false;
    return true;
  });
  if (specific) out.sort(bySiteOrder); // অ্যাপের মতো একই ক্রমে
  return out;
}

function siteRow(s) {
  const host = hostOf(s.url);
  const icon = s.logo_url || `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
  const letter = esc(String(s.name || '?').trim().charAt(0) || '?');
  const cat = catName(s.category_id);
  const picked = state.sel.has(String(s.id));
  return `<li class="row ${s.is_active ? '' : 'off'} ${picked ? 'sel' : ''}" data-id="${esc(s.id)}">
    <label class="pick"><input type="checkbox" data-action="select" ${picked ? 'checked' : ''} aria-label="${esc(s.name)} নির্বাচন"></label>
    <div class="ico"><img src="${esc(icon)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-letter="${letter}"></div>
    <div class="main">
      <strong title="${esc(s.name)}">${esc(s.name)}</strong>
      <a href="${esc(safeHref(s.url))}" target="_blank" rel="noopener noreferrer">${esc(host)}</a>
    </div>
    <div class="cat">${cat ? `<span class="pill">${esc(cat)}</span>` : '<span class="pill none">ক্যাটাগরি নেই</span>'}</div>
    <label class="switch" title="অ্যাপে দেখানো হবে কি না">
      <input type="checkbox" data-action="toggle" ${s.is_active ? 'checked' : ''} aria-label="${esc(s.name)} সক্রিয়">
      <span></span><em>${s.is_active ? 'সক্রিয়' : 'বন্ধ'}</em>
    </label>
    <div class="acts">
      <button class="btn ghost small" type="button" data-action="edit">এডিট</button>
      <button class="btn danger-ghost small" type="button" data-action="delete">মুছুন</button>
    </div>
  </li>`;
}

function renderSites() {
  const list = $('#site-list');
  const more = $('#btn-more');
  const info = $('#site-count');
  if (state.loading.core && !state.sites.length) {
    list.innerHTML = loadingRow; info.textContent = ''; more.hidden = true; updateBulkBar(); return;
  }
  if (state.err.core) {
    list.innerHTML = errBox(state.err.core, 'retry-core'); info.textContent = ''; more.hidden = true; updateBulkBar(); return;
  }
  const all = filteredSites();
  const part = all.slice(0, state.shown);
  if (!state.sites.length) {
    list.innerHTML = emptyBox('এখনো কোনো ওয়েবসাইট নেই। "নতুন সাইট" চেপে প্রথমটি যোগ করুন।');
    info.textContent = ''; more.hidden = true;
  } else if (!all.length) {
    list.innerHTML = emptyBox('কিছু পাওয়া যায়নি। ফিল্টার বা খোঁজার শব্দ বদলে দেখুন।');
    info.textContent = ''; more.hidden = true;
  } else {
    info.textContent = `${bn(all.length)}টির মধ্যে ${bn(part.length)}টি দেখানো হচ্ছে`;
    list.innerHTML = part.map(siteRow).join('');
    more.hidden = all.length <= part.length;
  }
  updateBulkBar();
}

function renderCats() {
  const list = $('#cat-list');
  if (state.loading.core && !state.cats.length) { list.innerHTML = loadingRow; return; }
  if (state.err.core) { list.innerHTML = errBox(state.err.core, 'retry-core2'); return; }
  if (!state.cats.length) { list.innerHTML = emptyBox('এখনো কোনো ক্যাটাগরি নেই। "নতুন ক্যাটাগরি" চেপে যোগ করুন।'); return; }
  list.innerHTML = state.cats.map((c, i) => {
    const n = state.sites.filter((s) => sameId(s.category_id, c.id)).length;
    return `<li class="row catrow" data-id="${esc(c.id)}">
      <div class="main"><strong>${esc(c.name)}</strong><span>${c.name_en ? esc(c.name_en) : '<b style="color:var(--red)">ইংরেজি নাম নেই</b>'} · ক্রম ${bn(c.sort_order ?? 0)} · ${bn(n)}টি সাইট</span></div>
      <div class="acts">
        <button class="btn ghost small mv" type="button" data-action="up" aria-label="উপরে নিন" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn ghost small mv" type="button" data-action="down" aria-label="নিচে নিন" ${i === state.cats.length - 1 ? 'disabled' : ''}>▼</button>
        <button class="btn ghost small" type="button" data-action="sites">সাইট দেখুন</button>
        <button class="btn ghost small" type="button" data-action="edit">এডিট</button>
        <button class="btn danger-ghost small" type="button" data-action="delete">মুছুন</button>
      </div>
    </li>`;
  }).join('');
}

function renderAll() {
  const ids = new Set(state.sites.map((s) => String(s.id)));
  state.sel.forEach((id) => { if (!ids.has(id)) state.sel.delete(id); });
  renderStats();
  renderCatFilter();
  renderSites();
  renderCats();
}

document.addEventListener('click', (e) => {
  const id = e.target?.id;
  if (id === 'retry-core' || id === 'retry-core2') loadCore();
  if (id === 'retry-users') loadUsers();
  if (id === 'retry-menu') loadMenu();
  if (id === 'retry-notices') loadNotices();
});

/* =====================================================================
   ফিল্টার ও খোঁজ
   ===================================================================== */
let searchTimer;
$('#f-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value; state.shown = PAGE_SIZE; renderSites(); }, 150);
});
$('#f-cat').addEventListener('change', (e) => { state.cat = e.target.value; state.shown = PAGE_SIZE; renderSites(); });
$('#f-status').addEventListener('change', (e) => { state.status = e.target.value; state.shown = PAGE_SIZE; renderSites(); });
$('#btn-more').addEventListener('click', () => { state.shown += PAGE_SIZE; renderSites(); });
$('#btn-reload').addEventListener('click', async () => {
  await loadCore();
  if (!state.err.core) toast('তালিকা রিফ্রেশ হয়েছে'); else toast(state.err.core, 'err');
});
$('#btn-cat-reload').addEventListener('click', async () => {
  await loadCore();
  if (!state.err.core) toast('ক্যাটাগরি রিফ্রেশ হয়েছে'); else toast(state.err.core, 'err');
});

/* =====================================================================
   সাইট নির্বাচন ও একসাথে অ্যাকশন
   ===================================================================== */
function updateBulkBar() {
  const n = state.sel.size;
  const show = n > 0 && state.tab === 'websites';
  $('#bulkbar').hidden = !show;
  document.body.classList.toggle('has-bulkbar', show);
  $('#bb-count').textContent = `${bn(n)}টি নির্বাচিত`;
  const all = filteredSites();
  const inFilter = all.filter((s) => state.sel.has(String(s.id))).length;
  const box = $('#sel-all');
  box.checked = all.length > 0 && inFilter === all.length;
  box.indeterminate = inFilter > 0 && inFilter < all.length;
  $('#sel-all-text').textContent = `তালিকার সবগুলো নির্বাচন করুন (${bn(all.length)}টি)`;
}

$('#sel-all').addEventListener('change', (e) => {
  filteredSites().forEach((s) => (e.target.checked ? state.sel.add(String(s.id)) : state.sel.delete(String(s.id))));
  renderSites();
});

const setBulkBusy = (b) => $$('#bulkbar button').forEach((x) => (x.disabled = b));
const selectedIds = () => Array.from(state.sel);

/* নির্বাচিত সাইটগুলোতে একই পরিবর্তন (patch) প্রয়োগ; patchFn(site) প্রতিটির জন্য আলাদা মান দিতে পারে */
async function bulkPatch(ids, patchFn) {
  const targets = ids.map((id) => state.sites.find((s) => sameId(s.id, id))).filter(Boolean);
  const done = await runBatches(targets, (batch, s) => {
    batch.update(doc(db, 'websites', String(s.id)), { ...patchFn(s), updated_at: serverTimestamp() });
  });
  targets.forEach((s) => Object.assign(s, patchFn(s), { updated_at: Timestamp.now() }));
  return done;
}

async function bulkSetActive(active) {
  const ids = selectedIds();
  if (!ids.length) return;
  setBulkBusy(true);
  try {
    const n = await bulkPatch(ids, () => ({ is_active: active }));
    toast(active ? `${bn(n)}টি সাইট সক্রিয় করা হয়েছে` : `${bn(n)}টি সাইট অ্যাপ থেকে লুকানো হয়েছে`);
  } catch (e) { toast(errText(e), 'err'); }
  finally { setBulkBusy(false); renderAll(); }
}
$('#bb-on').addEventListener('click', () => bulkSetActive(true));
$('#bb-off').addEventListener('click', () => bulkSetActive(false));
$('#bb-clear').addEventListener('click', () => { state.sel.clear(); renderSites(); });

$('#bb-cat').addEventListener('click', () => {
  if (!state.sel.size) return;
  $('#bc-info').textContent = `${bn(state.sel.size)}টি সাইটের ক্যাটাগরি বদলানো হবে।`;
  fillCatSelect($('#bc-cat'), null);
  $('#dlg-bulkcat').showModal();
});

$('#bulkcat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const ids = selectedIds();
  if (!ids.length) return;
  const newCat = $('#bc-cat').value || null;
  const btn = $('#bc-go');
  setBusy(btn, true, 'বদলানো হচ্ছে…');
  try {
    // নতুন ক্যাটাগরির শেষে বসবে, নির্বাচিতদের আগের আপেক্ষিক ক্রম ঠিক রেখে
    const targets = ids.map((id) => state.sites.find((s) => sameId(s.id, id))).filter(Boolean).sort(bySiteOrder);
    let base = nextSiteOrder(newCat, []);
    const orders = new Map(targets.map((s) => [String(s.id), base++]));
    const n = await bulkPatch(ids, (s) => ({ category_id: newCat, sort_order: orders.get(String(s.id)) }));
    toast(`${bn(n)}টি সাইটের ক্যাটাগরি বদলেছে`);
    $('#dlg-bulkcat').close();
  } catch (e) { toast(errText(e), 'err'); }
  finally { setBusy(btn, false); renderAll(); }
});

$('#bb-del').addEventListener('click', async () => {
  const ids = selectedIds();
  if (!ids.length) return;
  const ok = await confirmBox({
    title: `${bn(ids.length)}টি সাইট মুছবেন?`,
    message: 'সাইটগুলো স্থায়ীভাবে মুছে যাবে। আগে এক্সপোর্ট করে ব্যাকআপ রাখতে পারেন। শুধু লুকাতে চাইলে "বন্ধ" ব্যবহার করুন।',
  });
  if (!ok) return;
  setBulkBusy(true);
  let removed = 0;
  try {
    for (const part of chunk(ids, BATCH)) {
      const batch = writeBatch(db);
      part.forEach((id) => batch.delete(doc(db, 'websites', String(id))));
      await guard(() => batch.commit());
      const gone = new Set(part.map(String));
      state.sites = state.sites.filter((s) => !gone.has(String(s.id)));
      gone.forEach((id) => state.sel.delete(id));
      removed += part.length;
    }
    toast(`${bn(removed)}টি সাইট মুছে ফেলা হয়েছে`);
  } catch (e) {
    toast(`${bn(removed)}টি মোছার পর সমস্যা: ${errText(e)}`, 'err');
  } finally { setBulkBusy(false); renderAll(); }
});

/* =====================================================================
   এক্সপোর্ট (সব / ফিল্টার / নির্বাচিত × CSV / JSON / TXT / TXT+লোগো)
   ===================================================================== */
function openExport(preset) {
  const sel = $('#ex-scope');
  sel.innerHTML =
    `<option value="all">সব সাইট (${bn(state.sites.length)})</option>` +
    `<option value="filtered">বর্তমান ফিল্টারের সাইট (${bn(filteredSites().length)})</option>` +
    `<option value="selected" ${state.sel.size ? '' : 'disabled'}>নির্বাচিত সাইট (${bn(state.sel.size)})</option>`;
  sel.value = preset === 'selected' && state.sel.size ? 'selected' : 'all';
  $('#dlg-export').showModal();
}
$('#btn-export').addEventListener('click', () => openExport('all'));
$('#bb-export').addEventListener('click', () => openExport('selected'));

$('#export-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const scope = $('#ex-scope').value;
  const format = $('#ex-format').value;
  let list = state.sites;
  if (scope === 'filtered') list = filteredSites();
  if (scope === 'selected') list = state.sites.filter((s) => state.sel.has(String(s.id)));
  if (!list.length) return toast('এক্সপোর্ট করার মতো সাইট নেই', 'err');
  const rows = list.map((s) => ({
    id: s.id, name: s.name, url: s.url,
    category: catName(s.category_id), category_en: catById(s.category_id)?.name_en || '',
    category_id: s.category_id ?? '', logo_url: s.logo_url || '', is_active: !!s.is_active,
    sort_order: s.sort_order ?? '', created_at: isoDate(s.created_at),
  }));
  const out = buildExport(rows, format, today());
  download(out.filename, out.text, out.mime);
  $('#dlg-export').close();
  toast(`${bn(rows.length)}টি সাইট এক্সপোর্ট হয়েছে`);
});

/* =====================================================================
   লোগো (শুধু URL ইনপুট + প্রিভিউ; কোনো আপলোড নেই)
   ===================================================================== */
let logoCheckSeq = 0;
function setLogoStatus(msg, kind = '') {
  const el = $('#s-logo-status');
  el.textContent = msg;
  el.className = 'small-note' + (kind ? ' ' + kind : '');
}

function syncLogoPreview() {
  const raw = $('#s-logo').value.trim();
  const img = $('#s-logo-prev');
  const ph = $('#s-logo-ph');
  $('#s-logo-clear').hidden = !raw;
  const seq = ++logoCheckSeq;
  img.hidden = true; ph.hidden = false;
  img.removeAttribute('src');
  if (!raw) return setLogoStatus('');
  const n = normalizeUrl(raw, 'লোগোর URL');
  if (n.error) return setLogoStatus('লোগোর URL ঠিক নয়। https:// দিয়ে শুরু হওয়া ছবির সরাসরি লিংক দিন।', 'err');
  setLogoStatus('প্রিভিউ লোড হচ্ছে…');
  const probe = new Image();
  probe.referrerPolicy = 'no-referrer';
  probe.onload = () => {
    if (seq !== logoCheckSeq) return;
    img.src = n.value; img.hidden = false; ph.hidden = true;
    setLogoStatus('লোগো ঠিকমতো লোড হয়েছে।', 'ok');
  };
  probe.onerror = () => {
    if (seq !== logoCheckSeq) return;
    setLogoStatus('এই URL থেকে ছবি লোড হয়নি। লিংকটি ছবির সরাসরি লিংক কি না দেখুন।', 'err');
  };
  probe.src = n.value;
}
$('#s-logo').addEventListener('input', () => { clearTimeout($('#s-logo')._t); $('#s-logo')._t = setTimeout(syncLogoPreview, 250); });
$('#s-logo-clear').addEventListener('click', () => { $('#s-logo').value = ''; syncLogoPreview(); $('#s-logo').focus(); });

async function flashCopy(btn, ok, okToast, failToast) {
  if (ok) {
    toast(okToast);
    const old = btn.textContent;
    btn.textContent = 'কপি হয়েছে ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } else toast(failToast, 'err');
}
$('#s-name-copy').addEventListener('click', async () => {
  const name = $('#s-name').value.trim();
  if (!name) return toast('কপি করার মতো নাম নেই।', 'err');
  flashCopy($('#s-name-copy'), await copyText(name), 'নাম কপি হয়েছে।', 'কপি করা যায়নি।');
});
$('#s-logo-copy').addEventListener('click', async () => {
  const v = $('#s-logo').value.trim();
  if (!v) return toast('কপি করার মতো লোগোর URL নেই।', 'err');
  flashCopy($('#s-logo-copy'), await copyText(v), 'লোগোর URL কপি হয়েছে।', 'কপি করা যায়নি।');
});
$('#s-logo-paste').addEventListener('click', async () => {
  const input = $('#s-logo');
  try {
    if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('unsupported');
    const text = (await navigator.clipboard.readText()).trim();
    if (!text) return toast('ক্লিপবোর্ড ফাঁকা।', 'err');
    input.value = text;
    syncLogoPreview();
    toast('লোগোর URL পেস্ট হয়েছে।');
  } catch {
    input.focus();
    toast('পেস্ট করা যায়নি। ঘরটিতে ট্যাপ করে ধরে রেখে "পেস্ট" বেছে নিন।', 'err');
  }
});

/* =====================================================================
   ওয়েবসাইট: যোগ / এডিট / টগল / ডিলিট
   ===================================================================== */
function openSiteForm(id, prefill) {
  state.editingSiteId = id ?? null;
  const s = id != null ? state.sites.find((x) => sameId(x.id, id)) : null;
  $('#site-title').textContent = s ? 'ওয়েবসাইট এডিট' : 'নতুন ওয়েবসাইট';
  $('#s-name').value = s ? s.name : prefill?.name || '';
  $('#s-url').value = s ? s.url : prefill?.url || '';
  $('#s-logo').value = s?.logo_url || '';
  $('#s-active').checked = s ? !!s.is_active : true;
  const preCat = s ? s.category_id : state.cat !== 'all' && state.cat !== 'none' ? state.cat : null;
  fillCatSelect($('#s-cat'), preCat);
  setError('#site-error', '');
  syncLogoPreview();
  $('#dlg-site').showModal();
  $('#s-name').focus();
}
$('#btn-add-site').addEventListener('click', () => openSiteForm(null));

$('#site-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setError('#site-error', '');
  const name = $('#s-name').value.trim();
  if (!name) return setError('#site-error', 'ওয়েবসাইটের নাম দিন।');
  const u = normalizeUrl($('#s-url').value);
  if (u.error) return setError('#site-error', u.error);

  let logo = $('#s-logo').value.trim();
  if (logo) {
    const l = normalizeUrl(logo, 'লোগোর URL');
    if (l.error) return setError('#site-error', 'লোগোর URL ঠিক নয়। https:// দিয়ে শুরু হওয়া ছবির লিংক দিন, অথবা ঘরটি ফাঁকা রাখুন।');
    logo = l.value;
  }

  const key = dupKey(u.value);
  const dup = state.sites.find((x) => dupKey(x.url) === key && !sameId(x.id, state.editingSiteId));
  if (dup) return setError('#site-error', `এই সাইট আগেই যোগ করা আছে: ${dup.name}`);

  const editing = state.editingSiteId != null;
  const old = editing ? state.sites.find((x) => sameId(x.id, state.editingSiteId)) : null;
  const category_id = $('#s-cat').value || null;
  const payload = { name, url: u.value, logo_url: logo || null, category_id, is_active: $('#s-active').checked };
  const sameCat = old && (category_id == null ? inCat(old, null) : sameId(old.category_id, category_id));
  if (!sameCat || old?.sort_order == null) payload.sort_order = nextSiteOrder(category_id); // নতুন বা ক্যাটাগরি বদল: শেষে

  const btn = $('#site-save');
  setBusy(btn, true, 'সংরক্ষণ হচ্ছে…');
  try {
    if (editing) {
      await guard(() => updateDoc(doc(db, 'websites', String(old.id)), { ...payload, updated_at: serverTimestamp() }));
      Object.assign(old, payload, { updated_at: Timestamp.now() });
      toast('সাইট আপডেট হয়েছে');
    } else {
      const ref = doc(collection(db, 'websites'));
      await guard(() => setDoc(ref, { ...payload, id: ref.id, created_at: serverTimestamp(), updated_at: serverTimestamp() }));
      state.sites.unshift({ ...payload, id: ref.id, created_at: Timestamp.now(), updated_at: Timestamp.now() });
      toast('নতুন সাইট যোগ হয়েছে');
    }
    if (u.upgraded) toast('http লিংককে https করে সংরক্ষণ করা হয়েছে');
    $('#dlg-site').close();
    renderAll();
  } catch (e) {
    setError('#site-error', errText(e));
  } finally { setBusy(btn, false); }
});

$('#site-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('.row')?.dataset.id;
  if (id == null) return;
  if (btn.dataset.action === 'edit') return openSiteForm(id);
  if (btn.dataset.action === 'delete') {
    const s = state.sites.find((x) => sameId(x.id, id));
    if (!s) return;
    const ok = await confirmBox({
      title: 'সাইট মুছবেন?',
      message: `"${s.name}" স্থায়ীভাবে মুছে যাবে। শুধু অ্যাপ থেকে লুকাতে চাইলে মোছার বদলে সুইচ বন্ধ করুন।`,
    });
    if (!ok) return;
    try {
      await guard(() => deleteDoc(doc(db, 'websites', String(id))));
      state.sites = state.sites.filter((x) => !sameId(x.id, id));
      state.sel.delete(String(id));
      renderAll();
      toast('সাইট মুছে ফেলা হয়েছে');
    } catch (e) { toast(errText(e), 'err'); }
  }
});

$('#site-list').addEventListener('change', async (ev) => {
  const t = ev.target.closest('input[data-action]');
  if (!t) return;
  const row = t.closest('.row');
  const id = row.dataset.id;
  if (t.dataset.action === 'select') {
    if (t.checked) state.sel.add(String(id)); else state.sel.delete(String(id));
    row.classList.toggle('sel', t.checked);
    updateBulkBar();
    return;
  }
  if (t.dataset.action === 'toggle') {
    const s = state.sites.find((x) => sameId(x.id, id));
    if (!s) return;
    const next = t.checked;
    const prev = s.is_active;
    s.is_active = next;
    renderStats();
    row.classList.toggle('off', !next);
    t.closest('.switch').querySelector('em').textContent = next ? 'সক্রিয়' : 'বন্ধ';
    try {
      await guard(() => updateDoc(doc(db, 'websites', String(id)), { is_active: next, updated_at: serverTimestamp() }));
      toast(next ? 'সাইট অ্যাপে দেখানো হবে' : 'সাইট অ্যাপ থেকে লুকানো হয়েছে');
    } catch (e) {
      s.is_active = prev;
      renderAll();
      toast(errText(e), 'err');
    }
    if (state.status !== 'all') renderSites();
  }
});

/* =====================================================================
   ক্যাটাগরি
   ===================================================================== */
function openCatForm(id) {
  state.editingCatId = id ?? null;
  const c = id != null ? catById(id) : null;
  $('#cat-title').textContent = c ? 'ক্যাটাগরি এডিট' : 'নতুন ক্যাটাগরি';
  $('#c-name').value = c ? c.name : '';
  $('#c-name-en').value = c ? c.name_en || '' : '';
  $('#c-order').value = c ? c.sort_order ?? 0 : nextOrder(state.cats);
  setError('#cat-error', '');
  $('#dlg-cat').showModal();
  $('#c-name').focus();
}
$('#btn-add-cat').addEventListener('click', () => openCatForm(null));

const sortCats = () => state.cats.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.name).localeCompare(String(b.name)));

$('#cat-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setError('#cat-error', '');
  const name = $('#c-name').value.trim();
  if (!name) return setError('#cat-error', 'ক্যাটাগরির বাংলা নাম দিন।');
  const name_en = $('#c-name-en').value.trim();
  if (!name_en) return setError('#cat-error', 'ক্যাটাগরির ইংরেজি নাম দিন।');
  const orderRaw = $('#c-order').value.trim();
  const sort_order = Number.parseInt(orderRaw, 10);
  if (orderRaw === '' || Number.isNaN(sort_order)) return setError('#cat-error', 'ক্রমের জায়গায় একটি পূর্ণ সংখ্যা দিন।');
  const dup = state.cats.find((c) => String(c.name).trim().toLowerCase() === name.toLowerCase() && !sameId(c.id, state.editingCatId));
  if (dup) return setError('#cat-error', 'এই নামে ক্যাটাগরি আগেই আছে।');

  const btn = $('#cat-save');
  setBusy(btn, true, 'সংরক্ষণ হচ্ছে…');
  try {
    const payload = { name, name_en, sort_order };
    if (state.editingCatId != null) {
      const c = catById(state.editingCatId);
      await guard(() => updateDoc(doc(db, 'categories', String(c.id)), payload));
      Object.assign(c, payload);
      toast('ক্যাটাগরি আপডেট হয়েছে');
    } else {
      const ref = doc(collection(db, 'categories'));
      await guard(() => setDoc(ref, { ...payload, id: ref.id, created_at: serverTimestamp() }));
      state.cats.push({ ...payload, id: ref.id, created_at: Timestamp.now() });
      toast('নতুন ক্যাটাগরি যোগ হয়েছে');
    }
    sortCats();
    $('#dlg-cat').close();
    renderAll();
  } catch (e) {
    setError('#cat-error', errText(e));
  } finally { setBusy(btn, false); }
});

/* ক্যাটাগরির ক্রম ▲▼: সবগুলোকে ১,২,৩… করে নতুন করে নম্বর দেয় */
async function moveCategory(id, dir) {
  const ids = moveInList(state.cats.map((c) => String(c.id)), String(id), dir);
  const changes = [];
  ids.forEach((cid, i) => { const c = catById(cid); if (c && Number(c.sort_order) !== i + 1) changes.push({ c, order: i + 1 }); });
  if (!changes.length) return;
  try {
    await runBatches(changes, (batch, ch) => batch.update(doc(db, 'categories', String(ch.c.id)), { sort_order: ch.order }));
    changes.forEach((ch) => { ch.c.sort_order = ch.order; });
    sortCats();
    renderAll();
  } catch (e) { toast(errText(e), 'err'); await loadCore(); }
}

function openCatDelete(id) {
  const c = catById(id);
  if (!c) return;
  const n = state.sites.filter((s) => sameId(s.category_id, id)).length;
  state.editingCatId = id;
  $('#cd-msg').textContent = n
    ? `"${c.name}" ক্যাটাগরিতে ${bn(n)}টি সাইট আছে। ক্যাটাগরি মুছলে সাইটগুলো মুছবে না, নিচে যে ক্যাটাগরি বাছবেন সেখানে সরে যাবে।`
    : `"${c.name}" স্থায়ীভাবে মুছে যাবে।`;
  $('#cd-move-wrap').hidden = !n;
  fillCatSelect($('#cd-move'), null, true, id);
  setError('#cd-error', '');
  $('#dlg-catdel').showModal();
}

$('#catdel-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const c = catById(state.editingCatId);
  if (!c) return;
  const btn = $('#cd-ok');
  setBusy(btn, true, 'মোছা হচ্ছে…');
  try {
    const moving = state.sites.filter((s) => sameId(s.category_id, c.id)).sort(bySiteOrder);
    if (moving.length) {
      const target = $('#cd-move').value || null;
      let base = nextSiteOrder(target, []);
      const orders = new Map(moving.map((s) => [String(s.id), base++]));
      await bulkPatch(moving.map((s) => s.id), (s) => ({ category_id: target, sort_order: orders.get(String(s.id)) }));
    }
    // সাইট সরানো শেষ হলেই তবে ক্যাটাগরি মোছা হয়, তাই মাঝপথে ব্যর্থ হলে কোনো সাইট হারায় না
    await guard(() => deleteDoc(doc(db, 'categories', String(c.id))));
    state.cats = state.cats.filter((x) => !sameId(x.id, c.id));
    if (sameId(state.cat, c.id)) state.cat = 'all';
    $('#dlg-catdel').close();
    renderAll();
    toast('ক্যাটাগরি মুছে ফেলা হয়েছে');
  } catch (e) {
    setError('#cd-error', errText(e));
    renderAll();
  } finally { setBusy(btn, false); }
});

$('#cat-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const id = btn.closest('.row')?.dataset.id;
  if (id == null) return;
  const a = btn.dataset.action;
  if (a === 'edit') return openCatForm(id);
  if (a === 'delete') return openCatDelete(id);
  if (a === 'up' || a === 'down') return moveCategory(id, a);
  if (a === 'sites') {
    state.cat = String(id); state.status = 'all'; state.q = ''; state.shown = PAGE_SIZE;
    $('#f-status').value = 'all'; $('#f-search').value = '';
    renderCatFilter(); renderSites(); go('websites');
  }
});

/* =====================================================================
   একসাথে অনেক সাইট যোগ (প্রিভিউ → Batch Write → রিপোর্ট)
   ===================================================================== */
const MAX_PREVIEW_ROWS = 300;
const STATUS_LABEL = { ok: '✓ যোগ হবে', dup: '⚠ ডুপ্লিকেট', invalid: '✗ ভুল', failed: '✗ সংরক্ষণ হয়নি' };

function renderBulkPreview() {
  const text = $('#b-text').value;
  const box = $('#b-summary');
  const prev = $('#b-preview');
  if (!text.trim()) {
    state.bulkItems = [];
    box.innerHTML = ''; prev.innerHTML = '';
    $('#b-go').disabled = true; $('#b-go').textContent = 'যোগ করুন';
    return;
  }
  const items = parseBulk(text, state.cats, new Set(state.sites.map((s) => dupKey(s.url))));
  state.bulkItems = items;
  const ok = items.filter((i) => i.status === 'ok').length;
  const dup = items.filter((i) => i.status === 'dup').length;
  const bad = items.filter((i) => i.status === 'invalid').length;
  box.innerHTML = `<span class="ok">যোগ হবে: ${bn(ok)}টি</span>` +
    (dup ? ` · <span class="warn">ডুপ্লিকেট (বাদ যাবে): ${bn(dup)}টি</span>` : '') +
    (bad ? ` · <span class="down">ভুল লাইন (বাদ যাবে): ${bn(bad)}টি</span>` : '');
  const shown = items.slice(0, MAX_PREVIEW_ROWS);
  prev.innerHTML = `<table><thead><tr><th>অবস্থা</th><th>লাইন</th><th>নাম / URL</th><th>ক্যাটাগরি</th><th>কারণ</th></tr></thead><tbody>` +
    shown.map((i) => {
      const r = i.row;
      const cell = r
        ? `<strong>${esc(r.name)}</strong><br><small>${esc(r.url)}${r.logo_url ? ' · লোগো আছে' : ''}</small>`
        : `<small>${esc(i.raw)}</small>`;
      return `<tr class="st-${i.status}"><td>${STATUS_LABEL[i.status]}</td><td>${bn(i.line)}</td><td>${cell}</td><td>${r ? esc(r.category_id ? catName(r.category_id) : '—') : ''}</td><td>${esc(i.reason)}</td></tr>`;
    }).join('') + '</tbody></table>' +
    (items.length > shown.length ? `<p class="muted small-note" style="padding:.4rem .6rem">প্রথম ${bn(shown.length)}টি লাইন দেখানো হচ্ছে; যোগ হবে সবগুলোই।</p>` : '');
  $('#b-go').disabled = ok === 0;
  $('#b-go').textContent = ok ? `${bn(ok)}টি যোগ করুন` : 'যোগ করুন';
}

function resetBulkDialog() {
  $('#b-text').value = '';
  $('#b-input-pane').hidden = false;
  $('#b-report-pane').hidden = true;
  $('#b-go').hidden = false;
  $('#b-copy-failed').hidden = true;
  $('#b-close').textContent = 'বাতিল';
  state.bulkFailedLines = [];
  renderBulkPreview();
}
$('#btn-bulk').addEventListener('click', () => { resetBulkDialog(); $('#dlg-bulk').showModal(); $('#b-text').focus(); });
$('#b-text').addEventListener('input', renderBulkPreview);
$('#b-copy-failed').addEventListener('click', async () => {
  const ok = await copyText((state.bulkFailedLines || []).join('\n'));
  toast(ok ? 'ব্যর্থ লাইনগুলো কপি হয়েছে। ঠিক করে আবার পেস্ট করুন।' : 'কপি করা যায়নি।', ok ? 'ok' : 'err');
});

$('#bulk-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const items = state.bulkItems.map((i) => ({ ...i, row: i.row ? { ...i.row } : undefined }));
  const okItems = items.filter((i) => i.status === 'ok');
  if (!okItems.length) return;

  // প্রতিটি ক্যাটাগরির শেষে ক্রমানুযায়ী বসানোর জন্য sort_order
  const next = new Map();
  okItems.forEach((it) => {
    const k = it.row.category_id == null ? 'none' : String(it.row.category_id);
    if (!next.has(k)) next.set(k, nextSiteOrder(it.row.category_id));
    it.row.sort_order = next.get(k);
    next.set(k, it.row.sort_order + 1);
  });

  const btn = $('#b-go');
  btn.disabled = true;
  let added = 0;
  let stopReason = null;
  for (const part of chunk(okItems, BATCH)) {
    if (stopReason) { part.forEach((i) => { i.status = 'failed'; i.reason = 'আগের ব্যাচে সমস্যা হওয়ায় চেষ্টা করা হয়নি'; }); continue; }
    btn.textContent = `যোগ হচ্ছে… ${bn(added)}/${bn(okItems.length)}`;
    try {
      const batch = writeBatch(db);
      const created = part.map((i) => {
        const ref = doc(collection(db, 'websites'));
        const data = { ...i.row, id: ref.id };
        batch.set(ref, { ...data, created_at: serverTimestamp(), updated_at: serverTimestamp() });
        return { ...data, created_at: Timestamp.now(), updated_at: Timestamp.now() };
      });
      await guard(() => batch.commit());
      state.sites.unshift(...created);
      added += part.length;
    } catch (e) {
      stopReason = errText(e);
      part.forEach((i) => { i.status = 'failed'; i.reason = stopReason; });
    }
  }

  const failed = items.filter((i) => i.status !== 'ok');
  state.bulkFailedLines = failed.map((i) => i.raw);
  $('#b-input-pane').hidden = true;
  $('#b-report-pane').hidden = false;
  $('#b-go').hidden = true;
  $('#b-close').textContent = 'বন্ধ করুন';
  $('#b-copy-failed').hidden = failed.length === 0;
  $('#b-report').innerHTML =
    `<p><span class="ok">সফল: ${bn(added)}টি</span> · <span class="${failed.length ? 'down' : 'ok'}">ব্যর্থ/বাদ: ${bn(failed.length)}টি</span> · মোট লাইন: ${bn(items.length)}টি</p>` +
    (failed.length
      ? `<div class="b-preview"><table class="rep"><thead><tr><th>লাইন</th><th>লেখা</th><th>কারণ</th></tr></thead><tbody>${failed.map((i) => `<tr class="st-${i.status === 'dup' ? 'dup' : 'invalid'}"><td>${bn(i.line)}</td><td>${esc(i.raw)}</td><td>${esc(i.reason)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p>সব লাইন সফলভাবে যোগ হয়েছে।</p>');
  toast(`${bn(added)}টি সাইট যোগ হয়েছে${failed.length ? `, ${bn(failed.length)}টি যোগ হয়নি` : ''}`, failed.length && !added ? 'err' : 'ok');
  renderAll();
});

/* =====================================================================
   ক্যাটাগরি অনুযায়ী সাইটের ক্রম সাজান (Move Up/Down/First/Last)
   ===================================================================== */
const orderSite = (id) => state.sites.find((s) => sameId(s.id, id));

function renderOrderList(movedId) {
  $('#order-list').innerHTML = state.orderIds.map((id, i) => {
    const s = orderSite(id);
    if (!s) return '';
    const last = i === state.orderIds.length - 1;
    return `<li class="row order-row ${s.is_active ? '' : 'off'} ${sameId(id, movedId) ? 'moved' : ''}" data-id="${esc(id)}">
      <span class="num">${bn(i + 1)}</span>
      <div class="main">
        <strong title="${esc(s.name)}">${esc(s.name)}</strong>
        <span class="sub">${esc(hostOf(s.url))}${s.is_active ? '' : ' · বন্ধ'}</span>
      </div>
      <div class="acts">
        <button class="btn ghost small" type="button" data-move="top" aria-label="একেবারে উপরে নিন" ${i === 0 ? 'disabled' : ''}>⤒</button>
        <button class="btn ghost small" type="button" data-move="up" aria-label="এক ধাপ উপরে" ${i === 0 ? 'disabled' : ''}>▲</button>
        <button class="btn ghost small" type="button" data-move="down" aria-label="এক ধাপ নিচে" ${last ? 'disabled' : ''}>▼</button>
        <button class="btn ghost small" type="button" data-move="bottom" aria-label="একেবারে নিচে দিন" ${last ? 'disabled' : ''}>⤓</button>
      </div>
    </li>`;
  }).join('');
}

$('#btn-order').addEventListener('click', () => {
  if (state.cat === 'all' || state.cat === 'none') return toast('আগে উপরের ফিল্টার থেকে একটি ক্যাটাগরি বেছে নিন।', 'err');
  const list = state.sites.filter((s) => sameId(s.category_id, state.cat)).sort(bySiteOrder);
  if (list.length < 2) return toast('এই ক্যাটাগরিতে সাজানোর মতো দুটি সাইট নেই।', 'err');
  state.orderCat = state.cat;
  state.orderIds = list.map((s) => String(s.id));
  $('#order-title').textContent = `ক্রম সাজান: ${catName(state.cat)}`;
  setError('#order-error', '');
  renderOrderList(null);
  $('#dlg-order').showModal();
});

$('#order-list').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-move]');
  if (!btn || btn.disabled) return;
  const id = btn.closest('.row').dataset.id;
  state.orderIds = moveInList(state.orderIds, id, btn.dataset.move);
  renderOrderList(id);
  $('#order-list').querySelector('.moved')?.scrollIntoView({ block: 'nearest' });
});

$('#order-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setError('#order-error', '');
  const changes = [];
  state.orderIds.forEach((id, i) => {
    const s = orderSite(id);
    if (s && Number(s.sort_order) !== i + 1) changes.push({ s, order: i + 1 });
  });
  if (!changes.length) { $('#dlg-order').close(); return toast('ক্রমে কোনো বদল নেই'); }
  const btn = $('#order-save');
  setBusy(btn, true, 'সংরক্ষণ হচ্ছে…');
  try {
    await runBatches(changes, (batch, ch) => batch.update(doc(db, 'websites', String(ch.s.id)), { sort_order: ch.order, updated_at: serverTimestamp() }));
    changes.forEach((ch) => { ch.s.sort_order = ch.order; });
    toast(`${bn(changes.length)}টি সাইটের ক্রম সংরক্ষণ হয়েছে`);
    $('#dlg-order').close();
  } catch (e) {
    setError('#order-error', errText(e));
  } finally { setBusy(btn, false); renderAll(); }
});

/* =====================================================================
   More মেনু (অ্যাপের More স্ক্রিন) – collection: more_menu
   ===================================================================== */
const MENU_ICONS = {
  feedback: 'ফিডব্যাক', share: 'শেয়ার', x: 'X (টুইটার)', facebook: 'ফেসবুক',
  about: 'আমাদের সম্পর্কে', contact: 'যোগাযোগ', privacy: 'প্রাইভেসি', terms: 'শর্তাবলী',
  apps: 'অন্যান্য অ্যাপ', link: 'সাধারণ লিংক', info: 'তথ্য',
};
const MENU_ACTIONS = {
  url: 'লিংক (ব্রাউজারে খুলবে)',
  email: 'ইমেইল',
  share: 'শেয়ার টেক্সট',
  dialog: 'ডায়ালগের লেখা',
};
const MENU_VALUE_LABEL = { url: 'লিংক (URL)', email: 'ইমেইল ঠিকানা', share: 'শেয়ার টেক্সট', dialog: 'ডায়ালগে দেখানোর লেখা' };
const MENU_VALUE_HINT = {
  url: 'https:// দিয়ে শুরু হওয়া পূর্ণ লিংক দিন। ইউজার ট্যাপ করলে ব্রাউজারে খুলবে।',
  email: 'শুধু ইমেইল ঠিকানা, যেমন info@example.com। ট্যাপ করলে ইমেইল অ্যাপ খুলবে।',
  share: 'ইউজার "শেয়ার" চাপলে এই লেখা শেয়ার হবে। অ্যাপের লিংক সরাসরি লিখে দিন। {app_link} লিখলে অ্যাপ Play Store-এর লিংক বসাবে, কিন্তু অ্যাপ প্রকাশের আগে সেটা কাজ করবে না। ফাঁকা রাখলে অ্যাপ নিজের ডিফল্ট লেখা শেয়ার করবে।',
  dialog: 'ট্যাপ করলে পপআপে এই লেখা দেখাবে (আমাদের সম্পর্কে, নীতিমালা ইত্যাদির জন্য)।',
};
/* type → যে ফিল্ডে মান যায় (অ্যাপ এই ফিল্ডগুলোই পড়বে) */
const MENU_FIELD = { url: 'url', email: 'email', share: 'share_text', dialog: 'dialog_content' };

const sortedMenu = () => [...state.menu].sort((x, y) =>
  x.group - y.group || x.sort_order - y.sort_order || String(x.title_en || '').localeCompare(String(y.title_en || '')));

function menuRow(m) {
  const val = String(m.value || '');
  const preview = val ? (val.length > 90 ? val.slice(0, 90) + '…' : val) : '(ফাঁকা)';
  const placeholder = /YOUR_|example\.(com|org)/i.test(val);
  return `<li class="row menurow ${m.is_active ? '' : 'off'}" data-id="${esc(m.id)}">
    <div class="main">
      <strong title="${esc(m.title_bn)}">${esc(m.title_bn)}</strong>
      <span class="sub">${esc(m.title_en)} · ${esc(m.item_key)}</span>
      <span class="sub val">${esc(preview)}</span>
    </div>
    <div class="cat">
      <span class="pill">${esc(MENU_ACTIONS[m.type] || m.type)}</span>
      ${placeholder ? '<span class="pill warn" title="আসল মান বসাননি">প্লেসহোল্ডার</span>' : ''}
    </div>
    <label class="switch" title="অ্যাপে দেখানো হবে কি না">
      <input type="checkbox" data-action="toggle" ${m.is_active ? 'checked' : ''} aria-label="${esc(m.title_bn)} সক্রিয়">
      <span></span><em>${m.is_active ? 'সক্রিয়' : 'বন্ধ'}</em>
    </label>
    <div class="acts">
      <button class="btn ghost small mv" type="button" data-action="up" aria-label="উপরে নিন">▲</button>
      <button class="btn ghost small mv" type="button" data-action="down" aria-label="নিচে নিন">▼</button>
      <button class="btn ghost small" type="button" data-action="preview">প্রিভিউ</button>
      <button class="btn ghost small" type="button" data-action="edit">এডিট</button>
      <button class="btn danger-ghost small" type="button" data-action="delete">মুছুন</button>
    </div>
  </li>`;
}

function renderMenu() {
  const list = $('#menu-list');
  const info = $('#menu-count');
  if (state.loading.menu && !state.menu.length) { list.innerHTML = loadingRow; info.textContent = ''; return; }
  if (state.err.menu) { list.innerHTML = errBox(state.err.menu, 'retry-menu'); info.textContent = ''; return; }
  if (!state.menu.length) { info.textContent = ''; list.innerHTML = emptyBox('এখনো কোনো মেনু আইটেম নেই। "নতুন আইটেম" চেপে যোগ করুন।'); return; }
  const active = state.menu.filter((m) => m.is_active).length;
  info.textContent = `${bn(state.menu.length)}টি আইটেম · ${bn(active)}টি অ্যাপে দেখা যাচ্ছে`;
  let last = null;
  let html = '';
  for (const m of sortedMenu()) {
    if (m.group !== last) { html += `<li class="menu-group">গ্রুপ ${bn(m.group)}</li>`; last = m.group; }
    html += menuRow(m);
  }
  list.innerHTML = html;
}

function fillMenuSelects() {
  $('#m-icon').innerHTML = Object.entries(MENU_ICONS).map(([k, v]) => `<option value="${esc(k)}">${esc(v)} (${esc(k)})</option>`).join('');
  $('#m-action').innerHTML = Object.entries(MENU_ACTIONS).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
}

/* গ্রুপ বাছাই: আগের গ্রুপগুলো + "নতুন গ্রুপ" */
function fillGroupSelect(current) {
  const counts = new Map();
  state.menu.forEach((m) => counts.set(m.group, (counts.get(m.group) || 0) + 1));
  const keys = [...counts.keys()].sort((a, b) => a - b);
  const newG = (keys.length ? keys[keys.length - 1] : 0) + 1;
  $('#m-group').innerHTML =
    keys.map((g) => `<option value="${g}">গ্রুপ ${bn(g)} (${bn(counts.get(g))}টি আইটেম)</option>`).join('') +
    `<option value="${newG}">+ নতুন গ্রুপ (গ্রুপ ${bn(newG)})</option>`;
  const want = String(current);
  $('#m-group').value = Array.from($('#m-group').options).some((o) => o.value === want) ? want : String(keys.length ? keys[keys.length - 1] : 1);
}
const nextMenuOrder = (group, exceptId = null) =>
  nextOrder(state.menu.filter((m) => m.group === Number(group) && !sameId(m.id, exceptId)));
$('#m-group').addEventListener('change', () => {
  if (state.editingMenuId == null) $('#m-order').value = nextMenuOrder($('#m-group').value);
});

function updateMenuValueHint() {
  const t = $('#m-action').value;
  $('#m-value-label').textContent = MENU_VALUE_LABEL[t] || 'মান';
  $('#m-value-hint').textContent = MENU_VALUE_HINT[t] || '';
  $('#m-value').rows = t === 'share' || t === 'dialog' ? 6 : 2;
  $('#m-value').placeholder = t === 'url' ? 'https://…' : t === 'email' ? 'name@example.com' : '';
}
$('#m-action').addEventListener('change', updateMenuValueHint);

function openMenuForm(id) {
  state.editingMenuId = id ?? null;
  const m = id != null ? state.menu.find((x) => sameId(x.id, id)) : null;
  fillMenuSelects();
  fillGroupSelect(m ? m.group : state.menu.length ? Math.max(...state.menu.map((x) => x.group)) : 1);
  $('#menu-title').textContent = m ? 'মেনু আইটেম এডিট' : 'নতুন মেনু আইটেম';
  $('#m-key').value = m ? m.item_key : '';
  $('#m-key').readOnly = !!m;
  $('#m-title-bn').value = m ? m.title_bn || '' : '';
  $('#m-title-en').value = m ? m.title_en || '' : '';
  $('#m-desc-bn').value = m ? m.description_bn || '' : '';
  $('#m-desc-en').value = m ? m.description_en || '' : '';
  $('#m-icon').value = m && MENU_ICONS[m.icon] ? m.icon : 'link';
  $('#m-action').value = m && MENU_ACTIONS[m.type] ? m.type : 'url';
  $('#m-value').value = m ? m.value || '' : '';
  $('#m-order').value = m ? m.sort_order : nextMenuOrder($('#m-group').value);
  $('#m-active').checked = m ? !!m.is_active : true;
  updateMenuValueHint();
  setError('#menu-error', '');
  $('#dlg-menu').showModal();
  (m ? $('#m-title-bn') : $('#m-key')).focus();
}
$('#btn-add-menu').addEventListener('click', () => openMenuForm(null));
$('#btn-menu-reload').addEventListener('click', async () => {
  await loadMenu();
  toast(state.err.menu || 'রিফ্রেশ হয়েছে', state.err.menu ? 'err' : 'ok');
});

function validMenuValue(type, v) {
  if (type === 'url') { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } }
  if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (type === 'dialog') return v.length > 0;
  return true; // share: ফাঁকা হলে অ্যাপ ডিফল্ট লেখা ব্যবহার করে
}

function readMenuForm() {
  return {
    item_key: $('#m-key').value.trim(),
    title_bn: $('#m-title-bn').value.trim(),
    title_en: $('#m-title-en').value.trim(),
    description_bn: $('#m-desc-bn').value.trim(),
    description_en: $('#m-desc-en').value.trim(),
    icon: $('#m-icon').value,
    type: $('#m-action').value,
    value: $('#m-value').value.trim(),
    group: Number.parseInt($('#m-group').value, 10),
    sort_order: Number.parseInt($('#m-order').value, 10),
    is_active: $('#m-active').checked,
  };
}

/* Firestore-এ যাওয়া ডকুমেন্ট: নতুন ফিল্ড + পুরোনো অ্যাপের জন্য action_type / value / group_no */
function menuPayload(f) {
  const p = {
    title_bn: f.title_bn, title_en: f.title_en,
    description_bn: f.description_bn, description_en: f.description_en,
    icon: f.icon, type: f.type,
    url: '', email: '', share_text: '', dialog_content: '',
    group: f.group, sort_order: f.sort_order, is_active: f.is_active,
    action_type: f.type, value: f.value, group_no: f.group,
  };
  p[MENU_FIELD[f.type]] = f.value;
  return p;
}

$('#menu-preview').addEventListener('click', () => {
  const f = readMenuForm();
  openPreview('menu', { ...f, [MENU_FIELD[f.type] || 'url']: f.value });
});

$('#menu-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setError('#menu-error', '');
  const editing = state.editingMenuId != null;
  const f = readMenuForm();
  if (!/^[a-z0-9_-]{1,40}$/.test(f.item_key)) return setError('#menu-error', 'কী-তে শুধু ইংরেজি ছোট হাতের অক্ষর, সংখ্যা, _ বা - দিন (১ থেকে ৪০ অক্ষর)।');
  if (!editing && state.menu.some((x) => x.item_key === f.item_key)) return setError('#menu-error', 'এই কী দিয়ে আইটেম আগেই আছে।');
  if (!f.title_bn) return setError('#menu-error', 'বাংলা শিরোনাম দিন।');
  if (!f.title_en) return setError('#menu-error', 'ইংরেজি শিরোনাম দিন।');
  if (!MENU_ACTIONS[f.type]) return setError('#menu-error', 'ধরন বেছে নিন।');
  if (!validMenuValue(f.type, f.value)) {
    return setError('#menu-error',
      f.type === 'url' ? 'সঠিক লিংক দিন (http:// বা https:// দিয়ে শুরু)।'
      : f.type === 'email' ? 'সঠিক ইমেইল ঠিকানা দিন।'
      : 'ডায়ালগের লেখা ফাঁকা রাখা যাবে না।');
  }
  if (Number.isNaN(f.group) || f.group < 1) return setError('#menu-error', 'গ্রুপ নম্বর ১ বা তার বেশি পূর্ণ সংখ্যা হতে হবে।');
  if (Number.isNaN(f.sort_order)) return setError('#menu-error', 'ক্রমের জায়গায় একটি পূর্ণ সংখ্যা দিন।');

  const payload = menuPayload(f);
  const btn = $('#menu-save');
  setBusy(btn, true, 'সংরক্ষণ হচ্ছে…');
  try {
    if (editing) {
      const m = state.menu.find((x) => sameId(x.id, state.editingMenuId));
      await guard(() => updateDoc(doc(db, 'more_menu', String(m.id)), { ...payload, updated_at: serverTimestamp() }));
      Object.assign(m, normMenu({ ...m, ...payload, updated_at: Timestamp.now() }));
      toast('মেনু আইটেম আপডেট হয়েছে');
    } else {
      const ref = doc(db, 'more_menu', f.item_key); // কী-ই ডকুমেন্টের id, তাই ডুপ্লিকেট হতেই পারে না
      const exists = await guard(() => getDoc(ref));
      if (exists.exists()) throw Object.assign(new Error('এই কী দিয়ে আইটেম আগেই আছে।'), { code: 'already-exists' });
      await guard(() => setDoc(ref, { ...payload, item_key: f.item_key, id: ref.id, created_at: serverTimestamp(), updated_at: serverTimestamp() }));
      state.menu.push(normMenu({ ...payload, item_key: f.item_key, id: ref.id, created_at: Timestamp.now(), updated_at: Timestamp.now() }));
      toast('নতুন মেনু আইটেম যোগ হয়েছে');
    }
    $('#dlg-menu').close();
    renderMenu(); renderStats();
  } catch (e) {
    setError('#menu-error', errText(e));
  } finally { setBusy(btn, false); }
});

/* ---------- JSON থেকে মেনু আইটেম ইমপোর্ট ---------- */
let menuImportItems = [];

function parseMenuImport(text) {
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('JSON-এর শুরুতে [ ] দিয়ে আইটেমের তালিকা থাকতে হবে।');
  const seen = new Set(state.menu.map((m) => m.item_key));
  return data.map((it, i) => {
    const f = {
      item_key: String(it.item_key || '').trim(),
      title_bn: String(it.title_bn || '').trim(), title_en: String(it.title_en || '').trim(),
      description_bn: String(it.description_bn || '').trim(), description_en: String(it.description_en || '').trim(),
      icon: MENU_ICONS[it.icon] ? it.icon : 'link',
      type: it.type || it.action_type || 'url',
      value: String(it.value ?? '').trim(),
      group: Number.parseInt(it.group ?? it.group_no ?? 1, 10),
      sort_order: Number.parseInt(it.sort_order ?? 0, 10),
      is_active: it.is_active !== false && it.is_active !== 'false',
    };
    let status = 'ok', reason = '';
    if (!/^[a-z0-9_-]{1,40}$/.test(f.item_key)) { status = 'invalid'; reason = 'কী ঠিক নয়'; }
    else if (!f.title_bn || !f.title_en) { status = 'invalid'; reason = 'শিরোনাম (বাংলা/English) নেই'; }
    else if (!MENU_ACTIONS[f.type]) { status = 'invalid'; reason = 'ধরন ঠিক নয়'; }
    else if (!validMenuValue(f.type, f.value)) { status = 'invalid'; reason = 'মান ঠিক নয়'; }
    else if (Number.isNaN(f.group) || f.group < 1 || Number.isNaN(f.sort_order)) { status = 'invalid'; reason = 'গ্রুপ/ক্রম সংখ্যা নয়'; }
    else if (seen.has(f.item_key)) { status = 'exists'; reason = 'কী আগেই আছে'; }
    else seen.add(f.item_key);
    return { n: i + 1, f, status, reason };
  });
}

function renderMenuImport() {
  const text = $('#mi-text').value.trim();
  setError('#mi-error', '');
  menuImportItems = [];
  $('#mi-summary').innerHTML = '';
  $('#mi-go').disabled = true;
  if (!text) return;
  try { menuImportItems = parseMenuImport(text); }
  catch (e) { return setError('#mi-error', 'JSON পড়া যায়নি: ' + e.message); }
  const ok = menuImportItems.filter((x) => x.status === 'ok').length;
  const ex = menuImportItems.filter((x) => x.status === 'exists').length;
  const bad = menuImportItems.filter((x) => x.status === 'invalid');
  $('#mi-summary').innerHTML = `<span class="ok">যোগ হবে: ${bn(ok)}টি</span>` +
    (ex ? ` · <span class="warn">আগেই আছে (বাদ): ${bn(ex)}টি</span>` : '') +
    (bad.length ? ` · <span class="down">ভুল (বাদ): ${bn(bad.length)}টি</span><ul>${bad.map((x) => `<li>আইটেম ${bn(x.n)} (${esc(x.f.item_key)}): ${esc(x.reason)}</li>`).join('')}</ul>` : '');
  $('#mi-go').disabled = ok === 0;
}
$('#btn-import-menu').addEventListener('click', () => { $('#mi-text').value = ''; renderMenuImport(); $('#dlg-menuimp').showModal(); $('#mi-text').focus(); });
$('#mi-text').addEventListener('input', renderMenuImport);

$('#menuimp-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const items = menuImportItems.filter((x) => x.status === 'ok');
  if (!items.length) return;
  const btn = $('#mi-go');
  setBusy(btn, true, 'ইমপোর্ট হচ্ছে…');
  try {
    const created = [];
    await runBatches(items, (batch, it) => {
      const ref = doc(db, 'more_menu', it.f.item_key);
      const payload = { ...menuPayload(it.f), item_key: it.f.item_key, id: ref.id };
      batch.set(ref, { ...payload, created_at: serverTimestamp(), updated_at: serverTimestamp() });
      created.push(normMenu({ ...payload, created_at: Timestamp.now(), updated_at: Timestamp.now() }));
    });
    state.menu.push(...created);
    $('#dlg-menuimp').close();
    renderMenu(); renderStats();
    toast(`${bn(created.length)}টি মেনু আইটেম ইমপোর্ট হয়েছে`);
  } catch (e) {
    setError('#mi-error', errText(e));
  } finally { setBusy(btn, false); }
});

/* গ্রুপের ভেতরে ▲▼: গ্রুপের সবগুলোকে ১,২,৩… করে নতুন করে নম্বর দেয় */
async function moveMenuItem(id, dir) {
  const m = state.menu.find((x) => sameId(x.id, id));
  if (!m) return;
  const groupItems = sortedMenu().filter((x) => x.group === m.group);
  const ids = moveInList(groupItems.map((x) => String(x.id)), String(id), dir);
  const changes = [];
  ids.forEach((mid, i) => { const it = state.menu.find((x) => sameId(x.id, mid)); if (it && it.sort_order !== i + 1) changes.push({ it, order: i + 1 }); });
  if (!changes.length) return;
  try {
    await runBatches(changes, (batch, ch) => batch.update(doc(db, 'more_menu', String(ch.it.id)), { sort_order: ch.order, updated_at: serverTimestamp() }));
    changes.forEach((ch) => { ch.it.sort_order = ch.order; });
    renderMenu();
  } catch (e) { toast(errText(e), 'err'); await loadMenu(); }
}

$('#menu-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('.row')?.dataset.id;
  if (id == null) return;
  const m = state.menu.find((x) => sameId(x.id, id));
  if (!m) return;
  const a = btn.dataset.action;
  if (a === 'edit') return openMenuForm(id);
  if (a === 'preview') return openPreview('menu', m);
  if (a === 'up' || a === 'down') return moveMenuItem(id, a);
  if (a === 'delete') {
    const ok = await confirmBox({
      title: 'মেনু আইটেম মুছবেন?',
      message: `"${m.title_bn}" স্থায়ীভাবে মুছে যাবে এবং অ্যাপের More স্ক্রিন থেকে সরে যাবে। শুধু লুকাতে চাইলে মোছার বদলে সুইচ বন্ধ করুন।`,
    });
    if (!ok) return;
    try {
      await guard(() => deleteDoc(doc(db, 'more_menu', String(id))));
      state.menu = state.menu.filter((x) => !sameId(x.id, id));
      renderMenu(); renderStats();
      toast('মেনু আইটেম মুছে ফেলা হয়েছে');
    } catch (e) { toast(errText(e), 'err'); }
  }
});

$('#menu-list').addEventListener('change', async (ev) => {
  const t = ev.target.closest('input[data-action="toggle"]');
  if (!t) return;
  const row = t.closest('.row');
  const m = state.menu.find((x) => sameId(x.id, row.dataset.id));
  if (!m) return;
  const next = t.checked, prev = m.is_active;
  m.is_active = next;
  row.classList.toggle('off', !next);
  t.closest('.switch').querySelector('em').textContent = next ? 'সক্রিয়' : 'বন্ধ';
  try {
    await guard(() => updateDoc(doc(db, 'more_menu', String(m.id)), { is_active: next, updated_at: serverTimestamp() }));
    renderMenu();
    toast(next ? 'আইটেম অ্যাপে দেখানো হবে' : 'আইটেম অ্যাপ থেকে লুকানো হয়েছে');
  } catch (e) { m.is_active = prev; renderMenu(); toast(errText(e), 'err'); }
});

/* =====================================================================
   নোটিশ – collection: notices (বাংলা + English একই ডকুমেন্টে)
   ===================================================================== */
const noticeTitle = (n) => n.title_bn || n.title_en || '(শিরোনাম নেই)';

function noticeRow(n) {
  const desc = String(n.description_bn || n.description_en || '');
  const preview = desc.length > 110 ? desc.slice(0, 110) + '…' : desc;
  return `<li class="row menurow ${n.is_active ? '' : 'off'}" data-id="${esc(n.id)}">
    <div class="main">
      <strong title="${esc(noticeTitle(n))}">${esc(noticeTitle(n))}</strong>
      <span class="sub val">${esc(preview)}</span>
      <span class="sub">${esc(fmtDate(n.created_at))}</span>
    </div>
    <div class="cat">
      ${n.title_bn || n.description_bn ? '<span class="pill">বাংলা</span>' : ''}
      ${n.title_en || n.description_en ? '<span class="pill">English</span>' : ''}
      ${n.details_url ? '<span class="pill">লিংক আছে</span>' : ''}
    </div>
    <label class="switch" title="অ্যাপে প্রকাশিত কি না">
      <input type="checkbox" data-action="toggle" ${n.is_active ? 'checked' : ''} aria-label="${esc(noticeTitle(n))} প্রকাশিত">
      <span></span><em>${n.is_active ? 'প্রকাশিত' : 'বন্ধ'}</em>
    </label>
    <div class="acts">
      <button class="btn ghost small" type="button" data-action="preview">প্রিভিউ</button>
      <button class="btn ghost small" type="button" data-action="edit">এডিট</button>
      <button class="btn danger-ghost small" type="button" data-action="delete">মুছুন</button>
    </div>
  </li>`;
}

function renderNotices() {
  const list = $('#notice-list');
  const info = $('#notice-count');
  if (state.loading.notices && !state.notices.length) { list.innerHTML = loadingRow; info.textContent = ''; return; }
  if (state.err.notices) { list.innerHTML = errBox(state.err.notices, 'retry-notices'); info.textContent = ''; return; }
  if (!state.notices.length) { info.textContent = ''; list.innerHTML = emptyBox('এখনো কোনো নোটিশ নেই। "নতুন নোটিশ" চেপে যোগ করুন।'); return; }
  const active = state.notices.filter((n) => n.is_active).length;
  info.textContent = `${bn(state.notices.length)}টি নোটিশ · ${bn(active)}টি অ্যাপে দেখা যাচ্ছে`;
  list.innerHTML = state.notices.map(noticeRow).join('');
}

function openNoticeForm(id) {
  state.editingNoticeId = id ?? null;
  const n = id != null ? state.notices.find((x) => sameId(x.id, id)) : null;
  $('#notice-title').textContent = n ? 'নোটিশ এডিট' : 'নতুন নোটিশ';
  $('#n-title-bn').value = n ? n.title_bn : '';
  $('#n-title-en').value = n ? n.title_en : '';
  $('#n-desc-bn').value = n ? n.description_bn : '';
  $('#n-desc-en').value = n ? n.description_en : '';
  $('#n-link').value = n ? n.details_url || '' : '';
  $('#n-active').checked = n ? !!n.is_active : true;
  setError('#notice-error', '');
  $('#dlg-notice').showModal();
  $('#n-title-bn').focus();
}
$('#btn-add-notice').addEventListener('click', () => openNoticeForm(null));
$('#btn-notice-reload').addEventListener('click', async () => {
  await loadNotices();
  toast(state.err.notices || 'রিফ্রেশ হয়েছে', state.err.notices ? 'err' : 'ok');
});

const readNoticeForm = () => fixNoticeLangs({
  title_bn: $('#n-title-bn').value, title_en: $('#n-title-en').value,
  description_bn: $('#n-desc-bn').value, description_en: $('#n-desc-en').value,
});

$('#notice-preview').addEventListener('click', () => {
  const { fields } = readNoticeForm();
  openPreview('notice', { ...fields, details_url: $('#n-link').value.trim() });
});

$('#notice-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  setError('#notice-error', '');
  const editing = state.editingNoticeId != null;
  const { fields: f, moved } = readNoticeForm();
  const rawLink = $('#n-link').value.trim();
  const is_active = $('#n-active').checked;

  const hasBn = !!(f.title_bn || f.description_bn);
  const hasEn = !!(f.title_en || f.description_en);
  if (!hasBn && !hasEn) return setError('#notice-error', 'অন্তত একটি ভাষায় শিরোনাম ও বর্ণনা দিন।');
  if (hasBn && (!f.title_bn || !f.description_bn)) return setError('#notice-error', 'বাংলা অংশের শিরোনাম ও বর্ণনা দুটোই দিন (অথবা বাংলা অংশ পুরো ফাঁকা রাখুন)।');
  if (hasEn && (!f.title_en || !f.description_en)) return setError('#notice-error', 'English অংশের শিরোনাম ও বর্ণনা দুটোই দিন (অথবা English অংশ পুরো ফাঁকা রাখুন)।');

  let details_url = null;
  if (rawLink) {
    try {
      const u = new URL(rawLink);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('bad');
      details_url = u.href;
    } catch { return setError('#notice-error', 'সঠিক লিংক দিন (http:// বা https:// দিয়ে শুরু)।'); }
  }

  // পুরোনো অ্যাপের জন্য একক ভাষার ফিল্ড (title, message, lang, link_url) – বাংলা থাকলে বাংলা, নইলে English
  const payload = {
    ...f, details_url, is_active,
    title: hasBn ? f.title_bn : f.title_en,
    message: hasBn ? f.description_bn : f.description_en,
    lang: hasBn ? 'bn' : 'en',
    link_url: details_url,
  };
  const btn = $('#notice-save');
  setBusy(btn, true, 'সংরক্ষণ হচ্ছে…');
  try {
    if (editing) {
      const n = state.notices.find((x) => sameId(x.id, state.editingNoticeId));
      await guard(() => updateDoc(doc(db, 'notices', String(n.id)), { ...payload, updated_at: serverTimestamp() }));
      Object.assign(n, payload, { updated_at: Timestamp.now() });
      toast('নোটিশ আপডেট হয়েছে');
    } else {
      const ref = doc(collection(db, 'notices'));
      await guard(() => setDoc(ref, { ...payload, id: ref.id, created_at: serverTimestamp(), updated_at: serverTimestamp() }));
      state.notices.unshift({ ...payload, id: ref.id, created_at: Timestamp.now(), updated_at: Timestamp.now() });
      toast('নোটিশ যোগ হয়েছে' + (moved ? ' (ভাষা মিলিয়ে সঠিক ঘরে বসানো হয়েছে)' : ''));
    }
    $('#dlg-notice').close();
    renderNotices(); renderStats();
  } catch (e) {
    setError('#notice-error', errText(e));
  } finally { setBusy(btn, false); }
});

$('#notice-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.closest('.row')?.dataset.id;
  if (id == null) return;
  const n = state.notices.find((x) => sameId(x.id, id));
  if (!n) return;
  if (btn.dataset.action === 'edit') return openNoticeForm(id);
  if (btn.dataset.action === 'preview') return openPreview('notice', n);
  if (btn.dataset.action === 'delete') {
    const ok = await confirmBox({ title: 'নোটিশ মুছবেন?', message: `"${noticeTitle(n)}" স্থায়ীভাবে মুছে যাবে। শুধু লুকাতে চাইলে মোছার বদলে সুইচ বন্ধ করুন।` });
    if (!ok) return;
    try {
      await guard(() => deleteDoc(doc(db, 'notices', String(id))));
      state.notices = state.notices.filter((x) => !sameId(x.id, id));
      renderNotices(); renderStats();
      toast('নোটিশ মুছে ফেলা হয়েছে');
    } catch (e) { toast(errText(e), 'err'); }
  }
});

$('#notice-list').addEventListener('change', async (ev) => {
  const t = ev.target.closest('input[data-action="toggle"]');
  if (!t) return;
  const row = t.closest('.row');
  const n = state.notices.find((x) => sameId(x.id, row.dataset.id));
  if (!n) return;
  const next = t.checked, prev = n.is_active;
  n.is_active = next;
  try {
    await guard(() => updateDoc(doc(db, 'notices', String(n.id)), { is_active: next, updated_at: serverTimestamp() }));
    renderNotices();
    toast(next ? 'নোটিশ প্রকাশ করা হয়েছে, অ্যাপে দেখাবে' : 'নোটিশ বন্ধ করা হয়েছে, অ্যাপ থেকে লুকানো হয়েছে');
  } catch (e) { n.is_active = prev; renderNotices(); toast(errText(e), 'err'); }
});

/* =====================================================================
   প্রিভিউ (মেনু আইটেম / নোটিশ) – বাংলা ও English দুই ভাষায়
   ===================================================================== */
let pv = { kind: null, data: null, lang: 'bn' };

function renderPreview() {
  const { kind, data, lang } = pv;
  const pick = (bnV, enV) => (lang === 'bn' ? bnV || enV : enV || bnV) || '';
  $$('[data-pv-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pvLang === lang)));
  const body = $('#pv-body');
  if (kind === 'menu') {
    $('#pv-title').textContent = 'মেনু আইটেমের প্রিভিউ';
    const title = pick(data.title_bn, data.title_en);
    const desc = pick(data.description_bn, data.description_en);
    const type = data.type || data.action_type || 'url';
    const value = data[MENU_FIELD[type]] || data.value || '';
    body.innerHTML = `<div class="pv-menu"><div class="pv-ic">${esc((MENU_ICONS[data.icon] || 'লিং').trim().charAt(0))}</div>
      <div><strong>${esc(title) || '(শিরোনাম নেই)'}</strong><small>${esc(desc)}</small></div></div>
      <p class="pv-note">ধরন: ${esc(MENU_ACTIONS[type] || type)} · আইকন: ${esc(data.icon || '')} · গ্রুপ ${esc(data.group ?? '')} · ক্রম ${esc(data.sort_order ?? '')}<br>${esc(MENU_VALUE_LABEL[type] || 'মান')}: ${esc(value || '(ফাঁকা)')}</p>`;
  } else {
    $('#pv-title').textContent = 'নোটিশের প্রিভিউ';
    const title = lang === 'bn' ? data.title_bn : data.title_en;
    const desc = lang === 'bn' ? data.description_bn : data.description_en;
    const link = data.details_url || data.link_url;
    body.innerHTML = title || desc
      ? `<div class="pv-notice"><h3>${esc(title)}</h3><p>${esc(desc)}</p>${link ? `<button class="btn primary small" type="button" tabindex="-1">বিস্তারিত</button>` : ''}</div>`
      : '<p class="muted">এই ভাষায় কিছু লেখা নেই।</p>';
  }
}
function openPreview(kind, data) {
  pv = { kind, data, lang: pv.lang || 'bn' };
  renderPreview();
  $('#dlg-preview').showModal();
}
$$('[data-pv-lang]').forEach((b) => b.addEventListener('click', () => { pv.lang = b.dataset.pvLang; renderPreview(); }));

/* =====================================================================
   ইউজার ম্যানেজমেন্ট (Firestore users + Cloud Functions)
   ===================================================================== */
const uidOf = (u) => u.uid || u.id;
const isAdminUser = (u) => state.admins.has(uidOf(u));

function filteredUsers() {
  const q = state.us.q.trim().toLowerCase();
  return state.users.filter((u) => {
    if (state.us.filter === 'banned' && !u.is_banned) return false;
    if (state.us.filter === 'active' && u.is_banned) return false;
    if (state.us.filter === 'admin' && !isAdminUser(u)) return false;
    if (q && !(String(u.email || '').toLowerCase().includes(q) || String(uidOf(u)).toLowerCase().includes(q))) return false;
    return true;
  });
}

function userRow(u) {
  const uid = uidOf(u);
  const admin = isAdminUser(u);
  const isMe = state.me && uid === state.me.uid;
  return `<li class="row feed" data-id="${esc(u.id)}">
    <div class="line">
      <strong>${esc(u.email || 'ইমেইল নেই')}</strong>
      ${admin ? '<span class="pill">এডমিন</span>' : ''}
      ${isMe ? '<span class="pill none">আপনি</span>' : ''}
      ${u.is_banned ? '<span class="pill banned">নিষিদ্ধ</span>' : '<span class="pill">সক্রিয়</span>'}
    </div>
    <div class="meta">User ID: <code>${esc(uid)}</code></div>
    <div class="meta">যোগ দিয়েছেন: ${esc(fmtDate(u.created_at)) || '—'}</div>
    ${u.is_banned ? `<div class="meta">নিষিদ্ধ: ${esc(fmtDate(u.banned_at))}${u.ban_reason ? ' · কারণ: ' + esc(u.ban_reason) : ''}</div>` : ''}
    <div class="acts">
      <button class="btn ghost small" type="button" data-action="details">বিবরণ</button>
      ${!admin && !isMe ? (u.is_banned
        ? '<button class="btn ghost small" type="button" data-action="unban">নিষেধাজ্ঞা তুলুন</button>'
        : '<button class="btn danger-ghost small" type="button" data-action="ban">নিষিদ্ধ করুন</button>') : ''}
    </div>
  </li>`;
}

function renderUsers() {
  const list = $('#usr-list');
  const more = $('#us-more');
  const info = $('#us-count');
  more.hidden = true;
  if (state.loading.users && !state.users.length) { list.innerHTML = loadingRow; info.textContent = ''; return; }
  if (state.err.users) { list.innerHTML = errBox(state.err.users, 'retry-users'); info.textContent = ''; return; }
  const all = filteredUsers();
  const part = all.slice(0, state.us.shown);
  if (!state.users.length) {
    list.innerHTML = emptyBox('এখনো কোনো ইউজার ডকুমেন্ট নেই। Firebase Authentication-এর ইউজারদের আনতে "Auth থেকে সিঙ্ক" চাপুন (Cloud Functions লাগে)।');
    info.textContent = ''; return;
  }
  if (!all.length) { list.innerHTML = emptyBox('কোনো ইউজার পাওয়া যায়নি।'); info.textContent = ''; return; }
  info.textContent = `${bn(all.length)}জনের মধ্যে ${bn(part.length)}জন দেখানো হচ্ছে`;
  list.innerHTML = part.map(userRow).join('');
  more.hidden = all.length <= part.length;
}

function askBan(email) {
  return new Promise((resolve) => {
    const dlg = $('#dlg-ban');
    $('#ban-who').textContent = email || '';
    $('#ban-reason').value = '';
    $('#ban-disable').checked = false;
    dlg.returnValue = '';
    dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'
      ? { reason: $('#ban-reason').value.trim(), disable: $('#ban-disable').checked } : null), { once: true });
    dlg.showModal();
  });
}

const callFn = (name, data) => guard(() => httpsCallable(functions, name)(data).then((r) => r.data));

async function applyBan(u, ban, reason, disableLogin) {
  const uid = uidOf(u);
  // লগইন বন্ধ/চালু করতে Admin SDK লাগে → Cloud Function; নইলে Rules-সীমিত সরাসরি Firestore লেখা
  const viaFn = (ban && disableLogin) || (!ban && u.auth_disabled);
  if (viaFn) {
    await callFn('setUserBan', { uid, ban, reason: reason || '', disableLogin: !!disableLogin });
  } else {
    await guard(() => updateDoc(doc(db, 'users', String(u.id)), {
      is_banned: ban, ban_reason: ban ? reason || null : null, banned_at: ban ? serverTimestamp() : null, updated_at: serverTimestamp(),
    }));
  }
  Object.assign(u, {
    is_banned: ban, ban_reason: ban ? reason || null : null, banned_at: ban ? Timestamp.now() : null,
    auth_disabled: viaFn ? ban && !!disableLogin : u.auth_disabled, updated_at: Timestamp.now(),
  });
  renderUsers(); renderStats();
}

async function showUserDetails(u) {
  const rows = (extra = '') => {
    const base = [
      ['ইমেইল', u.email || '—'], ['User ID', uidOf(u)], ['অ্যাকাউন্ট তৈরি', fmtDate(u.created_at) || '—'],
      ['অবস্থা', u.is_banned ? 'নিষিদ্ধ' : 'সক্রিয়'],
      ...(u.is_banned ? [['নিষেধাজ্ঞার কারণ', u.ban_reason || '—'], ['নিষিদ্ধের সময়', fmtDate(u.banned_at) || '—']] : []),
      ['এডমিন', isAdminUser(u) ? 'হ্যাঁ' : 'না'], ['শেষ আপডেট', fmtDate(u.updated_at) || '—'],
    ];
    return base.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('') + extra;
  };
  $('#ud-body').innerHTML = rows('<dt>Auth তথ্য</dt><dd>লোড হচ্ছে…</dd>');
  $('#dlg-user').showModal();
  try {
    const d = await callFn('getUserDetails', { uid: uidOf(u) });
    const lines = [
      ['শেষ লগইন', d.lastSignIn ? fmtDate(d.lastSignIn) : '—'],
      ['লগইন পদ্ধতি', (d.providers || []).join(', ') || '—'],
      ['ইমেইল ভেরিফাইড', d.emailVerified ? 'হ্যাঁ' : 'না'],
      ['Firebase লগইন', d.disabled ? 'বন্ধ' : 'চালু'],
    ];
    $('#ud-body').innerHTML = rows(lines.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join(''));
  } catch (e) {
    $('#ud-body').innerHTML = rows(`<dt>Auth তথ্য</dt><dd class="muted">পাওয়া যায়নি: ${esc(errText(e))}</dd>`);
  }
}

$('#usr-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const u = state.users.find((x) => sameId(x.id, btn.closest('.row').dataset.id));
  if (!u) return;
  const a = btn.dataset.action;
  if (a === 'details') return showUserDetails(u);
  if (a === 'ban') {
    if (state.me && uidOf(u) === state.me.uid) return toast('নিজেকে নিষিদ্ধ করা যাবে না', 'err');
    if (isAdminUser(u)) return toast('এডমিনকে নিষিদ্ধ করা যায় না', 'err');
    const res = await askBan(u.email);
    if (!res) return;
    try { await applyBan(u, true, res.reason, res.disable); toast('ইউজার নিষিদ্ধ করা হয়েছে'); }
    catch (e) { toast(errText(e), 'err'); }
  }
  if (a === 'unban') {
    const ok = await confirmBox({ title: 'নিষেধাজ্ঞা তুলবেন?', message: `${u.email} আবার ফেভারিট, বুকমার্ক ও সাজেশন সেভ করতে পারবে।`, okText: 'নিষেধাজ্ঞা তুলুন', danger: false });
    if (!ok) return;
    try { await applyBan(u, false, null, false); toast('নিষেধাজ্ঞা তুলে নেওয়া হয়েছে'); }
    catch (e) { toast(errText(e), 'err'); }
  }
});

let userTimer;
$('#us-q').addEventListener('input', (e) => {
  clearTimeout(userTimer);
  userTimer = setTimeout(() => { state.us.q = e.target.value; state.us.shown = PAGE_SIZE; renderUsers(); }, 150);
});
$('#us-filter').addEventListener('change', (e) => { state.us.filter = e.target.value; state.us.shown = PAGE_SIZE; renderUsers(); });
$('#us-more').addEventListener('click', () => { state.us.shown += PAGE_SIZE; renderUsers(); });
$('#us-reload').addEventListener('click', async () => {
  await loadUsers();
  toast(state.err.users || 'রিফ্রেশ হয়েছে', state.err.users ? 'err' : 'ok');
});
$('#us-sync').addEventListener('click', async () => {
  const btn = $('#us-sync');
  setBusy(btn, true, 'সিঙ্ক হচ্ছে…');
  try {
    const r = await callFn('syncUsers', {});
    await loadUsers();
    toast(`সিঙ্ক শেষ: মোট ${bn(r.total)}জন, নতুন ${bn(r.created)}, আপডেট ${bn(r.updated)}`);
  } catch (e) { toast(errText(e), 'err'); }
  finally { setBusy(btn, false); }
});
