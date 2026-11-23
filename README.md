# Capturas de Clase (extensión para Edge y Chrome)

Captura **lo que comparte el profesor en Google Meet** cada X segundos y **solo guarda la imagen si ha cambiado**.
Reconoce la clase por el enlace de la Meet y guarda cada asignatura en su carpeta:

```
caps/
  Programación/
    2026-11-23/
      img001.png
      img002.png
  Bases de datos/
    2026-11-24/
      img001.png
```

## Instalar
1. Abre `edge://extensions` (en Chrome: `chrome://extensions`) y activa **Modo de desarrollador**.
2. Pulsa **Cargar desempaquetada** (en Chrome: **Cargar descomprimida**) y elige la carpeta `capturas-clase`.
3. Fija el icono en la barra (icono del puzle → ojo/chincheta).
4. Si al abrir Edge te sale «Desactivar extensiones en modo de desarrollador», ciérralo sin desactivarlas:
   si las desactivas, deja de funcionar.
5. Si tenías la Meet abierta mientras instalabas o actualizabas la extensión, recarga la pestaña de Meet (F5).

## Usar
1. La primera vez, pulsa el icono → **Elegir carpeta…** → elige tu carpeta (p. ej. `caps`). Se recuerda.
2. Entra en la Meet de la clase y **pulsa el icono de la extensión estando en esa pestaña**.
   - Si es una Meet nueva, te pregunta **de qué clase es** (p. ej. «Programación»). Escríbelo y pulsa **Guardar**.
     La próxima vez que entres en ese mismo enlace, la reconoce sola.
   - Empieza a capturar sola (puedes desactivarlo en Ajustes).
3. Puedes minimizar el panel y Edge, e irte a otras pestañas o programas. **No cierres** el panel ni la pestaña de Meet.
   Consejo: las capturas tienen la nitidez con la que Meet muestra la presentación en su ventana, así que
   cuanto más grande esté la presentación en la Meet (ventana maximizada, presentación fijada), mejor se lee.
4. Si cambias a otra Meet (otro profesor), pulsa el icono en esa pestaña: cambia de clase y de carpeta.

Edge no pone en suspensión la pestaña de Meet mientras se captura (está probado). Si quieres ir sobre seguro,
añade `meet.google.com` en `edge://settings/system` → «Nunca poner en suspensión estos sitios».

Tras reiniciar el navegador, el navegador puede pedirte de nuevo permiso para escribir en la carpeta:
pulsa **▶ Iniciar** y acepta.

## Ajustes
- **Qué capturar**
  - *Solo lo que comparte el profe* (por defecto): recorta automáticamente al vídeo de la presentación
    (sin cámaras, nombres ni la interfaz de Meet). Si nadie está compartiendo, no guarda nada.
    En la vista previa, el recuadro azul es lo que se guarda.
    Si tu propia cámara flotante tapa parte de la presentación, no cuenta como cambio, pero sí sale en la
    imagen: ocúltala en Meet (menú de tu miniatura → «Ocultarte» / «Minimizar») si quieres capturas limpias.
    Si el recuadro dice «nadie está presentando» y el profe SÍ está compartiendo, elige «La pestaña entera»
    o «Recorte a mano»: la detección se basa en cómo Meet etiqueta la presentación y podría cambiar.
  - *La pestaña entera* o *Recorte a mano* (arrastra sobre la vista previa).
- **Carpetas dentro de cada clase**: una por día, una por sesión (día y hora) o todo junto.
- **Nombre de las imágenes**: `img001.png…` o `img001_10-32-05.png…`. La numeración continúa y nunca se sobrescribe nada.
- **Intervalo**: cada cuántos segundos mira la pantalla (3 por defecto).
- **Cambio mínimo (%)**: guarda si cambia al menos ese % de la imagen. Además guarda siempre que cambie
  bien una zona pequeña (una línea de código nueva, el número de la diapositiva…).
- **Formato**: PNG para texto nítido, JPEG si quieres que ocupe menos.
- **Capturar ahora**: guarda una captura aunque no haya cambiado nada.
- **Clases guardadas**: lista de enlaces de Meet ↔ clase; puedes olvidar alguno.

## Cómo detecta si ha cambiado
Reduce cada captura a 256×144 en escala de grises y la compara con la última guardada. Un píxel cuenta como
cambiado si varía más de 24 niveles (así ignora el ruido de compresión del vídeo de Meet). Guarda si el % de
píxeles cambiados supera el umbral o si alguna zona pequeña (8×8 de la miniatura) cambia más de un 12 %.

## Permisos que pide
Al instalarla, Edge/Chrome muestra el aviso **«Leer y cambiar todos los datos en todos los sitios web»**.
Es el texto que el navegador pone siempre para el permiso de capturar pestañas; la extensión solo lee
meet.google.com y solo captura la pestaña en la que pulsas el icono.

- **Capturar pestañas** (`tabCapture`): para capturar la pestaña de Meet al pulsar el icono, sin diálogo.
- **meet.google.com**: para leer el código de la reunión (saber la clase) y localizar la presentación en la página.
- **Almacenamiento** y **scripting**: recordar las clases y activar el detector en Meets que ya estaban abiertas.
