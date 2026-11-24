// Worker de «Procesar vídeos grabados»: lee el archivo por trozos (WebM o MP4), lo decodifica con WebCodecs
// (VideoDecoder) de principio a fin en una sola pasada, toma una muestra por segundo de vídeo, detecta la
// presentación y decide qué guardar. La página solo escribe las imágenes en la carpeta.
// Funciona aunque la pestaña esté en segundo plano (no depende de temporizadores ni de requestAnimationFrame).
'use strict';
importScripts('core.js', 'vdetect.js', 'vpolicy.js', 'lib/webm-demux.js', 'lib/mp4box.all.js');

const DET_W = 480;
let job = null; // trabajo en curso: { aborted, acks, waitAck }

const log = (msg) => postMessage({ type: 'log', msg });
const hex2 = (n) => n.toString(16).padStart(2, '0');

// Cadena de códec + descripción de una pista Matroska. keyData = contenido del primer fotograma clave.
function codecFor(track, keyData) {
  switch (track.codec) {
    case 'V_VP8': return { codec: 'vp8' };
    case 'V_VP9': { // perfil en la cabecera del fotograma: frame_marker(2) profile_low(1) profile_high(1)
      const b = keyData[0], prof = ((b >> 5) & 1) | (((b >> 4) & 1) << 1);
      return { codec: `vp09.0${prof}.41.${prof >= 2 ? '10' : '08'}` };
    }
    case 'V_AV1': {
      const p = track.codecPrivate;
      if (p && p.length >= 4) {
        const prof = p[1] >> 5, lvl = p[1] & 31, tier = p[2] >> 7 ? 'H' : 'M', bd = (p[2] >> 6) & 1 ? ((p[2] >> 5) & 1 ? 12 : 10) : 8;
        return { codec: `av01.${prof}.${String(lvl).padStart(2, '0')}${tier}.${String(bd).padStart(2, '0')}`, description: p };
      }
      return { codec: 'av01.0.08M.08' };
    }
    case 'V_MPEG4/ISO/AVC': {
      const p = track.codecPrivate;
      if (p && p.length > 4) return { codec: `avc1.${hex2(p[1])}${hex2(p[2])}${hex2(p[3])}`, description: p }; // avcC (OBS/ffmpeg)
      // MediaRecorder de Chrome no escribe CodecPrivate: flujo Annex-B con el SPS (NAL 7) dentro del fotograma clave.
      for (let i = 0; i + 6 < keyData.length; i++) {
        if (keyData[i] === 0 && keyData[i + 1] === 0 && keyData[i + 2] === 1 && (keyData[i + 3] & 0x1f) === 7)
          return { codec: `avc1.${hex2(keyData[i + 4])}${hex2(keyData[i + 5])}${hex2(keyData[i + 6])}` };
      }
      return null;
    }
    default: return null; // HEVC y otros: no soportados en esta versión
  }
}
async function pickConfig(base) {
  for (const hardwareAcceleration of ['no-preference', 'prefer-hardware', 'prefer-software']) {
    const cfg = { ...base, hardwareAcceleration, optimizeForLatency: false };
    try { if ((await VideoDecoder.isConfigSupported(cfg)).supported) return cfg; } catch (_) {}
  }
  return null;
}

// ---------- Origen de bytes y tipo de contenedor ----------
const srcOf = (file) => ({ size: file.size, readAt: async (p, l) => new Uint8Array(await file.slice(p, p + l).arrayBuffer()) });
async function sniff(file) {
  const u = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (u[0] === 0x1A && u[1] === 0x45 && u[2] === 0xDF && u[3] === 0xA3) return 'webm';
  const box = String.fromCharCode(u[4], u[5], u[6], u[7]);
  if (['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'styp', 'moof'].includes(box)) return 'mp4';
  return null;
}
class Unsupported extends Error { constructor(msg) { super(msg); this.code = 'UNSUPPORTED'; } }

// ---------- Fuente de fragmentos codificados (WebM o MP4) ----------
// demux(file, h): h.onTrack({width,height,durationSec,makeBase(keyData)}), h.onChunk({key,ts(µs),data,pos}) → promesa|'stop'
async function demux(kind, file, h, signal) {
  if (kind === 'webm') {
    let track = null, info = {};
    return demuxWebm(srcOf(file), {
      signal,
      onInfo: (i) => { info = i; },
      onTracks: (ts) => {
        track = ts.find((t) => t.type === 1);
        if (!track) throw new Unsupported('sin pista de vídeo');
        h.onTrack({ width: track.width, height: track.height, durationSec: info.duration || null, codecId: track.codec, makeBase: (key) => codecFor(track, key) });
      },
      onResync: (from, to) => h.onResync && h.onResync(from, to),
      onBlock: (b) => h.onChunk({ key: b.key, ts: Math.round(b.time * 1e6), data: b.data, pos: b.pos })
    });
  }
  // MP4 (mp4box.js): se le van dando trozos de 4 MB; las muestras salen por onSamples.
  const mp4 = MP4Box.createFile();
  let track = null, err = null, stop = false;
  const pending = [];
  mp4.onError = (e) => { err = new Error(`mp4: ${e}`); };
  mp4.onReady = (info) => {
    track = info.videoTracks[0];
    if (!track) { err = new Unsupported('sin pista de vídeo'); return; }
    const trak = mp4.getTrackById(track.id);
    let description;
    for (const e of trak.mdia.minf.stbl.stsd.entries) {
      const bx = e.avcC || e.hvcC || e.vpcC || e.av1C;
      if (bx) { const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN); bx.write(s); description = new Uint8Array(s.buffer, 8); }
    }
    const codec = track.codec.startsWith('vp08') ? 'vp8' : track.codec;
    h.onTrack({ width: track.video.width, height: track.video.height, durationSec: info.duration ? info.duration / info.timescale : null, codecId: codec,
      makeBase: () => (/^(hvc1|hev1)/.test(codec) && !description ? null : { codec, description }) });
    mp4.setExtractionOptions(track.id, null, { nbSamples: 100 });
    mp4.start();
  };
  mp4.onSamples = (id, user, samples) => { for (const s of samples) pending.push(s); };
  const CH = 4 << 20;
  const drain = async (pos) => {
    while (pending.length && !stop) {
      const s = pending.shift();
      const r = h.onChunk({ key: s.is_sync, ts: Math.round(s.cts * 1e6 / s.timescale), data: s.data, pos });
      mp4.releaseUsedSamples(track.id, s.number + 1);
      const rr = r && r.then ? await r : r;
      if (rr === 'stop') stop = true;
    }
  };
  for (let pos = 0; pos < file.size && !stop; pos += CH) {
    if (signal && signal.aborted) return;
    const ab = await file.slice(pos, pos + CH).arrayBuffer();
    ab.fileStart = pos;
    mp4.appendBuffer(ab);
    if (err) throw err;
    await drain(pos + ab.byteLength);
  }
  mp4.flush();
  await drain(file.size);
  if (err) throw err;
}

// ---------- Lectura de píxeles ----------
const canvases = {};
function ctxFor(name, w, h) {
  let c = canvases[name];
  if (!c || c.canvas.width !== w || c.canvas.height !== h) {
    const cv = new OffscreenCanvas(w, h);
    c = canvases[name] = { canvas: cv, ctx: cv.getContext('2d', { willReadFrequently: true }) };
  }
  return c.ctx;
}
async function pixels(name, src, sx, sy, sw, sh, ow, oh) {
  const opts = ow ? { resizeWidth: ow, resizeHeight: oh, resizeQuality: 'medium' } : {};
  const bmp = await createImageBitmap(src, sx, sy, sw, sh, opts);
  const ctx = ctxFor(name, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  return ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
}
function rgbOf(img) {
  const d = img.data, g = new Uint8Array((d.length / 4) * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { g[j] = d[i]; g[j + 1] = d[i + 1]; g[j + 2] = d[i + 2]; }
  return g;
}
async function pngOf(bmpOrFrame, w, h) {
  const c = new OffscreenCanvas(w, h);
  c.getContext('2d').drawImage(bmpOrFrame, 0, 0, w, h);
  return c.convertToBlob({ type: 'image/png' });
}

// ---------- Paso de reconocimiento: solo el primer fotograma clave ----------
async function probeFile(file) {
  const kind = await sniff(file);
  if (!kind) throw new Unsupported('Formato no soportado');
  let meta = null, frame = null, decoder = null, codec = null;
  await demux(kind, file, {
    onTrack: (m) => { meta = m; },
    onChunk: async (c) => {
      if (!c.key) return;
      const base = meta.makeBase(c.data);
      const cfg = base && await pickConfig({ ...base, codedWidth: meta.width, codedHeight: meta.height });
      if (!cfg) throw new Unsupported(`códec ${meta.codecId}${base ? ` ${base.codec}` : ''}`);
      codec = cfg.codec;
      decoder = new VideoDecoder({ output: (f) => { if (frame) f.close(); else frame = f; }, error: () => {} });
      decoder.configure(cfg);
      decoder.decode(new EncodedVideoChunk({ type: 'key', timestamp: c.ts, data: c.data }));
      await decoder.flush().catch(() => {});
      return 'stop';
    }
  });
  if (decoder && decoder.state !== 'closed') decoder.close();
  if (!meta) throw new Unsupported('sin pista de vídeo');
  let thumb = null, W = meta.width, H = meta.height;
  if (frame) {
    W = frame.displayWidth; H = frame.displayHeight;
    thumb = await createImageBitmap(frame, { resizeWidth: 240, resizeHeight: Math.round(240 * H / W), resizeQuality: 'medium' });
    frame.close();
  }
  return { thumb, codec, W, H, durationSec: meta.durationSec };
}

// ---------- Proceso completo ----------
async function runFile(file, opts) {
  const t0 = performance.now();
  const step = CC.clampNum(opts.step, 0.5, 5, 1);
  const settings = opts.settings || {};
  const kind = await sniff(file);
  if (!kind) throw new Unsupported('Formato no soportado');
  const prof = { det: 0, roi: 0, detect: 0, sig: 0, crop: 0, policy: 0, encode: 0, wait: 0 };
  const tick = (k, a) => { prof[k] += performance.now() - a; return performance.now(); };
  const st = { decoded: 0, samples: 0, images: 0, reasons: {}, gaps: [], errors: 0, codec: null, hw: null, durationSec: null, lastT: 0, resyncs: 0, noneSec: 0, badSec: 0, maskDrops: new Set() };
  const dumpTimes = (opts.dumpTimes || []).slice().sort((a, b) => a - b);
  let imgId = 0, unacked = 0, ackWake = null;
  job.onAck = () => { unacked--; if (ackWake) { const w = ackWake; ackWake = null; w(); } };

  // Política y segmentador.
  const seg = VD.createSegmenter({ manualRect: opts.manualRect || null, always: !!opts.always });
  const vp = VP.create({ mode: opts.mode || 'equilibrado', minChange: CC.clampNum(settings.minChange, 0.1, 50, 1), startLast: opts.startSig || null,
    onFree: (s) => { if (s.crop) { s.crop.close(); s.crop = null; } } });
  const segMsg = (S, thumb) => ({ id: S.id, t0: S.t0, t1: S.t1, state: S.state, rect: S.rect ? [S.rect.x0, S.rect.y0, S.rect.x1, S.rect.y1] : null,
    ux: +(S.ux || 1).toFixed(3), uy: +(S.uy || 1).toFixed(3), squash: +(S.squash || 1).toFixed(3), conf: +(S.conf).toFixed(2), unstable: !!S.unstable, lowQ: !!S.lowQ, thumb });
  let lastSegPosted = null;

  async function emitSaves(acts) {
    for (const a of acts) {
      try {
        const s = a.s;
        if (!s.crop) continue;
        let sw = s.crop.width, sh = s.crop.height;
        if (settings.noTaskbar && s.is169) sh = Math.round(sh * 0.94);
        const outW = sw, outH = s.squash && s.squash !== 1 ? Math.round(sh / s.squash) : sh;
        const blob = await CC.encodeCrop(s.crop, { sx: 0, sy: 0, sw, sh }, { outW, outH, format: settings.format });
        const thumb = await createImageBitmap(s.crop, 0, 0, sw, sh, { resizeWidth: 160, resizeHeight: Math.max(1, Math.round(160 * outH / outW)), resizeQuality: 'medium' });
        const sig = s.sig.slice(), mb = s.maskBits ? s.maskBits.slice() : null;
        while (unacked > 3 && !job.aborted) await new Promise((r) => { ackWake = r; });
        unacked++;
        st.images++; st.reasons[a.reason] = (st.reasons[a.reason] || 0) + 1;
        postMessage({ type: 'image', id: ++imgId, blob, t: s.t, reason: a.reason, pct: a.pct, thumb, sig, sigSize: s.sigSize, maskBits: mb, w: outW, h: outH },
          [thumb, sig.buffer, ...(mb ? [mb.buffer] : [])]);
      } finally { vp.release(a.s); }
    }
  }

  // Cola productor → consumidor (dos avisos separados: "hay algo en la cola" y "el consumidor avanzó").
  const queue = [];
  let wakeConsumer = null, wakeProducer = null, consumerErr = null;
  const notifyConsumer = () => { if (wakeConsumer) { const w = wakeConsumer; wakeConsumer = null; w(); } };
  const notifyProducer = () => { if (wakeProducer) { const w = wakeProducer; wakeProducer = null; w(); } };
  const queueNonEmpty = () => new Promise((r) => { wakeConsumer = r; });
  const consumerProgressed = () => new Promise((r) => { wakeProducer = r; });

  let segInfoCache = null;
  async function consume() {
    for (;;) {
      while (!queue.length) await queueNonEmpty();
      const item = queue.shift(); notifyProducer();
      if (item === null) return;
      if (item.disc) { await emitSaves(vp.gap()); continue; }
      if (item.decodeGap) { await emitSaves(vp.gap()); continue; }
      const { frame, t, tEnd } = item;
      let crop = null, kept = false;
      try {
        if (job.aborted || consumerErr) continue;
        st.samples++;
        const W = frame.displayWidth, H = frame.displayHeight, roiY = Math.floor(0.70 * H);
        const dh = Math.round(H * DET_W / W);
        let ta = performance.now();
        const det = await pixels('det', frame, 0, 0, W, H, DET_W, dh);
        ta = tick('det', ta);
        const roi = await pixels('roi', frame, 0, roiY, W, H - roiY);
        ta = tick('roi', ta);
        const raw = VD.detectSample(det, roi, { W, H, roiY });
        ta = tick('detect', ta);
        const ev = seg.push(t, raw);
        const S = ev.seg;
        if (ev.opened) {
          if (S.state === 'PRESENT' && S.rect && !S.manual) {
            const full = await pixels('full', frame, 0, 0, W, H);
            const rf = VD.refine(S.rect, full, { ...raw, cL: S.cL, cR: S.cR });
            S.rect = rf.rect; if (rf.moved) S.conf -= 0.1;
            S.lowQ = Math.abs((S.squash || 1) - 1) > 0.25 || S.conf < 0.5;
          }
          const closed = seg.segments[seg.segments.length - 1];
          if (closed && closed !== lastSegPosted) { postMessage({ type: 'segment', seg: segMsg(closed) }); lastSegPosted = closed; }
          let thumb = null;
          try { thumb = await createImageBitmap(frame, { resizeWidth: 240, resizeHeight: Math.round(240 * H / W), resizeQuality: 'medium' }); } catch (_) {}
          postMessage({ type: 'segment', seg: { ...segMsg(S, thumb), provisional: true } }, thumb ? [thumb] : []);
          segInfoCache = null;
        }
        // Volcado de fotogramas completos (solo el arnés de pruebas).
        while (dumpTimes.length && dumpTimes[0] <= t) {
          const tt = dumpTimes.shift();
          postMessage({ type: 'frameDump', t: tt, tReal: t, blob: await pngOf(frame, W, H) });
        }
        if (ev.glitch) continue;
        if (S.state !== 'PRESENT' || S.lowQ) { st.noneSec += tEnd - t; await emitSaves(vp.gap()); continue; }
        const rect = S.rect, r = VD.rectPx(rect);
        const cropRel = VD.rectRel(rect, W, H);
        if (!segInfoCache || segInfoCache.id !== S.id || segInfoCache.rev !== S.rectRev) {
          const m0 = VD.masks(S, null, W, H, W / DET_W);
          segInfoCache = { id: S.id, rev: S.rectRev, transIdx: VD.sigIndices(m0.transient, cropRel) };
        }
        const m = VD.masks(S, det, W, H, W / DET_W);
        for (const dname of m.dropped) if (!st.maskDrops.has(dname)) { st.maskDrops.add(dname); log(`Zona ${dname} demasiado grande: no se tapa`); }
        const maskBits = CC.maskBits(m.masks, cropRel);
        ta = performance.now();
        const sig = rgbOf(await pixels('sig', frame, r.sx, r.sy, r.sw, r.sh, CC.SIG.W, CC.SIG.H));
        ta = tick('sig', ta);
        if (VD.sigIsBg(sig, maskBits, S.bg || { r: 18, g: 18, b: 18 })) { st.noneSec += tEnd - t; await emitSaves(vp.gap()); continue; }
        crop = await createImageBitmap(frame, r.sx, r.sy, r.sw, r.sh);
        ta = tick('crop', ta);
        const unSq = r.sw / (r.sh / (S.squash || 1));
        const sample = { t, tEnd, segId: `${S.id}`, sig, maskBits, sigSize: `${r.sw}x${r.sh}`, transIdx: segInfoCache.transIdx,
          unstable: seg.isUnstable(t) || S.unstable, crop, squash: S.squash || 1, is169: unSq >= 1.70 && unSq <= 1.85 };
        const acts = vp.step(sample);
        ta = tick('policy', ta);
        kept = sample.refs > 0;
        if (!kept) { crop.close(); sample.crop = null; }
        crop = null;
        await emitSaves(acts);
        tick('encode', ta);
      } catch (e) {
        consumerErr = e;
      } finally {
        if (crop && !kept) crop.close();
        frame.close();
      }
    }
  }
  const consumer = consume();

  // Decodificador (se puede recrear tras un error; pasa a software si el hardware falla).
  let nextTick = 0, prev = null, decoder = null, config = null, broken = false, needKey = true, skippedFrom = null, backWarned = false;
  const errTimes = [];
  let totalErrors = 0, forceSoftware = false, gaveUp = false;
  const enqueue = (it) => { queue.push(it); notifyConsumer(); };
  const onOutput = (f) => {
    st.decoded++;
    const ts = f.timestamp / 1e6;
    if (prev) {
      const pts = prev.timestamp / 1e6;
      if (ts < pts - 0.5) { // marcas de tiempo que van hacia atrás: discontinuidad
        if (!backWarned) { backWarned = true; log(`Marcas de tiempo hacia atrás en ${CC.fmtMediaTime(pts)}`); }
        prev.close(); prev = null; nextTick = ts; enqueue({ disc: true });
      } else if (nextTick < ts) { // prev es el último fotograma con pts ≤ nextTick (correcto con fps variable)
        const tick = Math.max(nextTick, pts);
        enqueue({ frame: prev, t: tick, tEnd: ts });
        while (nextTick < ts) nextTick += step; // los ticks sin fotograma nuevo darían la misma imagen
      } else prev.close();
    }
    prev = f;
    st.lastT = ts;
  };
  const onError = (e) => { broken = true; noteError(String(e && e.message || e)); };
  function noteError(msg) {
    totalErrors++; st.errors = totalErrors;
    const t = st.lastT;
    errTimes.push(t); while (errTimes.length && errTimes[0] < t - 60) errTimes.shift();
    if (totalErrors <= 3) log(`Error al decodificar en ${CC.fmtMediaTime(t)}: ${msg}`);
    if (config && config.hardwareAcceleration !== 'prefer-software' && errTimes.length >= 3) forceSoftware = true;
  }
  const makeDecoder = () => {
    decoder = new VideoDecoder({ output: onOutput, error: onError });
    decoder.configure(config);
  };
  let lastProgress = 0;
  const signal = { aborted: false };
  job.signal = signal;
  let meta = null;
  await demux(kind, file, {
    onTrack: (m) => { meta = m; st.durationSec = m.durationSec; },
    onResync: (from, to) => { st.resyncs++; log(`Datos dañados en el byte ${from}; sigo en ${to < 0 ? 'el final' : to}`); },
    onChunk: async (c) => {
      if (job.aborted) return 'stop';
      if (consumerErr) throw consumerErr;
      if (!config) { // se configura con el primer fotograma clave (perfil VP9 / SPS de H.264)
        if (!c.key) return;
        const base = meta.makeBase(c.data);
        config = base && await pickConfig({ ...base, codedWidth: meta.width, codedHeight: meta.height });
        if (!config) throw new Unsupported(`${meta.codecId}${base ? ` (${base.codec})` : ''}`);
        st.codec = config.codec; st.hw = config.hardwareAcceleration;
        makeDecoder();
        postMessage({ type: 'config', codec: config.codec, hw: config.hardwareAcceleration });
      }
      if (broken || forceSoftware) { // el decodificador murió (bloque dañado): uno nuevo y esperar al siguiente clave
        try { decoder.close(); } catch (_) {}
        if (forceSoftware && config.hardwareAcceleration !== 'prefer-software') {
          const sw = { ...config, hardwareAcceleration: 'prefer-software' };
          try { if ((await VideoDecoder.isConfigSupported(sw)).supported) { config = sw; st.hw = 'prefer-software'; log('Paso a decodificación por software.'); } } catch (_) {}
        }
        forceSoftware = false;
        if (totalErrors >= 20) { gaveUp = true; return 'stop'; }
        makeDecoder(); broken = false; needKey = true; if (skippedFrom == null) skippedFrom = c.ts / 1e6;
      }
      if (needKey) {
        if (!c.key) return;
        needKey = false;
        if (skippedFrom != null) {
          const g = [+skippedFrom.toFixed(2), +(c.ts / 1e6).toFixed(2), 'DECODE_ERROR'];
          st.gaps.push(g); st.badSec += g[1] - g[0];
          enqueue({ decodeGap: true });
          skippedFrom = null;
        }
      }
      try { decoder.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.data })); }
      catch (e) { broken = true; noteError(`decode() ${e.name}`); return; }
      while (!broken && !job.aborted && (decoder.decodeQueueSize > 8 || queue.length > 3)) {
        await (queue.length > 3 ? consumerProgressed() : new Promise((r) => decoder.addEventListener('dequeue', r, { once: true })));
      }
      const now = performance.now();
      if (now - lastProgress > 250) { lastProgress = now; postMessage({ type: 'progress', frac: c.pos / file.size, t: c.ts / 1e6, decoded: st.decoded, samples: st.samples }); }
    }
  }, signal);
  if (decoder && decoder.state === 'configured' && !broken && !job.aborted) await decoder.flush().catch((e) => noteError(`flush ${e && e.message}`));
  if (prev) { const pts = prev.timestamp / 1e6; if (!job.aborted) enqueue({ frame: prev, t: Math.max(nextTick, pts), tEnd: pts + step }); else prev.close(); prev = null; }
  enqueue(null);
  await consumer;
  if (decoder && decoder.state !== 'closed') decoder.close();
  if (consumerErr) throw consumerErr;
  if (!config) throw new Unsupported('no hay ningún fotograma clave');
  const end = Math.max(st.lastT, st.durationSec || 0);
  if (!job.aborted) await emitSaves(vp.finish());
  while (unacked > 0 && !job.aborted) await new Promise((r) => { ackWake = r; });
  const segs = seg.finish(end).map((S) => segMsg(S));
  st.noneSec = 0;
  for (const S of segs) if (S.state !== 'PRESENT' || S.lowQ) st.noneSec += S.t1 - S.t0;
  for (const S of segs) if (S.state !== 'PRESENT' || S.lowQ) st.gaps.push([+S.t0.toFixed(2), +S.t1.toFixed(2), S.lowQ && S.state === 'PRESENT' ? 'LOWQ' : S.state]);
  st.gaps.sort((a, b) => a[0] - b[0]);
  const last = vp.last;
  return {
    cancelled: !!job.aborted, gaveUp, ms: Math.round(performance.now() - t0), decoded: st.decoded, samples: st.samples, codec: st.codec, hw: st.hw,
    images: st.images, reasons: st.reasons, segments: segs, gaps: st.gaps, durationSec: st.durationSec, lastTime: +end.toFixed(2), errors: st.errors,
    resyncs: st.resyncs, prof: Object.fromEntries(Object.entries(prof).map(([k, v]) => [k, Math.round(v)])), noneSec: Math.round(st.noneSec), badSec: Math.round(st.badSec),
    last: last ? { sig: last.sig, maskBits: last.maskBits || null, sigSize: last.sigSize, t: last.t } : null
  };
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'ack') { if (job && job.onAck) job.onAck(); return; }
  if (m.type === 'cancel') { if (job) { job.aborted = true; if (job.signal) job.signal.aborted = true; if (job.onAck) job.onAck(); } return; }
  if (m.type === 'probe' || m.type === 'run') {
    job = { aborted: false };
    try {
      if (m.type === 'probe') { const r = await probeFile(m.file); postMessage({ type: 'done', result: r }, r.thumb ? [r.thumb] : []); }
      else postMessage({ type: 'done', result: await runFile(m.file, m.opts || {}) });
    } catch (err) {
      postMessage({ type: 'error', code: err.code || (/decod/i.test(err.message) ? 'DECODE' : 'ERROR'), msg: String(err && err.message || err) });
    }
  }
};
