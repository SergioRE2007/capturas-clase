'use strict';

// ---------- Referencias a la UI ----------
const $ = (s) => document.querySelector(s);
const els = {
  pickFolder: $('#pickFolder'), folderName: $('#folderName'), pathPreview: $('#pathPreview'),
  sourceHelp: $('#sourceHelp'), classBox: $('#classBox'), newClass: $('#newClass'), newCode: $('#newCode'),
  className: $('#className'), saveClass: $('#saveClass'), meetCode: $('#meetCode'), classList: $('#classList'),
  pickSource: $('#pickSource'), sourceName: $('#sourceName'),
  stage: $('#stage'), video: $('#video'), cropBox: $('#cropBox'), detect: $('#detect'),
  cropHint: $('#cropHint'), resetCrop: $('#resetCrop'),
  mode: $('#mode'), layout: $('#layout'), naming: $('#naming'),
  interval: $('#interval'), sensitivity: $('#sensitivity'), format: $('#format'), autoStart: $('#autoStart'),
  classes: $('#classes'), classCount: $('#classCount'),
  start: $('#start'), stop: $('#stop'), captureNow: $('#captureNow'),
  stats: $('#stats'), thumb: $('#thumb'), log: $('#log'), permWarn: $('#permWarn')
};

// ---------- Estado ----------
const state = {
  root: null,            // carpeta principal (FileSystemDirectoryHandle)
  sessionDir: null,      // carpeta donde se guardan las capturas de la sesión actual
  nextNum: 1,            // siguiente número de imagen en sessionDir
  stream: null, track: null, imageCapture: null,
  meet: null,            // { tabId, code } de la pestaña de Meet capturada (si se conoce)
  info: null,            // última respuesta del script de Meet
  classes: {},           // { 'abc-defg-hij': 'Programación' }
  manualClass: '',       // nombre de clase cuando la fuente no es una Meet conocida
  running: false, starting: false, busy: false, forcePending: false,
  gen: 0,                // "generación": cambia al iniciar/parar/cambiar de fuente; invalida capturas en curso
  lastSig: null,         // huella de la última captura GUARDADA
  lastDims: null,
  crop: null,            // recorte manual {x, y, w, h} relativo (0..1)
  saved: 0, skipped: 0, waiting: 0, errors: 0,
  thumbUrl: null
};

// Comparación: la imagen se reduce a 256x144 (color). Un píxel "cambia" si algún canal varía más de PIX_T niveles
// (así se ignora el ruido de compresión de Meet). Se guarda si cambia ≥ X % de la imagen O si alguna
// zona de 8x8 cambia ≥ TILE_T % (para no perder una línea de código nueva o un número de diapositiva).
const SIG_W = 256, SIG_H = 144, PIX_T = 24, TILE = 8, TILE_T = 10;
const TX = SIG_W / TILE, TY = SIG_H / TILE;
const sigCanvas = new OffscreenCanvas(SIG_W, SIG_H);
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

const ticker = new Worker('ticker.js');
ticker.onmessage = () => { if (state.running) tick(false); };

// ---------- Utilidades ----------
function log(msg) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.prepend(li);
  while (els.log.children.length > 80) els.log.lastChild.remove();
}
const pad = (n, l = 2) => String(n).padStart(l, '0');
const dateStr = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const timeStr = (d = new Date()) => `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
function clampNum(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' ? Math.min(max, Math.max(min, n)) : def;
}
const intervalMs = () => clampNum(els.interval.value, 1, 120, 3) * 1000;
const minChange = () => clampNum(els.sensitivity.value, 0.1, 50, 1);
function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('tiempo agotado')), ms); })])
    .finally(() => clearTimeout(t));
}
// Nombre válido de carpeta en Windows/Mac/Linux.
function safeName(s) {
  let n = String(s || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 80).replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(n)) n = `_${n}`;
  return n || 'otros';
}
function flash(el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 2500); }

function currentClassName() {
  if (state.meet && state.meet.code) return state.classes[state.meet.code] || '';
  return state.manualClass;
}

function updateUI() {
  const hasSource = !!state.track;
  const mode = els.mode.value;
  els.start.disabled = state.running || state.starting || !hasSource;
  els.stop.disabled = !state.running;
  els.captureNow.disabled = !hasSource || state.starting;
  els.pickSource.disabled = state.running || state.starting;
  els.pickFolder.disabled = state.running || state.starting;
  els.stage.classList.toggle('hidden', !hasSource);
  els.stage.classList.toggle('manual', mode === 'manual');
  els.start.textContent = state.running ? '● Capturando…' : '▶ Iniciar';
  els.resetCrop.classList.toggle('hidden', mode !== 'manual' || !state.crop);
  els.cropHint.textContent = !hasSource ? ''
    : mode === 'manual' ? 'Arrastra sobre la vista previa para elegir la zona.'
    : mode === 'auto' ? 'El recuadro azul es lo que se guarda.' : 'Se guarda la pestaña entera.';
  els.classBox.classList.toggle('hidden', !hasSource);
  const unknown = !!(state.meet && state.meet.code && !state.classes[state.meet.code]);
  els.newClass.classList.toggle('hidden', !unknown);
  els.newCode.textContent = state.meet && state.meet.code ? state.meet.code : '';
  els.meetCode.textContent = state.meet && state.meet.code ? `Meet: ${state.meet.code}` : 'Pestaña elegida a mano (no es una Meet reconocida)';
  updatePathPreview();
  if (state.meet && state.meet.tabId != null) {
    chrome.action.setBadgeBackgroundColor({ tabId: state.meet.tabId, color: '#e5484d' }).catch(() => {});
    chrome.action.setBadgeText({ tabId: state.meet.tabId, text: state.running ? 'REC' : '' }).catch(() => {});
    if (state.running) chrome.action.setTitle({ tabId: state.meet.tabId, title: `Capturas de Clase — capturando «${currentClassName()}»` }).catch(() => {});
  }
}
function updateStats() {
  els.stats.textContent = `Guardadas: ${state.saved} · Sin cambios: ${state.skipped}` +
    (els.mode.value === 'auto' ? ` · Esperando presentación: ${state.waiting}` : '');
}
function layoutPart(d = new Date()) {
  const l = els.layout.value;
  return l === 'day' ? dateStr(d) : l === 'session' ? `${dateStr(d)}_${timeStr(d).slice(0, 5)}` : '';
}
function updatePathPreview() {
  if (!state.root) { els.pathPreview.textContent = ''; return; }
  const parts = [state.root.name, safeName(currentClassName() || '(clase)')];
  const lp = layoutPart(); if (lp) parts.push(lp);
  parts.push(`img001${els.naming.value === 'numtime' ? `_${timeStr()}` : ''}.${els.format.value === 'jpeg' ? 'jpg' : 'png'}`);
  els.pathPreview.textContent = `Se guardará así: ${parts.join(' / ')}`;
}

// ---------- Ajustes persistentes ----------
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('ajustes') || '{}') || {}; } catch (_) {}
  const setSel = (el, v) => { if (v != null && [...el.options].some((o) => o.value === v)) el.value = v; };
  if (s.interval != null) els.interval.value = clampNum(s.interval, 1, 120, 3);
  if (s.sensitivity != null) els.sensitivity.value = clampNum(s.sensitivity, 0.1, 50, 1);
  setSel(els.format, s.format); setSel(els.mode, s.mode); setSel(els.layout, s.layout); setSel(els.naming, s.naming);
  if (typeof s.autoStart === 'boolean') els.autoStart.checked = s.autoStart;
  if (typeof s.manualClass === 'string') state.manualClass = s.manualClass;
  const c = s.crop;
  if (c && [c.x, c.y, c.w, c.h].every(Number.isFinite) && c.x >= 0 && c.y >= 0 && c.w >= 0.03 && c.h >= 0.03 &&
      c.x + c.w <= 1.0001 && c.y + c.h <= 1.0001) state.crop = c;
}
function saveSettings() {
  els.interval.value = clampNum(els.interval.value, 1, 120, 3);
  els.sensitivity.value = clampNum(els.sensitivity.value, 0.1, 50, 1);
  try {
    localStorage.setItem('ajustes', JSON.stringify({
      interval: els.interval.value, sensitivity: els.sensitivity.value, format: els.format.value,
      mode: els.mode.value, layout: els.layout.value, naming: els.naming.value,
      autoStart: els.autoStart.checked, manualClass: state.manualClass, crop: state.crop
    }));
  } catch (_) {}
}

// ---------- Clases (código de Meet → nombre) ----------
async function loadClasses() {
  try { state.classes = (await chrome.storage.local.get('clases')).clases || {}; } catch (_) { state.classes = {}; }
  renderClasses();
}
async function storeClasses() {
  await chrome.storage.local.set({ clases: state.classes });
  renderClasses();
}
function renderClasses() {
  const entries = Object.entries(state.classes).sort((a, b) => a[1].localeCompare(b[1], 'es'));
  els.classCount.textContent = entries.length;
  els.classes.replaceChildren(...entries.map(([code, name]) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${name} `;
    const c = document.createElement('code'); c.textContent = code; span.append(c);
    const del = document.createElement('button');
    del.className = 'link'; del.textContent = 'Olvidar';
    del.onclick = async () => { delete state.classes[code]; await storeClasses(); updateUI(); };
    li.append(span, del);
    return li;
  }));
  const names = [...new Set(Object.values(state.classes))].sort((a, b) => a.localeCompare(b, 'es'));
  els.classList.replaceChildren(...names.map((n) => Object.assign(document.createElement('option'), { value: n })));
  if (document.activeElement !== els.className) els.className.value = currentClassName();
}
async function saveClassName() {
  const name = els.className.value.trim();
  if (!name) { els.className.focus(); return; }
  const before = currentClassName();
  if (state.meet && state.meet.code) { state.classes[state.meet.code] = name; await storeClasses(); }
  else { state.manualClass = name; saveSettings(); }
  log(`Clase: ${name}${state.meet && state.meet.code ? ` (Meet ${state.meet.code})` : ''}`);
  updateUI();
  if (state.running && before !== name) { stopCapture('Cambio de clase.'); await startCapture(true); }
  else if (!state.running && state.track && els.autoStart.checked && state.meet) await startCapture(true);
}
els.saveClass.onclick = saveClassName;
els.className.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveClassName(); });

// ---------- IndexedDB (para recordar la carpeta entre sesiones) ----------
let dbPromise = null;
function idb() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open('capturas-clase', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbPromise = null; }; res(db); };
      r.onerror = () => { dbPromise = null; rej(r.error); };
    });
  }
  return dbPromise;
}
async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(val, key);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
}

// ---------- Carpeta ----------
function showFolder(name, perm) {
  els.folderName.textContent = perm === 'granted' ? `📁 ${name}`
    : perm === 'denied' ? `📁 ${name} (sin permiso: vuelve a elegirla)` : `📁 ${name} (se pedirá permiso al iniciar)`;
  els.folderName.classList.toggle('muted', perm !== 'granted');
  updatePathPreview();
}
async function loadSavedFolder() {
  try {
    const h = await idbGet('dir');
    if (!h) return;
    state.root = h;
    showFolder(h.name, await h.queryPermission({ mode: 'readwrite' }));
  } catch (_) {}
}
els.pickFolder.onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'capturas-clase', mode: 'readwrite', startIn: 'pictures' });
    state.root = h;
    await idbSet('dir', h).catch(() => {});
    showFolder(h.name, 'granted');
    log(`Carpeta: ${h.name}`);
    if (!state.running && state.track && els.autoStart.checked && state.meet && currentClassName()) startCapture(true);
  } catch (e) {
    if (e.name !== 'AbortError') log(`Error al elegir carpeta: ${e.message}`);
  }
};
// interactive=true solo desde un clic del usuario (pedir permiso exige un gesto).
async function ensurePermission(interactive) {
  if (!state.root) { log('Primero elige la carpeta principal.'); flash(els.pickFolder); return false; }
  const opts = { mode: 'readwrite' };
  let p = await state.root.queryPermission(opts);
  if (p === 'granted') { els.permWarn.classList.add('hidden'); return true; }
  if (!interactive) {
    log('Pulsa ▶ Iniciar para dar permiso a la carpeta.');
    els.permWarn.classList.remove('hidden'); flash(els.start); showFolder(state.root.name, p);
    // Aviso también en el icono de la pestaña de Meet, por si el panel está minimizado.
    if (state.meet && state.meet.tabId != null) {
      chrome.action.setBadgeBackgroundColor({ tabId: state.meet.tabId, color: '#f5a524' }).catch(() => {});
      chrome.action.setBadgeText({ tabId: state.meet.tabId, text: '!' }).catch(() => {});
      chrome.action.setTitle({ tabId: state.meet.tabId, title: 'Capturas de Clase — falta permiso de carpeta: abre el panel y pulsa Iniciar' }).catch(() => {});
    }
    return false;
  }
  try { p = await state.root.requestPermission(opts); } catch (e) { log(`No se pudo pedir permiso: ${e.message}`); return false; }
  showFolder(state.root.name, p);
  if (p === 'granted') els.permWarn.classList.add('hidden');
  if (p !== 'granted') { log('Sin permiso para escribir en la carpeta. Vuelve a elegirla.'); flash(els.pickFolder); }
  return p === 'granted';
}
async function makeSessionDir() {
  const cls = await state.root.getDirectoryHandle(safeName(currentClassName()), { create: true });
  const lp = layoutPart();
  const dir = lp ? await cls.getDirectoryHandle(lp, { create: true }) : cls;
  // La numeración continúa donde se quedó (img001, img002…) aunque reinicies.
  let max = 0;
  state.usedNums = new Set();
  for await (const name of dir.keys()) {
    const m = /^img(\d+)/i.exec(name);
    if (m) { max = Math.max(max, Number(m[1])); state.usedNums.add(Number(m[1])); }
  }
  state.nextNum = max + 1;
  return dir;
}

// ---------- Fuente ----------
function stopSource() {
  state.gen++;
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  if (state.meet && state.meet.tabId != null) chrome.action.setBadgeText({ tabId: state.meet.tabId, text: '' }).catch(() => {});
  state.stream = state.track = state.imageCapture = null;
  state.meet = null; state.info = null; state.lastSig = null; state.lastDims = null; state.lastRect = null; state.sigSize = null;
  state.sessionDir = null;
  els.video.srcObject = null;
  els.sourceName.textContent = 'Aún no has pulsado el icono en tu Meet';
  els.sourceName.classList.add('muted');
  els.sourceHelp.classList.remove('hidden');
  els.detect.classList.add('hidden');
  updateUI();
}
async function useStream(stream, meet, label) {
  stopCapture();
  stopSource();
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.imageCapture = 'ImageCapture' in window ? new ImageCapture(state.track) : null;
  state.meet = meet;
  const track = state.track;
  track.addEventListener('ended', () => {
    if (state.track !== track) return;
    log('Se dejó de capturar la pestaña (¿la cerraste o saliste de la Meet?).');
    stopCapture();
    stopSource();
  });
  els.video.srcObject = stream;
  await els.video.play().catch(() => {});
  els.sourceName.textContent = label;
  els.sourceName.classList.remove('muted');
  els.sourceHelp.classList.add('hidden');
  els.className.value = currentClassName();
  renderCrop();
  updateUI();
  log(`Pestaña capturada: ${label}`);
  if (state.meet) await refreshInfo();
}

// Pestaña de Meet entregada por el icono (tabCapture: sin diálogo).
async function useTabSource(src) {
  if (!src) return;
  if (!src.streamId) {
    if (state.meet && state.meet.tabId === src.tabId) return; // ya la estamos capturando
    if (/active stream/i.test(src.error || '') || state.starting) return; // doble clic mientras arranca
    log('No se pudo capturar esta pestaña. Recarga la Meet (F5) y vuelve a pulsar el icono.');
    return;
  }
  // minWidth/minHeight hacen que la imagen siga el tamaño real de la ventana de Meet; sin ellos el
  // navegador la amplía a 3840x2160 con bandas negras (más memoria y archivos más grandes sin ganar nitidez).
  const size = { minWidth: 16, minHeight: 16, maxWidth: 3840, maxHeight: 2160 };
  const open = (id) => navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: id, ...size, maxFrameRate: 5 } }
  });
  let stream;
  try {
    stream = await open(src.streamId);
  } catch (e1) {
    // El permiso pudo caducar si el panel tardó en abrirse: pedimos uno nuevo y reintentamos.
    try {
      const r = await chrome.runtime.sendMessage({ type: 'renew-stream', tabId: src.tabId });
      if (!r || !r.streamId) throw new Error((r && r.error) || e1.message);
      stream = await open(r.streamId);
    } catch (e) { log(`No se pudo capturar la pestaña de Meet. Pulsa otra vez el icono estando en ella. (${e.message})`); return; }
  }
  await useStream(stream, { tabId: src.tabId, code: src.code }, `Meet ${src.code}`);
  if (!currentClassName()) {
    log('Meet nueva: escribe de qué clase es y pulsa Guardar.');
    els.className.focus();
  } else if (els.autoStart.checked) {
    await startCapture(false);
  }
}
// Las fuentes que llegan del icono se procesan de una en una y solo cuando el panel ya ha cargado
// (clases y carpeta), para no confundir una clase conocida con una "Meet nueva".
let initDone;
const ready = new Promise((r) => { initDone = r; });
let srcChain = Promise.resolve();
function queueSource(src) {
  srcChain = srcChain.then(() => ready).then(() => useTabSource(src)).catch((e) => log(`Error con la Meet: ${e.message}`));
  return srcChain;
}
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'source') queueSource(msg.source);
});

// Plan B: elegir la pestaña con el diálogo de Chrome/Edge.
els.pickSource.onclick = async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 5, max: 10 } },
      audio: false, preferCurrentTab: false, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') log(`No se pudo capturar: ${e.message}`);
    return;
  }
  // Si solo hay una Meet abierta, asumimos que es esa (para saber la clase y detectar la presentación).
  let meet = null;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*' });
    const withCode = tabs.filter((t) => /meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/.test(t.url || ''));
    if (withCode.length === 1) meet = { tabId: withCode[0].id, code: /([a-z]{3}-[a-z]{4}-[a-z]{3})/.exec(withCode[0].url)[1] };
  } catch (_) {}
  await useStream(stream, meet, meet ? `Meet ${meet.code} (elegida a mano)` : 'Pestaña elegida a mano');
  if (!meet && els.mode.value === 'auto') log('Esta pestaña no es una Meet reconocida: usa «La pestaña entera» o «Recorte a mano».');
};

function fitStage() {
  if (els.video.videoWidth) els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
}
els.video.addEventListener('loadedmetadata', fitStage);
els.video.addEventListener('resize', fitStage);

// ---------- Información de la pestaña de Meet ----------
async function askMeet(tabId) {
  return withTimeout(chrome.tabs.sendMessage(tabId, { type: 'meet-info' }), 1500);
}
async function getMeetInfo() {
  if (!state.meet || state.meet.tabId == null) return null;
  const tabId = state.meet.tabId;
  try { return await askMeet(tabId); } catch (e) {
    // Si la Meet ya estaba abierta antes de instalar/recargar la extensión, inyectamos el script.
    if (!/Receiving end|Could not establish/i.test(e.message || '')) throw e;
    await chrome.scripting.executeScript({ target: { tabId }, files: ['meet.js'] });
    return askMeet(tabId);
  }
}
function showDetect(info) {
  const mode = els.mode.value;
  if (mode !== 'auto' || !state.track) { els.detect.classList.add('hidden'); return; }
  els.detect.classList.remove('hidden');
  if (!state.meet) { els.detect.textContent = 'Sin Meet asociada: no se puede detectar la presentación'; els.detect.className = 'badge wait'; return; }
  if (!info) { els.detect.textContent = 'Comprobando la Meet…'; els.detect.className = 'badge wait'; return; }
  els.detect.textContent = info.presenting ? `✔ ${info.reason}` : `⏸ ${info.reason} — no se guarda nada`;
  els.detect.className = `badge ${info.presenting ? 'ok' : 'wait'}`;
}
async function refreshInfo() {
  try { state.info = await getMeetInfo(); } catch (_) { state.info = null; }
  showDetect(state.info);
  renderCrop();
}

// ---------- Recorte ----------
// Rectángulo (relativo al fotograma) que se guarda, según el modo.
function activeCrop(info) {
  const mode = els.mode.value;
  if (mode === 'manual') return state.crop;
  if (mode === 'auto' && info && info.presenting && info.rect) return { ...info.rect, vw: info.vw, vh: info.vh, masks: info.masks || [] };
  return null;
}
function renderCrop() {
  const box = drag ? drag.box : activeCrop(state.info);
  if (!box || (els.mode.value === 'auto' && !state.track)) { els.cropBox.classList.add('hidden'); return; }
  Object.assign(els.cropBox.style, {
    left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`
  });
  els.cropBox.classList.remove('hidden');
}
let drag = null;
function relPoint(e) {
  const r = els.stage.getBoundingClientRect();
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
}
function boxFrom(a, p) {
  return { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) };
}
els.stage.addEventListener('pointerdown', (e) => {
  if (!state.track || e.button !== 0 || els.mode.value !== 'manual' || !els.video.videoWidth) return;
  const p = relPoint(e);
  drag = { start: p, box: { ...p, w: 0, h: 0 } };
  els.stage.setPointerCapture(e.pointerId);
  renderCrop();
});
els.stage.addEventListener('pointermove', (e) => { if (drag) { drag.box = boxFrom(drag.start, relPoint(e)); renderCrop(); } });
els.stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const box = boxFrom(drag.start, relPoint(e));
  drag = null;
  state.crop = box.w < 0.03 || box.h < 0.03 ? null : box;
  state.lastSig = null; state.gen++; // la siguiente captura se guarda con el nuevo recorte
  renderCrop(); saveSettings(); updateUI();
  log(state.crop ? 'Recorte aplicado.' : 'Recorte quitado.');
});
const cancelDrag = () => { if (drag) { drag = null; renderCrop(); } };
els.stage.addEventListener('pointercancel', cancelDrag);
els.stage.addEventListener('lostpointercapture', () => setTimeout(cancelDrag, 0));
els.resetCrop.onclick = () => {
  state.crop = null; state.lastSig = null; state.gen++;
  renderCrop(); saveSettings(); updateUI(); log('Recorte quitado.');
};

// ---------- Captura y comparación ----------
async function grabFrame() {
  // Siempre se intenta primero ImageCapture: el <video> de la vista previa se congela cuando el panel
  // está minimizado, así que solo sirve como último recurso.
  if (state.imageCapture) {
    const p = state.imageCapture.grabFrame();
    try { return await withTimeout(p, 3000); } catch (_) {
      p.then((b) => b.close(), () => {}); // si llega tarde, se libera
    }
  }
  if (els.video.videoWidth) return createImageBitmap(els.video);
  throw new Error('todavía no hay imagen');
}
// Pasa un recorte relativo a píxeles del fotograma. En el modo automático el recorte es relativo
// a la ventana de Meet; si el fotograma tiene bandas negras (otra proporción), se descuentan.
function cropRect(w, h, c) {
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
  return {
    sx, sy,
    sw: Math.max(1, Math.min(w - sx, Math.round(r.w * cw))),
    sh: Math.max(1, Math.min(h - sy, Math.round(r.h * ch)))
  };
}
function signature(bmp, r, crop) {
  sigCtx.imageSmoothingEnabled = true;
  sigCtx.imageSmoothingQuality = 'medium';
  sigCtx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, SIG_W, SIG_H);
  // Tapamos (solo para comparar) las cámaras que están encima de la presentación.
  if (crop && crop.masks && crop.masks.length && crop.w && crop.h) {
    sigCtx.fillStyle = '#000';
    for (const m of crop.masks) {
      sigCtx.fillRect(Math.floor((m.x - crop.x) / crop.w * SIG_W) - 1, Math.floor((m.y - crop.y) / crop.h * SIG_H) - 1,
        Math.ceil(m.w / crop.w * SIG_W) + 2, Math.ceil(m.h / crop.h * SIG_H) + 2);
    }
  }
  // Guardamos R, G y B (no solo el gris): así también se notan los cambios solo de color.
  const d = sigCtx.getImageData(0, 0, SIG_W, SIG_H).data;
  const g = new Uint8Array(SIG_W * SIG_H * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { g[j] = d[i]; g[j + 1] = d[i + 1]; g[j + 2] = d[i + 2]; }
  return g;
}
function isBlank(sig) {
  let max = 0;
  for (let i = 0; i < sig.length; i++) if (sig[i] > max) { max = sig[i]; if (max > 20) return false; }
  return true;
}
function compare(a, b) {
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
// El fotograma de la pestaña puede venir ampliado (p. ej. a 3840x2160). No tiene sentido guardar más
// píxeles de los que la Meet muestra de verdad en pantalla: se reduce a su tamaño real.
function outputScale(r, info, crop) {
  if (!info || !info.vw) return 1;
  const realW = (crop ? crop.w : 1) * info.vw * (info.dpr || 1);
  return Math.min(1, realW / r.sw);
}
async function encode(bmp, r, k = 1) {
  const ow = Math.max(1, Math.round(r.sw * k)), oh = Math.max(1, Math.round(r.sh * k));
  const c = new OffscreenCanvas(ow, oh);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, ow, oh);
  return els.format.value === 'jpeg'
    ? c.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    : c.convertToBlob({ type: 'image/png' });
}
async function exists(dir, name) {
  try { await dir.getFileHandle(name); return true; } catch (e) { if (e.name === 'NotFoundError') return false; throw e; }
}
async function writeFile(dir, blob) {
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const suffix = els.naming.value === 'numtime' ? `_${timeStr()}` : '';
  let n = state.nextNum, name;
  // Nunca se sobrescribe una imagen existente.
  for (;;) {
    name = `img${pad(n, 3)}${suffix}.${ext}`;
    const taken = dir === state.sessionDir && state.usedNums && state.usedNums.has(n);
    if (!taken && !(await exists(dir, name))) break;
    n++;
  }
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(blob);
    await w.close();
  } catch (e) {
    await w.abort().catch(() => {});
    await dir.removeEntry(name).catch(() => {});
    throw e;
  }
  if (dir === state.sessionDir) { state.nextNum = n + 1; if (state.usedNums) state.usedNums.add(n); }
  return name;
}
function showThumb(blob) {
  if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
  state.thumbUrl = URL.createObjectURL(blob);
  els.thumb.src = state.thumbUrl;
  els.thumb.classList.remove('hidden');
}
const APPEARING = { appearing: true }; // marca: la presentación acaba de empezar (Meet está animando)
const FATAL_FS = new Set(['NotFoundError', 'NotAllowedError', 'SecurityError', 'QuotaExceededError', 'NoModificationAllowedError', 'InvalidModificationError']);

async function tick(force) {
  if (!state.track) return;
  if (state.busy) { if (force) state.forcePending = true; return; }
  if (!force && !state.running) return;
  state.busy = true;
  const gen = state.gen, dir = state.sessionDir;
  let bmp = null, nextAction = null;
  try {
    // 1) ¿Qué Meet es y dónde está la presentación?
    let info = null;
    if (state.meet) {
      try { info = await getMeetInfo(); } catch (_) { info = null; }
      if (gen !== state.gen) return;
      state.info = info;
      showDetect(info);
      renderCrop();
      // Si la Meet se recargó, el navegador borra el aviso REC del icono: lo volvemos a poner.
      if (state.running) chrome.action.setBadgeText({ tabId: state.meet.tabId, text: 'REC' }).catch(() => {});
      if (info && info.code && state.meet.code && info.code !== state.meet.code) {
        nextAction = () => meetChanged(info.code);
        return;
      }
    }
    const mode = els.mode.value;
    if (mode === 'auto' && !force) {
      if (!state.meet) { state.waiting++; return; }
      if (!info || !info.presenting) { state.waiting++; state.lastRect = APPEARING; return; }
    }
    // 2) Fotograma
    bmp = await grabFrame();
    if (gen !== state.gen) return;
    state.errors = 0;
    const dims = `${bmp.width}x${bmp.height}`;
    if (!force && state.lastDims && state.lastDims !== dims) {
      // La ventana de Meet cambió de tamaño: esperamos un ciclo a que se estabilice.
      state.lastDims = dims; state.skipped++; return;
    }
    state.lastDims = dims;
    const crop = activeCrop(info);
    // La presentación se ha movido o la ventana de Meet cambió de tamaño (Meet anima las teselas al
    // empezar a presentar): esperamos un ciclo a que se estabilice.
    if (mode === 'auto' && crop) {
      const lr = state.lastRect;
      const moved = lr === APPEARING || (!!lr && (['x', 'y', 'w', 'h'].some((k) => Math.abs(lr[k] - crop[k]) > 0.01) ||
        Math.abs((lr.vw || 0) - (crop.vw || 0)) > 1 || Math.abs((lr.vh || 0) - (crop.vh || 0)) > 1));
      state.lastRect = crop;
      if (moved && !force) { state.skipped++; return; }
    }
    const r = cropRect(bmp.width, bmp.height, crop);
    // 3) ¿Ha cambiado?
    const sig = signature(bmp, r, crop);
    // Fotograma negro (el vídeo de la presentación aún no ha arrancado tras un cambio de diseño): no se guarda.
    if (!force && isBlank(sig)) { state.waiting++; return; }
    const diff = state.lastSig ? compare(sig, state.lastSig) : null;
    let changed = !diff || diff.pct >= minChange() || diff.tile >= TILE_T;
    const sigSize = `${r.sw}x${r.sh}`;
    if (!force && diff && state.sigSize && state.sigSize !== sigSize) {
      // La misma diapositiva dibujada a otro tamaño da pequeñas diferencias: solo cuenta un cambio grande.
      changed = diff.pct >= 10;
      if (!changed) { state.lastSig = sig; state.sigSize = sigSize; state.skipped++; return; }
    }
    if (!force && !changed) { state.skipped++; return; }
    // 4) Guardar
    const blob = await encode(bmp, r, outputScale(r, info, crop));
    if (gen !== state.gen || !dir) return;
    let name;
    try { name = await writeFile(dir, blob); } catch (e) { e.fs = true; throw e; }
    if (gen === state.gen) { state.lastSig = sig; state.sigSize = sigSize; }
    state.saved++; state.errors = 0; state.lastErr = null;
    showThumb(blob);
    log(`Guardada ${name}${diff ? ` (${diff.pct.toFixed(1)} % de cambio)` : ''}${force ? ' [manual]' : ''}`);
  } catch (e) {
    if (e.message !== state.lastErr) log(e.fs ? `No se pudo guardar la imagen (${e.message})` : `Fallo al capturar (${e.message}); lo vuelvo a intentar.`);
    state.lastErr = e.message;
    if (e.fs && FATAL_FS.has(e.name)) {
      stopCapture(e.name === 'QuotaExceededError' ? 'El disco está lleno.' : 'Se perdió el acceso a la carpeta (¿se borró o movió?). Vuelve a elegirla.');
      flash(els.pickFolder);
    } else if (++state.errors >= 5) {
      stopCapture('Demasiados errores seguidos.');
    }
  } finally {
    if (bmp && bmp.close) bmp.close();
    state.busy = false;
    updateStats();
    // (Promesas en vez de setTimeout: con el panel minimizado los setTimeout se retrasan.)
    if (nextAction) { state.forcePending = false; Promise.resolve().then(nextAction); }
    else if (state.forcePending) { state.forcePending = false; Promise.resolve().then(() => tick(true)); }
  }
}

// La pestaña capturada ha entrado en otra Meet (otro enlace): otra clase → otra carpeta.
async function meetChanged(code) {
  if (!state.meet) return;
  const wasRunning = state.running;
  stopCapture('Has cambiado de Meet.');
  state.meet.code = code;
  state.lastSig = null;
  els.className.value = currentClassName();
  updateUI();
  log(`Meet ${code}${currentClassName() ? ` → ${currentClassName()}` : ' (clase nueva: escribe su nombre y pulsa Guardar)'}`);
  if (currentClassName() && (wasRunning || els.autoStart.checked)) await startCapture(false);
}

// ---------- Controles ----------
async function startCapture(interactive) {
  if (state.running || state.starting) return;
  if (!state.track) { log('Primero abre la Meet y pulsa el icono de la extensión en esa pestaña.'); return; }
  if (state.meet && state.meet.code && !currentClassName()) { log('Escribe primero de qué clase es esta Meet y pulsa Guardar.'); els.className.focus(); flash(els.saveClass); return; }
  state.starting = true; updateUI();
  const g0 = state.gen, t0 = state.track;
  const changedSource = () => state.gen !== g0 || state.track !== t0;
  try {
    if (!(await ensurePermission(interactive))) return;
    if (changedSource()) { log('Cambiaste de pestaña de Meet mientras arrancaba; no se inicia.'); return; }
    const dir = await makeSessionDir();
    if (changedSource()) { log('Cambiaste de pestaña de Meet mientras arrancaba; no se inicia.'); return; }
    state.gen++;
    Object.assign(state, { sessionDir: dir, lastSig: null, lastDims: null, lastRect: null, sigSize: null, saved: 0, skipped: 0, waiting: 0, errors: 0, running: true });
    saveSettings();
    ticker.postMessage({ cmd: 'start', ms: intervalMs() });
    const where = [state.root.name, safeName(currentClassName()), layoutPart()].filter(Boolean).join('/');
    log(`Capturando cada ${intervalMs() / 1000} s en ${where}`);
  } catch (e) {
    log(`No se pudo empezar: ${e.message}`);
    if (e.name === 'NotFoundError') log('La carpeta principal ya no existe: vuelve a elegirla.');
  } finally {
    state.starting = false;
    updateUI(); updateStats();
  }
  if (state.running) tick(false);
}
function stopCapture(reason) {
  if (!state.running) return;
  state.gen++;
  ticker.postMessage({ cmd: 'stop' });
  state.running = false;
  state.sessionDir = null;
  updateUI();
  log(`${reason ? `${reason} ` : ''}Parado. ${state.saved} capturas guardadas.`);
}
els.start.onclick = () => startCapture(true);
els.stop.onclick = () => stopCapture();
els.captureNow.onclick = async () => {
  if (!state.track || state.starting) return;
  if (state.meet && state.meet.code && !currentClassName()) { log('Escribe primero de qué clase es esta Meet.'); els.className.focus(); return; }
  if (!(await ensurePermission(true))) return;
  if (!state.running) {
    try { state.sessionDir = await makeSessionDir(); } catch (e) { log(`No se pudo crear la carpeta: ${e.message}`); return; }
  }
  tick(true);
};
els.interval.addEventListener('change', () => {
  saveSettings();
  if (state.running) { ticker.postMessage({ cmd: 'start', ms: intervalMs() }); log(`Intervalo: ${intervalMs() / 1000} s`); }
});
els.mode.addEventListener('change', () => {
  state.lastSig = null; state.gen++;
  saveSettings(); showDetect(state.info); renderCrop(); updateUI(); updateStats();
});
[els.layout, els.naming].forEach((el) => el.addEventListener('change', () => {
  saveSettings(); updateUI();
  if (state.running) log('El cambio de carpetas/nombres se aplica la próxima vez que pulses Iniciar.');
}));
[els.sensitivity, els.format, els.autoStart].forEach((el) => el.addEventListener('change', () => { saveSettings(); updatePathPreview(); }));
els.className.addEventListener('input', () => {
  if (!(state.meet && state.meet.code)) { state.manualClass = els.className.value.trim(); updatePathPreview(); }
});
window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => {
  if (state.meet && state.meet.tabId != null) chrome.action.setBadgeText({ tabId: state.meet.tabId, text: '' }).catch(() => {});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.clases) { state.classes = changes.clases.newValue || {}; renderClasses(); updateUI(); }
});

// ---------- Inicio ----------
(async () => {
  try { if (screen.availHeight < window.outerHeight) window.resizeTo(window.outerWidth, screen.availHeight); } catch (_) {}
  loadSettings();
  updateUI(); updateStats();
  await Promise.all([loadClasses(), loadSavedFolder()]);
  updateUI();
  initDone();
  await consumePending();
})();
// ¿Nos han abierto (o nos han pasado) una pestaña de Meet mientras el panel cargaba?
async function consumePending() {
  try {
    const { pendingSource } = await chrome.storage.session.get('pendingSource');
    if (!pendingSource) return;
    await chrome.storage.session.remove('pendingSource');
    if (Date.now() - pendingSource.ts < 20000) await queueSource(pendingSource);
  } catch (e) { log(`Error al abrir la Meet: ${e.message}`); }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.pendingSource && changes.pendingSource.newValue) ready.then(consumePending);
});
