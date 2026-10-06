'use strict';
// Scan handwritten notes: pick a video (or photos), keep one sharp frame per distinct page, queue each as an upload.
// Nothing is transcribed on the phone. Thresholds are starting values, adjustable in localStorage key tr_scan (JSON).
const SCAN = Object.assign({ step: 0.5, change: 0.25, dup: 0.15, max: 60, side: 1600 }, (() => { try { return JSON.parse(localStorage.getItem('tr_scan') || '{}'); } catch (e) { return {}; } })());

function gray(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
  for (let i = 0; i < g.length; i++) g[i] = (d[4 * i] * 77 + d[4 * i + 1] * 150 + d[4 * i + 2] * 29) >> 8;
  return g;
}
// Ink map: 1 where a pixel is clearly darker than the page average. Compared by how much ink overlaps (a one pixel
// tolerance absorbs hand shake), because handwriting is sparse and whole-frame pixel differences barely move between pages.
function inkMap(g, w, h) {
  let m = 0; for (let i = 0; i < g.length; i++) m += g[i];
  const thr = (m / g.length) * 0.72, ink = new Uint8Array(g.length); let n = 0;
  for (let i = 0; i < g.length; i++) if (g[i] < thr) { ink[i] = 1; n++; }
  const dil = new Uint8Array(g.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (ink[i - w - 1] | ink[i - w] | ink[i - w + 1] | ink[i - 1] | ink[i] | ink[i + 1] | ink[i + w - 1] | ink[i + w] | ink[i + w + 1]) dil[i] = 1;
  }
  return { ink, dil, n };
}
// 0 means the same page, 1 means nothing in common.
function dist(a, b) {
  if (!a.n && !b.n) return 0;
  let ab = 0, ba = 0;
  for (let i = 0; i < a.ink.length; i++) { if (a.ink[i] & b.dil[i]) ab++; if (b.ink[i] & a.dil[i]) ba++; }
  return 1 - (ab + ba) / (a.n + b.n);
}
// Variance of a Laplacian: higher means sharper.
function sharp(g, w, h) {
  let sum = 0, sq = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    sum += l; sq += l * l; n++;
  }
  return sq / n - (sum / n) * (sum / n);
}
function seek(v, t) {
  return new Promise((res, rej) => {
    const ok = () => { v.removeEventListener('seeked', ok); res(); };
    v.addEventListener('seeked', ok);
    v.addEventListener('error', () => rej(new Error('video error')), { once: true });
    v.currentTime = t;
  });
}
function toBlob(canvas) { return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85)); }

// Returns an array of JPEG blobs, one per distinct stable view.
async function extractPages(file, onProgress) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = () => rej(new Error('Cannot read this video')); });
  const dur = v.duration, k = Math.min(1, SCAN.side / Math.max(v.videoWidth, v.videoHeight));
  const full = document.createElement('canvas'); full.width = Math.round(v.videoWidth * k); full.height = Math.round(v.videoHeight * k);
  const fctx = full.getContext('2d');
  const SW = 384, SH = Math.max(8, Math.round(384 * v.videoHeight / v.videoWidth));
  const small = document.createElement('canvas'); small.width = SW; small.height = SH;
  const sctx = small.getContext('2d', { willReadFrequently: true });
  const keep = []; // {t, vec}
  let run = null;
  const close = () => {
    if (!run) return;
    if (!keep.some(p => dist(p.vec, run.bestVec) < SCAN.dup)) keep.push({ t: run.bestT, vec: run.bestVec });
    run = null;
  };
  for (let t = 0; t < dur; t += SCAN.step) {
    await seek(v, Math.min(t, Math.max(0, dur - 0.05)));
    sctx.drawImage(v, 0, 0, SW, SH);
    const g = gray(sctx, SW, SH), im = inkMap(g, SW, SH);
    if (!run || dist(run.ref, im) > SCAN.change) { close(); run = { ref: im, bestS: -1, bestT: t, bestVec: im }; }
    const s = sharp(g, SW, SH);
    if (s > run.bestS) { run.bestS = s; run.bestT = t; run.bestVec = im; }
    if (onProgress) onProgress(Math.min(1, t / dur), keep.length);
  }
  close();
  const pages = [];
  for (const p of keep.slice(0, SCAN.max)) {
    await seek(v, Math.min(p.t, Math.max(0, dur - 0.05)));
    fctx.drawImage(v, 0, 0, full.width, full.height);
    pages.push(await toBlob(full));
  }
  URL.revokeObjectURL(url);
  return pages;
}

async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, SCAN.side / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return toBlob(c);
}

async function scanFiles(files) {
  const st = document.getElementById('scanstatus');
  const blobs = [];
  try {
    for (const f of files) {
      if (f.type.startsWith('video/')) blobs.push(...await extractPages(f, (p, n) => { st.textContent = 'Reading video ' + Math.round(p * 100) + '%, ' + n + ' pages'; }));
      else blobs.push(await resizeImage(f));
    }
  } catch (e) { st.textContent = 'Scan failed: ' + e.message; return; }
  if (!blobs.length) { st.textContent = 'No pages found'; return; }
  const scan = uuid().slice(0, 8), t0 = Date.now();
  for (let i = 0; i < blobs.length; i++) {
    await putItem({ id: uuid(), kind: 'page', text: '', blob: blobs[i], scan, page: i + 1, total: blobs.length,
      created_at: new Date(t0 + i).toISOString(), device: device(), state: 'saved', err: '', attempts: 0 });
  }
  st.textContent = blobs.length + ' pages saved on phone';
  await render();
  flush();
}

document.getElementById('scanbtn').addEventListener('click', () => document.getElementById('scanfile').click());
document.getElementById('scanfile').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) scanFiles(f); });
