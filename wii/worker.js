/* Web Worker of patcher-wii.html: runs the patch engine on the user's RVZ and the .patch file, posting the ISO
 * in chunks to the page (which writes them to a file or a streaming download). Files are read synchronously
 * (FileReaderSync), zstd / zlib are decoded with fzstd / fflate (vendor/), AES runs on WebCrypto. The groups are
 * built by helper workers (pool.js, one per core) when the browser allows workers inside workers, else here.
 * The page acknowledges every chunk once written, so no more than ~48 MB is ever waiting in memory (phones). */
importScripts('engine.js', 'vendor/fzstd.js', 'vendor/fflate.js');

const LIMIT = 48 << 20;
let pending = 0, waiters = [];
self.onmessage = e => {
  const d = e.data;
  if (d.type === 'ack') {
    pending -= d.n;
    if (pending <= LIMIT) { const w = waiters; waiters = []; w.forEach(f => f()); }
  } else if (d.type === 'start') start(d.rvz, d.patch, d.threads).catch(err =>
    self.postMessage({ type: 'error', message: err && err.user ? err.message : 'Kesalahan tak terduga: ' + (err && err.message || err) }));
};

function userError(msg) { const e = new Error(msg); e.user = true; return e; }

// k helper workers, each with its own reader of the RVZ; [] when nested workers are unavailable or fail to start
async function startPool(rvzFile, k) {
  if (typeof Worker !== 'function' || !(k > 0)) return [];
  const pool = [];
  for (let i = 0; i < k; i++) {
    let w;
    try { w = new Worker('pool.js'); } catch (_) { break; }
    const calls = new Map(); let seq = 0, onReady;
    const ready = new Promise((res, rej) => { onReady = { res, rej }; });
    const failAll = err => { onReady.rej(err); calls.forEach(c => c.rej(err)); calls.clear(); };
    w.onmessage = e => {
      const d = e.data;
      if (d.type === 'ready') onReady.res();
      else if (d.type === 'error' && d.id === undefined) failAll(d.user ? userError(d.message) : new Error(d.message));
      else {
        const c = calls.get(d.id); calls.delete(d.id);
        if (!c) return;
        if (d.type === 'error') c.rej(d.user ? userError(d.message) : new Error(d.message)); else c.res(d);
      }
    };
    w.onerror = e => { e.preventDefault && e.preventDefault(); failAll(new Error('Worker bantu berhenti' + (e.message ? ': ' + e.message : ''))); };
    w.postMessage({ type: 'init', rvz: rvzFile });
    pool.push({ w, ready, exec: job => new Promise((res, rej) => {
      const id = seq++; calls.set(id, { res, rej });
      w.postMessage({ type: 'job', id, job }, [job.data.buffer, job.parts.buffer]);
    }) });
  }
  try {
    await Promise.race([Promise.all(pool.map(p => p.ready)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000))]);
    return pool;
  } catch (err) {
    pool.forEach(p => p.w.terminate());
    if (err && err.user) throw err;               // the RVZ itself is unusable: same answer without the pool
    return [];
  }
}

async function start(rvzFile, patchFile, threads) {
  const fr = new FileReaderSync();
  const reader = f => (off, n) => new Uint8Array(fr.readAsArrayBuffer(f.slice(off, off + n)));
  const readP = reader(patchFile);
  const patch = WiiPatch.parsePatch(readP);
  self.postMessage({ type: 'info', version: patch.man.version, size: patch.man.iso[0] });
  const pool = await startPool(rvzFile, threads);
  self.postMessage({ type: 'threads', n: pool.length || 1 });
  try {
    const res = await WiiPatch.run({
      rvzRead: reader(rvzFile),
      zstd: u8 => fzstd.decompress(u8),
      patch,
      take: WiiPatch.payloadReader(readP, patch.dataOffset, patchFile.size, fflate.Unzlib),
      aes: WiiPatch.subtleAes,
      pool,
      write: async u8 => {
        const buf = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : u8.slice();
        pending += buf.length;
        self.postMessage({ type: 'chunk', bytes: buf }, [buf.buffer]);
        if (pending > LIMIT) await new Promise(r => waiters.push(r));
      },
      progress: f => self.postMessage({ type: 'progress', f }),
      log: s => self.postMessage({ type: 'stage', text: s }),
    });
    self.postMessage({ type: 'done', size: res.size });
  } finally {
    pool.forEach(p => p.w.terminate());
  }
}
