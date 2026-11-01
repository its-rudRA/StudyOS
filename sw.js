/**
 * StudyOS — Offline-First Service Worker (Network-First with Cache Fallback)
 *
 * Precaches the core application shell so StudyOS works 100% offline, while
 * using a Network-First strategy for HTML/CSS/JS during online sessions so
 * local development updates appear immediately without stale cache issues.
 */

const CACHE_NAME = 'studyos-shell-v2';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/variables.css',
  './css/layout.css',
  './css/components.css',
  './js/app.js',
  './js/core/db.js',
  './js/modules/focus.js',
  './js/modules/scheduler.js',
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((oldKey) => caches.delete(oldKey)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((networkResponse) => {
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          networkResponse.type === 'basic'
        ) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(async () => {
        const cachedResponse = await caches.match(request, { ignoreSearch: true });
        if (cachedResponse) return cachedResponse;

        if (request.mode === 'navigate') {
          const fallbackIndex = await caches.match('./index.html');
          if (fallbackIndex) return fallbackIndex;
        }
        throw new Error('Network error and no cached asset available.');
      }),
  );
});
