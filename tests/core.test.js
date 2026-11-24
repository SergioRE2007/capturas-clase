'use strict';
// core.js frente al código que tenía panel.js antes de moverlo (copias legacy* pegadas aquí tal cual).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const CC = require('../core.js');
const { FakeDir } = require('./helpers/fakefs.js');

// ---- Copias del panel.js v2.0.0 ----
const SIG_W = 256, SIG_H = 144, PIX_T = 24, TILE = 8;
const TX = SIG_W / TILE, TY = SIG_H / TILE;
function legacyCompare(a, b) {
  const tiles = new Uint16Array(TX * TY);
  let n = 0;
  for (let y = 0; y < SIG_H; y++) {
    const row = y * SIG_W, trow = (y / TILE | 0) * TX;
    for (let x = 0; x < SIG_W; x++) {
      const k = (row + x) * 3;
      const dd = Math.max(Math.abs(a[k] - b[k]), Math.abs(a[k + 1] - b[k + 1]), Math.abs(a[k + 2] - b[k + 2]));
      if (dd > PIX_T) { n++; tiles[trow + (x / TILE | 0)]++; }
    }
  }
  let maxT = 0;
  for (let i = 0; i < tiles.length; i++) if (tiles[i] > maxT) maxT = tiles[i];
  return { pct: (n * 100) / (SIG_W * SIG_H), tile: (maxT * 100) / (TILE * TILE) };
}
function legacyCropRect(w, h, c) {
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
  return { sx, sy, sw: Math.max(1, Math.min(w - sx, Math.round(r.w * cw))), sh: Math.max(1, Math.min(h - sy, Math.round(r.h * ch))) };
}
// Máscaras del panel: rectángulos negros sobre la huella (fillRect recorta a los bordes).
function legacyPaintMasks(sig, crop) {
  for (const m of crop.masks) {
    const x = Math.floor((m.x - crop.x) / crop.w * SIG_W) - 1, y = Math.floor((m.y - crop.y) / crop.h * SIG_H) - 1;
    const w = Math.ceil(m.w / crop.w * SIG_W) + 2, h = Math.ceil(m.h / crop.h * SIG_H) + 2;
    for (let yy = Math.max(0, y); yy < Math.min(SIG_H, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(SIG_W, x + w); xx++) { const k = (yy * SIG_W + xx) * 3; sig[k] = sig[k + 1] = sig[k + 2] = 0; }
  }
}

let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
function randSig() { const s = new Uint8Array(SIG_W * SIG_H * 3); for (let i = 0; i < s.length; i++) s[i] = rnd() * 256 | 0; return s; }
function perturb(a, frac, amp) { const b = a.slice(); for (let i = 0; i < b.length; i++) if (rnd() < frac) b[i] = Math.max(0, Math.min(255, b[i] + (rnd() * 2 - 1) * amp)); return b; }

test('compare = legacyCompare en 50 pares aleatorios', () => {
  for (let i = 0; i < 50; i++) {
    const a = randSig(), b = i % 2 ? randSig() : perturb(a, rnd() * 0.2, 60);
    assert.deepStrictEqual(CC.compare(a, b), legacyCompare(a, b));
  }
});
test('compare: casos límite', () => {
  const a = randSig();
  assert.deepStrictEqual(CC.compare(a, a), { pct: 0, tile: 0 });
  const b = a.slice();
  for (let y = 16; y < 24; y++) for (let x = 40; x < 48; x++) { const k = (y * SIG_W + x) * 3; b[k] = (a[k] + 128) % 256; }
  const r = CC.compare(a, b);
  assert.strictEqual(r.tile, 100);
  assert.ok(Math.abs(r.pct - 64 * 100 / (SIG_W * SIG_H)) < 1e-9 && Math.abs(r.pct - 0.17) < 0.01);
});
test('compareEx con máscara = panel con zonas pintadas de negro', () => {
  const crop = { x: 0.1, y: 0.2, w: 0.8, h: 0.7, masks: [{ x: 0.8, y: 0.72, w: 0.09, h: 0.15 }, { x: 0.05, y: 0.1, w: 0.2, h: 0.2 }] };
  for (let i = 0; i < 10; i++) {
    const a = randSig(), b = perturb(a, 0.3, 80);
    const pa = a.slice(), pb = b.slice(); legacyPaintMasks(pa, crop); legacyPaintMasks(pb, crop);
    const mask = CC.maskBits(crop.masks, crop);
    const ex = CC.compareEx(a, b, { mask });
    assert.deepStrictEqual({ pct: ex.pct, tile: ex.tile }, legacyCompare(pa, pb));
  }
  const m = CC.maskBits([{ x: 0, y: 0, w: 0.5, h: 1 }], { x: 0, y: 0, w: 1, h: 1 });
  const a = randSig(), b = a.slice();
  for (let y = 0; y < SIG_H; y++) for (let x = 0; x < 100; x++) b[(y * SIG_W + x) * 3] ^= 0xff;
  assert.strictEqual(CC.compareEx(a, b, { mask: m }).nPix, 0);
});
test('maskBits usa el margen del panel', () => {
  const m = CC.maskBits([{ x: 0.5, y: 0.5, w: 0.25, h: 0.25 }], { x: 0, y: 0, w: 1, h: 1 });
  // x: floor(128)−1 = 127 … 127+ceil(64)+2 = 193 (excl.); y: 71 … 71+36+2 = 109 (excl.)
  assert.strictEqual(m[71 * SIG_W + 127], 1); assert.strictEqual(m[71 * SIG_W + 126], 0);
  assert.strictEqual(m[108 * SIG_W + 192], 1); assert.strictEqual(m[109 * SIG_W + 192], 0); assert.strictEqual(m[108 * SIG_W + 193], 0);
});
test('cropRect = legacy (identidad, recorte en bordes, bandas con vw/vh)', () => {
  const cases = [[1440, 852, null], [1440, 852, { x: 0.0951, y: 0.1702, w: 0.8083, h: 0.7265 }], [100, 100, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }],
    [3840, 2160, { x: 0.1, y: 0.1, w: 0.8, h: 0.8, vw: 1440, vh: 900 }], [1000, 1000, { x: 0, y: 0, w: 1, h: 1, vw: 1600, vh: 900 }]];
  for (const [w, h, c] of cases) assert.deepStrictEqual(CC.cropRect(w, h, c), legacyCropRect(w, h, c));
  assert.deepStrictEqual(CC.cropRect(1440, 852, null), { sx: 0, sy: 0, sw: 1440, sh: 852 });
});
test('safeName y fmtMediaTime', () => {
  assert.strictEqual(CC.safeName('CON'), '_CON');
  assert.strictEqual(CC.safeName('Clase...  '), 'Clase');
  assert.strictEqual(CC.safeName('a<b>c'), 'a_b_c');
  assert.strictEqual(CC.safeName(''), 'otros');
  assert.strictEqual(CC.fmtMediaTime(750.4), '00h12m30s');
  assert.strictEqual(CC.fmtMediaTime(3600 + 61), '01h01m01s');
});
test('scanCounter / writeImage: continúa, no sobrescribe, ignora el manifiesto', async () => {
  const d = new FakeDir();
  for (const n of ['img001.png', 'img003_10-00-00.png', '.capturas-clase.json', 'otra.txt']) (await d.getFileHandle(n, { create: true }));
  const c = await CC.scanCounter(d);
  assert.strictEqual(c.nextNum, 4);
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
  assert.strictEqual(await CC.writeImage(d, blob, { counter: c, lockName: 'x' }), 'img004.png');
  assert.strictEqual(await CC.writeImage(d, blob, { counter: c, suffix: '_p2_00h00m03s', lockName: 'x' }), 'img005_p2_00h00m03s.png');
  // Otro escritor (otro contador viejo) no pisa nada.
  const old = { nextNum: 4, usedNums: new Set() };
  assert.strictEqual(await CC.writeImage(d, blob, { counter: old, lockName: 'x' }), 'img006.png');
});
test('writeImage: dos escritores a la vez con navigator.locks reciben nombres distintos', async () => {
  // Stub de navigator.locks: cola por nombre.
  const q = new Map();
  const locks = { request(name, fn) { const p = (q.get(name) || Promise.resolve()).then(() => fn()); q.set(name, p.catch(() => {})); return p; } };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { locks }, configurable: true, writable: true });
  try {
    const d = new FakeDir();
    const blob = new Blob([new Uint8Array([9])], { type: 'image/png' });
    const a = await CC.scanCounter(d), b = await CC.scanCounter(d);
    const names = await Promise.all([0, 1, 2, 3].map((i) => CC.writeImage(d, blob, { counter: i % 2 ? a : b, lockName: 'cc-write:X/2026-11-09' })));
    assert.strictEqual(new Set(names).size, 4);
  } finally { if (had) Object.defineProperty(globalThis, 'navigator', had); else delete globalThis.navigator; }
});
test('writeImage: si falla la escritura se borra el archivo a medias', async () => {
  const d = new FakeDir();
  d.failNextWrite = true;
  await assert.rejects(CC.writeImage(d, new Blob([new Uint8Array([1])], { type: 'image/png' }), { lockName: 'y' }), { name: 'QuotaExceededError' });
  assert.strictEqual(d.files.size, 0);
});
test('readJson / writeJson', async () => {
  const d = new FakeDir();
  assert.strictEqual(await CC.readJson(d, '.capturas-clase.json'), null);
  await CC.writeJson(d, '.capturas-clase.json', { version: 1, entries: [] });
  assert.deepStrictEqual(await CC.readJson(d, '.capturas-clase.json'), { version: 1, entries: [] });
  const bits = new Uint8Array(256 * 144); bits[5] = 1; bits[36863] = 1;
  assert.deepStrictEqual(CC.unpackBits(CC.b64dec(CC.b64enc(CC.packBits(bits))), bits.length), bits);
});
test('panel.js compila y no redeclara lo que ahora está en core.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'panel.js'), 'utf8');
  new vm.Script(src);
  for (const n of ['pad', 'dateStr', 'timeStr', 'clamp01', 'clampNum', 'withTimeout', 'safeName', 'cropRect', 'isBlank', 'compare', 'exists', 'idbGet', 'idbSet', 'CC', 'VN', 'VD', 'VP'])
    assert.ok(!new RegExp(`^(?:const|let|var|function|async function)\\s+${n}\\b`, 'm').test(src), `panel.js redeclara ${n}`);
  // El panel + core.js juntos en el mismo ámbito global tampoco chocan.
  new vm.Script(fs.readFileSync(path.join(__dirname, '..', 'core.js'), 'utf8') + '\n' + src);
});
