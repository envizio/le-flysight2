// Try the network briefly so updates arrive when online; fall back to the cache so the app opens with no signal.
const CACHE = 'le-live-v4';
const FILES = ['./', 'index.html', 'manifest.json', 'icon-192.png', 'icon-512.png',
  'logo-light.webp', 'fonts/anton.woff2', 'fonts/archivo.woff2', 'fonts/mono.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then(res => {
        if (res.ok) cache.put(e.request, res.clone());
        return res;
      });
      if (!cached) return fresh;
      const timeout = new Promise(r => setTimeout(() => r(cached), 2500));
      return Promise.race([fresh.catch(() => cached), timeout]);
    })
  );
});
