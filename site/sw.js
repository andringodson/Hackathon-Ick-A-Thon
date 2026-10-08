// Rushcast service worker: offline app shell, fresh model data, notification clicks.
const VERSION = 'rc-v1';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/app.js',
  'assets/js/engine.js',
  'assets/js/store.js',
  'assets/js/bg.js',
  'assets/js/charts.js',
  'assets/js/ui.js',
  'assets/js/i18n.js',
  'assets/js/fx.js',
  'assets/js/assistant.js',
  'assets/js/session.js',
  'assets/js/clock.js',
  'assets/js/config.js',
  'assets/i18n/en.json',
  'assets/icons/icon.svg',
  'assets/icons/icon-192.png',
  'data/facilities.json',
  'data/model.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k.startsWith('rc-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    })
    .catch(() => cached);
  return cached || fresh;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache live database traffic.
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in') || url.hostname === 'ntfy.sh' || url.hostname.endsWith('qrserver.com')) return;
  if (url.origin === self.location.origin) {
    // HTML, code and model data: try the network first so deploys show up at once.
    const fresh = req.mode === 'navigate' || /\.(json|js|css|html|webmanifest)$/.test(url.pathname);
    event.respondWith(fresh ? networkFirst(req) : staleWhileRevalidate(req));
    return;
  }
  if (/fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(`./${event.notification.data?.url || ''}`, self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const win = wins.find((w) => w.url.startsWith(self.registration.scope));
      if (win) {
        win.navigate(target);
        return win.focus();
      }
      return self.clients.openWindow(target);
    }),
  );
});
