// Service worker: makes Tessitura work offline after the first visit.
// Stale-while-revalidate for the app's own files; VERSION is replaced at deploy time.

const VERSION = 'dev';
const CACHE = `tessitura-${VERSION}`;
const CORE = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest', 'icons/icon.svg',
  'js/app.js', 'js/ui.js', 'js/state.js', 'js/store.js', 'js/music.js', 'js/charts.js', 'js/audio.js',
  'js/praat-client.js', 'js/praat-worker.js', 'js/capture-worklet.js', 'js/target.js',
  'js/views/live.js', 'js/views/practice.js', 'js/views/analyze.js', 'js/views/progress.js', 'js/views/settings.js',
  'wasm/praat.mjs', 'wasm/praat.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('tessitura-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    const network = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});
