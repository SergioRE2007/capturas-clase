// Nombres de los vídeos grabados: fecha, parte y tema; agrupar por (clase, fecha) y ordenar las partes.
// Script clásico puro (página y Node). Espacio de nombres VN.
const VN = (() => {
  'use strict';
  const DATE_RE = /^\s*(\d{1,2})\s*([-_.\/])\s*(\d{1,2})(?:\2(\d{4}|\d{2}))?(?!\d)/;
  const PART_RE = /(?:^|[\s\-_.(])(?:parte|part|pt)\.?\s*(\d{1,2}|uno|una|primera|dos|segunda|tres|tercera|cuatro|cuarta|cinco|quinta|i{1,3}|iv|v)(?=$|[\s\-_.)])/i;
  const PART_WORDS = { uno: 1, una: 1, primera: 1, dos: 2, segunda: 2, tres: 3, tercera: 3, cuatro: 4, cuarta: 4, cinco: 5, quinta: 5, i: 1, ii: 2, iii: 3, iv: 4, v: 5 };
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const valid = (y, m, d) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };

  function toDate(today) {
    if (today instanceof Date) return new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (typeof today === 'string') { const [y, m, d] = today.split('-').map(Number); return new Date(y, m - 1, d); }
    const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }
  // Año más reciente tal que la fecha no pase de mañana (las clases se graban antes de procesarlas).
  function inferYear(m, d, today) {
    const lim = toDate(today); lim.setDate(lim.getDate() + 1);
    for (let y = lim.getFullYear(); y > lim.getFullYear() - 8; y--) {
      if (valid(y, m, d) && new Date(y, m - 1, d) <= lim) return y;
    }
    return null;
  }

  // Quita tildes manteniendo mayúsculas y un mapa de índices al texto original (NFD).
  function fold(s) {
    const nfd = s.normalize('NFD');
    let out = ''; const map = [];
    for (let i = 0; i < nfd.length; i++) {
      if (/\p{M}/u.test(nfd[i])) continue;
      out += nfd[i]; map.push(i);
    }
    map.push(nfd.length);
    return { nfd, out, map };
  }
  const clean = (s) => s.replace(/^[\s\-_.]+|[\s\-_.]+$/g, '').replace(/\s{2,}/g, ' ');

  function parseName(fileName, today) {
    let base = String(fileName || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').replace(/\s*\(\d+\)$/, '');
    const f = fold(base);
    const orig = (a, b) => f.nfd.slice(f.map[a], f.map[b]).normalize('NFC');
    const res = { date: null, part: null, topic: '', warn: null, proposed: null };
    let rest = 0; // índice (en f.out) donde empieza lo que va después de la fecha
    const m = DATE_RE.exec(f.out);
    if (!m) res.warn = 'nodate';
    else {
      rest = m[0].length;
      const d = Number(m[1]), mo = Number(m[3]);
      let y = m[4] ? Number(m[4]) : null;
      if (y != null && y < 100) y += 2000;
      if (d <= 12 && mo > 12) {
        res.warn = 'swapped';
        const yy = y != null ? y : inferYear(d, mo, today);
        if (yy != null && valid(yy, d, mo)) res.proposed = iso(yy, d, mo);
      } else {
        if (y == null) y = inferYear(mo, d, today);
        if (y != null && mo >= 1 && mo <= 12 && valid(y, mo, d)) res.date = iso(y, mo, d);
        else res.warn = 'invalid';
      }
    }
    const tail = f.out.slice(rest);
    const p = PART_RE.exec(tail);
    let topicA = rest, topicB = f.out.length, cut = null;
    if (p) {
      const v = p[1].toLowerCase();
      res.part = /^\d+$/.test(v) ? Number(v) : PART_WORDS[v];
      cut = [rest + p.index, rest + p.index + p[0].length];
    }
    res.topic = clean(cut ? `${orig(topicA, cut[0])} ${orig(cut[1], topicB)}` : orig(topicA, topicB));
    return res;
  }

  // Orden dentro de un grupo (misma clase y fecha). files: [{part}] → {ordered, ambiguous}; cada uno recibe partEff.
  function orderGroup(files) {
    const list = files.slice();
    const marked = list.filter((f) => f.part != null), unmarked = list.filter((f) => f.part == null);
    const parts = marked.map((f) => f.part);
    const dup = new Set(parts).size !== parts.length;
    for (const f of list) f.partEff = f.part;
    if (list.length === 1) return { ordered: list, ambiguous: false };
    let ambiguous = dup || unmarked.length >= 2;
    if (unmarked.length === 1) {
      if (parts.length && parts.every((p) => p >= 2)) unmarked[0].partEff = 1;
      else ambiguous = true;
    }
    const ordered = ambiguous ? list : list.slice().sort((a, b) => a.partEff - b.partEff);
    return { ordered, ambiguous };
  }

  // Agrupa por (clase, fecha); grupos por fecha ascendente.
  function groupFiles(items) {
    const map = new Map();
    for (const it of items) {
      const k = `${it.clase || ''}\u0000${it.date || ''}`;
      if (!map.has(k)) map.set(k, { clase: it.clase || '', date: it.date || '', files: [] });
      map.get(k).files.push(it);
    }
    return [...map.values()].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || a.clase.localeCompare(b.clase, 'es'));
  }

  return { DATE_RE, PART_RE, PART_WORDS, parseName, inferYear, orderGroup, groupFiles };
})();
if (typeof module !== 'undefined') module.exports = VN;
