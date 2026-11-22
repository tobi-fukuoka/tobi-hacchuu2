// 東美発注 Service Worker — オフラインで動かすためにファイルを保存します
const CACHE = 'tobi-hacchu-v4';
const FILES = ['./', './index.html', './app.js', './zxing.min.js', './html2canvas.min.js', './jspdf.umd.min.js', './manifest.json', './icon-192.png', './icon-512.png', './data/seed.json', './data/products.json'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(res => {
    if (res.ok && new URL(e.request.url).origin === location.origin) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return res;
  })));
});
