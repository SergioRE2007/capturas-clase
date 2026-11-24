'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const VD = require('../vdetect.js');
const { decodePng } = require('./helpers/png.js');

const FX = path.join(__dirname, 'fixtures', 'calib-7_10');
// Fotogramas de una clase real (salen nombres de personas): no están en el repo; si faltan, la prueba se salta.
const HAS_FX = fs.existsSync(path.join(FX, 'fixture.json'));
const fixture = HAS_FX ? JSON.parse(fs.readFileSync(path.join(FX, 'fixture.json'), 'utf8')) : { frames: [], pairs: [] };
function detect(img) {
  const W = img.width, H = img.height, roiY = Math.floor(0.7 * H);
  const roi = { width: W, height: H - roiY, data: img.data.subarray(roiY * W * 4) };
  return VD.detectSample(img, roi, { W, H, roiY });
}
const covers = (outer, inner, tol) => outer.x <= inner.x + tol && outer.y <= inner.y + tol &&
  outer.x + outer.w >= inner.x + inner.w - tol && outer.y + outer.h >= inner.y + inner.h - tol;

test('fixtures de 7_10 (480x284): rectángulo, estado y zonas tapadas', { skip: !HAS_FX && 'faltan tests/fixtures/calib-7_10 (no se suben al repo)' }, () => {
  for (const f of fixture.frames) {
    const img = decodePng(path.join(FX, f.png));
    const r = detect(img);
    // El botón se mide en la propia imagen de 480 → ux ≈ 0.33.
    assert.ok(Math.abs(r.ux - 1 / 3) <= 0.1 && Math.abs(r.uy - 1 / 3) <= 0.1, `${f.png}: ux ${r.ux} uy ${r.uy}`);
    if (!f.presenting) { assert.strictEqual(r.state, 'NONE', f.png); continue; }
    assert.strictEqual(r.state, 'PRESENT', f.png);
    const rel = VD.rectRel(r.rect, img.width, img.height);
    for (const k of ['x', 'y', 'w', 'h']) assert.ok(Math.abs(rel[k] - f.expectedRect[k]) <= fixture.tolerance.rect, `${f.png} ${k}: ${rel[k]} vs ${f.expectedRect[k]}`);
    if (f.assertMasks) {
      const m = VD.masks(r, img, img.width, img.height, 1);
      for (const em of f.expectedMasks) assert.ok(m.masks.some((b) => covers(b, em, fixture.tolerance.mask)), `${f.png}: zona ${JSON.stringify(em)} sin tapar`);
    }
  }
});

test('detector: un fotograma que no es de Meet → UNKNOWN', () => {
  const img = { width: 480, height: 270, data: new Uint8ClampedArray(480 * 270 * 4).fill(200) };
  assert.strictEqual(detect(img).state, 'UNKNOWN');
});

// ---- Segmentador sobre secuencias sintéticas ----
const R1 = { x0: 16, y0: 64, x1: 1423, y1: 812 }, R2 = { x0: 137, y0: 145, x1: 1300, y1: 763 };
const P = (rect) => ({ state: 'PRESENT', rect, ux: 1, uy: 1, squash: 1, conf: 1, probeKey: [35, 24, 280] });
const N = { state: 'NONE', rect: null, ux: 1, uy: 1, squash: 1, conf: 1, probeKey: [35, 24, 280] };
function runSeq(seq) {
  const s = VD.createSegmenter();
  const evs = seq.map((raw, t) => s.push(t, raw));
  return { s, evs, segs: s.finish(seq.length) };
}
test('segmentador: un fallo de 1 muestra no parte el segmento', () => {
  const { evs, segs } = runSeq([P(R1), P(R1), P(R1), P(R2), P(R1), P(R1)]);
  assert.strictEqual(segs.length, 1);
  assert.strictEqual(evs[3].glitch, true);
});
test('segmentador: 2 muestras iguales abren segmento nuevo', () => {
  const { segs } = runSeq([P(R1), P(R1), P(R2), P(R2), P(R2)]);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[1].t0, 2);
});
test('segmentador: un NONE de < 2 s no corta la presentación', () => {
  const { segs } = runSeq([P(R1), P(R1), N, P(R1), P(R1)]);
  assert.strictEqual(segs.length, 1);
});
test('segmentador: 5 cambios en 10 s → inestable', () => {
  const seq = [];
  for (let i = 0; i < 6; i++) { const r = i % 2 ? R1 : R2; seq.push(P(r), P(r)); }
  for (let i = 0; i < 4; i++) seq.push(P(R1));
  const { segs, s } = runSeq(seq);
  assert.ok(segs.length >= 5);
  assert.ok(segs.some((g) => g.unstable));
  assert.ok(s.isUnstable(13));
  assert.ok(!s.isUnstable(30));
});
test('segmentador: aplastado (squash 0.79) → baja calidad solo si |squash−1| > 0.25', () => {
  const s = VD.createSegmenter();
  s.push(0, { ...P(R1), squash: 0.79, uy: 0.79 });
  assert.strictEqual(s.current.lowQ, false);
  const s2 = VD.createSegmenter();
  s2.push(0, { ...P(R1), squash: 0.48, ux: 1.63, uy: 0.79 });
  assert.strictEqual(s2.current.lowQ, true);
});
test('sigIsBg: huella casi toda fondo', () => {
  const sig = new Uint8Array(256 * 144 * 3).fill(18);
  assert.ok(VD.sigIsBg(sig, null, { r: 18, g: 18, b: 18 }));
  for (let i = 0; i < sig.length * 0.05; i++) sig[i] = 200;
  assert.ok(!VD.sigIsBg(sig, null, { r: 18, g: 18, b: 18 }));
});

// ---- Fixtures locales a resolución completa (extraídos con el arnés; opcionales) ----
const LOCAL = path.join(__dirname, 'fixtures', 'local');
test('fixtures locales a resolución completa (si existen)', { skip: !fs.existsSync(path.join(LOCAL, 'expected.json')) && 'no hay tests/fixtures/local/expected.json' }, () => {
  const exp = JSON.parse(fs.readFileSync(path.join(LOCAL, 'expected.json'), 'utf8'));
  for (const e of exp) {
    const img = decodePng(path.join(LOCAL, e.png));
    // Copia de 480 de ancho como en el worker: aquí basta con un submuestreo por área.
    const { areaResize } = require('./helpers/area.js');
    const dw = 480, dh = Math.round(img.height * 480 / img.width);
    const rgb = areaResize(img, 0, 0, img.width, img.height, dw, dh);
    const det = { width: dw, height: dh, data: new Uint8ClampedArray(dw * dh * 4) };
    for (let i = 0, j = 0; i < dw * dh; i++, j += 3) { det.data[i * 4] = rgb[j]; det.data[i * 4 + 1] = rgb[j + 1]; det.data[i * 4 + 2] = rgb[j + 2]; det.data[i * 4 + 3] = 255; }
    const roiY = Math.floor(0.7 * img.height);
    const r = VD.detectSample(det, { width: img.width, height: img.height - roiY, data: img.data.subarray(roiY * img.width * 4) }, { W: img.width, H: img.height, roiY });
    assert.strictEqual(r.state, e.state, e.png);
    if (e.rect) for (const k of ['x0', 'y0', 'x1', 'y1']) assert.ok(Math.abs(r.rect[k] - e.rect[k]) <= (e.tol || 4) * Math.ceil(img.width / 480), `${e.png} ${k}: ${r.rect[k]} vs ${e.rect[k]}`);
    if (e.uy) assert.ok(Math.abs(r.uy - e.uy) <= 0.03, `${e.png} uy ${r.uy}`);
  }
});
