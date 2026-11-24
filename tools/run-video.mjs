#!/usr/bin/env node
// Arnés de pruebas: procesa vídeos con el código REAL de la extensión (video.html + video-worker.js + core/vnames/
// vdetect/vpolicy) en un Edge sin ventana, servido por http://127.0.0.1 (contexto seguro: OPFS, Web Locks y
// WebCodecs funcionan). Solo cambian el almacén (memoria) y la carpeta raíz (OPFS), mediante video.html?harness.
//
// Uso:
//   node tools/run-video.mjs <vídeo> <carpetaSalida> [opciones]
//   node tools/run-video.mjs --out <carpetaSalida> [opciones] <vídeo> [<vídeo>…]
// Opciones:
//   --tmp <dir>        dónde crear el perfil temporal de Edge (por defecto, el directorio temporal del sistema)
//   --mode equilibrado|final|todas   --step 1   --clase PMDPM   --naming vidtime|num
//   --order "a.webm,b.webm"          orden de los vídeos (confirma los grupos ambiguos)
//   --dump fixtures.json             {"<nombre del vídeo>": [t, …]}: guarda fotogramas completos en _dumps/
//   --edge <ruta a msedge.exe>       --headful (para depurar)
// Escribe en carpetaSalida: <Clase>/<fecha>/img…, .capturas-clase.json, _sheet_*.png y report.json.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { mode: 'equilibrado', step: 1, clase: 'PMDPM', tmp: os.tmpdir(), edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' };
const pos = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--headful') opt.headful = true;
  else if (a.startsWith('--')) opt[a.slice(2)] = args[++i];
  else pos.push(a);
}
if (!opt.out && pos.length === 2 && !/\.(webm|mp4|mkv|mov|m4v)$/i.test(pos[1])) opt.out = pos.pop();
if (!opt.out || !pos.length) { console.error('Uso: node tools/run-video.mjs <vídeo> <carpetaSalida> [--mode …] [--step …] [--clase …] [--tmp …]'); process.exit(2); }
const videos = pos.map((p) => path.resolve(p));
for (const v of videos) if (!fs.existsSync(v)) { console.error(`No existe: ${v}`); process.exit(2); }
const outDir = path.resolve(opt.out);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

// 1) Servidor http de la raíz del repositorio.
const srv = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0]).replace(/^\/+/, '');
  const f = path.resolve(ROOT, rel || 'video.html');
  if (!f.startsWith(ROOT)) { r.writeHead(403); r.end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    r.end(d);
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const httpPort = srv.address().port;

let edge = null, profile = null, ws = null;
async function cleanup() {
  try { if (ws) ws.close(); } catch (_) {}
  if (edge && edge.pid) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(-edge.pid, 'SIGKILL');
    } catch (_) {}
    edge = null;
  }
  srv.close();
  if (profile) { for (let i = 0; i < 10; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch (_) { await sleep(300); } } }
}
process.on('SIGINT', async () => { await cleanup(); process.exit(130); });

const t0 = Date.now();
let exitCode = 0;
try {
  // 2) Edge sin ventana con perfil propio y puerto de depuración libre.
  let ver = null, dport = 0;
  for (let attempt = 0; attempt < 5 && !ver; attempt++) {
    dport = 9300 + Math.floor(Math.random() * 500);
    try { await fetch(`http://127.0.0.1:${dport}/json/version`); continue; } catch (_) {} // ocupado
    profile = path.join(opt.tmp, `edge-prof-${dport}`);
    const eargs = [`--remote-debugging-port=${dport}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-background-timer-throttling', opt.headful ? '--window-size=1200,900' : '--headless=new', 'about:blank'];
    edge = spawn(opt.edge, eargs, { stdio: 'ignore', detached: process.platform !== 'win32' });
    for (let i = 0; i < 80 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${dport}/json/version`)).json(); } catch (_) { await sleep(250); } }
    if (!ver) { await cleanup(); }
  }
  if (!ver) throw new Error('No se pudo arrancar Edge');
  const page = (await (await fetch(`http://127.0.0.1:${dport}/json/list`)).json()).find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  let lastActivity = Date.now();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); return; }
    if (d.method === 'Runtime.consoleAPICalled') {
      lastActivity = Date.now();
      const txt = d.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
      if (/^\[video\]/.test(txt)) process.stdout.write(`${txt}\n`);
    } else if (d.method === 'Runtime.exceptionThrown') {
      const ex = d.params.exceptionDetails; console.error('Excepción en la página:', ex.exception ? ex.exception.description : ex.text);
    }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr, timeout = 120000) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout });
    if (r.result && r.result.exceptionDetails) throw new Error(`${expr.slice(0, 60)}: ${r.result.exceptionDetails.exception ? r.result.exceptionDetails.exception.description : r.result.exceptionDetails.text}`);
    if (r.error) throw new Error(r.error.message);
    return r.result.result.value;
  };
  await send('Page.enable'); await send('DOM.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: `http://127.0.0.1:${httpPort}/video.html?harness=1` });
  let ready = false;
  for (let i = 0; i < 200 && !ready; i++) { try { ready = await evaluate('!!(window.__harness && window.__harness.ready)'); } catch (_) {} if (!ready) await sleep(100); }
  if (!ready) throw new Error('La página no arrancó (window.__harness.ready)');
  await evaluate('__harness.clear()');
  // 3) Vídeos al <input type=file> y proceso.
  const doc = await send('DOM.getDocument');
  const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: '#files' });
  await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: videos });
  let n = 0;
  for (let i = 0; i < 50 && n < videos.length; i++) { n = await evaluate('__harness.rows().length'); if (n < videos.length) { if (i === 10) await evaluate('__harness.addSelected()'); await sleep(100); } }
  if (n < videos.length) throw new Error(`La página solo tiene ${n} de ${videos.length} vídeos`);
  const dumpTimes = opt.dump ? JSON.parse(fs.readFileSync(opt.dump, 'utf8')) : undefined;
  const runOpts = { clase: opt.clase, mode: opt.mode, step: Number(opt.step), naming: opt.naming, order: opt.order ? opt.order.split(',').map((s) => s.trim()) : undefined, dumpTimes };
  console.log(`Edge ${ver.Browser} · ${videos.length} vídeo(s) · modo ${opt.mode} · paso ${opt.step} s`);
  const stall = setInterval(() => { if (Date.now() - lastActivity > 120000) console.error('⚠ 2 min sin mensajes de la página'); }, 30000);
  const tRun = Date.now();
  let report;
  try { report = await evaluate(`__harness.run(${JSON.stringify(runOpts)})`, 3600000); } finally { clearInterval(stall); }
  const runMs = Date.now() - tRun;
  if (!report) throw new Error('El proceso no empezó (¿orden ambiguo o faltan datos?)');
  const rows = await evaluate('__harness.rows()');
  // 4) Copiar la salida de OPFS a disco.
  const files = await evaluate('__harness.list()');
  let bytes = 0;
  for (const f of files) {
    const dst = path.join(outDir, ...f.path.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const parts = [];
    for (let off = 0; off < f.size || off === 0; off += 4 << 20) {
      parts.push(Buffer.from(await evaluate(`__harness.read(${JSON.stringify(f.path)}, ${off}, ${4 << 20})`), 'base64'));
      if (f.size === 0) break;
    }
    fs.writeFileSync(dst, Buffer.concat(parts)); bytes += f.size;
  }
  const out = { browser: ver.Browser, videos, options: runOpts, runMs, totalMs: Date.now() - t0, rows, report, outputFiles: files.length, outputBytes: bytes };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(out, null, 1));
  // Resumen en consola.
  for (const [name, r] of Object.entries(report.files || {})) {
    const segs = (r.segments || []).length, pres = (r.segments || []).filter((s) => s.state === 'PRESENT').length;
    console.log(`${name}: ${r.images ?? 0} imágenes ${JSON.stringify(r.reasons || {})} · ${segs} segmentos (${pres} con presentación) · ${r.samples} muestras · ${r.decoded} fotogramas · ${((r.ms || 0) / 1000).toFixed(1)} s · ${r.codec} ${r.hw}${r.error ? ` · ERROR ${r.error.msg}` : ''}`);
  }
  console.log(`Total ${(runMs / 1000).toFixed(1)} s · ${files.length} archivos → ${outDir}`);
  if (report.error) { console.error(`Error: ${report.error}`); exitCode = 1; }
} catch (e) {
  console.error(e.stack || e.message);
  exitCode = 1;
} finally {
  await cleanup();
}
process.exit(exitCode);
