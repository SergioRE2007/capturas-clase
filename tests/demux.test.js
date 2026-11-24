'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { demuxWebm } = require('../lib/webm-demux.js');

// ---- Constructor EBML mínimo ----
const idBytes = (id) => { const b = []; let v = id; while (v > 0) { b.unshift(v & 0xff); v = Math.floor(v / 256); } return b; };
function sizeBytes(n) { // 4 bytes de tamaño (válido para todo lo que generamos aquí)
  return [0x10 | ((n >>> 24) & 0x0f), (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id, payload) => [...idBytes(id), ...sizeBytes(payload.length), ...payload];
const elUnknown = (id, payload) => [...idBytes(id), ...UNKNOWN, ...payload];
const uintB = (v, n) => { const b = []; for (let i = n - 1; i >= 0; i--) b.push(Math.floor(v / 2 ** (8 * i)) & 0xff); return b; };
function block(track, rel, key, data) { return [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, key ? 0x80 : 0x00, ...data]; }
const simple = (track, rel, key, data) => el(0xA3, block(track, rel, key, data));
const group = (track, rel, data, ref) => el(0xA0, [...el(0xA1, [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, 0, ...data]), ...(ref ? el(0xFB, [0xFF]) : [])]);

function buildFile({ garbage = false, truncate = 0 } = {}) {
  const header = el(0x1A45DFA3, el(0x4282, [...Buffer.from('webm')]));
  const info = el(0x1549A966, el(0x2AD7B1, uintB(1000000, 3))); // sin Duration
  const tracks = el(0x1654AE6B, el(0xAE, [...el(0xD7, [1]), ...el(0x83, [1]), ...el(0x86, [...Buffer.from('V_VP9')]),
    ...el(0xE0, [...el(0xB0, uintB(1440, 2)), ...el(0xBA, uintB(852, 2))])]));
  const audioBlock = simple(2, 5, true, [7, 7]);
  const c1 = elUnknown(0x1F43B675, [...el(0xE7, uintB(0, 1)), ...simple(1, 0, true, [1, 1, 1]), ...audioBlock, ...simple(1, 40, false, [2, 2]), ...group(1, 80, [3, 3], true)]);
  const junk = garbage ? [0x00, 0x00, 0x13, 0x37, 0x42, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06] : [];
  // Cluster 2 en t = 1000 ms, con un timecode relativo negativo.
  const c2 = elUnknown(0x1F43B675, [...el(0xE7, uintB(1000, 2)), ...simple(1, -20, false, [4]), ...simple(1, 0, true, [5, 5]), ...simple(1, 33, false, [6, 6, 6, 6, 6, 6])]);
  let all = [...header, ...elUnknown(0x18538067, [...info, ...tracks, ...c1, ...junk, ...c2])];
  if (truncate) all = all.slice(0, all.length - truncate);
  return new Uint8Array(all);
}
const srcOf = (u) => ({ size: u.length, readAt: async (p, l) => u.slice(p, p + l) });

async function collect(u) {
  const blocks = [], resyncs = [];
  let tracks = null, info = null;
  const r = await demuxWebm(srcOf(u), { onInfo: (i) => { info = i; }, onTracks: (t) => { tracks = t; }, onBlock: (b) => { blocks.push(b); }, onResync: (a, b) => resyncs.push([a, b]) });
  return { blocks, resyncs, tracks, info, r };
}

test('demux: Segment/Cluster de tamaño desconocido, sin Duration, SimpleBlock y BlockGroup', async () => {
  const { blocks, tracks, info } = await collect(buildFile());
  assert.strictEqual(info.duration, undefined);
  assert.deepStrictEqual(tracks.map((t) => [t.number, t.type, t.codec, t.width, t.height]), [[1, 1, 'V_VP9', 1440, 852]]);
  assert.deepStrictEqual(blocks.map((b) => [Math.round(b.time * 1000), b.key, b.track]),
    [[0, true, 1], [40, false, 1], [80, false, 1], [980, false, 1], [1000, true, 1], [1033, false, 1]]);
  assert.deepStrictEqual([...blocks[0].data], [1, 1, 1]);
});
test('demux: el último bloque truncado termina limpio', async () => {
  const { blocks } = await collect(buildFile({ truncate: 3 }));
  assert.strictEqual(blocks.length, 5);
});
test('demux: basura entre clusters → onResync y siguen llegando bloques', async () => {
  const { blocks, resyncs } = await collect(buildFile({ garbage: true }));
  assert.strictEqual(resyncs.length, 1);
  assert.ok(resyncs[0][1] > resyncs[0][0]);
  assert.deepStrictEqual(blocks.map((b) => Math.round(b.time * 1000)), [0, 40, 80, 980, 1000, 1033]);
});
test('demux: onBlock puede parar', async () => {
  let n = 0;
  const r = await demuxWebm(srcOf(buildFile()), { onBlock: () => (++n === 2 ? 'stop' : undefined) });
  assert.strictEqual(n, 2); assert.ok(r.stopped);
});
