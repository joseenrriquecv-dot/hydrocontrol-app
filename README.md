# HydroControl (web)

Versión web instalable (PWA) del panel de control de una bomba de agua por MQTT: nivel, válvula, velocidad, horarios y auto-nivel.

Esta página **no contiene ningún dato de la bomba ni credenciales**. Solo es la interfaz: se conecta al broker MQTT con el host, usuario y contraseña que cada quien escribe en su propio login, y esa información se queda guardada solo en el navegador de cada dispositivo (nunca en este repositorio ni en ningún servidor).

Es una copia estática de `webapp/` del proyecto principal (repositorio privado). El código fuente y el resto del proyecto (Raspberry Pi, firmware ESP32, documentación) no están aquí.

## Instalar en el celular
1. Abre este sitio en el navegador del celular.
2. **Android (Chrome):** aparece un aviso para instalar, o desde el menú ⋮ elige *Añadir a pantalla de inicio*.
3. **iPhone (Safari):** toca *Compartir* → *Añadir a pantalla de inicio*.

Queda como un icono normal, en pantalla completa, sin la barra del navegador.
