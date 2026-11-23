// Al pulsar el icono de la extensión se abre (o se enfoca) la ventana del panel.
const PANEL_URL = chrome.runtime.getURL('panel.html');

chrome.action.onClicked.addListener(async () => {
  try {
    const ctx = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [PANEL_URL]
    });
    if (ctx.length) {
      await chrome.windows.update(ctx[0].windowId, { focused: true, state: 'normal' });
      return;
    }
  } catch (_) { /* si falla, abrimos una nueva */ }

  chrome.windows.create({ url: PANEL_URL, type: 'popup', width: 560, height: 860 });
});
