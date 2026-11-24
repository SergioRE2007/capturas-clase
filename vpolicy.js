// Cuándo guardar una imagen en un vídeo grabado (máquina de estados por muestra, en tiempo del vídeo).
// Idea: guardar cada diapositiva / pantalla una vez, ya asentada, y la "versión final" antes de que cambie
// (desplazamiento, cambio de diapositiva, pausa al escribir). Script clásico puro (worker y Node). Espacio VP.
const VP = (() => {
  'use strict';
  const C = typeof CC !== 'undefined' ? CC : require('./core.js');

  const DEFAULTS = {
    mode: 'equilibrado', // 'equilibrado' | 'final' | 'todas'
    SETTLE: 2, SETTLE_UNSTABLE: 3, BIG: 1, minChange: 1, PAUSE: 5, PAUSE_FINAL: 10, MAXGAP: 60, CLEAN_WIN: 4, REBASE_PCT: 10,
    // Cambio "menor" (no se guarda): < MINOR_PIX píxeles de la huella, o < MINOR_PIX_MAX repartidos en
    // ≤ MINOR_COMPS manchas de ≤ 2 zonas. Los cambios pequeños no se pierden: se acumulan frente a la última guardada.
    MINOR_PIX: 100, MINOR_PIX_MAX: 250, MINOR_COMPS: 4, RECENT: 6
  };

  // Muestra: {t, tEnd, segId, sig (RGB 256x144), maskBits, sigSize, transIdx, unstable, crop?}
  // opts.onFree(s) se llama cuando la política ya no necesita la muestra (el worker cierra su bitmap).
  // opts.startLast = {sig, maskBits, sigSize} (última imagen guardada de la carpeta / del vídeo anterior).
  function create(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    const mode = o.mode;
    const PAUSE = mode === 'final' ? o.PAUSE_FINAL : o.PAUSE;
    const onFree = o.onFree || (() => {});
    let last = o.startLast && o.startLast.sig ? { sig: o.startLast.sig, maskBits: o.startLast.maskBits || null, sigSize: o.startLast.sigSize || null } : null;
    let lastSaveT = -Infinity, curSeg = null, cand = null;
    let run = { prev: null };
    let acts = [];
    const stats = { reasons: {} };

    const retain = (s) => { s.refs = (s.refs || 0) + 1; };
    const release = (s) => { if (!s) return; s.refs = (s.refs || 0) - 1; if (s.refs <= 0) { s.refs = 0; onFree(s); } };
    const settle = (s) => (s.unstable ? o.SETTLE_UNSTABLE : o.SETTLE);
    const diff = (a, b) => C.compareEx(a.sig, b.sig, { mask: C.orMask(a.maskBits, b.maskBits) });
    const strictChanged = (d) => d.pct >= o.minChange || d.tile >= C.SIG.TILE_T;
    // Cursor, caret, resaltado de un paréntesis, reloj del emulador, «línea:columna» del IDE…: no es un cambio.
    // Un cambio "menor" son muy pocos píxeles, o unas pocas manchas sueltas de ≤ 2 zonas cada una (p. ej. el
    // puntero que desaparece de un sitio y aparece en otro). Una línea de código nueva ocupa ≥ 3 zonas seguidas.
    function smallBlob(d) {
      if (d.nPix < o.MINOR_PIX) return true;
      if (d.nPix >= o.MINOR_PIX_MAX) return false;
      const TX = C.SIG.TX, hits = d.hits, seen = new Uint8Array(hits.length);
      let comps = 0;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i] < 3 || seen[i]) continue;
        if (++comps > o.MINOR_COMPS) return false;
        let size = 0;
        const stack = [i]; seen[i] = 1;
        while (stack.length) {
          const k = stack.pop(); size++;
          if (size > 2) return false;
          const kx = k % TX, ky = (k / TX) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = kx + dx, ny = ky + dy, j = ny * TX + nx;
            if ((dx || dy) && nx >= 0 && nx < TX && ny >= 0 && j < hits.length && !seen[j] && hits[j] >= 3) { seen[j] = 1; stack.push(j); }
          }
        }
      }
      return true;
    }
    const meaningful = (d) => !smallBlob(d) && strictChanged(d);
    // Las últimas imágenes guardadas: si la pantalla vuelve a una que ya está guardada (se cerró un menú,
    // se volvió al archivo de antes sin tocarlo), no se repite.
    const recent = last ? [last] : [];
    function savedChanged(s) {
      if (!last) return { changed: true, d: null };
      const d = diff(s, last);
      if (last.sigSize && s.sigSize !== last.sigSize) {
        // La misma diapositiva a otro tamaño da pequeñas diferencias: solo cuenta un cambio grande.
        if (d.pct < o.REBASE_PCT) { last = { sig: s.sig, maskBits: s.maskBits, sigSize: s.sigSize }; return { changed: false, d }; }
        return { changed: true, d };
      }
      if (!meaningful(d)) return { changed: false, d };
      for (const r of recent) {
        if (r === last || r.sigSize !== s.sigSize) continue;
        if (!meaningful(diff(s, r))) return { changed: false, d, repeat: true };
      }
      return { changed: true, d };
    }
    function trySave(s, reason) {
      const { changed, d } = savedChanged(s);
      if (!changed) return false;
      retain(s); // el worker la libera (VP.release) cuando ya la ha codificado
      acts.push({ type: 'save', s, reason, pct: d ? d.pct : null });
      last = { sig: s.sig, maskBits: s.maskBits, sigSize: s.sigSize, t: s.t };
      recent.unshift(last); if (recent.length > o.RECENT) recent.length = o.RECENT;
      lastSaveT = s.t;
      if (run) run.savedInRun = (run.savedInRun || 0) + 1;
      stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      return true;
    }

    // ---- Elección del fotograma más limpio dentro de una racha estable (≤ CLEAN_WIN s) ----
    const snap = (s) => { const idx = s.transIdx; if (!idx || !idx.length) return null; const v = new Uint8Array(idx.length * 3); for (let i = 0; i < idx.length; i++) { const k = idx[i] * 3; v[i * 3] = s.sig[k]; v[i * 3 + 1] = s.sig[k + 1]; v[i * 3 + 2] = s.sig[k + 2]; } return v; };
    function scoreAll() {
      const sn = cand.snaps;
      if (!sn.length || !sn[0]) return null;
      const n = sn[0].length, med = new Uint8Array(n), tmp = new Uint8Array(sn.length);
      for (let i = 0; i < n; i++) { for (let j = 0; j < sn.length; j++) tmp[j] = sn[j][i]; const srt = tmp.slice(0, sn.length).sort(); med[i] = srt[srt.length >> 1]; }
      return (v) => { let sc = 0; for (let i = 0; i < n; i++) sc += Math.abs(v[i] - med[i]); return sc; };
    }
    function openCand(s) {
      retain(s); retain(s);
      cand = { base: s, best: s, until: s.t + o.CLEAN_WIN, snaps: [] };
      const v = snap(s); if (v) cand.snaps.push(v);
      s._snap = v;
    }
    function offerCand(s) {
      if (s.t >= cand.until || strictChanged(diff(s, cand.base))) { closeCand(); return; }
      const v = snap(s);
      if (!v) return;
      s._snap = v;
      if (cand.snaps.length < 8) cand.snaps.push(v);
      const sc = scoreAll();
      if (sc && cand.best._snap && sc(v) < sc(cand.best._snap)) { release(cand.best); cand.best = s; retain(s); }
    }
    function closeCand() {
      if (!cand) return;
      const c = cand; cand = null;
      trySave(c.best, last === null ? 'first' : 'settled');
      release(c.best); release(c.base);
    }

    function endRun() {
      closeCand();
      const p = run.prev;
      if (p) {
        if (p.calm >= settle(p)) trySave(p, 'end');
        else if (!run.savedInRun && p.tEnd - run.t0 >= 1.5 && !p.unstable) trySave(p, 'end-forced');
        release(p);
      }
      run = { prev: null };
    }

    function step(s) {
      acts = [];
      s.refs = s.refs || 0;
      if (s.segId !== curSeg) { endRun(); curSeg = s.segId; }
      if (mode === 'todas') { trySave(s, 'change'); return acts; }
      if (!run.prev) run = { prev: null, calmSince: s.t, strictSince: s.t, pending: true, savedInRun: 0, t0: s.t };
      else {
        const d = diff(s, run.prev);
        if (d.pct >= o.BIG) {
          closeCand();
          if (run.prev.calm >= settle(run.prev)) trySave(run.prev, 'flush'); // versión final antes de moverse
          run.calmSince = run.strictSince = s.t; run.pending = true;
        } else if (strictChanged(d)) run.strictSince = s.t;
      }
      const calm = s.tEnd - run.calmSince;
      if (cand) offerCand(s);
      if (run.pending && calm >= settle(s)) {
        if (mode !== 'final') openCand(s);
        run.pending = false;
      } else if (!cand && s.tEnd - run.strictSince >= PAUSE) trySave(s, 'pause');
      else if (!cand && mode !== 'final' && s.t - lastSaveT > o.MAXGAP && calm >= settle(s)) trySave(s, 'timeout');
      s.calm = calm;
      if (run.prev) release(run.prev);
      retain(s); run.prev = s;
      return acts;
    }
    // Sin presentación, hueco por vídeo dañado, cambio de archivo…: se cierra la racha (la referencia se mantiene).
    function gap() { acts = []; endRun(); curSeg = null; return acts; }
    function finish() { return gap(); }

    return { step, gap, finish, release, get last() { return last; }, stats };
  }
  return { DEFAULTS, create };
})();
if (typeof module !== 'undefined') module.exports = VP;
