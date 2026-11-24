'use strict';
const test = require('node:test');
const assert = require('node:assert');
const VP = require('../vpolicy.js');

const W = 256, H = 144;
// Huella sintética: "contenido" n = patrón de bloques 16x16 de colores distintos.
function content(n) {
  const s = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const b = ((x >> 4) * 7 + (y >> 4) * 13 + n * 31) % 11, k = (y * W + x) * 3;
    s[k] = 20 + b * 20; s[k + 1] = 200 - b * 15; s[k + 2] = (b * 50 + n * 40) % 256;
  }
  return s;
}
function paintTile(sig, tx, ty, v, size = 8) {
  const s = sig.slice();
  for (let y = ty * 8; y < ty * 8 + size; y++) for (let x = tx * 8; x < tx * 8 + size; x++) { const k = (y * W + x) * 3; s[k] = s[k + 1] = s[k + 2] = v; }
  return s;
}
// Ejecuta una secuencia [{sig, seg?, gap?, unstable?, sigSize?, transIdx?}] con paso 1 s.
function run(seq, opts = {}) {
  const vp = VP.create({ ...opts });
  const saves = [];
  const take = (acts) => { for (const a of acts) { saves.push({ t: a.s.t, reason: a.reason, s: a.s }); vp.release(a.s); } };
  seq.forEach((e, t) => {
    if (e.gap) { take(vp.gap()); return; }
    take(vp.step({ t, tEnd: t + 1, segId: e.seg || 1, sig: e.sig, maskBits: e.maskBits || null, sigSize: e.sigSize || '1407x748', unstable: !!e.unstable, transIdx: e.transIdx, id: e.id }));
  });
  take(vp.finish());
  return saves;
}
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i));

test('diapositiva fija 30 s → 1 imagen (first)', () => {
  const A = content(1);
  const s = run(rep(30, () => ({ sig: A })));
  assert.deepStrictEqual(s.map((x) => x.reason), ['first']);
});
test('diapositiva A 10 s → B 10 s → 2 imágenes', () => {
  const A = content(1), B = content(2);
  const s = run([...rep(10, () => ({ sig: A })), ...rep(10, () => ({ sig: B }))]);
  assert.strictEqual(s.length, 2);
});
test('escribiendo (1 zona por segundo) 20 s y pausa de 6 s → solo la pausa (y la primera)', () => {
  let cur = content(1);
  const seq = rep(2, () => ({ sig: cur }));
  for (let i = 0; i < 20; i++) { cur = paintTile(cur, 2 + i, 5, 250); seq.push({ sig: cur }); }
  for (let i = 0; i < 6; i++) seq.push({ sig: cur });
  const s = run(seq);
  assert.deepStrictEqual(s.map((x) => x.reason), ['first', 'pause']);
  assert.ok(s[1].t >= 21 + 4);
});
test('desplazamiento → se guarda la versión final de antes (flush) y luego la asentada', () => {
  let cur = content(1);
  const seq = [];
  for (let i = 0; i < 10; i++) { cur = paintTile(cur, 2 + (i % 25), 3 + (i / 25 | 0), 250); seq.push({ sig: cur }); } // escribiendo sin pausa
  for (let i = 0; i < 4; i++) seq.push({ sig: content(10 + i) }); // desplazamiento
  for (let i = 0; i < 8; i++) seq.push({ sig: content(20) });
  const s = run(seq);
  assert.deepStrictEqual(s.map((x) => x.reason), ['first', 'flush', 'settled']);
  assert.strictEqual(s[1].t, 9);
});
test('misma diapositiva con otro tamaño de recorte (squash) → 0 imágenes nuevas', () => {
  const A = content(1), A2 = A.slice();
  for (let i = 0; i < A2.length; i += 97) A2[i] = Math.min(255, A2[i] + 40); // ligeras diferencias de reescalado
  const s = run([...rep(5, () => ({ sig: A, seg: 1, sigSize: '1401x583' })), ...rep(5, () => ({ sig: A2, seg: 2, sigSize: '1401x711' }))]);
  assert.strictEqual(s.length, 1);
});
test('hueco sin presentación y vuelve lo mismo → 0 imágenes nuevas', () => {
  const A = content(1);
  const s = run([...rep(5, () => ({ sig: A })), ...rep(5, () => ({ gap: true })), ...rep(5, () => ({ sig: A, seg: 2 }))]);
  assert.strictEqual(s.length, 1);
});
test('entre archivos: startSig igual al primer contenido → 0 imágenes (F38)', () => {
  const A = content(1);
  const s = run(rep(10, () => ({ sig: A })), { startLast: { sig: A, maskBits: null, sigSize: '1407x748' } });
  assert.strictEqual(s.length, 0);
});
test('cursor (2 zonas vecinas, 30 px) → 0 imágenes (F32)', () => {
  const A = content(1);
  let B = paintTile(A, 10, 10, 255, 4); // 16 px
  B = paintTile(B, 11, 10, 255, 4).map((v, i) => v);
  for (let y = 80; y < 82; y++) for (let x = 88; x < 92; x++) { const k = (y * W + x) * 3; B[k] = B[k + 1] = B[k + 2] = 0; } // ~8 px más en la zona vecina
  const s = run([...rep(10, () => ({ sig: A })), ...rep(10, () => ({ sig: B }))]);
  assert.strictEqual(s.length, 1);
});
test('destello de 2 s entre huecos → como mucho 1 imagen (F21)', () => {
  const s = run([...rep(5, () => ({ gap: true })), { sig: content(3) }, { sig: content(3) }, ...rep(5, () => ({ gap: true }))]);
  assert.ok(s.length <= 1);
});
test('segmento inestable: 2 s → 0; 3 s → 1', () => {
  const A = content(4);
  assert.strictEqual(run([...rep(2, () => ({ sig: A, unstable: true })), { gap: true }]).length, 0);
  assert.strictEqual(run([...rep(3, () => ({ sig: A, unstable: true })), { gap: true }]).length, 1);
});
test('baja calidad (el worker la trata como hueco) → 0', () => {
  assert.strictEqual(run(rep(10, () => ({ gap: true }))).length, 0);
});
test('elige el fotograma sin la barra flotante (zona pasajera)', () => {
  const A = content(1);
  const idx = [];
  for (let y = 60; y < 84; y++) for (let x = 100; x < 156; x++) idx.push(y * W + x);
  const transIdx = Uint32Array.from(idx);
  const hover = A.slice();
  for (const i of idx) { hover[i * 3] = 60; hover[i * 3 + 1] = 60; hover[i * 3 + 2] = 60; } // barra encima, pero < BIG? no: se tapa abajo
  // La barra cubre ~3.6 % (≥ BIG) en una sola muestra; para probar solo la elección la ponemos como máscara común.
  const mask = new Uint8Array(W * H); for (const i of idx) mask[i] = 1;
  const seq = [{ sig: hover, id: 'h' }, { sig: hover, id: 'h' }, { sig: hover, id: 'h' }, { sig: A, id: 'limpio' }, { sig: A, id: 'limpio' }, { sig: A, id: 'limpio' }]
    .map((e) => ({ ...e, maskBits: mask, transIdx }));
  const s = run([...seq, { sig: A, maskBits: mask, transIdx, id: 'limpio' }, ...rep(3, () => ({ sig: A, maskBits: mask, transIdx, id: 'limpio' }))]);
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].s.id, 'limpio');
});
test('modos: final ≤ equilibrado ≤ todas', () => {
  let cur = content(1);
  const seq = [];
  for (let i = 0; i < 40; i++) {
    if (i % 10 < 4) cur = paintTile(cur, 2 + i, 6, 250);
    if (i === 20) cur = content(7);
    seq.push({ sig: cur });
  }
  const n = (mode) => run(seq, { mode }).length;
  const f = n('final'), e = n('equilibrado'), t = n('todas');
  assert.ok(f <= e && e <= t, `${f} ${e} ${t}`);
  assert.ok(t > e);
});
test('las muestras se liberan (refs a 0) al terminar', () => {
  const freed = new Set();
  const vp = VP.create({ onFree: (s) => freed.add(s) });
  const all = [];
  for (let t = 0; t < 30; t++) {
    const s = { t, tEnd: t + 1, segId: 1, sig: content(t < 15 ? 1 : 2), sigSize: 'a' };
    all.push(s);
    for (const a of vp.step(s)) vp.release(a.s);
    if (!s.refs) { /* el worker la libera ya */ freed.add(s); }
  }
  for (const a of vp.finish()) vp.release(a.s);
  assert.ok(all.every((s) => freed.has(s) && !s.refs));
});
