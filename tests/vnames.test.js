'use strict';
const test = require('node:test');
const assert = require('node:assert');
const VN = require('../vnames.js');

const TODAY = '2026-11-24';
const TABLE = [
  ['13-11 database kotlin.webm', '2026-11-13', null, 'database kotlin'],
  ['13-11 database kotlin PARTE DOS.webm', '2026-11-13', 2, 'database kotlin'],
  ['16-10 ALGO DE FLUJO - PARTE 1.webm', '2026-10-16', 1, 'ALGO DE FLUJO'],
  ['16-11 ANDROID PARTE TRES.webm', '2026-11-16', 3, 'ANDROID'],
  ['18 - 11 dataStorage.webm', '2026-11-18', null, 'dataStorage'],
  ['18-11 Storage.webm', '2026-11-18', null, 'Storage'],
  ['23-10 - ToDo App _.webm', '2026-10-23', null, 'ToDo App'],
  ['26-10 Parte Dos.webm', '2026-10-26', 2, ''],
  ['7_10 - LOL GRABADO MAL.webm', '2026-10-07', null, 'LOL GRABADO MAL'],
  ['9-11.webm', '2026-11-09', null, ''],
  ['9-11 PARTE 2.webm', '2026-11-09', 2, ''],
  ['9_10 PARTE 2 - NavHost & Route.webm', '2026-10-09', 2, 'NavHost & Route']
];

test('los 12 nombres del corpus', () => {
  for (const [name, date, part, topic] of TABLE) {
    const r = VN.parseName(name, TODAY);
    assert.deepStrictEqual([r.date, r.part, r.topic, r.warn], [date, part, topic, null], name);
  }
});
test('nombres sintéticos (F39)', () => {
  assert.strictEqual(VN.parseName('9-11 (1).webm', TODAY).date, '2026-11-09');
  const inv = VN.parseName('31-02 x.webm', TODAY);
  assert.strictEqual(inv.warn, 'invalid'); assert.strictEqual(inv.date, null);
  const sw = VN.parseName('10-23 y.webm', TODAY);
  assert.strictEqual(sw.warn, 'swapped'); assert.strictEqual(sw.date, null); assert.strictEqual(sw.proposed, '2026-10-23');
  const p = VN.parseName('9-11-2026 PARTE 2.webm', TODAY);
  assert.deepStrictEqual([p.date, p.part], ['2026-11-09', 2]);
  assert.strictEqual(VN.parseName('9_11_26.webm', TODAY).date, '2026-11-09');
  assert.strictEqual(VN.parseName('clase sin fecha.webm', TODAY).warn, 'nodate');
  assert.strictEqual(VN.parseName('5-11 tema parte IV.mp4', TODAY).part, 4);
});
test('año alrededor de año nuevo y fechas futuras', () => {
  assert.strictEqual(VN.parseName('30-12 repaso', '2027-01-02').date, '2026-12-30');
  assert.strictEqual(VN.parseName('25-11 mañana', TODAY).date, '2026-11-25'); // mañana todavía vale
  assert.strictEqual(VN.parseName('26-11 pasado', TODAY).date, '2025-11-26');
});
test('las tildes se mantienen en el tema', () => {
  assert.strictEqual(VN.parseName('5-11 Introducción.webm', TODAY).topic, 'Introducción');
  assert.strictEqual(VN.parseName('5-11 Introducción parte dos.webm', TODAY).part, 2);
});
test('orderGroup', () => {
  const mk = (n) => ({ name: n, ...VN.parseName(n, TODAY) });
  let g = VN.orderGroup([mk('9-11 PARTE 2.webm'), mk('9-11.webm')]);
  assert.strictEqual(g.ambiguous, false);
  assert.deepStrictEqual(g.ordered.map((f) => [f.name, f.partEff]), [['9-11.webm', 1], ['9-11 PARTE 2.webm', 2]]);
  g = VN.orderGroup([mk('13-11 database kotlin PARTE DOS.webm'), mk('13-11 database kotlin.webm')]);
  assert.strictEqual(g.ambiguous, false); assert.strictEqual(g.ordered[0].partEff, 1);
  assert.strictEqual(VN.orderGroup([mk('18-11 Storage.webm'), mk('18 - 11 dataStorage.webm')]).ambiguous, true);
  assert.strictEqual(VN.orderGroup([mk('1-11 a parte 2'), mk('1-11 b parte 2')]).ambiguous, true);
  g = VN.orderGroup([mk('1-11 a parte 3'), mk('1-11 b parte 1')]); // falta la parte 2: normal
  assert.strictEqual(g.ambiguous, false); assert.deepStrictEqual(g.ordered.map((f) => f.part), [1, 3]);
  assert.strictEqual(VN.orderGroup([mk('9-11.webm')]).ambiguous, false);
});
test('groupFiles: por clase y fecha, fechas ascendentes', () => {
  const items = TABLE.map(([n]) => ({ name: n, clase: 'PMDPM', ...VN.parseName(n, TODAY) }));
  const g = VN.groupFiles(items);
  assert.strictEqual(g.length, 9);
  assert.deepStrictEqual(g.map((x) => x.date), [...g.map((x) => x.date)].sort());
});
