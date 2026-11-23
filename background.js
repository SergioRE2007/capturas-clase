'use strict';
// Al pulsar el icono:
//  - Si estás en una pestaña de Meet: se obtiene permiso para capturar ESA pestaña (sin diálogo)
//    y se manda al panel, que detecta la clase por el código de la Meet y empieza a capturar.
//  - Si no: solo abre (o trae delante) el panel.
const PANEL_URL = chrome.runtime.getURL('panel.html');
const MEET_CODE_RE = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?=$|[/?#])/;
const meetCode = (url) => (MEET_CODE_RE.exec(url || '') || [])[1] || null;

async function findPanel() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [PANEL_URL] });
  return ctx[0] || null;
}

async function focusPanel(c) {
  const win = await chrome.windows.get(c.windowId);
  // Solo "des-minimizamos" si hace falta: no queremos quitar el maximizado/pantalla completa.
  await chrome.windows.update(c.windowId, win.state === 'minimized' ? { focused: true, state: 'normal' } : { focused: true });
  if (c.tabId >= 0) await chrome.tabs.update(c.tabId, { active: true });
}

async function onClick(tab) {
  const code = meetCode(tab && tab.url);
  let source = null;
  if (code) {
    try {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
      source = { tabId: tab.id, url: tab.url, code, streamId, ts: Date.now() };
    } catch (e) {
      // Normalmente: "la pestaña ya se está capturando" (por nosotros). Solo traemos el panel.
      source = { tabId: tab.id, url: tab.url, code, streamId: null, error: String((e && e.message) || e), ts: Date.now() };
    }
  }

  const panel = await findPanel().catch(() => null);
  if (panel) {
    if (source) await chrome.runtime.sendMessage({ type: 'source', source }).catch(() => {});
    await focusPanel(panel).catch(() => {});
    return;
  }
  if (source) await chrome.storage.session.set({ pendingSource: source });
  // ¿Hay un panel que acabamos de abrir y todavía está cargando? (doble clic rápido)
  // Entonces no abrimos otro: el panel recogerá pendingSource al terminar de cargar.
  const { panelWin } = await chrome.storage.session.get('panelWin');
  if (panelWin != null) {
    // (Los id de ventana no se reutilizan: si la ventana sigue existiendo, es nuestro panel.)
    const win = await chrome.windows.get(panelWin).catch(() => null);
    if (win && win.type === 'popup') {
      await chrome.windows.update(panelWin, { focused: true }).catch(() => {});
      return;
    }
  }
  const win = await chrome.windows.create({ url: PANEL_URL, type: 'popup', width: 600, height: 920 });
  await chrome.storage.session.set({ panelWin: win.id });
}

// Los clics se procesan de uno en uno: un doble clic rápido no abre dos paneles.
let queue = Promise.resolve();
chrome.action.onClicked.addListener((tab) => {
  queue = queue.then(() => onClick(tab)).catch((e) => console.warn('[Capturas de Clase]', e));
});

// El permiso para capturar (streamId) caduca a los pocos segundos. Si el panel tardó en abrirse, nos pide
// uno nuevo: el permiso que da pulsar el icono en esa pestaña sigue valiendo hasta que la pestaña navega.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== 'renew-stream') return;
  chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId })
    .then((streamId) => reply({ streamId }), (e) => reply({ error: String((e && e.message) || e) }));
  return true; // respuesta asíncrona
});

// El script de Meet avisa cuando entras en una reunión: ponemos un aviso en el icono de esa pestaña.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== 'meet-here' || !sender.tab) return;
  const tabId = sender.tab.id;
  (async () => {
    const { clases = {} } = await chrome.storage.local.get('clases');
    const name = msg.code ? clases[msg.code] : null;
    const title = msg.code
      ? `Capturas de Clase — pulsa para capturar ${name ? `«${name}»` : `esta Meet (${msg.code}, clase nueva)`}`
      : 'Capturas de Clase — pulsa estando en la pestaña de Meet';
    await chrome.action.setTitle({ tabId, title });
  })().catch(() => {});
});
