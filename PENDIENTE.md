# Pendiente

## 1. Capturar sin tener la ventana del panel abierta
Ahora la captura ocurre dentro de la ventana del panel: si se cierra, se para.
Idea: moverla a un *documento offscreen* de la extensión (`chrome.offscreen`, motivo `USER_MEDIA`),
que recibe el `streamId` de `tabCapture` y hace todo el trabajo: temporizador, comparación y guardado.
- El panel quedaría solo para la configuración: carpeta, clases y ajustes.
- Elegir la carpeta y conceder el permiso de escritura exige un clic en una página visible, así que
  eso seguiría haciéndose desde el panel. Hay que comprobar que el documento offscreen puede escribir
  con el `FileSystemDirectoryHandle` guardado en IndexedDB una vez concedido el permiso.
- Avisos (falta permiso, carpeta borrada…) en el icono (insignia y título) o con `chrome.notifications`.

## 2. Empezar solo al entrar en una Meet
- `meet.js` ya detecta cuándo entras en una reunión y la clase por su código.
- Límite del navegador: capturar una pestaña exige un gesto del usuario sobre ella (pulsar el icono,
  un atajo de teclado o un menú contextual). No se puede empezar sin ninguna acción.
- Lo más cercano a "automático":
  - **Atajo de teclado** (`commands` en el manifest, p. ej. Alt+Shift+C): cuenta como gesto y da permiso
    de `tabCapture` igual que el icono.
  - **Aviso al entrar** en una Meet conocida, con `chrome.notifications` o una insignia llamativa
    «▶ Pulsa para capturar Programación».
  - Confirmar con una prueba si una notificación de la extensión puede dar ese permiso. Seguramente no.

## 3. Comprobar el recorte en la Meet real
En la primera prueba real (23/11/2026) la detección funcionó («presentación detectada»), pero en la
vista previa el recuadro parecía desplazado un poco a la derecha y abajo, y podía cortar el borde
izquierdo de lo compartido. Hay que revisar `img001.png` de una clase real; si falta un trozo, revisar
`pictureRect()` en `meet.js` y `cropRect()` en `panel.js`.

## 4. Pruebas automáticas sin resolver
En la última tanda fallaron dos comprobaciones de regresión que no se llegaron a analizar:
- **Numeración:** no hubo números repetidos ni archivos sobrescritos, pero se guardaron menos imágenes
  de las esperadas.
- **Carpeta borrada a mitad de captura:** la captura no llegó a arrancar en esa prueba.

Sospecha: chocan con que ahora la captura arranca sola al elegir la carpeta. Sin confirmar.
