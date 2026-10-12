// Service worker de HydroControl: solo cachea el cascarón de la app (HTML/JS/CSS/iconos propios)
// para que abra al instante y se pueda instalar. La conexión MQTT en sí siempre necesita internet;
// esto no la reemplaza, solo evita una pantalla en blanco al abrir sin señal.
const CACHE = 'hydrocontrol-shell-v2';
const ARCHIVOS = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', (evento) => {
  evento.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARCHIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(claves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (evento) => {
  const { request } = evento;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;   // deja pasar MQTT/CDN sin tocar
  evento.respondWith(
    caches.match(request).then((cacheado) => cacheado || fetch(request).then((resp) => {
      const copia = resp.clone();
      caches.open(CACHE).then((c) => c.put(request, copia));
      return resp;
    }).catch(() => cacheado))
  );
});
