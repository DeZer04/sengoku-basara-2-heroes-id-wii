/* Helper worker of wii/worker.js: builds whole 2 MiB groups (RVZ data, hash tree, H3 check, AES) for the
 * coordinator, several of these run side by side (one per CPU core). Reads the RVZ itself (FileReaderSync). */
importScripts('engine.js', 'vendor/fzstd.js');

let rvz = null, aes = null;
self.onmessage = async e => {
  const d = e.data;
  try {
    if (d.type === 'init') {
      const fr = new FileReaderSync();
      rvz = new WiiPatch.RVZ((off, n) => new Uint8Array(fr.readAsArrayBuffer(d.rvz.slice(off, off + n))), u8 => fzstd.decompress(u8));
      aes = await WiiPatch.subtleAes(rvz.parts[rvz.parts.length - 1].key);
      self.postMessage({ type: 'ready' });
    } else if (d.type === 'job') {
      const res = await WiiPatch.doGroup(d.job, rvz, aes), data = d.job.data;
      self.postMessage({ type: 'done', id: d.id, bad: !!res.bad, out: res.out, data },
        res.out ? [res.out.buffer, data.buffer] : [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: d.id, user: !!(err && err.user), message: String(err && err.message || err) });
  }
};
