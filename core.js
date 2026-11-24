// Funciones compartidas por el panel (captura en directo), la página de vídeos grabados, su worker y los tests de Node.
// Script clásico (no módulo ES): expone un único espacio de nombres CC. No toca document/chrome/indexedDB al cargar.
const CC = (() => {
  'use strict';

  // Comparación: la imagen se reduce a 256x144 (color). Un píxel "cambia" si algún canal varía más de PIX_T niveles
  // (así se ignora el ruido de compresión de Meet). Se guarda si cambia ≥ X % de la imagen O si alguna
  // zona de 8x8 cambia ≥ TILE_T % (para no perder una línea de código nueva o un número de diapositiva).
  const SIG = { W: 256, H: 144, PIX_T: 24, TILE: 8, TILE_T: 10 };
  SIG.TX = SIG.W / SIG.TILE; SIG.TY = SIG.H / SIG.TILE;

  // ---------- Utilidades ----------
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const timeStr = (d = new Date()) => `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  function clampNum(v, min, max, def) {
    const n = Number(v);
    return Number.isFinite(n) && v !== '' ? Math.min(max, Math.max(min, n)) : def;
  }
  function withTimeout(p, ms) {
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tiempo agotado')), ms); })])
      .finally(() => clearTimeout(t));
  }
  // Nombre válido de carpeta en Windows/Mac/Linux.
  function safeName(s) {
    let n = String(s || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80).replace(/[. ]+$/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = `_${n}`;
    return n || 'otros';
  }
  // Tiempo del vídeo para nombres de archivo: 750.4 → '00h12m30s'.
  function fmtMediaTime(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    return `${pad(Math.floor(s / 3600))}h${pad(Math.floor(s / 60) % 60)}m${pad(s % 60)}s`;
  }

  // Pasa un recorte relativo a píxeles del fotograma. En el modo automático el recorte es relativo
  // a la ventana de Meet; si el fotograma tiene bandas negras (otra proporción), se descuentan.
  function cropRect(w, h, c) {
    let ox = 0, oy = 0, cw = w, ch = h;
    if (c && c.vw && c.vh) {
      const va = c.vw / c.vh, fa = w / h;
      if (Math.abs(va - fa) / fa > 0.01) {
        if (fa > va) { cw = h * va; ox = (w - cw) / 2; } else { ch = w / va; oy = (h - ch) / 2; }
      }
    }
    const r = c || { x: 0, y: 0, w: 1, h: 1 };
    const sx = Math.min(w - 1, Math.max(0, Math.round(ox + r.x * cw)));
    const sy = Math.min(h - 1, Math.max(0, Math.round(oy + r.y * ch)));
    return {
      sx, sy,
      sw: Math.max(1, Math.min(w - sx, Math.round(r.w * cw))),
      sh: Math.max(1, Math.min(h - sy, Math.round(r.h * ch)))
    };
  }
  function isBlank(sig) {
    let max = 0;
    for (let i = 0; i < sig.length; i++) if (sig[i] > max) { max = sig[i]; if (max > 20) return false; }
    return true;
  }
  // Compara dos huellas. ch = canales por píxel (3 = RGB como el panel, 4 = RGBA).
  // mask[i] = 1 → ese píxel no se compara (pero sigue contando en el total, como las zonas tapadas en negro del panel).
  function compareEx(a, b, opts = {}) {
    const ch = opts.ch || 3, pixT = opts.pixT != null ? opts.pixT : SIG.PIX_T, mask = opts.mask || null;
    const { W, H, TILE, TX, TY } = SIG;
    const hits = new Uint16Array(TX * TY);
    let n = 0;
    for (let y = 0; y < H; y++) {
      const row = y * W, trow = (y / TILE | 0) * TX;
      for (let x = 0; x < W; x++) {
        if (mask && mask[row + x]) continue;
        const k = (row + x) * ch;
        const dd = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
        if (dd > pixT) { n++; hits[trow + (x / TILE | 0)]++; }
      }
    }
    let maxT = 0;
    for (let i = 0; i < hits.length; i++) if (hits[i] > maxT) maxT = hits[i];
    return { pct: (n * 100) / (W * H), tile: (maxT * 100) / (TILE * TILE), nPix: n, hits };
  }
  function compare(a, b) {
    const r = compareEx(a, b);
    return { pct: r.pct, tile: r.tile };
  }
  // Zonas tapadas (relativas al fotograma) → máscara 256x144 de la huella del recorte `crop` (relativo).
  // Mismo margen que el panel: floor(rel·256)−1, ceil(relw·256)+2 (y lo mismo con 144).
  function maskBits(masksRel, crop) {
    const { W, H } = SIG;
    const out = new Uint8Array(W * H);
    if (!masksRel || !masksRel.length || !crop || !crop.w || !crop.h) return out;
    for (const m of masksRel) {
      const x0 = Math.floor((m.x - crop.x) / crop.w * W) - 1, y0 = Math.floor((m.y - crop.y) / crop.h * H) - 1;
      const x1 = x0 + Math.ceil(m.w / crop.w * W) + 2, y1 = y0 + Math.ceil(m.h / crop.h * H) + 2;
      for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) out.fill(1, y * W + Math.max(0, x0), y * W + Math.min(W, x1));
    }
    return out;
  }
  function orMask(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    const o = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] | b[i];
    return o;
  }

  // ---------- Carpetas y archivos ----------
  async function exists(dir, name) {
    try { await dir.getFileHandle(name); return true; } catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
  }
  // La numeración continúa donde se quedó (img001, img002…). Los archivos que empiezan por punto se ignoran.
  async function scanCounter(dir) {
    let max = 0;
    const usedNums = new Set();
    for await (const name of dir.keys()) {
      const m = /^img(\d+)/i.exec(name);
      if (m) { max = Math.max(max, Number(m[1])); usedNums.add(Number(m[1])); }
    }
    return { nextNum: max + 1, usedNums };
  }
  // Cerrojo con nombre: Web Locks si existen (panel y página de vídeos a la vez), si no una cola en memoria.
  const localLocks = new Map();
  function withLock(name, fn) {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    if (name && nav && nav.locks && nav.locks.request) return nav.locks.request(name, fn);
    const prev = localLocks.get(name) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    localLocks.set(name, run.catch(() => {}));
    return run;
  }
  // Escribe la imagen con el primer número libre. Nunca se sobrescribe una imagen existente.
  // Todo («elegir número → existe → crear → escribir») ocurre dentro del cerrojo de la carpeta.
  async function writeImage(dir, blob, { counter, suffix = '', lockName = null, ext = null } = {}) {
    const e = ext || (blob.type === 'image/png' ? 'png' : 'jpg');
    if (!counter) counter = await scanCounter(dir);
    return withLock(lockName, async () => {
      // Otro escritor (panel en directo / otro vídeo) pudo usar números con otro sufijo: se vuelve a mirar la carpeta.
      const fresh = await scanCounter(dir);
      if (!counter.usedNums) counter.usedNums = new Set();
      for (const u of fresh.usedNums) counter.usedNums.add(u);
      counter.nextNum = Math.max(counter.nextNum, fresh.nextNum);
      let n = counter.nextNum, name;
      for (;;) {
        name = `img${pad(n, 3)}${suffix}.${e}`;
        const taken = counter.usedNums && counter.usedNums.has(n);
        if (!taken && !(await exists(dir, name))) break;
        n++;
      }
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      try {
        await w.write(blob);
        await w.close();
      } catch (err) {
        await w.abort().catch(() => {});
        await dir.removeEntry(name).catch(() => {});
        throw err;
      }
      counter.nextNum = n + 1;
      if (counter.usedNums) counter.usedNums.add(n);
      return name;
    });
  }
  const lockNameFor = (clase, sub) => `cc-write:${safeName(clase)}/${sub || ''}`;
  async function openSessionDir(root, clase, sub) {
    const cls = await root.getDirectoryHandle(safeName(clase), { create: true });
    const dir = sub ? await cls.getDirectoryHandle(sub, { create: true }) : cls;
    return { dir, counter: await scanCounter(dir), lockName: lockNameFor(clase, sub) };
  }
  // JSON: null si no existe; cualquier otro error se lanza. createWritable confirma el archivo al cerrar (atómico).
  async function readJson(dir, name) {
    let fh;
    try { fh = await dir.getFileHandle(name); } catch (e) { if (e.name === 'NotFoundError') return null; throw e; }
    const f = await fh.getFile();
    const txt = await f.text();
    return txt ? JSON.parse(txt) : null;
  }
  async function writeJson(dir, name, obj) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try { await w.write(JSON.stringify(obj, null, 1)); await w.close(); } catch (e) { await w.abort().catch(() => {}); throw e; }
  }

  // ---------- IndexedDB (para recordar la carpeta entre sesiones) ----------
  let dbPromise = null;
  function idb() {
    if (!dbPromise) {
      dbPromise = new Promise((res, rej) => {
        const r = indexedDB.open('capturas-clase', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbPromise = null; }; res(db); };
        r.onerror = () => { dbPromise = null; rej(r.error); };
      });
    }
    return dbPromise;
  }
  async function idbGet(key) {
    const db = await idb();
    return new Promise((res, rej) => {
      const q = db.transaction('kv').objectStore('kv').get(key);
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idb();
    return new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(val, key);
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  }

  // Almacén de la extensión (chrome.storage.local); el arnés de pruebas lo sustituye por uno en memoria.
  const store = {
    async get(key) { return chrome.storage.local.get(key); },
    async set(obj) { return chrome.storage.local.set(obj); }
  };

  // Recorta (y si hace falta escala) un bitmap a PNG/JPEG. Lo usan la página y el worker.
  async function encodeCrop(bmp, r, { outW, outH, format } = {}) {
    const ow = Math.max(1, Math.round(outW || r.sw)), oh = Math.max(1, Math.round(outH || r.sh));
    const c = new OffscreenCanvas(ow, oh);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, ow, oh);
    return format === 'jpeg'
      ? c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
      : c.convertToBlob({ type: 'image/png' });
  }

  // base64 de bytes (para el manifiesto de la carpeta).
  function b64enc(u8) {
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function b64dec(s) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s), u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  function packBits(bits) {
    const o = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) if (bits[i]) o[i >> 3] |= 0x80 >> (i & 7);
    return o;
  }
  function unpackBits(packed, n) {
    const o = new Uint8Array(n);
    for (let i = 0; i < n; i++) o[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
    return o;
  }

  return {
    SIG, pad, dateStr, timeStr, clamp01, clampNum, withTimeout, safeName, fmtMediaTime,
    cropRect, isBlank, compare, compareEx, maskBits, orMask,
    exists, scanCounter, withLock, writeImage, lockNameFor, openSessionDir, readJson, writeJson,
    idbGet, idbSet, store, encodeCrop, b64enc, b64dec, packBits, unpackBits
  };
})();
if (typeof module !== 'undefined') module.exports = CC;
