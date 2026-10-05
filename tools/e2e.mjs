// Headless Chrome e2e over a CDP pipe (no listening port). Serves docs/ at the real Pages origin via request interception.
// Usage: node tools/e2e.mjs   (reads the test token from `gh auth token`; never prints it)
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { readdirSync } from 'node:fs';

const ROOT = resolve(new URL('..', import.meta.url).pathname, 'docs');
const ORIGIN = 'https://dshak1.github.io';
const BASE = ORIGIN + '/thought-router/';
const OUT = process.env.OUT || tmpdir();
const chromeDir = join(homedir(), '.cache/ms-playwright');
const chrome = join(chromeDir, readdirSync(chromeDir).find(d => d.startsWith('chromium-')), 'chrome-linux64/chrome');
const profile = mkdtempSync(join(tmpdir(), 'tr-prof-'));
const TOKEN = process.env.TR_TOKEN || execFileSync('gh', ['auth', 'token']).toString().trim();
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-pipe', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let id = 0; const pending = new Map(); const listeners = []; let buf = '';
proc.stdio[4].on('data', d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else listeners.forEach(l => l(m));
  }
});
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const n = ++id; pending.set(n, { res, rej });
  proc.stdio[3].write(JSON.stringify({ id: n, method, params, sessionId }) + '\0');
});
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
const cmd = (m, p) => send(m, p, S);
listeners.push(async m => {
  if (m.method === 'Fetch.requestPaused' && m.sessionId === S) {
    const r = m.params; const u = new URL(r.request.url);
    let path = u.pathname.replace('/thought-router/', '');
    if (path === '' ) path = 'index.html';
    try {
      const body = readFileSync(join(ROOT, path));
      await cmd('Fetch.fulfillRequest', { requestId: r.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: MIME[extname(path)] || 'text/plain' }], body: body.toString('base64') });
    } catch { await cmd('Fetch.fulfillRequest', { requestId: r.requestId, responseCode: 404, body: '' }); }
  }
});
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable');
if (!process.env.LIVE) await cmd('Fetch.enable', { patterns: [{ urlPattern: ORIGIN + '/*' }] });
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
const ev = async expr => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception?.description)); return r.result.value; };
const goto = async url => { await cmd('Page.navigate', { url }); await sleep(1200); };
const waitFor = async (expr, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr).catch(() => false)) return true; await sleep(250); } return false; };
const shot = async name => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); };
const gh = (...a) => { try { return execFileSync('gh', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch (e) { return ''; } };
const badges = () => ev(`[...document.querySelectorAll('li')].map(li=>li.querySelector('.t').textContent+'|'+li.querySelector('.badge').textContent)`);
const send_ = async text => { await ev(`document.getElementById('text').value=${JSON.stringify(text)}; document.getElementById('send').click(); 1`); };
const stamp = Date.now().toString(36);

try {
  // 0. setup link: token stored via fragment and fragment cleared
  await goto(BASE + '#t=' + TOKEN);
  const hash = await ev('location.hash'); const stored = await ev(`!!localStorage.getItem('tr_token')`);
  check('setup link stores token and clears fragment', hash === '' && stored === true);
  check('warning line present', (await ev(`document.querySelector('.warn').textContent`)) === 'Personal thoughts only. No work-confidential content.');
  await shot('01-empty-390x844.png');

  // 1. real submit
  const t1 = 'TEST online ' + stamp;
  await send_(t1);
  const okRecv = await waitFor(`[...document.querySelectorAll('.badge')].some(b=>b.textContent==='RECEIVED')`);
  check('online submit shows RECEIVED', okRecv, JSON.stringify(await badges()));
  const itemId = await ev(`allItems().then(a=>a.find(i=>i.text===${JSON.stringify(t1)}).id)`);
  const file = JSON.parse(gh('api', `repos/dshak1/thought-inbox/contents/thoughts/${itemId}.json`, '--jq', '.content') ? Buffer.from(gh('api', `repos/dshak1/thought-inbox/contents/thoughts/${itemId}.json`, '--jq', '.content').trim(), 'base64').toString() : '{}');
  check('file exists in private inbox with right fields', file.id === itemId && file.text === t1 && !!file.created_at && !!file.device, JSON.stringify(Object.keys(file)));
  await shot('02-received-390x844.png');

  // 2. duplicate retry with same UUID
  await ev(`allItems().then(a=>{const it=a.find(i=>i.id==='${itemId}'); it.state='saved'; return putItem(it)})`);
  await ev(`flush()`);
  const st = await ev(`allItems().then(a=>a.find(i=>i.id==='${itemId}').state)`);
  const commits = JSON.parse(gh('api', `repos/dshak1/thought-inbox/commits?path=thoughts/${itemId}.json`) || '[]').length;
  const names = JSON.parse(gh('api', 'repos/dshak1/thought-inbox/contents/thoughts') || '[]').filter(f => f.name === itemId + '.json').length;
  check('duplicate retry treated as success, exactly one file, one commit', st === 'received' && names === 1 && commits === 1, `state=${st} files=${names} commits=${commits}`);

  // 3. offline then reconnect
  await cmd('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  const t2 = 'TEST offline ' + stamp;
  await send_(t2); await sleep(1500);
  const offB = await badges();
  check('offline capture stays SAVED ON PHONE', offB.includes(t2 + '|SAVED ON PHONE'), JSON.stringify(offB));
  await shot('03-offline-saved-390x844.png');
  await goto(BASE); // reload while still offline: item must survive
  const surv = await badges();
  check('unsent item survives reload (offline)', surv.includes(t2 + '|SAVED ON PHONE'));
  await cmd('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await ev(`window.dispatchEvent(new Event('online')); 1`);
  const up = await waitFor(`[...document.querySelectorAll('li')].some(li=>li.textContent.includes(${JSON.stringify(t2)}) && li.querySelector('.badge').textContent==='RECEIVED')`, 20000);
  check('uploads automatically on reconnect', up, JSON.stringify(await badges()));

  // 4. wrong token
  await ev(`setToken('github_pat_BOGUS'); 1`);
  const t3 = 'TEST badtoken ' + stamp;
  await send_(t3); await sleep(3000);
  const badInfo = await ev(`(()=>{const li=[...document.querySelectorAll('li')].find(l=>l.textContent.includes(${JSON.stringify(t3)})); return li.querySelector('.badge').textContent+'|'+(li.querySelector('.err')||{}).textContent+'|banner='+document.getElementById('authbanner').textContent})()`);
  check('wrong token rejected, item stays on phone with clear message', /^SAVED ON PHONE\|Token rejected/.test(badInfo), badInfo);
  await shot('04-bad-token-390x844.png');
  // 5. absent token
  await ev(`setToken(''); 1`);
  const t4 = 'TEST notoken ' + stamp;
  await send_(t4); await sleep(1000);
  const noInfo = await ev(`(()=>{const li=[...document.querySelectorAll('li')].find(l=>l.textContent.includes(${JSON.stringify(t4)})); return li.querySelector('.badge').textContent+'|'+(li.querySelector('.err')||{}).textContent})()`);
  check('absent token keeps item on phone with message', /^SAVED ON PHONE\|No token set/.test(noInfo), noInfo);
  // 6. restore token, retry button uploads the stuck items
  await ev(`setToken(${JSON.stringify(TOKEN)}); 1`);
  await ev(`document.getElementById('retry').click(); 1`);
  const rec = await waitFor(`![...document.querySelectorAll('.badge')].some(b=>b.textContent==='SAVED ON PHONE')`, 20000);
  check('Retry button uploads stuck items once token fixed', rec, JSON.stringify(await badges()));
  // 7. PULLED status: run thought-pull on the computer, then Refresh on the phone
  execFileSync(resolve(ROOT, '../bin/thought-pull'), { env: process.env });
  await ev(`document.getElementById('refresh').click(); 1`);
  const pulled = await waitFor(`[...document.querySelectorAll('.badge')].every(b=>b.textContent==='PULLED')`, 20000);
  check('after thought-pull, phone shows PULLED', pulled, JSON.stringify(await badges()));
  await shot('05-pulled-390x844.png');
  if (process.env.LIVE) {
    const sw = await ev(`navigator.serviceWorker.getRegistration().then(r=>!!r)`);
    const mf = JSON.parse((await cmd('Page.getAppManifest')).data || '{}').name;
    check('LIVE: service worker registered, manifest served', sw === true && mf === 'Thought router', `sw=${sw} manifest=${mf}`);
  }
  console.log('STAMP ' + stamp);
} catch (e) { console.log('ERROR ' + e.message); results.push(false); }
finally { proc.kill(); rmSync(profile, { recursive: true, force: true }); console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED'); process.exit(results.every(Boolean) ? 0 : 1); }
