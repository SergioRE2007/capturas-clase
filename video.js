'use strict';
// Página «Procesar vídeos grabados»: lista de vídeos, carpeta y permisos, manifiesto por carpeta, escritura de
// las imágenes que manda el worker (video-worker.js), progreso, línea de tiempo y registro.

const $ = (s) => document.querySelector(s);
const els = {
  pickFolder: $('#pickFolder'), folderName: $('#folderName'), pathPreview: $('#pathPreview'),
  drop: $('#drop'), addFiles: $('#addFiles'), files: $('#files'), claseAll: $('#claseAll'), applyClase: $('#applyClase'),
  claseList: $('#claseList'), queue: $('#queue'),
  mode: $('#vmode'), step: $('#vstep'), min: $('#vmin'), format: $('#vformat'), layout: $('#vlayout'), naming: $('#vnaming'), taskbar: $('#vtaskbar'),
  cropSec: $('#cropSec'), cropFile: $('#cropFile'), cropStage: $('#cropStage'), cropImg: $('#cropImg'), cropBox: $('#cropBox'),
  cropAlways: $('#cropAlways'), cropOne: $('#cropOne'), cropSize: $('#cropSize'), cropDims: $('#cropDims'), cropClear: $('#cropClear'), cropClose: $('#cropClose'),
  liveWarn: $('#liveWarn'), start: $('#start'), cancel: $('#cancel'), global: $('#global'), counters: $('#counters'), strip: $('#strip'), log: $('#log')
};
const { pad, safeName, fmtMediaTime } = CC;
const MANIFEST = '.capturas-clase.json';
const APP_VERSION = '2.1.0';
const FATAL_FS = new Set(['NotFoundError', 'NotAllowedError', 'SecurityError', 'QuotaExceededError', 'NoModificationAllowedError', 'InvalidModificationError']);
const HARNESS = location.protocol !== 'chrome-extension:' && new URLSearchParams(location.search).has('harness');

const state = {
  root: null, rows: [], nextId: 1, running: false, cancelRequested: false, worker: null,
  confirmed: new Set(),   // grupos con el orden confirmado
  sizeRects: {},          // recorte manual para todos los vídeos de un tamaño: { '1440x900': {rect, always} }
  classes: [], subfolders: [], groupInfo: {}, stripUrls: [], current: null, report: null, harnessSheets: HARNESS
};

// ---------- Utilidades ----------
function log(msg, t) {
  const li = document.createElement('li');
  li.textContent = `[${t != null ? fmtMediaTime(t).replace(/h|m/g, ':').replace('s', '') : new Date().toLocaleTimeString()}] ${msg}`;
  els.log.prepend(li);
  while (els.log.children.length > 200) els.log.lastChild.remove();
  if (HARNESS) console.log(`[video] ${li.textContent}`);
}
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); for (const k of kids) if (k != null) e.append(k); return e; };
const fmtDur = (s) => (s == null ? '—' : `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`);
const fmtMMSS = (s) => `${pad(Math.floor(s / 60))}:${pad(Math.floor(s % 60))}`;
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const humanDate = (iso) => { if (!iso) return 'sin fecha'; const [y, m, d] = iso.split('-').map(Number); return `${d} ${MESES[m - 1]} ${y}`; };
const groupKey = (r) => `${r.clase}\u0000${r.date}`;

// ---------- Almacén (chrome.storage o, en el arnés, memoria) ----------
if (HARNESS) {
  const mem = {};
  CC.store.get = async (k) => ({ [k]: mem[k] });
  CC.store.set = async (o) => { Object.assign(mem, o); };
}

// ---------- Ajustes (localStorage['ajustesVideo']; nunca se toca 'ajustes' del panel) ----------
function loadSettings() {
  let s = {}, p = {};
  try { s = JSON.parse(localStorage.getItem('ajustesVideo') || '{}') || {}; } catch (_) {}
  try { p = JSON.parse(localStorage.getItem('ajustes') || '{}') || {}; } catch (_) {}
  const setSel = (e, v) => { if (v != null && [...e.options].some((o) => o.value === v)) e.value = v; };
  setSel(els.mode, s.mode);
  setSel(els.format, s.format || p.format);
  setSel(els.layout, s.layout || p.layout);
  setSel(els.naming, s.naming);
  if (s.step != null) els.step.value = CC.clampNum(s.step, 0.5, 5, 1);
  if (s.minChange != null) els.min.value = CC.clampNum(s.minChange, 0.1, 50, 1);
  els.taskbar.checked = !!s.noTaskbar;
  if (s.lastClase) els.claseAll.value = s.lastClase;
}
function settings() {
  return {
    mode: els.mode.value, step: CC.clampNum(els.step.value, 0.5, 5, 1), minChange: CC.clampNum(els.min.value, 0.1, 50, 1),
    format: els.format.value, layout: els.layout.value, naming: els.naming.value, noTaskbar: els.taskbar.checked, lastClase: els.claseAll.value.trim()
  };
}
function saveSettings() {
  try { localStorage.setItem('ajustesVideo', JSON.stringify(settings())); } catch (_) {}
  updatePreview();
}
const subFor = (date) => { const l = els.layout.value; return l === 'flat' ? '' : l === 'session' ? `${date}_grabacion` : date; };
function imgName(num, ext, row, t) {
  const s = els.naming.value === 'vidtime' ? `${row.partEff ? `_p${row.partEff}` : ''}_${fmtMediaTime(t)}` : '';
  return `img${pad(num, 3)}${s}.${ext}`;
}
function updatePreview() {
  if (!state.root) { els.pathPreview.textContent = ''; return; }
  const r = state.rows.find((x) => x.checked) || { clase: els.claseAll.value.trim() || '(clase)', date: '2026-11-09', partEff: 1 };
  const parts = [state.root.name, safeName(r.clase || '(clase)'), subFor(r.date || 'YYYY-MM-DD'), imgName(1, els.format.value === 'jpeg' ? 'jpg' : 'png', r, 3)].filter(Boolean);
  els.pathPreview.textContent = `Se guardará así: ${parts.join(' / ')}`;
}

// ---------- Carpeta ----------
function showFolder(name, perm) {
  els.folderName.textContent = perm === 'granted' ? `📁 ${name}` : perm === 'denied' ? `📁 ${name} (sin permiso: vuelve a elegirla)` : `📁 ${name} (se pedirá permiso al empezar)`;
  els.folderName.classList.toggle('muted', perm !== 'granted');
  updatePreview();
}
async function loadFolder() {
  if (HARNESS) {
    const opfs = await navigator.storage.getDirectory();
    state.root = await opfs.getDirectoryHandle('harness', { create: true });
    showFolder('harness (OPFS)', 'granted');
    return;
  }
  try {
    const h = (await CC.idbGet('dirVideo')) || (await CC.idbGet('dir'));
    if (h) { state.root = h; showFolder(h.name, await h.queryPermission({ mode: 'readwrite' })); }
  } catch (_) {}
}
els.pickFolder.onclick = async () => {
  try {
    const h = await window.showDirectoryPicker({ id: 'capturas-clase', mode: 'readwrite', startIn: 'pictures' });
    state.root = h;
    await CC.idbSet('dirVideo', h).catch(() => {});
    showFolder(h.name, 'granted');
    log(`Carpeta: ${h.name}`);
    await refreshSubfolders(); await refreshProcessed();
  } catch (e) { if (e.name !== 'AbortError') log(`Error al elegir carpeta: ${e.message}`); }
};
async function hasPermission() {
  if (!state.root) return false;
  if (HARNESS) return true;
  try { return (await state.root.queryPermission({ mode: 'readwrite' })) === 'granted'; } catch (_) { return false; }
}
async function ensurePermission() {
  if (!state.root) { log('Primero elige la carpeta principal.'); els.pickFolder.classList.add('flash'); return false; }
  if (await hasPermission()) return true;
  let p;
  try { p = await state.root.requestPermission({ mode: 'readwrite' }); } catch (e) { log(`No se pudo pedir permiso: ${e.message}`); return false; }
  showFolder(state.root.name, p);
  if (p !== 'granted') log('Sin permiso para escribir en la carpeta. Vuelve a elegirla.');
  return p === 'granted';
}
async function refreshSubfolders() {
  state.subfolders = [];
  if (await hasPermission()) {
    try { for await (const [name, h] of state.root.entries()) if (h.kind === 'directory' && !name.startsWith('.')) state.subfolders.push(name); } catch (_) {}
  }
  renderClaseList();
}
async function loadClasses() {
  try { const c = (await CC.store.get('clases')).clases || {}; state.classes = [...new Set(Object.values(c))]; } catch (_) { state.classes = []; }
  renderClaseList();
}
function renderClaseList() {
  const names = [...new Set([...state.classes, ...state.subfolders])].sort((a, b) => a.localeCompare(b, 'es'));
  els.claseList.replaceChildren(...names.map((n) => el('option', { value: n })));
}

// ---------- Lista de vídeos ----------
function addFiles(list) {
  const today = new Date();
  for (const file of list) {
    if (!/\.(webm|mp4|mkv|m4v|mov)$/i.test(file.name) && !/^video\//.test(file.type)) { log(`Se ignora ${file.name} (no es un vídeo)`); continue; }
    if (state.rows.some((r) => r.name === file.name && r.size === file.size)) continue;
    const p = VN.parseName(file.name, today);
    const row = {
      id: state.nextId++, file, name: file.name, size: file.size, parsed: p, clase: els.claseAll.value.trim(), date: p.date || '', part: p.part,
      topic: p.topic, checked: true, status: 'pendiente', probe: null, progress: 0, images: 0, result: null, done: null, segs: [], ticks: [], manual: null
    };
    state.rows.push(row);
    probeRow(row);
  }
  render();
  refreshProcessed();
}
els.addFiles.onclick = () => els.files.click();
els.files.addEventListener('change', () => { addFiles([...els.files.files]); if (!HARNESS) els.files.value = ''; });
els.drop.addEventListener('dragover', (e) => { e.preventDefault(); els.drop.classList.add('over'); });
els.drop.addEventListener('dragleave', () => els.drop.classList.remove('over'));
els.drop.addEventListener('drop', (e) => { e.preventDefault(); els.drop.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
els.applyClase.onclick = () => {
  const c = els.claseAll.value.trim();
  if (!c) { els.claseAll.focus(); return; }
  for (const r of state.rows) r.clase = c;
  saveSettings(); render(); refreshProcessed();
};

// Reconocimiento de cada vídeo (miniatura, códec, tamaño, duración) en un worker aparte, de uno en uno.
let probeWorker = null, probeChain = Promise.resolve();
function probeRow(row) {
  probeChain = probeChain.then(() => new Promise((res) => {
    if (!probeWorker) probeWorker = new Worker('video-worker.js');
    const t = setTimeout(() => { row.probe = { error: 'tiempo agotado' }; probeWorker.terminate(); probeWorker = null; res(); }, 20000);
    probeWorker.onmessage = (e) => {
      const m = e.data;
      if (m.type !== 'done' && m.type !== 'error') return;
      clearTimeout(t);
      if (m.type === 'done') row.probe = m.result;
      else { row.probe = { error: m.msg, code: m.code }; if (m.code === 'UNSUPPORTED') { row.checked = false; row.status = 'no soportado'; } }
      render(); res();
    };
    probeWorker.postMessage({ type: 'probe', file: row.file });
  }));
}

// ¿Ya se procesó? (manifiesto de su carpeta) y cuántas imágenes tiene ya la carpeta.
async function readFolderInfo(clase, date) {
  if (!clase || !(await hasPermission())) return null;
  try {
    const cls = await state.root.getDirectoryHandle(safeName(clase));
    const sub = subFor(date);
    const dir = sub ? await cls.getDirectoryHandle(sub) : cls;
    return { manifest: await CC.readJson(dir, MANIFEST), counter: await CC.scanCounter(dir) };
  } catch (e) { if (e.name === 'NotFoundError' || e.name === 'TypeError') return null; throw e; }
}
async function refreshProcessed() {
  for (const g of VN.groupFiles(state.rows.filter((r) => r.clase && r.date))) {
    let info = null;
    try { info = await readFolderInfo(g.clase, g.date); } catch (_) {}
    state.groupInfo[`${g.clase}\u0000${g.date}`] = info;
    for (const r of g.files) {
      const e = info && info.manifest && (info.manifest.entries || []).find((x) => x.file === r.name && x.size === r.size);
      r.done = e || null;
      if (e && e.status === 'done' && r.status === 'pendiente' && !r.reprocess) r.checked = false;
    }
  }
  render();
}

// Grupos (clase, fecha) con su orden. Orden: parte explícita > «la única sin parte es la 1» > confirmar a mano.
function groups() {
  const gs = VN.groupFiles(state.rows.filter((r) => r.checked));
  for (const g of gs) {
    const key = `${g.clase}\u0000${g.date}`;
    const manual = state.confirmed.has(key);
    const o = VN.orderGroup(g.files);
    g.key = key;
    g.ambiguous = o.ambiguous && !manual;
    // El orden a mano (el de la lista) solo se usa si las partes no lo deciden: si las partes lo dejan claro, mandan ellas.
    g.ordered = o.ambiguous ? g.files.slice().sort((a, b) => state.rows.indexOf(a) - state.rows.indexOf(b)) : o.ordered;
    if (manual && o.ambiguous) g.ordered.forEach((r, i) => { if (r.part == null) r.partEff = null; });
  }
  return gs;
}
function move(row, dir) {
  const i = state.rows.indexOf(row), j = i + dir;
  if (j < 0 || j >= state.rows.length) return;
  [state.rows[i], state.rows[j]] = [state.rows[j], state.rows[i]];
  render();
}

// ---------- Dibujo de la lista ----------
function render() {
  const gs = groups();
  const unchecked = state.rows.filter((r) => !r.checked);
  const table = el('table');
  table.append(el('tr', {}, ...['', '#', '', 'Archivo', 'Duración', 'Clase', 'Fecha', 'Parte', 'Tema', 'Estado', ''].map((h) => el('th', { textContent: h }))));
  let n = 0;
  const addRow = (r) => {
    n++;
    const tr = el('tr');
    const chk = el('input', { type: 'checkbox', checked: r.checked, disabled: state.running });
    chk.onchange = () => { r.checked = chk.checked; if (chk.checked) r.reprocess = true; render(); };
    let mini = el('span', { className: 'muted', textContent: r.probe ? '' : '…' });
    if (r.probe && r.probe.thumb) { const c = el('canvas', { width: r.probe.thumb.width, height: r.probe.thumb.height, className: 'mini' }); c.getContext('2d').drawImage(r.probe.thumb, 0, 0); c.style.width = '96px'; mini = c; }
    const inp = (type, val, cls, onch) => { const i = el('input', { type, value: val == null ? '' : val, disabled: state.running }); if (cls) i.className = cls; i.onchange = () => onch(i.value); return i; };
    const clase = inp('text', r.clase, r.clase ? '' : 'bad', (v) => { r.clase = v.trim(); render(); refreshProcessed(); });
    clase.setAttribute('list', 'claseList');
    const date = inp('date', r.date, r.date ? '' : 'bad', (v) => { r.date = v; r.parsed.warn = null; render(); refreshProcessed(); });
    const part = inp('number', r.part, '', (v) => { r.part = v === '' ? null : Math.max(1, Math.round(Number(v)) || 1); render(); });
    const topic = inp('text', r.topic, '', (v) => { r.topic = v; });
    const name = el('td', {}, el('div', { textContent: r.name }));
    if (r.probe && r.probe.W) name.append(el('div', { className: 'muted', textContent: `${r.probe.W}x${r.probe.H} · ${r.probe.codec || ''}${r.manual ? ' · recorte manual' : ''}` }));
    if (r.probe && r.probe.error) name.append(el('div', { className: 'warn', textContent: r.probe.code === 'UNSUPPORTED' ? `⚠ Formato no soportado (${r.probe.error}). Conviértelo a WebM o MP4 H.264.` : `⚠ ${r.probe.error}` }));
    if (r.parsed.warn === 'swapped' && r.parsed.proposed && !r.date) {
      const [, mm, dd] = r.parsed.proposed.split('-').map(Number);
      const yes = el('button', { textContent: 'Sí' }), no = el('button', { textContent: 'No, la escribo', className: 'link' });
      yes.onclick = () => { r.date = r.parsed.proposed; r.parsed.warn = null; render(); refreshProcessed(); };
      no.onclick = () => { r.parsed.warn = null; render(); };
      name.append(el('div', { className: 'warn mini-btns' }, `¿Es el ${dd} de ${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][mm - 1]}? `, yes, ' ', no));
    } else if (r.parsed.warn === 'invalid' && !r.date) name.append(el('div', { className: 'warn', textContent: 'La fecha del nombre no existe: escríbela.' }));
    else if (r.parsed.warn === 'nodate' && !r.date) name.append(el('div', { className: 'warn', textContent: 'El nombre no lleva fecha: escríbela.' }));
    if (r.done && r.done.status === 'done' && !r.checked) {
      const d = new Date(r.done.processedAt);
      const again = el('button', { textContent: 'Procesar otra vez' }), drop = el('button', { textContent: 'Quitar', className: 'link' });
      again.onclick = () => { r.checked = true; r.reprocess = true; render(); };
      drop.onclick = () => { state.rows.splice(state.rows.indexOf(r), 1); render(); };
      name.append(el('div', { className: 'muted mini-btns' }, `Ya procesado el ${pad(d.getDate())}/${pad(d.getMonth() + 1)} (${r.done.images} imágenes) `, again, ' ', drop));
    }
    const status = el('td', { className: 'status' }, el('div', { textContent: r.status }));
    if (r.progress) { const b = el('div', { className: 'bar' }, el('i')); b.firstChild.style.width = `${Math.round(r.progress * 100)}%`; status.append(b); }
    const tools = el('td', { className: 'mini-btns' });
    if (!state.running) {
      const up = el('button', { textContent: '▲', title: 'Subir' }), dn = el('button', { textContent: '▼', title: 'Bajar' });
      up.onclick = () => move(r, -1); dn.onclick = () => move(r, 1);
      const cut = el('button', { textContent: '✂', title: 'Recorte manual…' }); cut.onclick = () => openCrop(r);
      const x = el('button', { textContent: '✕', title: 'Quitar de la lista' }); x.onclick = () => { state.rows.splice(state.rows.indexOf(r), 1); render(); };
      tools.append(up, dn, cut, x);
    }
    tr.append(el('td', {}, chk), el('td', { textContent: String(n) }), el('td', {}, mini), name,
      el('td', { textContent: fmtDur(r.result ? r.result.durationSec || r.result.lastTime : r.probe && r.probe.durationSec) }),
      el('td', { className: 'clase' }, clase), el('td', {}, date), el('td', { className: 'num' }, part), el('td', { className: 'tema' }, topic), status, tools);
    table.append(tr);
    if (r.result || r.segs.length) table.append(resultRow(r));
  };
  for (const g of gs) {
    const info = state.groupInfo[g.key];
    const sub = subFor(g.date);
    const more = info && info.counter && info.counter.nextNum > 1 ? ` (ya tiene ${info.counter.usedNums.size} imágenes; se seguirá en img${pad(info.counter.nextNum, 3)})` : '';
    table.append(el('tr', { className: 'group' }, el('td', { colSpan: 11 }, `${g.clase || '(sin clase)'} · ${humanDate(g.date)} `, el('span', { className: 'muted', textContent: `→ carpeta ${sub || '(la de la clase)'}${more}` }))));
    if (g.ambiguous) {
      const ok = el('button', { textContent: 'Confirmar orden', className: 'primary' });
      ok.onclick = () => { state.confirmed.add(g.key); render(); };
      table.append(el('tr', { className: 'ambig' }, el('td', { colSpan: 11 }, el('div', { className: 'warn' }, 'No sé en qué orden van estos vídeos. Ordénalos con ▲▼ (primero el que empezó antes) y pulsa Confirmar orden. ', ok))));
    }
    for (const r of g.ordered) addRow(r);
  }
  if (unchecked.length) {
    table.append(el('tr', { className: 'group' }, el('td', { colSpan: 11, textContent: 'Sin marcar (no se procesan)' })));
    for (const r of unchecked) addRow(r);
  }
  els.queue.replaceChildren(state.rows.length ? table : el('p', { className: 'muted', textContent: 'Todavía no has añadido vídeos.' }));
  const ready = gs.length && gs.every((g) => !g.ambiguous) && state.rows.filter((r) => r.checked).every((r) => r.clase && r.date);
  els.start.disabled = state.running || !ready;
  els.cancel.disabled = !state.running;
  updatePreview();
}
// Fila de resultado: línea de tiempo coloreada, miniaturas por segmento y resumen.
function resultRow(r) {
  const td = el('td', { colSpan: 11 });
  const total = Math.max(1, (r.result && r.result.lastTime) || (r.probe && r.probe.durationSec) || Math.max(1, ...r.segs.map((s) => s.t1 || s.t0)));
  const tl = el('div', { className: 'timeline' });
  const label = { PRESENT: 'presentación', NONE: 'sin presentación', PARTICIPANT: 'cámara de alguien', UNKNOWN: 'no es Meet', DECODE_ERROR: 'dañado', UNSTABLE: 'inestable', LOWQ: 'baja calidad' };
  const spans = r.segs.map((s) => ({ ...s, cls: s.state === 'PRESENT' && s.lowQ ? 'LOWQ' : s.state === 'PRESENT' && s.unstable ? 'UNSTABLE' : s.state }));
  if (r.result) for (const g of r.result.gaps.filter((x) => x[2] === 'DECODE_ERROR')) spans.push({ t0: g[0], t1: g[1], cls: 'DECODE_ERROR' });
  for (const s of spans) {
    const t1 = s.t1 != null ? s.t1 : total;
    const sp = el('span', { className: s.cls, title: `${fmtMMSS(s.t0)}–${fmtMMSS(t1)} · ${label[s.cls] || s.cls}${s.rect ? ` ${s.rect[2] - s.rect[0] + 1}×${s.rect[3] - s.rect[1] + 1}` : ''}` });
    sp.style.left = `${(s.t0 / total) * 100}%`; sp.style.width = `${Math.max(0.2, ((t1 - s.t0) / total) * 100)}%`;
    tl.append(sp);
  }
  for (const t of r.ticks) { const b = el('b'); b.style.left = `${(t / total) * 100}%`; tl.append(b); }
  td.append(tl);
  const thumbs = el('div', { className: 'segthumbs' });
  for (const s of r.segs.filter((x) => x.state === 'PRESENT' && x.thumb).slice(0, 20)) {
    const c = el('canvas', { width: s.thumb.width, height: s.thumb.height, title: `${fmtMMSS(s.t0)} · conf ${s.conf}` });
    const ctx = c.getContext('2d'); ctx.drawImage(s.thumb, 0, 0);
    if (s.rect && r.probe && r.probe.W) {
      const k = s.thumb.width / r.probe.W; ctx.strokeStyle = '#4f8cff'; ctx.lineWidth = 2;
      ctx.strokeRect(s.rect[0] * k, s.rect[1] * k, (s.rect[2] - s.rect[0]) * k, (s.rect[3] - s.rect[1]) * k);
    }
    if (s.conf < 0.7 || s.unstable) c.classList.add('amber');
    thumbs.append(c);
  }
  td.append(thumbs);
  if (r.result) {
    const none = r.result.noneSec || 0, pct = Math.round((none / total) * 100);
    const extra = pct >= 50 ? ` · ${pct} % del vídeo sin presentación: por eso hay pocas imágenes` : pct ? ` · ${pct} % sin presentación` : '';
    td.append(el('div', { className: 'muted small', textContent: `${r.result.images} imágenes · ${(r.result.ms / 1000).toFixed(1)} s de proceso${extra}${r.result.badSec ? ` · Se saltaron ${r.result.badSec} s dañados` : ''}` }));
  }
  return el('tr', { className: 'result' }, td);
}

// ---------- Recorte manual (por vídeo o por tamaño) ----------
let cropRow = null, drag = null, cropRel = null;
function openCrop(r) {
  if (!r.probe || !r.probe.thumb) { log('Espera a que se vea la miniatura del vídeo.'); return; }
  cropRow = r;
  const c = new OffscreenCanvas(r.probe.thumb.width, r.probe.thumb.height);
  c.getContext('2d').drawImage(r.probe.thumb, 0, 0);
  c.convertToBlob().then((b) => { els.cropImg.src = URL.createObjectURL(b); });
  els.cropStage.style.aspectRatio = `${r.probe.W} / ${r.probe.H}`;
  els.cropFile.textContent = r.name; els.cropDims.textContent = `${r.probe.W}x${r.probe.H}`;
  const m = r.manual || state.sizeRects[`${r.probe.W}x${r.probe.H}`];
  cropRel = m ? { x: m.rect.x0 / r.probe.W, y: m.rect.y0 / r.probe.H, w: (m.rect.x1 - m.rect.x0 + 1) / r.probe.W, h: (m.rect.y1 - m.rect.y0 + 1) / r.probe.H } : null;
  els.cropAlways.checked = !!(m && m.always);
  renderCropBox();
  els.cropSec.classList.remove('hidden');
  els.cropSec.scrollIntoView({ behavior: 'smooth' });
}
function renderCropBox() {
  const b = drag ? drag.box : cropRel;
  if (!b) { els.cropBox.classList.add('hidden'); return; }
  Object.assign(els.cropBox.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  els.cropBox.classList.remove('hidden');
}
function relPoint(e) {
  const r = els.cropStage.getBoundingClientRect();
  return { x: CC.clamp01((e.clientX - r.left) / r.width), y: CC.clamp01((e.clientY - r.top) / r.height) };
}
function boxFrom(a, p) { return { x: Math.min(a.x, p.x), y: Math.min(a.y, p.y), w: Math.abs(p.x - a.x), h: Math.abs(p.y - a.y) }; }
els.cropStage.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; const p = relPoint(e); drag = { start: p, box: { ...p, w: 0, h: 0 } }; els.cropStage.setPointerCapture(e.pointerId); renderCropBox(); });
els.cropStage.addEventListener('pointermove', (e) => { if (drag) { drag.box = boxFrom(drag.start, relPoint(e)); renderCropBox(); } });
els.cropStage.addEventListener('pointerup', (e) => { if (!drag) return; const b = boxFrom(drag.start, relPoint(e)); drag = null; cropRel = b.w < 0.03 || b.h < 0.03 ? null : b; renderCropBox(); });
function cropValue() {
  if (!cropRel || !cropRow) return null;
  const W = cropRow.probe.W, H = cropRow.probe.H;
  return { rect: { x0: Math.round(cropRel.x * W), y0: Math.round(cropRel.y * H), x1: Math.round((cropRel.x + cropRel.w) * W) - 1, y1: Math.round((cropRel.y + cropRel.h) * H) - 1 }, always: els.cropAlways.checked };
}
els.cropOne.onclick = () => { if (!cropRow) return; cropRow.manual = cropValue(); log(cropRow.manual ? `Recorte manual para ${cropRow.name}` : 'Recorte quitado.'); els.cropSec.classList.add('hidden'); render(); };
els.cropSize.onclick = () => {
  if (!cropRow) return;
  const k = `${cropRow.probe.W}x${cropRow.probe.H}`, v = cropValue();
  if (v) state.sizeRects[k] = v; else delete state.sizeRects[k];
  for (const r of state.rows) if (r.probe && `${r.probe.W}x${r.probe.H}` === k) r.manual = v;
  log(v ? `Recorte manual para todos los vídeos de ${k}` : 'Recorte quitado.');
  els.cropSec.classList.add('hidden'); render();
};
els.cropClear.onclick = () => { cropRel = null; renderCropBox(); };
els.cropClose.onclick = () => els.cropSec.classList.add('hidden');

// ---------- Proceso ----------
function updateGlobal(cur, totalBytes, doneBytes, eta) {
  const n = state.queue ? state.queue.length : 0;
  const i = state.queue ? state.queue.indexOf(cur) + 1 : 0;
  const pct = totalBytes ? Math.round((doneBytes / totalBytes) * 100) : 0;
  els.global.textContent = state.running ? `Vídeo ${i} de ${n} · ${pct} % del total${eta != null && isFinite(eta) ? ` · quedan ~${Math.max(1, Math.round(eta / 60))} min` : ''}` : els.global.textContent;
  const c = state.counters || { saved: 0, none: 0, bad: 0 };
  els.counters.textContent = `Guardadas ${c.saved} · Sin presentación ${fmtMMSS(c.none)} · Dañado ${fmtMMSS(c.bad)}`;
}
function addToStrip(blob, name) {
  const url = URL.createObjectURL(blob);
  state.stripUrls.push(url);
  const img = el('img', { src: url, title: name });
  img.onclick = () => window.open(url, '_blank');
  els.strip.prepend(img);
  while (els.strip.children.length > 50) { els.strip.lastChild.remove(); URL.revokeObjectURL(state.stripUrls.shift()); }
}

// Hoja de contactos (solo en el arnés): todas las imágenes guardadas a 240 px con nombre y motivo.
async function contactSheet(dir, row, items) {
  if (!items.length) return;
  const cw = 240, cols = 6;
  const ch = Math.max(...items.map((it) => Math.round(cw * it.h / it.w))) + 18;
  const rows = Math.ceil(items.length / cols);
  const c = new OffscreenCanvas(cw * cols, ch * rows), ctx = c.getContext('2d');
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.font = '11px sans-serif'; ctx.fillStyle = '#ddd';
  items.forEach((it, i) => {
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    ctx.drawImage(it.bmp, x, y, cw, Math.round(cw * it.h / it.w));
    ctx.fillText(`${it.name} · ${it.reason}`, x + 2, y + ch - 5);
    it.bmp.close();
  });
  const blob = await c.convertToBlob({ type: 'image/png' });
  const fh = await dir.getFileHandle(`_sheet_${row.name.replace(/\.[^.]+$/, '')}.png`, { create: true });
  const w = await fh.createWritable(); await w.write(blob); await w.close();
}

// Procesa un vídeo. Devuelve el resultado del worker (y escribe imágenes y manifiesto).
async function processRow(row, ctx) {
  const st = settings();
  const sub = subFor(row.date);
  const sess = await CC.openSessionDir(state.root, row.clase, sub);
  const { dir, counter, lockName } = sess;
  // Captura en directo en la misma carpeta: se permite (las escrituras van con cerrojo) pero se avisa.
  try {
    const q = navigator.locks && await navigator.locks.query();
    if (q && q.held.some((l) => l.name === `cc-live:${safeName(row.clase)}/${sub}`)) {
      els.liveWarn.textContent = 'Esa carpeta se está usando en una captura en directo; las imágenes se intercalarán.';
      els.liveWarn.classList.remove('hidden');
    }
  } catch (_) {}
  let manifest = await CC.withLock(lockName, () => CC.readJson(dir, MANIFEST)) || { version: 1, last: null, entries: [] };
  if (!manifest.entries) manifest.entries = [];
  if (manifest.entries.some((e) => e.date === row.date && e.part != null && row.partEff != null && e.part > row.partEff && e.file !== row.name))
    log(`Esta parte va antes que otras ya guardadas; sus imágenes irán al final (img${pad(counter.nextNum, 3)}…)`);
  // Referencia para no repetir la última imagen: la del vídeo anterior del grupo o la del manifiesto.
  let startSig = ctx.last;
  if (!startSig && manifest.last && manifest.last.sig) {
    try { startSig = { sig: CC.b64dec(manifest.last.sig), maskBits: manifest.last.maskBits ? CC.unpackBits(CC.b64dec(manifest.last.maskBits), 256 * 144) : null, sigSize: manifest.last.sigSize }; } catch (_) {}
  }
  const entry = {
    file: row.name, size: row.size, lastModified: row.file.lastModified, clase: row.clase, date: row.date, part: row.partEff, topic: row.topic,
    durationSec: row.probe && row.probe.durationSec || null, codec: row.probe && row.probe.codec || null, firstImg: null, lastImg: null, images: 0,
    reasons: {}, gaps: [], segments: [], mode: st.mode, settings: { step: st.step, minChange: st.minChange }, status: 'running', lastTime: 0,
    processedAt: new Date().toISOString(), app: APP_VERSION
  };
  manifest.entries = manifest.entries.filter((e) => !(e.file === row.name && e.size === row.size));
  manifest.entries.push(entry);
  let lastSaved = null, lastManifestWrite = performance.now(), sinceWrite = 0;
  const writeManifest = async () => {
    if (lastSaved) manifest.last = { file: row.name, img: lastSaved.name, t: lastSaved.t, sigSize: lastSaved.sigSize, sig: CC.b64enc(lastSaved.sig), maskBits: lastSaved.maskBits ? CC.b64enc(CC.packBits(lastSaved.maskBits)) : null };
    await CC.withLock(lockName, () => CC.writeJson(dir, MANIFEST, manifest));
    lastManifestWrite = performance.now(); sinceWrite = 0;
  };
  await writeManifest();
  row.status = 'procesando…'; row.progress = 0.001; row.segs = []; row.ticks = []; row.images = 0;
  render();
  const sheet = [], saved = [];
  const manual = row.manual || (row.probe && state.sizeRects[`${row.probe.W}x${row.probe.H}`]) || null;
  const worker = new Worker('video-worker.js');
  state.worker = worker;
  const t0 = performance.now();
  let fatal = null;
  const result = await new Promise((resolve) => {
    let writes = Promise.resolve();
    worker.onerror = (e) => { resolve({ error: { code: 'ERROR', msg: e.message || 'el worker falló' } }); };
    worker.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'progress') {
        row.progress = m.frac; ctx.onProgress(row, m.frac);
        row.status = `${Math.round(m.frac * 100)} % · ${row.images} imágenes`;
        throttleRender();
      } else if (m.type === 'segment') {
        const i = row.segs.findIndex((s) => s.id === m.seg.id);
        if (i >= 0) row.segs[i] = { ...row.segs[i], ...m.seg, thumb: m.seg.thumb || row.segs[i].thumb }; else row.segs.push(m.seg);
      } else if (m.type === 'image') {
        writes = writes.then(async () => {
          if (fatal) { worker.postMessage({ type: 'ack', id: m.id }); return; }
          try {
            const ext = m.blob.type === 'image/png' ? 'png' : 'jpg';
            const suffix = st.naming === 'vidtime' ? `${row.partEff ? `_p${row.partEff}` : ''}_${fmtMediaTime(m.t)}` : '';
            const name = await CC.writeImage(dir, m.blob, { counter, suffix, lockName, ext });
            row.images++; entry.images++; sinceWrite++; state.counters.saved++;
            entry.reasons[m.reason] = (entry.reasons[m.reason] || 0) + 1;
            entry.firstImg = entry.firstImg || name; entry.lastImg = name;
            lastSaved = { name, t: m.t, sig: m.sig, maskBits: m.maskBits, sigSize: m.sigSize };
            row.ticks.push(m.t);
            saved.push({ name, t: +m.t.toFixed(2), reason: m.reason, pct: m.pct != null ? +m.pct.toFixed(2) : null });
            addToStrip(m.blob, name);
            if (m.thumb && m.thumb.close) m.thumb.close();
            if (state.harnessSheets) sheet.push({ name, reason: m.reason, w: m.w, h: m.h, bmp: await createImageBitmap(m.blob, { resizeWidth: 240, resizeQuality: 'medium' }) });
            log(`Guardada ${name} (${{ first: 'primera', settled: 'ajustada', flush: 'antes de cambiar', pause: 'pausa', timeout: 'hace rato', end: 'final', 'end-forced': 'final', change: 'cambio' }[m.reason] || m.reason}${m.pct != null ? `; ${m.pct.toFixed(1)} % de cambio` : ''})`, m.t);
            if (sinceWrite >= 10 || performance.now() - lastManifestWrite > 60000) { entry.lastTime = m.t; entry.status = 'running'; await writeManifest(); }
          } catch (err) {
            log(`No se pudo guardar la imagen (${err.message})`);
            if (FATAL_FS.has(err.name)) { fatal = err; worker.postMessage({ type: 'cancel' }); }
          }
          worker.postMessage({ type: 'ack', id: m.id });
        });
      } else if (m.type === 'frameDump') {
        writes = writes.then(() => ctx.onDump && ctx.onDump(row, m));
      } else if (m.type === 'config') {
        log(`${row.name}: ${m.codec} (${m.hw === 'prefer-software' ? 'software' : 'aceleración por hardware si hay'})`);
      } else if (m.type === 'log') log(`${row.name}: ${m.msg}`);
      else if (m.type === 'done') writes.then(() => resolve({ result: m.result }));
      else if (m.type === 'error') writes.then(() => resolve({ error: m }));
    };
    worker.postMessage({ type: 'run', file: row.file, opts: { step: st.step, mode: st.mode, settings: { minChange: st.minChange, format: st.format, noTaskbar: st.noTaskbar },
      startSig, manualRect: manual && manual.rect, always: manual && manual.always, dumpTimes: ctx.dumpTimes || [] } });
    state.cancelHook = () => worker.postMessage({ type: 'cancel' });
  });
  worker.terminate(); state.worker = null; state.cancelHook = null;
  const res = result.result;
  if (res) {
    Object.assign(entry, { status: res.cancelled ? 'cancelled' : res.gaveUp ? 'partial' : 'done', lastTime: res.lastTime, gaps: res.gaps, codec: res.codec || entry.codec,
      durationSec: res.durationSec || entry.durationSec || res.lastTime,
      segments: res.segments.map((s) => ({ t0: s.t0, t1: s.t1, state: s.state, rect: s.rect, ux: s.ux, uy: s.uy, conf: s.conf, unstable: s.unstable || undefined, lowQ: s.lowQ || undefined })) });
    row.result = res;
    row.segs = res.segments.map((s) => ({ ...s, thumb: (row.segs.find((x) => x.id === s.id) || {}).thumb }));
    state.counters.none += res.noneSec || 0; state.counters.bad += res.badSec || 0;
    row.status = res.cancelled ? `cancelado · ${row.images} imágenes` : res.gaveUp ? `⚠ Vídeo dañado; se guardó hasta ${fmtMMSS(res.lastTime)}` : `✔ ${row.images} imágenes`;
    if (res.badSec) log(`${row.name}: se saltaron ${res.badSec} s dañados`);
    log(`${row.name}: ${row.images} imágenes en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } else {
    entry.status = 'partial';
    const err = result.error;
    row.status = err.code === 'UNSUPPORTED' ? `⚠ Formato no soportado (${err.msg})` : `⚠ ${err.msg}`;
    log(err.code === 'UNSUPPORTED' ? `Formato no soportado (${err.msg}). Conviértelo a WebM o MP4 H.264.` : `${row.name}: ${err.msg}`);
  }
  if (fatal) entry.status = 'cancelled';
  row.progress = 0;
  try { await writeManifest(); } catch (e) { if (!fatal) fatal = e; }
  if (state.harnessSheets) await contactSheet(dir, row, sheet).catch((e) => log(`Hoja de contactos: ${e.message}`));
  if (fatal) { fatal.fs = true; throw fatal; }
  const out = { ...(res || {}), error: result.error || null, dir: [safeName(row.clase), sub].filter(Boolean).join('/'), firstImg: entry.firstImg, lastImg: entry.lastImg, saved, wallMs: Math.round(performance.now() - t0) };
  ctx.last = res && res.last && res.last.sig ? res.last : ctx.last;
  return out;
}
let renderTimer = null;
function throttleRender() { if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; render(); }, 500); }

async function start(opts = {}) {
  if (state.running) return null;
  if (!(await ensurePermission())) return null;
  const gs = groups();
  if (gs.some((g) => g.ambiguous)) { log('Confirma primero el orden de los vídeos.'); return null; }
  saveSettings();
  state.running = true; state.cancelRequested = false; state.counters = { saved: 0, none: 0, bad: 0 };
  state.queue = gs.flatMap((g) => g.ordered);
  render();
  const totalBytes = state.queue.reduce((a, r) => a + r.size, 0);
  let doneBytes = 0, rate = null, lastT = performance.now(), lastB = 0;
  const report = { files: {}, startedAt: new Date().toISOString() };
  const t0 = performance.now();
  try {
    for (const g of gs) {
      const ctx = {
        last: null, dumpTimes: null, onDump: opts.onDump,
        onProgress: (row, frac) => {
          const now = performance.now(), b = doneBytes + frac * row.size;
          const inst = (b - lastB) / Math.max(1, (now - lastT) / 1000);
          if (now - lastT > 500) { rate = rate == null ? inst : 0.8 * rate + 0.2 * inst; lastT = now; lastB = b; }
          updateGlobal(row, totalBytes, b, rate ? (totalBytes - b) / rate : null);
        }
      };
      for (const row of g.ordered) {
        if (state.cancelRequested) break;
        ctx.dumpTimes = opts.dumpTimes && opts.dumpTimes[row.name] || null;
        updateGlobal(row, totalBytes, doneBytes, null);
        report.files[row.name] = await processRow(row, ctx);
        doneBytes += row.size; lastB = doneBytes;
        render();
      }
      if (state.cancelRequested) break;
    }
  } catch (e) {
    log(e.fs && FATAL_FS.has(e.name) ? (e.name === 'QuotaExceededError' ? 'El disco está lleno.' : 'Se perdió el acceso a la carpeta (¿se borró o movió?). Vuelve a elegirla.') : `Error: ${e.message}`);
    report.error = e.message;
  } finally {
    state.running = false;
    report.ms = Math.round(performance.now() - t0);
    els.global.textContent = state.cancelRequested ? 'Cancelado.' : `Terminado: ${state.counters.saved} imágenes en ${(report.ms / 1000).toFixed(0)} s.`;
    updateGlobal(null, 0, 0, null);
    render();
    refreshSubfolders();
  }
  return report;
}
els.start.onclick = () => start();
els.cancel.onclick = () => { state.cancelRequested = true; if (state.cancelHook) state.cancelHook(); log('Cancelando…'); };
window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
[els.mode, els.step, els.min, els.format, els.layout, els.naming, els.taskbar].forEach((e) => e.addEventListener('change', () => { saveSettings(); render(); refreshProcessed(); }));
els.claseAll.addEventListener('change', saveSettings);

// ---------- Arnés de pruebas (solo por http con ?harness; inerte en la extensión) ----------
async function walk(dir, prefix, out) {
  for await (const [name, h] of dir.entries()) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (h.kind === 'directory') await walk(h, p, out);
    else out.push({ path: p, size: (await h.getFile()).size });
  }
  return out;
}
async function fileAt(path) {
  const parts = path.split('/');
  let d = state.root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  return (await d.getFileHandle(parts[parts.length - 1])).getFile();
}
if (HARNESS) {
  window.__harness = {
    ready: false,
    async run(o = {}) {
      if (o.clase) { els.claseAll.value = o.clase; for (const r of state.rows) r.clase = o.clase; }
      if (o.mode) els.mode.value = o.mode;
      if (o.step) els.step.value = o.step;
      if (o.naming) els.naming.value = o.naming;
      if (o.dates) for (const r of state.rows) if (o.dates[r.name]) r.date = o.dates[r.name];
      if (o.order) {
        state.rows.sort((a, b) => (o.order.indexOf(a.name) + 1 || 999) - (o.order.indexOf(b.name) + 1 || 999));
        for (const g of VN.groupFiles(state.rows)) if (VN.orderGroup(g.files.slice()).ambiguous) state.confirmed.add(`${g.clase}\u0000${g.date}`);
      }
      for (const g of VN.groupFiles(state.rows)) if (VN.orderGroup(g.files.slice()).ambiguous && !o.order) state.confirmed.add(`${g.clase}\u0000${g.date}`);
      await probeChain;
      render();
      const dumps = [];
      const rep = await start({
        dumpTimes: o.dumpTimes,
        onDump: async (row, m) => {
          const slug = row.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_');
          const d = await (await state.root.getDirectoryHandle('_dumps', { create: true })).getDirectoryHandle(slug, { create: true });
          const fh = await d.getFileHandle(`${m.t}.png`, { create: true });
          const w = await fh.createWritable(); await w.write(m.blob); await w.close();
          dumps.push({ file: row.name, t: m.t, tReal: m.tReal, path: `_dumps/${slug}/${m.t}.png` });
        }
      });
      if (rep) { rep.dumps = dumps; for (const f of Object.values(rep.files)) if (f.last) delete f.last; }
      return rep;
    },
    async list() { return walk(state.root, '', []); },
    async read(path, off, len) {
      const f = await fileAt(path);
      const u = new Uint8Array(await f.slice(off, off + len).arrayBuffer());
      return CC.b64enc(u);
    },
    async clear() { for await (const name of state.root.keys()) await state.root.removeEntry(name, { recursive: true }); },
    addSelected() { addFiles([...els.files.files]); return state.rows.length; },
    rows() { return state.rows.map((r) => ({ name: r.name, date: r.date, part: r.part, partEff: r.partEff, clase: r.clase, probe: r.probe && { W: r.probe.W, H: r.probe.H, codec: r.probe.codec, durationSec: r.probe.durationSec, error: r.probe.error } })); }
  };
}

// ---------- Inicio ----------
(async () => {
  loadSettings();
  render();
  await Promise.all([loadClasses(), loadFolder()]);
  await refreshSubfolders();
  render();
  if (HARNESS) window.__harness.ready = true;
})();
