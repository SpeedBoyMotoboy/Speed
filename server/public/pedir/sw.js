// Só existe para a página de pedidos poder ser salva no celular. Não guarda nada: tudo vem sempre do servidor.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
