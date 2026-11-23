'use strict';

// ---------- Referencias a la UI ----------
const $ = (s) => document.querySelector(s);
const els = {
  pickFolder: $('#pickFolder'), folderName: $('#folderName'), sessionFolder: $('#sessionFolder'),
  pickSource: $('#pickSource'), sourceName: $('#sourceName'),
  stage: $('#stage'), video: $('#video'), cropBox: $('#cropBox'), resetCrop: $('#resetCrop'),
  interval: $('#interval'), sensitivity: $('#sensitivity'), format: $('#format'),
  start: $('#start'), stop: $('#stop'), captureNow: $('#captureNow'),
  stats: $('#stats'), thumb: $('#thumb'), log: $('#log')
};

// ---------- Estado ----------
const state = {
  root: null,          // carpeta elegida (FileSystemDirectoryHandle)
  sessionDir: null,    // subcarpeta de la sesión actual
  stream: null, track: null, imageCapture: null,
  running: false, busy: false,
  lastSig: null,       // "huella" de la última captura guardada
  crop: null,          // {x, y, w, h} relativo (0..1)
  saved: 0, skipped: 0, seq: 0,
  thumbUrl: null
};

// Comparación: se reduce la imagen a 160x90 en escala de grises y se cuenta
// qué % de píxeles ha cambiado más de PIX_T niveles (así ignora el "ruido" de compresión de Meet).
const SIG_W = 160, SIG_H = 90, PIX_T = 24;
const sigCanvas = new OffscreenCanvas(SIG_W, SIG_H);
const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

const ticker = new Worker('ticker.js');
ticker.onmessage = () => tick(false);

// ---------- Utilidades ----------
function log(msg) {
  const li = document.createElement('li');
  li.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  els.log.prepend(li);
  while (els.log.children.length > 80) els.log.lastChild.remove();
}
const pad = (n, l = 2) => String(n).padStart(l, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function updateUI() {
  const hasSource = !!state.track;
  els.start.disabled = state.running || !hasSource;
  els.stop.disabled = !state.running;
  els.captureNow.disabled = !hasSource;
  els.pickSource.disabled = state.running;
  els.pickFolder.disabled = state.running;
  els.stage.classList.toggle('hidden', !hasSource);
  els.start.textContent = state.running ? '● Capturando…' : '▶ Iniciar';
}
function updateStats() {
  els.stats.textContent = `Guardadas: ${state.saved} · Sin cambios: ${state.skipped}`;
}

// ---------- Ajustes persistentes ----------
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('ajustes') || '{}');
    if (s.interval) els.interval.value = s.interval;
    if (s.sensitivity) els.sensitivity.value = s.sensitivity;
    if (s.format) els.format.value = s.format;
    if (typeof s.sessionFolder === 'boolean') els.sessionFolder.checked = s.sessionFolder;
    if (s.crop) state.crop = s.crop;
  } catch (_) {}
}
function saveSettings() {
  localStorage.setItem('ajustes', JSON.stringify({
    interval: els.interval.value, sensitivity: els.sensitivity.value,
    format: els.format.value, sessionFolder: els.sessionFolder.checked, crop: state.crop
  }));
}
const intervalMs = () => Math.max(1, Number(els.interval.value) || 3) * 1000;
const minChange = () => Math.max(0, Number(els.sensitivity.value) || 1);

// ---------- IndexedDB (para recordar la carpeta entre sesiones) ----------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('capturas-clase', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
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
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

// ---------- Carpeta ----------
function showFolder(name, granted) {
  els.folderName.textContent = granted ? `📁 ${name}` : `📁 ${name} (se pedirá permiso al iniciar)`;
  els.folderName.classList.toggle('muted', !granted);
}
async function loadSavedFolder() {
  try {
    const h = await idbGet('dir');
    if (!h) return;
    state.root = h;
    showFolder(h.name, (await h.queryPermission({ mode: 'readwrite' })) === 'granted');
  } catch (_) {}
}
els.pickFolder.onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'capturas-clase', mode: 'readwrite', startIn: 'pictures' });
    state.root = h;
    await idbSet('dir', h);
    showFolder(h.name, true);
    log(`Carpeta: ${h.name}`);
  } catch (e) {
    if (e.name !== 'AbortError') log(`Error al elegir carpeta: ${e.message}`);
  }
};
async function ensurePermission() {
  if (!state.root) { log('Primero elige una carpeta de destino.'); return false; }
  const opts = { mode: 'readwrite' };
  if ((await state.root.queryPermission(opts)) === 'granted') return true;
  const ok = (await state.root.requestPermission(opts)) === 'granted';
  if (ok) showFolder(state.root.name, true); else log('Sin permiso para escribir en la carpeta.');
  return ok;
}

// ---------- Fuente (pestaña de Meet) ----------
function stopSource() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = state.track = state.imageCapture = null;
  els.video.srcObject = null;
  els.sourceName.textContent = 'Sin fuente';
  els.sourceName.classList.add('muted');
  updateUI();
}
els.pickSource.onclick = async () => {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'browser', frameRate: { ideal: 5, max: 10 } },
      audio: false,
      preferCurrentTab: false,
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'include'
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') log(`No se pudo capturar: ${e.message}`);
    return;
  }
  stopSource();
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.imageCapture = 'ImageCapture' in window ? new ImageCapture(state.track) : null;
  state.track.addEventListener('ended', () => {
    log('Se dejó de compartir la pestaña.');
    stopCapture();
    stopSource();
  });
  els.video.srcObject = stream;
  await els.video.play().catch(() => {});
  els.sourceName.textContent = state.track.label || 'Pestaña seleccionada';
  els.sourceName.classList.remove('muted');
  state.lastSig = null;
  renderCrop();
  updateUI();
  log(`Fuente: ${els.sourceName.textContent}`);
};
function fitStage() {
  if (els.video.videoWidth) els.stage.style.aspectRatio = `${els.video.videoWidth} / ${els.video.videoHeight}`;
}
els.video.addEventListener('loadedmetadata', fitStage);
els.video.addEventListener('resize', fitStage);

// ---------- Recorte (arrastrar sobre la vista previa) ----------
function renderCrop(box = state.crop) {
  if (!box) { els.cropBox.classList.add('hidden'); return; }
  Object.assign(els.cropBox.style, {
    left: `${box.x * 100}%`, top: `${box.y * 100}%`,
    width: `${box.w * 100}%`, height: `${box.h * 100}%`
  });
  els.cropBox.classList.remove('hidden');
}
let drag = null;
function relPoint(e) {
  const r = els.stage.getBoundingClientRect();
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) };
}
function boxFrom(p) {
  return { x: Math.min(drag.x, p.x), y: Math.min(drag.y, p.y), w: Math.abs(p.x - drag.x), h: Math.abs(p.y - drag.y) };
}
els.stage.addEventListener('pointerdown', (e) => {
  if (!state.track) return;
  drag = relPoint(e);
  els.stage.setPointerCapture(e.pointerId);
  renderCrop({ ...drag, w: 0, h: 0 });
});
els.stage.addEventListener('pointermove', (e) => { if (drag) renderCrop(boxFrom(relPoint(e))); });
els.stage.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const box = boxFrom(relPoint(e));
  drag = null;
  state.crop = box.w < 0.03 || box.h < 0.03 ? null : box;
  state.lastSig = null; // la siguiente captura se guardará con el nuevo recorte
  renderCrop();
  saveSettings();
  log(state.crop ? 'Recorte aplicado.' : 'Recorte quitado.');
});
els.resetCrop.onclick = () => { state.crop = null; state.lastSig = null; renderCrop(); saveSettings(); log('Recorte quitado.'); };

// ---------- Captura y comparación ----------
async function grabFrame() {
  if (state.imageCapture) {
    try { return await state.imageCapture.grabFrame(); } catch (_) { /* usamos el plan B */ }
  }
  if (els.video.videoWidth) return await createImageBitmap(els.video);
  throw new Error('todavía no hay imagen');
}
function cropRect(w, h) {
  const c = state.crop || { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.round(c.x * w), sy = Math.round(c.y * h);
  return { sx, sy, sw: Math.max(1, Math.min(w - sx, Math.round(c.w * w))), sh: Math.max(1, Math.min(h - sy, Math.round(c.h * h))) };
}
function signature(bmp, r) {
  sigCtx.imageSmoothingQuality = 'medium';
  sigCtx.drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, SIG_W, SIG_H);
  const d = sigCtx.getImageData(0, 0, SIG_W, SIG_H).data;
  const g = new Uint8Array(SIG_W * SIG_H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) g[j] = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
  return g;
}
function changedPercent(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIX_T) n++;
  return (n * 100) / a.length;
}
async function encode(bmp, r) {
  const c = new OffscreenCanvas(r.sw, r.sh);
  c.getContext('2d').drawImage(bmp, r.sx, r.sy, r.sw, r.sh, 0, 0, r.sw, r.sh);
  return els.format.value === 'jpeg'
    ? c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    : c.convertToBlob({ type: 'image/png' });
}
async function writeFile(blob) {
  const dir = state.sessionDir || state.root;
  const ext = blob.type === 'image/png' ? 'png' : 'jpg';
  const name = `${pad(++state.seq, 4)}_${stamp()}.${ext}`;
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return name;
}
function showThumb(blob) {
  if (state.thumbUrl) URL.revokeObjectURL(state.thumbUrl);
  state.thumbUrl = URL.createObjectURL(blob);
  els.thumb.src = state.thumbUrl;
  els.thumb.classList.remove('hidden');
}

async function tick(force) {
  if (state.busy || !state.track) return;
  state.busy = true;
  let bmp = null;
  try {
    bmp = await grabFrame();
    const r = cropRect(bmp.width, bmp.height);
    const sig = signature(bmp, r);
    const pct = state.lastSig ? changedPercent(sig, state.lastSig) : 100;
    if (!force && pct < minChange()) { state.skipped++; return; }
    const blob = await encode(bmp, r);
    const name = await writeFile(blob);
    state.lastSig = sig;
    state.saved++;
    showThumb(blob);
    log(`Guardada ${name}${pct < 100 ? ` (${pct.toFixed(1)} % de cambio)` : ''}`);
  } catch (e) {
    log(`Error: ${e.message}`);
  } finally {
    if (bmp && bmp.close) bmp.close();
    state.busy = false;
    updateStats();
  }
}

// ---------- Controles ----------
els.start.onclick = async () => {
  if (!state.track) return log('Primero elige la pestaña de Meet.');
  if (!(await ensurePermission())) return;
  try {
    state.sessionDir = els.sessionFolder.checked
      ? await state.root.getDirectoryHandle(`clase_${stamp()}`, { create: true })
      : null;
  } catch (e) { return log(`No se pudo crear la subcarpeta: ${e.message}`); }
  saveSettings();
  Object.assign(state, { lastSig: null, saved: 0, skipped: 0, seq: 0, running: true });
  ticker.postMessage({ cmd: 'start', ms: intervalMs() });
  updateUI(); updateStats();
  log(`Capturando cada ${intervalMs() / 1000} s${state.sessionDir ? ` en ${state.root.name}/${state.sessionDir.name}` : ''}`);
  tick(false);
};
function stopCapture() {
  if (!state.running) return;
  ticker.postMessage({ cmd: 'stop' });
  state.running = false;
  updateUI();
  log(`Parado. ${state.saved} capturas guardadas.`);
}
els.stop.onclick = stopCapture;
els.captureNow.onclick = async () => {
  if (!(await ensurePermission())) return;
  tick(true);
};
els.interval.addEventListener('change', () => {
  saveSettings();
  if (state.running) { ticker.postMessage({ cmd: 'start', ms: intervalMs() }); log(`Intervalo: ${intervalMs() / 1000} s`); }
});
[els.sensitivity, els.format, els.sessionFolder].forEach((el) => el.addEventListener('change', saveSettings));
window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });

// ---------- Inicio ----------
loadSettings();
loadSavedFolder();
renderCrop();
updateUI();
updateStats();
