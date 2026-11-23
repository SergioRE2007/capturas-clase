// Temporizador en un Worker: los setInterval de una pestaña/ventana en segundo plano
// se ralentizan mucho en Chrome; en un Worker siguen yendo a su ritmo.
let id = null;
onmessage = (e) => {
  const { cmd, ms } = e.data || {};
  if (id !== null) clearInterval(id);
  id = null;
  if (cmd === 'start') id = setInterval(() => postMessage('tick'), ms);
};
