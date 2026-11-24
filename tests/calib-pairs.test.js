'use strict';
// Pares de fotogramas de 7_10 con resultado conocido (cambia / no cambia), usando la geometría esperada.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const CC = require('../core.js');
const { decodePng } = require('./helpers/png.js');
const { areaResize } = require('./helpers/area.js');

const FX = path.join(__dirname, 'fixtures', 'calib-7_10');
// Fotogramas de una clase real (salen nombres de personas): no están en el repo; si faltan, la prueba se salta.
const HAS_FX = fs.existsSync(path.join(FX, 'fixture.json'));
const fixture = HAS_FX ? JSON.parse(fs.readFileSync(path.join(FX, 'fixture.json'), 'utf8')) : { frames: [], pairs: [] };
const byBin = new Map(fixture.frames.map((f) => [f.file, f]));

test('los 8 pares de fixture.json dan el resultado esperado con compareEx', { skip: !HAS_FX && 'faltan tests/fixtures/calib-7_10 (no se suben al repo)' }, () => {
  const sx = 46, sy = 48, sw = 433 - 46 + 1, sh = 254 - 48 + 1;
  const crop = { x: sx / 480, y: sy / 284, w: sw / 480, h: sh / 284 };
  const sigOf = (f) => areaResize(decodePng(path.join(FX, f.png)), sx, sy, sw, sh, 256, 144);
  for (const p of fixture.pairs) {
    const A = byBin.get(p.fileA), B = byBin.get(p.fileB);
    const mask = CC.orMask(CC.maskBits(A.expectedMasks, crop), CC.maskBits(B.expectedMasks, crop));
    const d = CC.compareEx(sigOf(A), sigOf(B), { mask });
    const changed = d.pct >= 1 || d.tile >= CC.SIG.TILE_T;
    assert.strictEqual(changed, p.changed, `${p.a} → ${p.b}: pct ${d.pct.toFixed(3)} tile ${d.tile.toFixed(1)}`);
  }
});
