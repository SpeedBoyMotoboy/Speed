// Só existe para o app do motoboy poder ser instalado pelo Chrome. Não guarda nada: tudo vem sempre do servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
