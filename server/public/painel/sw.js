// Só existe para o painel poder ser instalado como aplicativo. Não guarda nada: tudo vem sempre do servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
