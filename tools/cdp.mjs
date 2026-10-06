// Minimal headless Chrome over a CDP pipe (no listening port). Shared by the e2e tests.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

export async function launch() {
  const dir = join(homedir(), '.cache/ms-playwright');
  const chrome = join(dir, readdirSync(dir).find(d => d.startsWith('chromium-')), 'chrome-linux64/chrome');
  const profile = mkdtempSync(join(tmpdir(), 'tr-prof-'));
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-pipe', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0; const pending = new Map(); const listeners = []; let buf = '';
  proc.stdio[4].on('data', d => {
    buf += d.toString(); let i;
    while ((i = buf.indexOf('\0')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
      else listeners.forEach(l => l(m));
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); proc.stdio[3].write(JSON.stringify({ id: n, method, params, sessionId }) + '\0'); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const cmd = (m, p) => send(m, p, sessionId);
  const close = () => { proc.kill(); rmSync(profile, { recursive: true, force: true }); };
  return { cmd, listeners, sessionId, close };
}
