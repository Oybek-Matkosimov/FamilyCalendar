/*
 * Minimal service worker. Its only job is a friendly "you're offline" page when the app is opened without a
 * connection. It never caches or touches API calls, live updates or any other request: calendar data always
 * comes fresh from the server.
 */
const CACHE = 'oybeks-calendar-offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/offline.html')));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return; // only page loads; everything else goes straight to the network
  event.respondWith(fetch(req).catch(() => caches.match('/offline.html')));
});
