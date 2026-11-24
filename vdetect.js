// Detector de la presentación en vídeos grabados de Meet (sin la página de Meet: solo píxeles).
// Se ancla en el botón rojo de colgar, mide el fondo de Meet, busca la zona del escenario con un relleno desde
// los bordes y valida el rectángulo (centrado). Incluye las zonas a ignorar al comparar y el segmentador temporal.
// Script clásico puro sobre buffers RGBA (worker y Node). Espacio de nombres VD.
// Unidades: las constantes de la interfaz de Meet están en px de una grabación de 1440 de ancho a dpr 1 y se
// multiplican por ux/uy (medidos con el botón de colgar). Los rectángulos se devuelven en px del fotograma.
const VD = (() => {
  'use strict';
  const BG_TOL = 7;
  const DEFAULT_BG = { r: 18, g: 18, b: 18 };

  const median = (a) => { if (!a.length) return NaN; const s = Float64Array.from(a).sort(); return s[s.length >> 1]; };
  const isBgPx = (d, i, bg, tol = BG_TOL) =>
    Math.abs(d[i] - bg.r) <= tol && Math.abs(d[i + 1] - bg.g) <= tol && Math.abs(d[i + 2] - bg.b) <= tol;
  const isDarkNeutral = (d, i) => { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); return mx <= 70 && mx - mn <= 20; };
  function hueSat(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const S = mx ? (mx - mn) / mx : 0;
    let h = 0;
    if (mx !== mn) {
      if (mx === r) h = ((g - b) / (mx - mn)) % 6;
      else if (mx === g) h = (b - r) / (mx - mn) + 2;
      else h = (r - g) / (mx - mn) + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return { h, S, V: mx / 255 };
  }

  // ---------- §3.2 Color de fondo (bloque abajo a la izquierda, moda en 5 bits) ----------
  function measureBg(roi, W, H, roiY) {
    const s = W / 1440;
    const x0 = Math.round(4 * s), x1 = Math.max(x0 + 2, Math.round(44 * s));
    const y0 = H - Math.round(24 * s), y1 = Math.max(y0 + 2, H - Math.round(4 * s));
    const bins = new Map();
    let n = 0;
    for (let y = y0; y < y1; y++) {
      const ry = y - roiY; if (ry < 0 || ry >= roi.height) continue;
      for (let x = x0; x < x1; x++) {
        const i = (ry * roi.width + x) * 4, d = roi.data;
        const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
        let e = bins.get(key); if (!e) bins.set(key, e = { n: 0, r: 0, g: 0, b: 0 });
        e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; n++;
      }
    }
    let best = null;
    for (const e of bins.values()) if (!best || e.n > best.n) best = e;
    if (best && n) {
      const bg = { r: best.r / best.n, g: best.g / best.n, b: best.b / best.n };
      const gray = (bg.r + bg.g + bg.b) / 3;
      if (gray >= 8 && gray <= 40 && best.n / n >= 0.5) return { bg, fallback: false };
    }
    return { bg: { ...DEFAULT_BG }, fallback: true };
  }

  // ---------- §3.1 Botón rojo de colgar (en el ROI a resolución completa = 30 % inferior) ----------
  function probe(roi, W, H, roiY, bg) {
    const s = W / 1440, w = roi.width, h = roi.height, d = roi.data;
    const red = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < red.length; i += 4, j++) if (d[i] > 190 && d[i + 1] < 90 && d[i + 2] < 90) red[j] = 1;
    const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
    const minArea = 400 * s * s, ring = Math.max(2, Math.round(6 * s));
    let best = null;
    for (let start = 0; start < red.length; start++) {
      if (!red[start] || seen[start]) continue;
      let sp = 0, area = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
      stack[sp++] = start; seen[start] = 1;
      while (sp) {
        const p = stack[--sp], x = p % w, y = (p / w) | 0;
        area++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
        if (x > 0 && red[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
        if (x < w - 1 && red[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
        if (y > 0 && red[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
        if (y < h - 1 && red[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
      }
      if (area < minArea) continue;
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1, asp = bw / bh;
      if (asp < 1.0 || asp > 3.5) continue;
      // Anillo a `ring` px fuera de la caja: debe ser oscuro y gris (fondo de Meet o la barra de controles, que es
      // un poco más clara: 31,30,33 en 7_10). Así se descarta el rojo de las diapositivas.
      let nr = 0, nb = 0;
      const rx0 = bx0 - ring, rx1 = bx1 + ring, ry0 = by0 - ring, ry1 = by1 + ring;
      const test = (x, y) => { if (x < 0 || y < 0 || x >= w || y >= h) return; nr++; if (isDarkNeutral(d, (y * w + x) * 4)) nb++; };
      for (let x = rx0; x <= rx1; x++) { test(x, ry0); test(x, ry1); }
      for (let y = ry0 + 1; y < ry1; y++) { test(rx0, y); test(rx1, y); }
      if (!nr || nb / nr < 0.7) continue;
      if (!best || area > best.area) best = { x: bx0, y: by0 + roiY, w: bw, h: bh, area };
    }
    return best;
  }
  function snapUnit(u) {
    for (const v of [1, 2]) if (Math.abs(u - v) <= 0.06) return v;
    return u;
  }

  // ---------- Morfología (cierre) sobre una máscara binaria ----------
  function dilate(src, w, h, r, outsideOn) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w; let cnt = 0;
      // ventana [x-r, x+r]
      for (let x = -r; x <= r; x++) cnt += x < 0 || x >= w ? outsideOn : src[row + x];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = cnt > 0 ? 1 : 0;
        const xo = x - r, xi = x + r + 1;
        cnt -= xo < 0 ? outsideOn : src[row + xo];
        cnt += xi >= w ? outsideOn : src[row + xi];
      }
    }
    for (let x = 0; x < w; x++) {
      let cnt = 0;
      for (let y = -r; y <= r; y++) cnt += y < 0 || y >= h ? outsideOn : tmp[y * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = cnt > 0 ? 1 : 0;
        const yo = y - r, yi = y + r + 1;
        cnt -= yo < 0 ? outsideOn : tmp[yo * w + x];
        cnt += yi >= h ? outsideOn : tmp[yi * w + x];
      }
    }
    return out;
  }
  // Cierre (dilatar y luego erosionar) con un margen de r px alrededor, para que no "crezca" hasta los bordes.
  function closing(mask, w, h, r) {
    if (r <= 0) return mask;
    const p = r + 1, pw = w + 2 * p, ph = h + 2 * p;
    const pm = new Uint8Array(pw * ph);
    for (let y = 0; y < h; y++) pm.set(mask.subarray(y * w, (y + 1) * w), (y + p) * pw + p);
    const d = dilate(pm, pw, ph, r, 0);
    for (let i = 0; i < d.length; i++) d[i] ^= 1;
    const e = dilate(d, pw, ph, r, 1); // erosión = complemento de la dilatación del complemento
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = e[(y + p) * pw + x + p] ? 0 : 1;
    return out;
  }

  // Racha más larga de 1s en arr[from..to] tolerando huecos ≤ gap. Devuelve [ini, fin] o null.
  function longestRun(get, from, to, gap) {
    let best = null, s = -1, last = -1;
    for (let i = from; i <= to; i++) {
      if (!get(i)) continue;
      if (s < 0 || i - last - 1 > gap) { s = i; }
      last = i;
      if (!best || last - s > best[1] - best[0]) best = [s, last];
    }
    return best;
  }

  // ---------- §3.3–3.8 Detección en una muestra ----------
  // det: {data,width,height} RGBA (copia de 480 de ancho); roi: {data,width,height} RGBA a resolución completa
  // de las filas [roiY, H). opts: {W, H, roiY}.
  function detectSample(det, roi, opts) {
    const W = opts.W, H = opts.H, roiY = opts.roiY;
    const k = W / det.width, dw = det.width, dh = det.height, dd = det.data;
    const { bg, fallback } = measureBg(roi, W, H, roiY);
    const out = { state: 'UNKNOWN', rect: null, ux: 1, uy: 1, squash: 1, bg, chromeH: 0, SB: 0, ctrlTop: 0, probeKey: null, conf: 1,
      flags: { repaired: false, bgFallback: fallback, refineMoved: false }, fgBox: null, k };
    if (fallback) out.conf -= 0.3;
    const btn = probe(roi, W, H, roiY, bg);
    if (!btn) return out; // no es un fotograma de Meet
    let ux = btn.w / 70, uy = btn.h / 47.5;
    let squash = uy / ux;
    if (Math.abs(squash - 1) <= 0.05) squash = 1;
    ux = snapUnit(ux); uy = squash === 1 ? ux : snapUnit(uy);
    Object.assign(out, { ux, uy, squash, ctrlTop: btn.y, btn, probeKey: [Math.round(btn.w / 2), Math.round(btn.h / 2), Math.round(btn.y / 3)] });
    const ctrlTop = btn.y;
    const bandBottomF = ctrlTop - Math.round(18 * uy);
    out.SB = ctrlTop - Math.round(20 * uy);
    // Altura del navegador encima de Meet (7_10): se sube por las columnas 1–3 hasta encontrar algo que no es fondo.
    let chromeRow = -1, run = 0;
    for (let y = Math.min(dh - 1, Math.floor(bandBottomF / k)); y >= 0; y--) {
      let nb = 0;
      for (let x = 1; x <= 3; x++) if (!isBgPx(dd, (y * dw + x) * 4, bg)) nb++;
      if (nb >= 2) { run++; if (run === 1) chromeRow = y; if (run >= 3) break; } else run = 0;
    }
    const chromeH = run >= 3 ? Math.round((chromeRow + 1) * k) : 0;
    out.chromeH = chromeH;
    const bandTopF = chromeH + Math.round(50 * uy);
    const bt = Math.max(0, Math.round(bandTopF / k)), bb = Math.min(dh - 1, Math.round(bandBottomF / k));
    const bw = dw, bh = bb - bt + 1;
    if (bh < 10) { out.state = 'NONE'; return out; }
    // Primer plano dentro de la banda, cierre y relleno del fondo desde abajo, izquierda y derecha.
    const fg = new Uint8Array(bw * bh);
    {
      const br = bg.r, bgG = bg.g, bb2 = bg.b, T = BG_TOL;
      for (let y = 0, j = 0; y < bh; y++) {
        let i = (y + bt) * dw * 4;
        for (let x = 0; x < bw; x++, j++, i += 4) {
          const a = dd[i] - br, b = dd[i + 1] - bgG, c = dd[i + 2] - bb2;
          if (a > T || a < -T || b > T || b < -T || c > T || c < -T) fg[j] = 1;
        }
      }
    }
    const rc = Math.max(1, Math.ceil(6 * ux / k));
    const fgc = closing(fg, bw, bh, rc);
    const reached = new Uint8Array(bw * bh), q = new Int32Array(bw * bh);
    let qh = 0, qt = 0;
    const seed = (p) => { if (!fgc[p] && !reached[p]) { reached[p] = 1; q[qt++] = p; } };
    for (let x = 0; x < bw; x++) seed((bh - 1) * bw + x);
    for (let y = 0; y < bh; y++) { seed(y * bw); seed(y * bw + bw - 1); }
    while (qh < qt) {
      const p = q[qh++], x = p % bw, y = (p / bw) | 0;
      if (x > 0) seed(p - 1); if (x < bw - 1) seed(p + 1); if (y > 0) seed(p - bw); if (y < bh - 1) seed(p + bw);
    }
    // Componentes de lo no alcanzado.
    const lab = new Int32Array(bw * bh);
    let nLab = 0, cand = null;
    for (let s0 = 0; s0 < lab.length; s0++) {
      if (reached[s0] || lab[s0]) continue;
      nLab++;
      let sp = 0, cnt = 0, x0 = bw, y0 = bh, x1 = -1, y1 = -1;
      q[sp++] = s0; lab[s0] = nLab;
      while (sp) {
        const p = q[--sp], x = p % bw, y = (p / bw) | 0;
        cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && !reached[p - 1] && !lab[p - 1]) { lab[p - 1] = nLab; q[sp++] = p - 1; }
        if (x < bw - 1 && !reached[p + 1] && !lab[p + 1]) { lab[p + 1] = nLab; q[sp++] = p + 1; }
        if (y > 0 && !reached[p - bw] && !lab[p - bw]) { lab[p - bw] = nLab; q[sp++] = p - bw; }
        if (y < bh - 1 && !reached[p + bw] && !lab[p + bw]) { lab[p + bw] = nLab; q[sp++] = p + bw; }
      }
      if (x1 - x0 + 1 >= 0.30 * bw && y1 - y0 + 1 >= 0.30 * bh && (!cand || cnt > cand.cnt)) cand = { id: nLab, cnt, x0, y0, x1, y1 };
    }
    if (!cand) { out.state = 'NONE'; return out; }
    out.fgBox = { x0: cand.x0 * k, y0: (cand.y0 + bt) * k, x1: (cand.x1 + 1) * k - 1, y1: (cand.y1 + bt + 1) * k - 1 };
    const inC = (x, y) => lab[y * bw + x] === cand.id;
    // §3.5 Extremos por rachas (no por la caja): deja fuera la pastilla propia, la miniatura, Personas, reacciones.
    const ch = cand.y1 - cand.y0 + 1;
    const gx = Math.ceil(12 * ux / k), gy = Math.ceil(12 * uy / k);
    const lefts = [], rights = [];
    for (let y = Math.round(cand.y0 + 0.40 * ch); y <= Math.round(cand.y0 + 0.70 * ch); y++) {
      const r = longestRun((x) => inC(x, y), cand.x0, cand.x1, gx);
      if (r) { lefts.push(r[0]); rights.push(r[1]); }
    }
    if (!lefts.length) { out.state = 'NONE'; return out; }
    let x0 = median(lefts), x1 = median(rights);
    const cL = lefts.filter((v) => Math.abs(v - x0) <= 1).length / lefts.length;
    const cR = rights.filter((v) => Math.abs(v - x1) <= 1).length / rights.length;
    const tops = [], bots = [];
    for (let x = Math.round(x0); x <= Math.round(x0 + 0.60 * (x1 - x0)); x++) {
      const r = longestRun((y) => inC(x, y), cand.y0, cand.y1, gy);
      if (r) { tops.push(r[0]); bots.push(r[1]); }
    }
    let y0 = median(tops), y1 = median(bots);
    // §3.6 Centrado horizontal: si los márgenes no cuadran, se refleja el borde más fiable.
    const L = x0, R = bw - 1 - x1;
    if (Math.abs(L - R) > Math.max(2, 6 * ux / k)) {
      if (cL >= cR) x1 = bw - 1 - L; else x0 = R;
      out.flags.repaired = true; out.conf -= 0.3;
    }
    // Comprobación de proporción: debe tocar arriba y abajo del escenario (o izquierda y derecha).
    const tolA = Math.ceil(20 * uy / k);
    const touchesTB = y0 <= tolA && y1 >= bh - 1 - tolA;
    const touchesLR = x0 <= Math.ceil(20 * ux / k) && x1 >= bw - 1 - Math.ceil(20 * ux / k);
    if (!touchesTB && !touchesLR) out.conf -= 0.2;
    out.cL = cL; out.cR = cR;
    // A px del fotograma (inclusivos).
    const rect = { x0: Math.round(x0 * k), y0: Math.round((y0 + bt) * k), x1: Math.round((x1 + 1) * k) - 1, y1: Math.round((y1 + bt + 1) * k) - 1 };
    rect.x1 = Math.min(W - 1, rect.x1); rect.y1 = Math.min(H - 1, rect.y1);
    out.rect = rect;
    out.band = { top: bandTopF, bottom: bandBottomF };
    // §3.7 ¿Es la cámara de alguien a pantalla completa (fondo de color liso) y no una presentación?
    const rw = (x1 - x0 + 1), rh = (y1 - y0 + 1);
    if (rw >= 0.85 * bw || rh >= 0.92 * bh) {
      if (isParticipant(det, Math.round(x0), Math.round(y0 + bt), Math.round(x1), Math.round(y1 + bt))) { out.state = 'PARTICIPANT'; return out; }
    }
    out.state = 'PRESENT';
    return out;
  }

  function isParticipant(det, x0, y0, x1, y1) {
    const d = det.data, w = det.width;
    const hist = new Float64Array(24);
    let n = 0, edges = 0, ne = 0;
    const gray = (i) => (d[i] + d[i + 1] + d[i + 2]) / 3;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = (y * w + x) * 4;
      n++;
      const hs = hueSat(d[i], d[i + 1], d[i + 2]);
      if (hs.S > 0.25 && hs.V > 0.15) hist[Math.min(23, (hs.h / 15) | 0)]++;
      if (x < x1 && y < y1) {
        ne++;
        const g = gray(i);
        if (Math.abs(gray(i + 4) - g) + Math.abs(gray(i + w * 4) - g) > 40) edges++;
      }
    }
    let dom = 0;
    for (let b = 0; b < 24; b++) dom = Math.max(dom, hist[b] + hist[(b + 1) % 24] + hist[(b + 2) % 24]);
    dom /= Math.max(1, n);
    const e = edges / Math.max(1, ne);
    return dom > 0.60 && e < 0.015;
  }

  // Refinado a resolución completa (una vez al abrir el segmento). full = {data,width,height} del fotograma.
  function refine(rect, full, raw) {
    const { bg, k, ux } = raw;
    const W = full.width, H = full.height, d = full.data;
    const m = Math.ceil(k) + 2;
    const r = { ...rect };
    let moved = false;
    const nonBgShare = (pts) => { let n = 0, nb = 0; for (const [x, y] of pts) { if (x < 0 || y < 0 || x >= W || y >= H) continue; n++; if (!isBgPx(d, (y * W + x) * 4, bg)) nb++; } return n ? nb / n : 0; };
    const ys = (a, b) => { const o = []; const s = Math.round(a + 0.2 * (b - a)), e = Math.round(a + 0.8 * (b - a)); for (let y = s; y <= e; y++) o.push(y); return o; };
    const colPts = (x) => ys(rect.y0, rect.y1).map((y) => [x, y]);
    const rowPts = (y) => ys(rect.x0, rect.x1).map((x) => [x, y]);
    const scan = (from, to, step, pts) => { for (let v = from; step > 0 ? v <= to : v >= to; v += step) if (nonBgShare(pts(v)) >= 0.6) return v; return null; };
    const edges = [
      ['x0', scan(rect.x0 - m, rect.x0 + m, 1, colPts)], ['x1', scan(rect.x1 + m, rect.x1 - m, -1, colPts)],
      ['y0', scan(rect.y0 - m, rect.y0 + m, 1, rowPts)], ['y1', scan(rect.y1 + m, rect.y1 - m, -1, rowPts)]
    ];
    for (const [key, v] of edges) {
      if (v == null || Math.abs(v - rect[key]) > m) { moved = true; continue; }
      r[key] = v;
    }
    const L = r.x0, R = W - 1 - r.x1;
    if (Math.abs(L - R) > Math.max(2, 6 * ux)) { if ((raw.cL || 0) >= (raw.cR || 0)) r.x1 = W - 1 - L; else r.x0 = R; }
    return { rect: r, moved };
  }

  // ---------- §4 Zonas a ignorar al comparar (los píxeles guardados no se tocan) ----------
  function clipBox(b, r) {
    const x0 = Math.max(b.x0, r.x0), y0 = Math.max(b.y0, r.y0), x1 = Math.min(b.x1, r.x1), y1 = Math.min(b.y1, r.y1);
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
  }
  // Fracción de píxeles (en det) dentro de una caja de px del fotograma que cumplen pred.
  function shareIn(det, k, b, pred) {
    const d = det.data, w = det.width;
    let n = 0, ok = 0;
    for (let y = Math.max(0, Math.floor(b.y0 / k)); y <= Math.min(det.height - 1, Math.floor(b.y1 / k)); y++)
      for (let x = Math.max(0, Math.floor(b.x0 / k)); x <= Math.min(w - 1, Math.floor(b.x1 / k)); x++) {
        const i = (y * w + x) * 4; n++; if (pred(d[i], d[i + 1], d[i + 2])) ok++;
      }
    return n ? ok / n : 0;
  }
  // seg: {rect, ux, uy, squash, SB, bg}; devuelve {masks:[rel], transient:[rel], dropped:[nombres]} (relativos al fotograma).
  function masks(seg, det, W, H, k) {
    const { rect, ux, uy, SB, bg } = seg;
    const sq = seg.squash || 1;
    const rw = rect.x1 - rect.x0 + 1, rh = rect.y1 - rect.y0 + 1, area = rw * rh;
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
    const boxes = [], transient = [], dropped = [];
    const add = (name, b, list = boxes) => {
      const c = clipBox(b, rect); if (!c) return;
      if (list === boxes && (c.x1 - c.x0) * (c.y1 - c.y0) > 0.30 * area) { dropped.push(name); return; }
      list.push({ name, ...c });
    };
    add('M1', { x0: W - 360 * ux, x1: W - 28 * ux, y0: SB - 56 * uy, y1: SB - 4 * uy });
    const m2 = { x0: W - 272 * ux, x1: W - 28 * ux, y0: SB - 152 * uy, y1: SB - 10 * uy };
    let m2on = false;
    if (det) {
      if (m2.x1 > rect.x1 + 2) {
        const strip = { x0: rect.x1 + 3, x1: m2.x1, y0: m2.y0, y1: m2.y1 };
        if (shareIn(det, k, strip, (r, g, b) => !(Math.abs(r - bg.r) <= BG_TOL && Math.abs(g - bg.g) <= BG_TOL && Math.abs(b - bg.b) <= BG_TOL)) > 0.5) m2on = true;
      }
      if (!m2on && shareIn(det, k, m2, (r, g, b) => { const h = hueSat(r, g, b); return h.S > 0.25 && h.h >= 250 && h.h <= 290; }) >= 0.6) m2on = true;
    }
    if (m2on) add('M2', m2);
    const m3 = { x0: cx - 75 * ux, x1: cx + 75 * ux, y0: cy - 26 * uy, y1: cy + 26 * uy };
    const m4 = { x0: cx - 80 * ux, x1: cx + 140 * ux, y0: rect.y1 - 86 * uy, y1: rect.y1 - 4 * uy };
    add('M3', m3); add('M4', m4);
    const aspect = rw / (rh / sq);
    if (aspect >= 1.70 && aspect <= 1.85) {
      add('M5', { x0: rect.x0, x1: rect.x1, y0: rect.y1 - 0.06 * rh, y1: rect.y1 });
      const m6 = { x0: cx - 0.18 * rw, x1: cx + 0.18 * rw, y0: rect.y0 + 0.86 * rh, y1: rect.y0 + 0.945 * rh };
      if (det && shareIn(det, k, m6, (r, g, b) => r < 90 && g > 90 && g < 170 && b > 180) >= 0.01) add('M6', m6);
    }
    // Zonas pasajeras: solo para elegir el fotograma más limpio, nunca se tapan.
    add('M3', m3, transient); add('M4', m4, transient);
    add('Personas', { x0: rect.x1 - 330 * ux, y0: rect.y0, x1: rect.x1, y1: rect.y0 + 250 * uy }, transient);
    add('Reacciones', { x0: rect.x0, y0: rect.y1 - 0.35 * rh, x1: rect.x0 + 0.25 * rw, y1: rect.y1 }, transient);
    const rel = (b) => ({ name: b.name, x: b.x0 / W, y: b.y0 / H, w: (b.x1 - b.x0) / W, h: (b.y1 - b.y0) / H });
    return { masks: boxes.map(rel), transient: transient.map(rel), dropped, m2: m2on };
  }
  const rectRel = (r, W, H) => ({ x: r.x0 / W, y: r.y0 / H, w: (r.x1 - r.x0 + 1) / W, h: (r.y1 - r.y0 + 1) / H });
  const rectPx = (r) => ({ sx: r.x0, sy: r.y0, sw: r.x1 - r.x0 + 1, sh: r.y1 - r.y0 + 1 });

  // Índices (en la huella 256x144) de los píxeles dentro de las zonas pasajeras.
  function sigIndices(boxesRel, cropRel) {
    const bits = typeof CC !== 'undefined' ? CC.maskBits(boxesRel, cropRel) : require('./core.js').maskBits(boxesRel, cropRel);
    const idx = [];
    for (let i = 0; i < bits.length; i++) if (bits[i]) idx.push(i);
    return Uint32Array.from(idx);
  }
  // Respaldo de «sin presentación»: ≥ 98 % de los píxeles no tapados de la huella son fondo (±10).
  function sigIsBg(sig, mask, bg) {
    let n = 0, nb = 0;
    for (let i = 0, j = 0; j < sig.length / 3; i += 3, j++) {
      if (mask && mask[j]) continue;
      n++;
      if (Math.abs(sig[i] - bg.r) <= 10 && Math.abs(sig[i + 1] - bg.g) <= 10 && Math.abs(sig[i + 2] - bg.b) <= 10) nb++;
    }
    return n > 0 && nb / n >= 0.98;
  }

  // ---------- §3.9 Segmentador temporal (en línea, una muestra por paso) ----------
  function createSegmenter(opts = {}) {
    const manual = opts.manualRect || null, always = !!opts.always;
    const segs = [];
    let S = null, C = null, nextId = 1;
    const boundaries = [];
    let unstableUntil = -Infinity;
    const keyClose = (a, b) => (!a && !b) || (a && b && a.every((v, i) => Math.abs(v - b[i]) <= 1));
    function same(a, b) {
      if (a.state !== b.state) return false;
      if (a.state !== 'PRESENT') return true;
      if (!keyClose(a.probeKey, b.probeKey)) return false;
      return ['x0', 'y0', 'x1', 'y1'].every((e) => Math.abs(a.rect[e] - b.rect[e]) <= 4);
    }
    function applyOverride(raw) {
      if (!manual) return raw;
      let state = raw.state;
      if (always && (state === 'NONE' || state === 'PARTICIPANT')) state = 'PRESENT';
      if (state !== 'PRESENT') return raw;
      return { ...raw, state, rect: { ...manual }, conf: 1, probeKey: raw.probeKey || [0, 0, 0], manual: true, ux: raw.ux || 1, uy: raw.uy || 1, squash: 1 };
    }
    function open(raw, t) {
      if (S) { S.t1 = t; segs.push(S); boundaries.push(t); }
      while (boundaries.length && boundaries[0] < t - 10) boundaries.shift();
      if (boundaries.length >= 4) {
        unstableUntil = t + 10;
        for (const g of segs) if (g.t1 >= t - 10) g.unstable = true;
      }
      S = {
        id: nextId++, state: raw.state, rect: raw.rect ? { ...raw.rect } : null, ux: raw.ux, uy: raw.uy, squash: raw.squash,
        SB: raw.SB, bg: raw.bg, chromeH: raw.chromeH, probeKey: raw.probeKey, t0: t, t1: t, n: 1, conf: raw.conf, rectRev: 0,
        unstable: t < unstableUntil, lowQ: false, rects: raw.rect ? [{ ...raw.rect }] : [], cL: raw.cL, cR: raw.cR, k: raw.k, opened: true
      };
      S.lowQ = S.state === 'PRESENT' && (Math.abs((S.squash || 1) - 1) > 0.25 || S.conf < 0.5);
      return S;
    }
    function refreshRect() {
      const rs = S.rects.slice(-10);
      const u = { x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) };
      if (['x0', 'y0', 'x1', 'y1'].some((e) => Math.abs(u[e] - S.rect[e]) > 4)) { S.rect = u; S.rectRev++; }
      if (S.n >= 10) {
        const med = { x0: median(rs.map((r) => r.x0)), y0: median(rs.map((r) => r.y0)), x1: median(rs.map((r) => r.x1)), y1: median(rs.map((r) => r.y1)) };
        if (['x0', 'y0', 'x1', 'y1'].some((e) => Math.abs(u[e] - med[e]) > 8)) S.conf -= 0.3;
      }
    }
    // Devuelve {seg, glitch, opened}
    function push(t, raw0) {
      const raw = applyOverride(raw0);
      if (!S) { open(raw, t); return { seg: S, glitch: false, opened: true }; }
      if (t < unstableUntil) S.unstable = true;
      if (same(raw, S)) {
        C = null;
        S.t1 = t; S.n++;
        if (S.state === 'PRESENT' && raw.rect && S.n <= 10 && !S.manual) {
          S.rects.push({ ...raw.rect });
          if (S.n === 3 || S.n === 10) refreshRect();
        }
        return { seg: S, glitch: false, opened: false };
      }
      if (C && same(raw, C.raw)) {
        const tOpen = C.t;
        C = null;
        open(raw, tOpen);
        S.t1 = t; S.n = 2;
        return { seg: S, glitch: false, opened: true };
      }
      C = { raw, t };
      return { seg: S, glitch: true, opened: false };
    }
    function finish(t) { if (S) { S.t1 = Math.max(S.t1, t); segs.push(S); S = null; } return segs; }
    return { push, finish, get current() { return S; }, segments: segs, isUnstable: (t) => t < unstableUntil };
  }

  return { BG_TOL, measureBg, probe, detectSample, isParticipant, refine, masks, rectRel, rectPx, sigIndices, sigIsBg, createSegmenter, hueSat };
})();
if (typeof module !== 'undefined') module.exports = VD;
