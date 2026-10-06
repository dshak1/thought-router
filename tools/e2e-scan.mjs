// Scan test: synthetic "notes video" -> phone frame extraction -> real private repo -> thought-pull -> thought-inbox.
// Usage: THOUGHT_ROUTER_HOME=<scratch> OUT=<dir> node tools/e2e-scan.mjs   (token from `gh auth token`, never printed)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { launch } from './cdp.mjs';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DOCS = join(ROOT, 'docs'), BASE = 'https://dshak1.github.io/thought-router/';
const OUT = process.env.OUT || tmpdir();
const TOKEN = execFileSync('gh', ['auth', 'token']).toString().trim();
const FFMPEG = join(homedir(), '.cache/ms-playwright', readdirSync(join(homedir(), '.cache/ms-playwright')).find(d => d.startsWith('ffmpeg')), 'ffmpeg-linux');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = []; const check = (n, ok, x = '') => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + n + (x ? '  ' + x : '')); };
const gh = (...a) => { try { return execFileSync('gh', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString(); } catch { return ''; } };

const { cmd, listeners, sessionId, close } = await launch();
listeners.push(async m => {
  if (m.method === 'Fetch.requestPaused' && m.sessionId === sessionId) {
    const r = m.params; const p = new URL(r.request.url).pathname.replace('/thought-router/', '') || 'index.html';
    try { await cmd('Fetch.fulfillRequest', { requestId: r.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: MIME[extname(p)] || 'text/plain' }], body: readFileSync(join(DOCS, p)).toString('base64') }); }
    catch { await cmd('Fetch.fulfillRequest', { requestId: r.requestId, responseCode: 404, body: '' }); }
  }
});
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('DOM.enable'); await cmd('Network.enable');
const ev = async e => { const r = await cmd('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text)); return r.result.value; };
const waitFor = async (e, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(e).catch(() => false)) return true; await sleep(300); } return false; };
const shot = async (name) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(OUT, name), Buffer.from(r.data, 'base64')); };

// 1. build a test video in the browser itself (MediaRecorder), pages 2s each: p1, p2, p3, p1 again (must be deduped)
const work = join(OUT, 'scanwork'); mkdirSync(work, { recursive: true });
const pages = [
  ['Graphs', ['BFS uses a queue', 'DFS uses a stack or recursion', 'Dijkstra needs a heap']],
  ['Bucket sort', ['Split range into buckets', 'Sort each bucket', 'O(n+k) on uniform data']],
  ['Pattern words', ['"top k" means heap', '"subarray sum" means prefix sums', '"shortest path" means BFS']],
];
await cmd('Page.navigate', { url: 'data:text/html,<body></body>' }); await sleep(500);
const b64 = await ev(`(async()=>{
  const pages=${JSON.stringify(pages)}; const seq=[0,1,2,0];
  const c=document.createElement('canvas'); c.width=720; c.height=960; const x=c.getContext('2d');
  const draw=i=>{x.fillStyle='#fdfcf5';x.fillRect(0,0,720,960);x.fillStyle='#1a1a3a';x.font='bold 44px serif';x.fillText(pages[i][0],50,100);x.font='32px serif';pages[i][1].forEach((l,j)=>x.fillText(l,50,200+j*70));};
  const rec=new MediaRecorder(c.captureStream(10),{mimeType:'video/webm;codecs=vp8'}); const chunks=[]; rec.ondataavailable=e=>chunks.push(e.data);
  const done=new Promise(r=>rec.onstop=r); rec.start();
  for(const i of seq){ const t=Date.now(); while(Date.now()-t<2000){draw(i); await new Promise(r=>setTimeout(r,100));} }
  rec.stop(); await done; const blob=new Blob(chunks,{type:'video/webm'});
  return await new Promise(r=>{const f=new FileReader(); f.onload=()=>r(String(f.result).split(',')[1]); f.readAsDataURL(blob);});
})()`);
writeFileSync(join(work, 'rec.webm'), Buffer.from(b64, 'base64'));
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', join(work, 'rec.webm'), '-c', 'copy', join(work, 'notes.webm')]);
check('test video built', true);

// 2. open the app at the real origin and scan the video
await cmd('Fetch.enable', { patterns: [{ urlPattern: 'https://dshak1.github.io/*' }] });
await cmd('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await cmd('Page.navigate', { url: BASE + '#t=' + TOKEN }); await sleep(1500);
const { root } = await cmd('DOM.getDocument'); const { nodeId } = await cmd('DOM.querySelector', { nodeId: root.nodeId, selector: '#scanfile' });
await cmd('DOM.setFileInputFiles', { files: [join(work, 'notes.webm')], nodeId });
const saved = await waitFor(`document.getElementById('scanstatus').textContent.includes('saved on phone') || document.getElementById('scanstatus').textContent.includes('failed') || document.getElementById('scanstatus').textContent.includes('No pages')`);
const status = await ev(`document.getElementById('scanstatus').textContent`);
check('video scan finds exactly 3 distinct pages (repeat deduped)', /^3 pages/.test(status), status);
await waitFor(`!![...document.querySelectorAll('.badge')].length && [...document.querySelectorAll('.badge')].every(b=>b.textContent==='RECEIVED')`, 60000);
const b = await ev(`[...document.querySelectorAll('li')].map(li=>li.querySelector('.t').firstChild.textContent+'|'+li.querySelector('.badge').textContent)`);
check('all pages uploaded and RECEIVED', b.length === 3 && b.every(x => x.endsWith('|RECEIVED')), JSON.stringify(b));
await shot('06-scan-390x844.png');

// 3. verify real repo
const ids = await ev(`allItems().then(a=>a.map(i=>i.id))`);
const files = ids.map(id => ({ img: gh('api', `repos/dshak1/thought-inbox/contents/attachments/${id}.jpg`, '--jq', '.size').trim(), js: gh('api', `repos/dshak1/thought-inbox/contents/thoughts/${id}.json`, '--jq', '.size').trim() }));
check('image + json exist in private repo for every page', files.length === 3 && files.every(f => +f.img > 2000 && +f.js > 50), JSON.stringify(files));

// 4. pull + inbox (scratch home)
const env = { ...process.env };
const pull = execFileSync(join(ROOT, 'bin/thought-pull'), { env }).toString();
check('thought-pull imports pages with images', /new: \d+/.test(pull) && ids.every(id => existsSync(join(env.THOUGHT_ROUTER_HOME, 'attachments', id + '.jpg'))), pull.trim());
const pull2 = execFileSync(join(ROOT, 'bin/thought-pull'), { env }).toString();
check('second pull is a no-op', /new: 0/.test(pull2), pull2.trim());
const inbox = execFileSync(join(ROOT, 'bin/thought-inbox'), { env, input: '' }).toString() + execFileSync(join(ROOT, 'bin/thought-inbox'), ['-n', '100'], { env }).toString();
check('thought-inbox lists each page as untranscribed', ids.every(id => new RegExp(id.slice(0, 8) + '.*untranscribed').test(inbox)));
if (process.env.CLEAN) {
  const clone = join(env.THOUGHT_ROUTER_HOME, 'inbox-repo'); const g = (...a) => execFileSync('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...a], { cwd: clone, stdio: 'pipe' });
  g('pull', '-q', '--rebase', 'origin', 'main');
  for (const f of readdirSync(join(clone, 'thoughts'))) { const j = JSON.parse(readFileSync(join(clone, 'thoughts', f))); if (j.kind === 'page') { g('rm', '-q', '--ignore-unmatch', 'thoughts/' + f, 'attachments/' + j.id + '.jpg', 'pulled/' + j.id); } }
  try { g('commit', '-q', '-m', 'remove test pages'); g('push', '-q', 'origin', 'main'); console.log('cleaned test pages from inbox repo'); } catch (e) { console.log('nothing to clean'); }
}
console.log('IDS ' + ids.join(','));
close();
console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED'); process.exit(results.every(Boolean) ? 0 : 1);
