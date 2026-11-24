// Capturas de Clase — demultiplexor WebM/Matroska mínimo y en streaming (solo la pista de vídeo, sin "lacing").
// Código propio de la extensión (misma licencia que el repositorio).
// readAt(pos, len) → Promise<Uint8Array>; size = tamaño total en bytes. Nunca lee el archivo entero.
// Soporta Segment/Cluster de tamaño desconocido (MediaRecorder), archivos sin Cues ni Duration, SimpleBlock y
// BlockGroup, cola truncada y elementos dañados (se busca el siguiente Cluster y se avisa con onResync).
// Uso: await demuxWebm({readAt, size}, {onInfo(info), onTracks(tracks), onBlock(b), onResync(from, to), signal})
//   b = {track, time (segundos, absoluto), key (bool), data (Uint8Array), pos}
//   onBlock puede devolver una promesa (contrapresión) o 'stop'.
(function (root) {
  'use strict';
  const ID = {
    EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Info: 0x1549A966,
    Tracks: 0x1654AE6B, Cluster: 0x1F43B675, Cues: 0x1C53BB6B, Timecode: 0xE7,
    SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1, ReferenceBlock: 0xFB,
    TimecodeScale: 0x2AD7B1, Duration: 0x4489, TrackEntry: 0xAE, TrackNumber: 0xD7,
    TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2, Video: 0xE0,
    PixelWidth: 0xB0, PixelHeight: 0xBA, DisplayWidth: 0x54B0, DisplayHeight: 0x54BA, Void: 0xEC, Tags: 0x1254C367
  };
  // Elementos que pueden aparecer en el recorrido plano (nivel 0/1 e hijos de Cluster). Cualquier otro = datos dañados.
  const KNOWN = new Set([ID.EBML, ID.Segment, ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags,
    0x1043A770 /* Chapters */, 0x1941A469 /* Attachments */, ID.Void, 0xBF /* CRC-32 */,
    ID.Timecode, ID.SimpleBlock, ID.BlockGroup, 0xA7 /* Position */, 0xAB /* PrevSize */, 0x5854 /* SilentTracks */,
    0xAF /* EncryptedBlock */]);
  const CLUSTER_SIG = [0x1F, 0x43, 0xB6, 0x75];
  const RESYNC_MAX = 16 << 20;

  function vintLen(b) { for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1; return 0; }
  function readId(u, o) { const l = vintLen(u[o]); if (!l || l > 4 || o + l > u.length) return [0, 0]; let v = 0; for (let i = 0; i < l; i++) v = v * 256 + u[o + i]; return [v, l]; }
  function readSize(u, o) {
    if (o >= u.length) return [0, 0];
    const l = vintLen(u[o]); if (!l || o + l > u.length) return [0, 0];
    let v = u[o] & (0xFF >> l); let allOnes = v === (0xFF >> l);
    for (let i = 1; i < l; i++) { v = v * 256 + u[o + i]; if (u[o + i] !== 0xFF) allOnes = false; }
    return [allOnes ? -1 : v, l];
  }
  function uint(u, o, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + u[o + i]; return v; }
  function float(u, o, n) { const dv = new DataView(u.buffer, u.byteOffset + o, n); return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); }

  function parseChildren(u, start, end, cb) {
    let o = start;
    while (o < end) {
      const [id, il] = readId(u, o); const [sz, sl] = readSize(u, o + il);
      if (!il || !sl) return;
      const ds = o + il + sl; const de = sz < 0 ? end : Math.min(end, ds + sz);
      cb(id, ds, de); o = de;
    }
  }

  async function demuxWebm(src, h) {
    const CH = 1 << 22; // lecturas de 4 MB
    let buf = new Uint8Array(0), bufPos = 0; // buf = bytes [bufPos, bufPos+buf.length)
    async function ensure(pos, n) {
      if (pos >= bufPos && pos + n <= bufPos + buf.length) return true;
      if (pos >= src.size) return false;
      const len = Math.min(Math.max(n, CH), src.size - pos);
      buf = await src.readAt(pos, len); bufPos = pos;
      return pos + n <= bufPos + buf.length;
    }
    const at = (pos) => pos - bufPos;
    // Busca el siguiente Cluster a partir de from (como mucho 16 MB). Devuelve su posición o -1.
    async function findCluster(from) {
      const end = Math.min(src.size, from + RESYNC_MAX);
      for (let p = from; p < end - 3;) {
        const n = Math.min(CH, end - p);
        const u = await src.readAt(p, n);
        for (let i = 0; i + 3 < u.length; i++) {
          if (u[i] === CLUSTER_SIG[0] && u[i + 1] === CLUSTER_SIG[1] && u[i + 2] === CLUSTER_SIG[2] && u[i + 3] === CLUSTER_SIG[3]) return p + i;
        }
        p += Math.max(1, u.length - 3);
      }
      return -1;
    }
    let scale = 1e6, clusterTc = 0, videoTrack = -1, nBlocks = 0, resyncs = 0;
    let pos = 0, sawSegment = false;
    const info = {};
    async function resync(from) {
      const to = await findCluster(from + 1);
      resyncs++;
      if (h.onResync) h.onResync(from, to);
      return to;
    }
    while (pos < src.size) {
      if (h.signal && h.signal.aborted) return { blocks: nBlocks, resyncs, aborted: true };
      if (!(await ensure(pos, 12))) { if (!(await ensure(pos, src.size - pos))) break; }
      const o = at(pos);
      const [id, il] = readId(buf, o); const [sz, sl] = il ? readSize(buf, o + il) : [0, 0];
      const hdr = il + sl, ds = pos + hdr;
      const remaining = src.size - ds;
      const corrupt = !il || !sl || (sawSegment && !KNOWN.has(id)) || (sz > remaining && remaining > (1 << 20) && id !== ID.Segment && id !== ID.Cluster);
      if (corrupt) {
        if (!sawSegment || src.size - pos < 16) break; // cabecera ilegible o cola truncada
        const to = await resync(pos);
        if (to < 0) break;
        pos = to; continue;
      }
      if (id === ID.Segment) sawSegment = true;
      if (id === ID.Segment || id === ID.Cluster || (sz < 0 && id !== ID.BlockGroup && id !== ID.SimpleBlock)) { pos = ds; continue; } // entrar
      if (sz < 0) break;
      if (id === ID.Timecode) { await ensure(ds, sz); clusterTc = uint(buf, at(ds), sz); pos = ds + sz; continue; }
      if (id === ID.Info) {
        if (!(await ensure(ds, sz))) break;
        const b = buf.subarray(at(ds), at(ds) + sz);
        parseChildren(b, 0, b.length, (cid, s, e) => {
          if (cid === ID.TimecodeScale) scale = uint(b, s, e - s);
          if (cid === ID.Duration && (e - s === 4 || e - s === 8)) info.durationRaw = float(b, s, e - s);
        });
        info.timecodeScale = scale; if (info.durationRaw != null) info.duration = info.durationRaw * scale / 1e9;
        if (h.onInfo) h.onInfo(info);
        pos = ds + sz; continue;
      }
      if (id === ID.Tracks) {
        if (!(await ensure(ds, sz))) break;
        const b = buf.subarray(at(ds), at(ds) + sz); const tracks = [];
        parseChildren(b, 0, b.length, (cid, s, e) => {
          if (cid !== ID.TrackEntry) return; const t = {};
          parseChildren(b, s, e, (k, s2, e2) => {
            if (k === ID.TrackNumber) t.number = uint(b, s2, e2 - s2);
            else if (k === ID.TrackType) t.type = uint(b, s2, e2 - s2);
            else if (k === ID.CodecID) t.codec = new TextDecoder().decode(b.subarray(s2, e2));
            else if (k === ID.CodecPrivate) t.codecPrivate = b.slice(s2, e2);
            else if (k === ID.Video) parseChildren(b, s2, e2, (v, s3, e3) => {
              if (v === ID.PixelWidth) t.width = uint(b, s3, e3 - s3);
              if (v === ID.PixelHeight) t.height = uint(b, s3, e3 - s3);
            });
          });
          tracks.push(t); if (t.type === 1 && videoTrack < 0) videoTrack = t.number;
        });
        if (h.onTracks) h.onTracks(tracks);
        pos = ds + sz; continue;
      }
      if (id === ID.SimpleBlock || id === ID.BlockGroup) {
        if (!(await ensure(ds, sz))) break; // cola truncada
        const b = buf.subarray(at(ds), at(ds) + sz);
        let key, blk;
        if (id === ID.SimpleBlock) { blk = b; key = !!(b[vintLen(b[0]) + 2] & 0x80); }
        else {
          let hasRef = false;
          parseChildren(b, 0, b.length, (cid, s, e) => { if (cid === ID.Block) blk = b.subarray(s, e); if (cid === ID.ReferenceBlock) hasRef = true; });
          key = !hasRef;
        }
        if (blk && blk.length > 4) {
          const tl = vintLen(blk[0]);
          const track = tl ? uint(blk, 0, tl) & ~(0x80 << (8 * (tl - 1))) : -1;
          let rel = (blk[tl] << 8) | blk[tl + 1]; if (rel & 0x8000) rel -= 0x10000;
          const flags = blk[tl + 2];
          if (track === videoTrack && !(flags & 0x06)) {
            nBlocks++;
            const r = h.onBlock({ track, time: (clusterTc + rel) * scale / 1e9, key, data: blk.subarray(tl + 3), pos });
            if (r === 'stop') return { blocks: nBlocks, resyncs, stopped: true };
            if (r && r.then) { const rr = await r; if (rr === 'stop') return { blocks: nBlocks, resyncs, stopped: true }; }
          }
        }
        pos = ds + sz; continue;
      }
      // Lo demás se salta (Cues, SeekHead, Void, Tags…).
      pos = ds + sz;
    }
    return { blocks: nBlocks, resyncs };
  }
  root.demuxWebm = demuxWebm;
  if (typeof module !== 'undefined') module.exports = { demuxWebm };
})(typeof self !== 'undefined' ? self : globalThis);
