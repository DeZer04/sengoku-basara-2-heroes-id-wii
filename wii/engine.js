/* Sengoku Basara 2 Heroes (Wii, RBSJ08) - Indonesian patch engine.
 * The user's own RVZ (Dolphin) + the .patch file -> a translated ISO, written front to back in one pass.
 * Same layout rules as the PC patcher (patch_wii.py) and the reference build, so the ISO is byte-identical
 * to the release; every 2 MiB group is checked against the H3 table the patch carries.
 * Environment-agnostic: the caller supplies file reads, zstd, the patch payload stream and AES (see run()).
 * The heavy part (RVZ decompression, hash tree, AES) runs per group in doGroup(), so a caller can spread the
 * groups over several workers (env.pool); the groups are written back in order.
 * Used by wii/worker.js + wii/pool.js in the browser and by the Node test script. */
(function (root) {
  'use strict';
  const SECT = 0x8000, DATA = 0x7C00, CL = 0x8000, CD = 0x7C00, POFF = 0xF800000, ALIGN = 0x8000, GD = 64 * CD;

  // ---------------------------------------------------------------- SHA-1 (sync; the hash tree needs millions)
  const Wt = new Int32Array(80);
  const TAIL = new Uint8Array(128);
  function sha1Into(b, off, len, out, oo) {
    let h0 = 0x67452301, h1 = 0xEFCDAB89 | 0, h2 = 0x98BADCFE | 0, h3 = 0x10325476, h4 = 0xC3D2E1F0 | 0;
    const full = len >>> 6, rem = len - full * 64, extra = rem < 56 ? 1 : 2;
    TAIL.fill(0);
    TAIL.set(b.subarray(off + full * 64, off + len), 0);
    TAIL[rem] = 0x80;
    const lp = extra * 64 - 8, hi = Math.floor(len / 0x20000000), lo = (len * 8) >>> 0;
    TAIL[lp] = hi >>> 24; TAIL[lp + 1] = hi >>> 16; TAIL[lp + 2] = hi >>> 8; TAIL[lp + 3] = hi;
    TAIL[lp + 4] = lo >>> 24; TAIL[lp + 5] = lo >>> 16; TAIL[lp + 6] = lo >>> 8; TAIL[lp + 7] = lo;
    const W = Wt;
    for (let blk = 0; blk < full + extra; blk++) {
      let src = b, p = off + blk * 64;
      if (blk >= full) { src = TAIL; p = (blk - full) * 64; }
      for (let i = 0; i < 16; i++, p += 4) W[i] = (src[p] << 24) | (src[p + 1] << 16) | (src[p + 2] << 8) | src[p + 3];
      for (let i = 16; i < 80; i++) { const x = W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16]; W[i] = (x << 1) | (x >>> 31); }
      let a = h0, c1 = h1, c = h2, d = h3, e = h4, t;
      for (let i = 0; i < 20; i++) { t = (((a << 5) | (a >>> 27)) + ((c1 & c) | (~c1 & d)) + e + 0x5A827999 + W[i]) | 0; e = d; d = c; c = (c1 << 30) | (c1 >>> 2); c1 = a; a = t; }
      for (let i = 20; i < 40; i++) { t = (((a << 5) | (a >>> 27)) + (c1 ^ c ^ d) + e + 0x6ED9EBA1 + W[i]) | 0; e = d; d = c; c = (c1 << 30) | (c1 >>> 2); c1 = a; a = t; }
      for (let i = 40; i < 60; i++) { t = (((a << 5) | (a >>> 27)) + ((c1 & c) | (c1 & d) | (c & d)) + e - 0x70E44324 + W[i]) | 0; e = d; d = c; c = (c1 << 30) | (c1 >>> 2); c1 = a; a = t; }
      for (let i = 60; i < 80; i++) { t = (((a << 5) | (a >>> 27)) + (c1 ^ c ^ d) + e - 0x359D3E2A + W[i]) | 0; e = d; d = c; c = (c1 << 30) | (c1 >>> 2); c1 = a; a = t; }
      h0 = (h0 + a) | 0; h1 = (h1 + c1) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
    }
    put32be(out, oo, h0); put32be(out, oo + 4, h1); put32be(out, oo + 8, h2); put32be(out, oo + 12, h3); put32be(out, oo + 16, h4);
  }
  function sha1(b, off, len) { const o = new Uint8Array(20); sha1Into(b, off, len, o, 0); return o; }
  const hex = u8 => Array.from(u8, x => x.toString(16).padStart(2, '0')).join('');

  function fail(msg) { const e = new Error(msg); e.user = true; throw e; }
  const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const be16 = (b, o) => (b[o] << 8) | b[o + 1];
  const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const be64 = (b, o) => be32(b, o) * 0x100000000 + be32(b, o + 4);
  function put32be(b, o, v) { b[o] = v >>> 24; b[o + 1] = v >>> 16; b[o + 2] = v >>> 8; b[o + 3] = v; }
  function put32le(b, o, v) { b[o] = v; b[o + 1] = v >>> 8; b[o + 2] = v >>> 16; b[o + 3] = v >>> 24; }

  // ---------------------------------------------------------------- RVZ (Dolphin) reader
  class RVZ {
    constructor(read, zstd) {
      this.read = read; this.zstd = zstd;
      const h = read(0, 0x48), m = String.fromCharCode(h[0], h[1], h[2], h[3]);
      if (m !== 'RVZ\x01' && m !== 'WIA\x01') fail('File game bukan RVZ. Ubah dulu ISO/WBFS-mu ke RVZ di Dolphin (lihat petunjuk).');
      this.rvz = m === 'RVZ\x01';
      const d = read(0x48, 0xDC);
      this.compression = be32(d, 4); this.chunk = be32(d, 12);
      this.dhead = d.slice(0x10, 0x90);
      if (this.compression !== 0 && this.compression !== 5)
        fail('RVZ ini memakai kompresi selain Zstandard. Konversi ulang di Dolphin dengan Compression: Zstandard.');
      const nPart = be32(d, 0x90), partT = be32(d, 0x94), partOff = be64(d, 0x98);
      const nRaw = be32(d, 0xB4), rawOff = be64(d, 0xB8), rawSize = be32(d, 0xC0);
      const nGroups = be32(d, 0xC4), groupOff = be64(d, 0xC8), groupSize = be32(d, 0xD0);
      this.parts = [];
      for (let k = 0; k < nPart; k++) {
        const p = new Uint8Array(0x30); p.set(read(partOff + k * partT, partT).subarray(0, 0x30));
        const pd = [0, 1].map(j => [be32(p, 0x10 + 16 * j), be32(p, 0x14 + 16 * j), be32(p, 0x18 + 16 * j), be32(p, 0x1C + 16 * j)]);
        this.parts.push({ key: p.slice(0, 16), pd });
      }
      const raw = this.unz(read(rawOff, rawSize));
      this.raws = [];
      for (let k = 0; k < nRaw; k++) this.raws.push([be64(raw, 24 * k), be64(raw, 24 * k + 8), be32(raw, 24 * k + 16), be32(raw, 24 * k + 20)]);
      const gs = this.rvz ? 12 : 8, gt = this.unz(read(groupOff, groupSize));
      this.groups = [];
      for (let k = 0; k < nGroups; k++) this.groups.push([be32(gt, gs * k), be32(gt, gs * k + 4), this.rvz ? be32(gt, gs * k + 8) : 0]);
      this.cache = new Map(); this.cached = 0;
    }
    unz(b) { return this.compression === 5 ? this.zstd(b) : b; }
    unpack(b, size) {
      const out = new Uint8Array(size); let i = 0, o = 0;
      while (i < b.length && o < size) {
        let n = be32(b, i); i += 4;
        if (n & 0x80000000) { n &= 0x7FFFFFFF; i += 68; o += n; }      // junk padding -> zeroes
        else { out.set(b.subarray(i, i + n).subarray(0, size - o), o); i += n; o += n; }
      }
      return out;
    }
    group(gi, size, part) {
      const key = gi * 2 + (part ? 1 : 0);
      let d = this.cache.get(key);
      if (d) return d;
      const [off4, sz, packed] = this.groups[gi];
      const stored = sz & 0x7FFFFFFF, comp = this.rvz ? (sz & 0x80000000) !== 0 : this.compression !== 0;
      if (stored === 0) d = new Uint8Array(size);
      else {
        let raw = this.read(off4 * 4, stored);
        if (comp) raw = this.zstd(raw);
        let i = 0;
        if (part) {
          for (let k = Math.max(1, Math.floor(this.chunk / 0x200000)); k > 0; k--) i += 2 + be16(raw, i) * 22;
          if (!comp && i % 4) i += 4 - i % 4;
        }
        const body = raw.subarray(i);
        if (packed) d = this.unpack(body, size);
        else { d = new Uint8Array(size); d.set(body.subarray(0, size)); }
      }
      if (this.cached > (8 << 20)) { this.cache.clear(); this.cached = 0; }   // a few groups are enough (reads go forward)
      this.cache.set(key, d); this.cached += d.length;
      return d;
    }
    readPartInto(pi, off, n, out, o) {
      const p = this.parts[pi], first = p.pd[0][0], perGroup = this.chunk / SECT * DATA;
      while (n > 0) {
        const sector = first + Math.floor(off / DATA); let hit = false;
        for (const [fs, ns, gi] of p.pd) {
          if (fs <= sector && sector < fs + ns) {
            const rel = off - (fs - first) * DATA, g = Math.floor(rel / perGroup);
            const gsize = Math.min(perGroup, ns * DATA - g * perGroup);
            const data = this.group(gi + g, gsize, true), s = rel - g * perGroup, take = Math.min(n, gsize - s);
            out.set(data.subarray(s, s + take), o);
            o += take; off += take; n -= take; hit = true; break;
          }
        }
        if (!hit) fail('Data di luar partisi game: dump ini tidak sesuai.');
      }
    }
    readPart(pi, off, n) { const out = new Uint8Array(n); this.readPartInto(pi, off, n, out, 0); return out; }
    readRaw(off, n) {
      const out = new Uint8Array(n); let o = 0;
      while (n > 0) {
        if (off < 0x80) { const t = Math.min(n, 0x80 - off); out.set(this.dhead.subarray(off, off + t), o); o += t; off += t; n -= t; continue; }
        let hit = false;
        for (const [ro, rs, gi] of this.raws) {
          const start = ro - ro % SECT, end = ro + rs;
          if (start <= off && off < end) {
            const rel = off - start, g = Math.floor(rel / this.chunk), gsize = Math.min(this.chunk, end - start - g * this.chunk);
            const data = this.group(gi + g, gsize, false), s = rel - g * this.chunk, take = Math.min(n, gsize - s);
            out.set(data.subarray(s, s + take), o); o += take; off += take; n -= take; hit = true; break;
          }
        }
        if (!hit) { const t = Math.min(n, SECT - off % SECT); o += t; off += t; n -= t; }
      }
      return out;
    }
  }
  // the game partition is the last one stored in the RVZ
  const gamePart = r => r.parts.length - 1;

  // ---------------------------------------------------------------- patch header
  function parsePatch(readPatch) {
    const h = readPatch(0, 12);
    if (String.fromCharCode(...h.subarray(0, 8)) !== 'BSR2WII2') fail('File ini bukan patch Basara 2 Wii (format v2).');
    const ml = le32(h, 8);
    const man = JSON.parse(new TextDecoder().decode(readPatch(12, ml)));
    let p = 12 + ml;
    const tl = le32(readPatch(p, 4), 0); const tmd = readPatch(p + 4, tl); p += 4 + tl;
    const hl = le32(readPatch(p, 4), 0); const h3 = readPatch(p + 4, hl); p += 4 + hl;
    return { man, tmd, h3, dataOffset: p };
  }

  // the payload stream (zlib) as take(n), inflated as it is consumed; Unzlib = fflate's streaming class
  function payloadReader(readPatch, start, end, Unzlib) {
    let pos = start, queue = [], queued = 0;
    const unz = new Unzlib(chunk => { queue.push(chunk); queued += chunk.length; });
    return n => {
      while (queued < n) {
        if (pos >= end) fail('File patch terpotong (unduhan tidak lengkap?). Unduh ulang file .patch.');
        const c = readPatch(pos, Math.min(4 << 20, end - pos));
        pos += c.length;
        unz.push(c, pos >= end);
      }
      const out = new Uint8Array(n); let o = 0;
      while (o < n) {
        const h = queue[0], k = Math.min(h.length, n - o);
        out.set(h.subarray(0, k), o); o += k;
        if (k === h.length) queue.shift(); else queue[0] = h.subarray(k);
      }
      queued -= n;
      return out;
    };
  }

  // ---------------------------------------------------------------- one group: data -> hash tree -> AES
  // job: { g, nc (clusters), data (64 * 0x7C00, filled except the parts), parts (Float64Array of
  //        [dest, partition offset in the RVZ, length] triples), h3 (the 20 bytes the group must hash to) }
  // -> { out (nc * 0x8000 encrypted bytes) } or { bad: true } when the group does not match the patch.
  async function doGroup(job, rvz, aes) {
    const { data, parts, nc, h3 } = job, pi = gamePart(rvz);
    for (let i = 0; i < parts.length; i += 3) rvz.readPartInto(pi, parts[i + 1], parts[i + 2], data, parts[i]);
    const hb = new Uint8Array(64 * 0x400), h1 = new Uint8Array(64 * 20), h2 = new Uint8Array(160), top = new Uint8Array(20);
    for (let c = 0; c < 64; c++) {
      const base = c * 0x400;
      for (let i = 0; i < 31; i++) sha1Into(data, c * CD + i * 0x400, 0x400, hb, base + i * 20);
      sha1Into(hb, base, 0x26C, h1, c * 20);
    }
    for (let s = 0; s < 8; s++) sha1Into(h1, s * 160, 160, h2, s * 20);
    sha1Into(h2, 0, 160, top, 0);
    for (let i = 0; i < 20; i++) if (top[i] !== h3[i]) return { bad: true };
    for (let c = 0; c < nc; c++) {
      const base = c * 0x400, s = c >> 3;
      hb.set(h1.subarray(s * 160, s * 160 + 160), base + 0x280); hb.set(h2, base + 0x340);
    }
    const out = new Uint8Array(nc * CL), zIV = new Uint8Array(16), cs = [];
    for (let c = 0; c < nc; c++) cs.push(c);
    const ehb = await Promise.all(cs.map(c => aes.enc(zIV, hb.subarray(c * 0x400, c * 0x400 + 0x400))));
    cs.forEach(c => out.set(ehb[c], c * CL));
    const ed = await Promise.all(cs.map(c => aes.enc(out.subarray(c * CL + 0x3D0, c * CL + 0x3E0), data.subarray(c * CD, c * CD + CD))));
    cs.forEach(c => out.set(ed[c], c * CL + 0x400));
    return { out };
  }

  // ---------------------------------------------------------------- segment reader (sorted, binary search)
  // a source: { size, read(a, k, out, oo, parts) } fills out[oo..] with its bytes a..a+k, or (data of the
  // original partition) adds a [oo, partition offset, k] triple to parts for doGroup to fill
  class Segs {
    constructor(list) { this.s = list.slice().sort((a, b) => a.start - b.start); }
    async read(off, n, out, oo, parts) {
      const s = this.s; let lo = 0, hi = s.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (s[m].start + s[m].size <= off) lo = m + 1; else hi = m; }
      for (let i = lo; i < s.length && s[i].start < off + n; i++) {
        const a = Math.max(off, s[i].start), b = Math.min(off + n, s[i].start + s[i].size);
        if (a < b) await s[i].read(a - s[i].start, b - a, out, oo + a - off, parts);
      }
    }
  }

  // ---------------------------------------------------------------- run
  // env: { rvzRead(off, n) -> Uint8Array, zstd(u8) -> Uint8Array, patch: parsePatch result,
  //        take(n) -> Uint8Array or Promise (the next n bytes of the patch payload stream),
  //        aes: async (key) -> { enc(iv, u8) -> Promise<Uint8Array> }  (CBC, no padding),
  //        pool: optional [{ exec(job) -> Promise<{out, data?} | {bad}> }] (doGroup elsewhere; data = the job's
  //              buffer handed back for reuse); without it the groups run here, one after another,
  //        write(u8) -> Promise (takes ownership of u8), progress(fraction), log(text) }
  async function run(env) {
    const { man, tmd: newTmd, h3 } = env.patch;
    const log = env.log || (() => {}), progress = env.progress || (() => {});
    log('Membaca RVZ…');
    const r = new RVZ(env.rvzRead, env.zstd);
    if (String.fromCharCode(...r.dhead.subarray(0, 6)) !== 'RBSJ08') fail('Dump ini bukan RBSJ08 (Sengoku Basara 2 Heroes, disk Heroes dari Double Pack Jepang).');
    const pt = r.readRaw(0x40000, 0x20), nP = be32(pt, 0), ents = r.readRaw(be32(pt, 4) * 4, 8 * nP);
    let game = null;
    for (let k = 0; k < nP; k++) if (be32(ents, 8 * k + 4) === 0) game = be32(ents, 8 * k) * 4;
    if (game !== POFF) fail('Tata letak partisi tidak dikenal.');
    const gi = gamePart(r), rp = (o, n) => r.readPart(gi, o, n);
    const boot = rp(0, 0x440);
    const dolOff = be32(boot, 0x420) * 4, fstOff = be32(boot, 0x424) * 4, fstSize = be32(boot, 0x428) * 4;
    const fst = rp(fstOff, fstSize);
    // FST: every file with its path (like wiiiso.file_paths; this disc's folders are empty)
    const n = be32(fst, 8), names = 12 * n, files = [];
    const nm = i => { const no = (fst[12 * i + 1] << 16) | (fst[12 * i + 2] << 8) | fst[12 * i + 3]; let e = names + no; while (fst[e]) e++; return String.fromCharCode(...fst.subarray(names + no, e)); };
    (function walk(i, end, path) {
      while (i < end) {
        if (fst[12 * i]) { const next = be32(fst, 12 * i + 8); if (next <= i || next > n) fail('Struktur FST tidak dikenal.'); walk(i + 1, next, path + nm(i) + '/'); i = next; }
        else { files.push({ i, name: path + nm(i), off: be32(fst, 12 * i + 4) * 4, size: be32(fst, 12 * i + 8) }); i++; }
      }
    })(1, n, '');
    const byName = Object.fromEntries(files.map(f => [f.name, f]));
    log('Memeriksa dump…');
    for (const [name, [size, digest]] of Object.entries(man.files)) {
      if (name === 'main.dol') continue;
      const f = byName[name];
      if (!f || f.size !== size) fail(`Ukuran ${name} berbeda: dump ini tidak sesuai.`);
      if (digest && hex(sha1(rp(f.off, f.size), 0, f.size)) !== digest) fail(`Isi ${name} berbeda: dump ini tidak sesuai.`);
    }
    // main.dol with the patched ranges (first in the payload stream)
    const dh = rp(dolOff, 0x100);
    let dolSize = 0;
    for (let k = 0; k < 18; k++) { const s = be32(dh, 0x90 + 4 * k); if (s) dolSize = Math.max(dolSize, be32(dh, 4 * k) + s); }
    const dol = rp(dolOff, dolSize);
    if (hex(sha1(dol, 0, dol.length)) !== man.files['main.dol'][1]) fail('main.dol berbeda: dump ini tidak sesuai.');
    for (const [a, k] of man.dol) dol.set(await env.take(k), a);
    // sources of the new partition
    const lazy = size => {                       // a payload: its bytes come from the stream as they are needed
      const o = { size, used: 0 };
      o.read = async (a, k, out, oo) => {
        if (a !== o.used) fail('Urutan patch rusak.');
        out.set(await env.take(k), oo); o.used += k;
      };
      return o;
    };
    const fromRvz = (base, size) => ({ size, read: (a, k, out, oo, parts) => { if (parts) parts.push(oo, base + a, k); else out.set(rp(base + a, k), oo); } });
    const bytesSrc = u8 => ({ size: u8.length, read: (a, k, out, oo) => out.set(u8.subarray(a, a + k), oo) });
    function afs(f, changed) {                    // rebuilt like wii_afs.py
      const head = rp(f.off, 8), cnt = le32(head, 4), tb = rp(f.off + 8, 8 * cnt + 8);
      const toc = []; for (let k = 0; k < cnt; k++) toc.push([le32(tb, 8 * k), le32(tb, 8 * k + 4)]);
      const ntOff = le32(tb, 8 * cnt), ntSize = le32(tb, 8 * cnt + 4);
      const repl = new Map(changed.map(([i, s]) => [i, s]));
      const segs = []; const hdr = new Uint8Array(toc[0][0]); hdr.set(head, 0);
      let pos = toc[0][0];
      toc.forEach(([o, s], i) => {
        const src = repl.has(i) ? lazy(repl.get(i)) : fromRvz(f.off + o, s);
        segs.push({ start: pos, size: src.size, read: src.read });
        put32le(hdr, 8 + 8 * i, pos); put32le(hdr, 12 + 8 * i, src.size);
        pos += src.size + ((0x800 - src.size % 0x800) % 0x800);
      });
      const end = pos;
      put32le(hdr, 8 + 8 * cnt, end); put32le(hdr, 12 + 8 * cnt, ntSize);
      segs.push({ start: end, size: ntSize, read: fromRvz(f.off + ntOff, ntSize).read });
      segs.push({ start: 0, size: hdr.length, read: bytesSrc(hdr).read });
      const S = new Segs(segs);
      return { size: end + ntSize, read: (a, k, out, oo, parts) => S.read(a, k, out, oo, parts) };
    }
    const src = {};
    for (const [kind, name] of man.stream) {
      if (kind === 'afs') src[name] = afs(byName[name], man.afs[name]);
      else if (kind === 'whole') src[name] = lazy(man.whole[name]);
    }
    const ah = rp(0x2440, 0x20), asz = 0x20 + be32(ah, 0x14) + be32(ah, 0x18);
    const list = [{ start: 0, ...bytesSrc(boot) }, { start: 0x440, ...bytesSrc(rp(0x440, 0x2000)) },
      { start: 0x2440, ...bytesSrc(rp(0x2440, asz)) }, { start: dolOff, ...bytesSrc(dol) }];
    let pos = Math.max(Math.min(...files.map(f => f.off)), fstOff + fstSize);
    const newFst = fst.slice();
    for (const f of files.slice().sort((a, b) => a.off - b.off)) {
      const s = src[f.name] || fromRvz(f.off, f.size);
      pos = Math.ceil(pos / ALIGN) * ALIGN;
      put32be(newFst, 12 * f.i + 4, pos / 4); put32be(newFst, 12 * f.i + 8, s.size);
      list.push({ start: pos, size: s.size, read: s.read });
      pos += s.size;
    }
    list.push({ start: fstOff, ...bytesSrc(newFst) });
    const logical = new Segs(list), end = pos;
    const nclu = Math.ceil(end / CD), ngrp = Math.ceil(nclu / 64);
    if (nclu * CL !== man.data_size || h3.length !== 20 * ngrp) fail('Patch dan dump tidak cocok (ukuran partisi berbeda).');
    // ---- disc header, gap, partition header
    const total = POFF + 0x20000 + nclu * CL;
    let written = 0;
    const out = async u8 => { const k = u8.length; await env.write(u8); written += k; };
    const disc = r.readRaw(0, 0x50000);
    disc.fill(0, 0x40000, 0x40040);
    put32be(disc, 0x40000, 1); put32be(disc, 0x40004, 0x40020 / 4); put32be(disc, 0x40020, POFF / 4);
    await out(disc);
    for (let left = POFF - 0x50000; left > 0;) { const k = Math.min(left, 8 << 20); await out(new Uint8Array(k)); left -= k; }
    const ph = r.readRaw(POFF, 0x20000);
    const tmdSize = be32(ph, 0x2A4), tmdOff = be32(ph, 0x2A8) * 4;
    if (tmdSize !== newTmd.length) fail('TMD tidak cocok.');
    ph.set(newTmd, tmdOff);
    put32be(ph, 0x2BC, nclu * CL / 4);
    ph.fill(0, 0x8000, 0x20000); ph.set(h3, 0x8000);
    await out(ph);
    // ---- groups: planned here in disc order (payloads come from one stream), hashed and encrypted by the
    //      executors (two jobs each so none waits), written back in order
    log('Menulis ISO…');
    let localAes = null;
    const execs = env.pool && env.pool.length ? env.pool : [{ exec: async job => {
      localAes = localAes || await env.aes(r.parts[gi].key);
      return Object.assign(await doGroup(job, r, localAes), { data: job.data });
    } }];
    const lanes = execs.length * 2, WINDOW = lanes + 2;
    const results = new Map(), free = [], waiters = [];
    let nextPlan = 0, nextWrite = 0, failed = null, planLock = Promise.resolve(), writeLock = Promise.resolve();
    const wake = () => waiters.splice(0).forEach(f => f());
    const getJob = () => (planLock = planLock.then(async () => {
      while (!failed && nextPlan - nextWrite >= WINDOW) await new Promise(f => waiters.push(f));
      if (failed || nextPlan >= ngrp) return null;
      const g = nextPlan++, data = free.pop() || new Uint8Array(GD), parts = [];
      data.fill(0);
      await logical.read(g * GD, GD, data, 0, parts);
      return { g, nc: Math.min(64, nclu - g * 64), data, parts: Float64Array.from(parts), h3: h3.slice(20 * g, 20 * g + 20) };
    }));
    const lane = async ex => {
      try {
        for (;;) {
          const job = await getJob();
          if (!job) return;
          const g = job.g, res = await ex.exec(job);
          if (failed) return;
          if (res.bad) fail('Hasil tidak cocok dengan patch (grup ' + g + '). Pastikan dump-mu bersih, versi RBSJ08 yang sama.');
          if (res.data && free.length < lanes) free.push(res.data);
          results.set(g, res.out);
          writeLock = writeLock.then(async () => {
            while (results.has(nextWrite)) {
              const o = results.get(nextWrite); results.delete(nextWrite);
              await out(o); nextWrite++; wake(); progress(written / total);
            }
          });
          await writeLock;
        }
      } catch (e) { failed = failed || e; wake(); throw e; }
    };
    await Promise.all(execs.flatMap(ex => [lane(ex), lane(ex)]));
    if (nextWrite !== ngrp) fail('Penulisan berhenti di tengah.');
    progress(1);
    return { size: total };
  }

  // AES-128-CBC without padding on WebCrypto (browser workers, Node 19+): WebCrypto always pads, the
  // ciphertext of the data itself is the first u8.length bytes
  async function subtleAes(key) {
    const subtle = globalThis.crypto.subtle, k =await subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    return { enc: async (iv, u8) => new Uint8Array(await subtle.encrypt({ name: 'AES-CBC', iv }, k, u8), 0, u8.length) };
  }

  const api = { run, parsePatch, payloadReader, doGroup, subtleAes, sha1, RVZ };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WiiPatch = api;
})(typeof self !== 'undefined' ? self : this);
