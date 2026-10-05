'use strict';
// Thought router phone client. No secrets live here: the token is entered once and kept in localStorage.
const OWNER = 'dshak1';
const REPO = 'thought-inbox';
const API = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/contents/';
const $ = id => document.getElementById(id);

// ---- token handling ----
function getToken() { try { return localStorage.getItem('tr_token') || ''; } catch (e) { return ''; } }
function setToken(t) { try { t ? localStorage.setItem('tr_token', t) : localStorage.removeItem('tr_token'); } catch (e) {} }
function takeTokenFromFragment() {
  const m = /[#&]t=([^&]+)/.exec(location.hash);
  if (!m) return;
  setToken(decodeURIComponent(m[1]).trim());
  history.replaceState(null, '', location.pathname + location.search);
}

// ---- IndexedDB ----
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('thought-router', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('items', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction('items', mode);
    const out = fn(t.objectStore('items'));
    t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
    t.onerror = () => rej(t.error);
  });
}
const putItem = it => tx('readwrite', s => s.put(it));
const allItems = () => tx('readonly', s => s.getAll()).then(a => (a || []).sort((x, y) => y.created_at.localeCompare(x.created_at)));

// ---- helpers ----
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}
function b64utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach(c => { bin += String.fromCharCode(c); });
  return btoa(bin);
}
function device() { try { return localStorage.getItem('tr_device') || 'phone'; } catch (e) { return 'phone'; } }
function headers() {
  return { 'Authorization': 'Bearer ' + getToken(), 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- upload ----
// Returns {ok:true} or {ok:false, fatal:bool, msg}. 422 "sha wasn't supplied" means the file already exists: success.
async function upload(item) {
  if (!getToken()) return { ok: false, fatal: true, msg: 'No token set. Open Setup and add the token.' };
  const body = JSON.stringify({ id: item.id, text: item.text, created_at: item.created_at, device: item.device });
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try {
      r = await fetch(API + 'thoughts/' + item.id + '.json', {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers()),
        body: JSON.stringify({ message: 'thought ' + item.id, content: b64utf8(body) })
      });
    } catch (e) {
      return { ok: false, fatal: false, msg: 'No connection. Will retry.' };
    }
    if (r.status === 201 || r.status === 200) return { ok: true };
    let j = {};
    try { j = await r.json(); } catch (e) {}
    const m = String(j.message || '');
    if (r.status === 422 && /sha/i.test(m)) return { ok: true, dup: true };
    if (r.status === 409) { await sleep(400 * (attempt + 1)); continue; }
    if (r.status === 401) return { ok: false, fatal: true, msg: 'Token rejected (401). Fix it in Setup.' };
    if (r.status === 403 && /rate limit/i.test(m)) return { ok: false, fatal: false, msg: 'Rate limited. Will retry.' };
    if (r.status === 403) return { ok: false, fatal: true, msg: 'Token not allowed to write (403). Needs Contents read and write on the inbox repo.' };
    if (r.status === 404) return { ok: false, fatal: true, msg: 'Inbox repo not reachable with this token (404). Check token repo access.' };
    return { ok: false, fatal: false, msg: 'Server said ' + r.status + '. Will retry.' };
  }
  return { ok: false, fatal: false, msg: 'Busy (409). Will retry.' };
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    const items = (await allItems()).filter(i => i.state === 'saved').reverse();
    for (const it of items) {
      const res = await upload(it);
      if (res.ok) { it.state = 'received'; it.err = ''; it.received_at = new Date().toISOString(); }
      else { it.err = res.msg; it.attempts = (it.attempts || 0) + 1; }
      await putItem(it);
      await render();
      if (!res.ok && (res.fatal || /connection/i.test(res.msg))) {
        // Same failure applies to everything still waiting: say so on each item, then stop.
        for (const rest of items.slice(items.indexOf(it) + 1)) { rest.err = res.msg; await putItem(rest); }
        break;
      }
    }
  } finally { flushing = false; }
  await render();
}

// ---- pulled status: computer commits pulled/<id> markers ----
async function refreshPulled() {
  if (!getToken() || !navigator.onLine) return;
  const items = await allItems();
  if (!items.some(i => i.state === 'received')) return;
  let r;
  try { r = await fetch(API + 'pulled', { headers: headers(), cache: 'no-store' }); } catch (e) { return; }
  if (r.status === 404) return; // nothing pulled yet
  if (!r.ok) return;
  const names = new Set((await r.json()).map(f => f.name));
  for (const it of items) {
    if (it.state === 'received' && names.has(it.id)) { it.state = 'pulled'; await putItem(it); }
  }
  await render();
}

// ---- UI ----
const LABEL = { saved: 'SAVED ON PHONE', received: 'RECEIVED', pulled: 'PULLED' };
async function render() {
  const items = await allItems();
  const ul = $('list');
  ul.textContent = '';
  for (const it of items) {
    const li = document.createElement('li');
    const t = document.createElement('div'); t.className = 't'; t.textContent = it.text;
    const m = document.createElement('div'); m.className = 'm';
    const b = document.createElement('span'); b.className = 'badge ' + it.state; b.textContent = LABEL[it.state];
    const when = document.createElement('span'); when.textContent = new Date(it.created_at).toLocaleString();
    m.append(b, when);
    if (it.state === 'saved' && it.err) { const e = document.createElement('span'); e.className = 'err'; e.textContent = it.err; m.append(e); }
    li.append(t, m);
    ul.append(li);
  }
  const n = items.filter(i => i.state === 'saved').length;
  $('summary').textContent = n ? n + ' not sent yet' : (items.length ? 'All sent' : '');
  $('retry').hidden = n === 0;
  const tok = getToken();
  $('tokenstate').textContent = tok ? 'Token is set on this phone.' : 'No token set.';
  const bn = $('authbanner');
  const bad = items.find(i => i.state === 'saved' && i.err && /Token|token|repo/.test(i.err));
  if (!tok) { bn.hidden = false; bn.textContent = 'No token set. Thoughts are kept on this phone until you add it in Setup.'; }
  else if (bad) { bn.hidden = false; bn.textContent = bad.err + ' Your thoughts are safe on this phone.'; }
  else bn.hidden = true;
}

async function submit(e) {
  e.preventDefault();
  const text = $('text').value.trim();
  if (!text) return;
  await putItem({ id: uuid(), text, created_at: new Date().toISOString(), device: device(), state: 'saved', err: '', attempts: 0 });
  $('text').value = '';
  if (navigator.vibrate) navigator.vibrate(30);
  await render();
  flush();
}

function init() {
  takeTokenFromFragment();
  $('form').addEventListener('submit', submit);
  $('retry').addEventListener('click', () => flush());
  $('refresh').addEventListener('click', async () => { await flush(); await refreshPulled(); });
  $('savetoken').addEventListener('click', async () => { setToken($('token').value.trim()); $('token').value = ''; await render(); flush(); });
  $('cleartoken').addEventListener('click', async () => { setToken(''); await render(); });
  window.addEventListener('online', () => { flush().then(refreshPulled); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { flush().then(refreshPulled); } });
  setInterval(() => { if (!document.hidden) { flush().then(refreshPulled); } }, 30000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  render().then(() => flush()).then(refreshPulled);
}
init();
