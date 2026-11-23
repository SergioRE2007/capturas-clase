# Capturas de Clase (extensión de Chrome)

Hace una captura de la pestaña de Meet cada X segundos y **solo la guarda si la imagen ha cambiado**.
Las guarda en la carpeta que tú elijas.

## Instalar
1. Descomprime el zip.
2. Abre `chrome://extensions` y activa **Modo de desarrollador** (arriba a la derecha).
3. Pulsa **Cargar descomprimida** y elige la carpeta `capturas-clase`.
4. Fija el icono en la barra (icono del puzzle → chincheta).

## Usar
1. Entra en la clase de Meet.
2. Pulsa el icono de la extensión: se abre una ventanita con el panel.
3. **Elegir carpeta…** → elige dónde guardar (se recuerda para la próxima vez).
4. **Elegir pestaña de Meet…** → en el diálogo de Chrome elige la pestaña de la clase.
5. (Recomendado) Arrastra sobre la vista previa para **recortar solo la presentación**.
   Así las cámaras de la gente o los nombres de Meet no cuentan como "cambio".
6. **Iniciar**. Puedes cambiar de pestaña o minimizar el panel; no lo cierres.

## Ajustes
- **Intervalo**: cada cuántos segundos mira la pantalla (3 por defecto).
- **Cambio mínimo (%)**: qué porcentaje de la imagen tiene que cambiar para guardar.
  - Guarda demasiadas casi iguales → sube a 2–5 % o recorta mejor.
  - Se salta cambios pequeños (una línea nueva de código) → baja a 0,3–0,5 %.
- **Formato**: PNG para texto nítido, JPEG si quieres que ocupe menos.
- **Capturar ahora**: guarda una captura aunque no haya cambiado nada.

## Cómo detecta si ha cambiado
Reduce cada captura a 160×90 en escala de grises y la compara con la última guardada:
cuenta los píxeles que han cambiado de forma notable (más de 24 niveles, para ignorar
el ruido de compresión del vídeo de Meet). Si el % supera el umbral, guarda.
