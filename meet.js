'use strict';
// Script dentro de la pestaña de Google Meet.
//  - Dice al panel el código de la reunión (abc-defg-hij) → así se sabe de qué clase es.
//  - Localiza el vídeo de la PRESENTACIÓN (lo que comparte el profesor) y devuelve dónde está
//    en la pantalla, para recortar solo eso (sin cámaras, sin nombres, sin la interfaz de Meet).
(() => {
  if (window.__capturasClaseMeet) return;
  window.__capturasClaseMeet = true;

  const CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?:\/|$)/;
  const meetCode = () => (CODE_RE.exec(location.pathname) || [])[1] || null;
  // Meet etiqueta la presentación como "Presentación de X", "X (presentación)", "X's presentation"…
  // OJO: "X está presentando" / "is presenting" aparece en la CÁMARA de quien presenta: no cuenta.
  // ("Presentación" sola puede ser un nombre de persona: exigimos "Presentación de…" o "(presentación)".)
  const LABEL_RE = /presentaci[oó]n de |\(presentaci[oó]n\)|presentation|pantalla compartida|screen ?shar|apresenta[çc][aã]o|pr[äa]sentation/i;

  function transformIsMirrored(el) {
    const t = getComputedStyle(el).transform;
    if (!t || t === 'none') return false;
    const m = /matrix(3d)?\(([^)]+)\)/.exec(t);
    return !!m && parseFloat(m[2].split(',')[0]) < 0;
  }

  // Contenedor de la "tesela" (tile) del participante que contiene al vídeo.
  function tileOf(v, vArea) {
    let el = v, best = v;
    for (let i = 0; i < 10 && el.parentElement; i++) {
      el = el.parentElement;
      if (el.hasAttribute('data-participant-id') || el.hasAttribute('data-requested-participant-id')) return el;
      const r = el.getBoundingClientRect();
      if (r.width * r.height > vArea * 1.8 + 1) break;
      best = el;
    }
    return best;
  }

  function tileLabel(tile) {
    let s = tile.getAttribute('aria-label') || '';
    tile.querySelectorAll('[aria-label],[data-tooltip],[title]').forEach((n, i) => {
      if (i < 30) s += ' ' + (n.getAttribute('aria-label') || n.getAttribute('data-tooltip') || n.getAttribute('title') || '');
    });
    s += ' ' + (tile.innerText || '').slice(0, 300);
    return s;
  }

  // Rectángulo de la IMAGEN dentro del <video> (descontando las bandas negras de object-fit).
  function pictureRect(v) {
    const r = v.getBoundingClientRect();
    let x = r.left, y = r.top, w = r.width, h = r.height;
    const fit = getComputedStyle(v).objectFit;
    if (fit !== 'fill' && fit !== 'cover' && v.videoWidth && v.videoHeight && w && h) {
      const ar = v.videoWidth / v.videoHeight;
      if (w / h > ar) { const nw = h * ar; x += (w - nw) / 2; w = nw; } else { const nh = w / ar; y += (h - nh) / 2; h = nh; }
    }
    // recortar a la parte visible: ventana y contenedores que ocultan lo que sobresale (overflow)
    let x1 = Math.max(0, x), y1 = Math.max(0, y), x2 = Math.min(innerWidth, x + w), y2 = Math.min(innerHeight, y + h);
    for (let el = v.parentElement; el && el !== document.documentElement; el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const a = el.getBoundingClientRect();
      x1 = Math.max(x1, a.left); y1 = Math.max(y1, a.top); x2 = Math.min(x2, a.right); y2 = Math.min(y2, a.bottom);
    }
    return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
  }
  const overlap = (a, b) => {
    const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h);
    return x2 > x1 && y2 > y1 ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : null;
  };

  function detect() {
    const vw = innerWidth, vh = innerHeight, vpArea = vw * vh;
    const cands = [], visibleVids = [];
    for (const v of document.querySelectorAll('video')) {
      if (!v.videoWidth || !v.videoHeight || v.readyState < 2) continue;
      const cs = getComputedStyle(v);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const pr = pictureRect(v);
      if (pr.w * pr.h > 0) visibleVids.push({ v, pr });
      const areaFrac = (pr.w * pr.h) / vpArea;
      if (areaFrac < 0.02) continue;
      const tile = tileOf(v, pr.w * pr.h);
      const label = LABEL_RE.test(tileLabel(tile));
      const mirrored = transformIsMirrored(v);
      const px = v.videoWidth * v.videoHeight;
      const score = areaFrac * 100 + (label ? 200 : 0) + (mirrored ? -300 : 0) + (px >= 1.5e6 ? 30 : 0);
      cands.push({ v, pr, areaFrac, label, mirrored, px, score, res: `${v.videoWidth}x${v.videoHeight}` });
    }
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0];
    let presenting = false, reason = 'no hay vídeos';
    if (best) {
      if (best.mirrored) reason = 'solo está tu cámara';
      else if (best.label) { presenting = true; reason = 'presentación detectada'; }
      // Sin etiqueta: solo aceptamos un vídeo muy grande y de resolución de pantalla (≥ 1080p);
      // las cámaras en Meet casi siempre llegan a ≤ 720p.
      else if (best.areaFrac >= 0.3 && best.px >= 1.8e6) { presenting = true; reason = 'vídeo grande de alta resolución (probable presentación, sin etiqueta)'; }
      else reason = 'nadie está presentando';
    }
    const rel = (r) => ({ x: r.x / vw, y: r.y / vh, w: r.w / vw, h: r.h / vh });
    // Otras cámaras que tapan la presentación (p. ej. tu propia vista flotante): el panel las ignora al
    // comparar, para que tu cámara moviéndose no cuente como "cambio de diapositiva".
    const masks = [];
    if (presenting) {
      for (const o of visibleVids) {
        if (o.v === best.v) continue;
        const ov = overlap(o.pr, best.pr);
        if (ov) masks.push(rel(ov));
      }
    }
    return {
      presenting, reason,
      rect: presenting ? rel(best.pr) : null, masks,
      videoRes: best ? best.res : null, videos: cands.length
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.type !== 'meet-info') return;
    let d;
    try { d = detect(); } catch (e) { d = { presenting: false, reason: `error: ${e.message}`, rect: null }; }
    reply({ ...d, code: meetCode(), title: document.title, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, visible: document.visibilityState });
  });

  // Avisar al icono cuando entras/cambias de reunión (Meet es una app de una sola página).
  let last;
  function announce() {
    const c = meetCode();
    if (c === last) return;
    last = c;
    try { chrome.runtime.sendMessage({ type: 'meet-here', code: c }).catch(() => {}); } catch (_) { /* extensión recargada */ }
  }
  announce();
  if (window.navigation) navigation.addEventListener('navigatesuccess', announce);
  setInterval(announce, 5000);
})();
