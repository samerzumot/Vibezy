// sw.js - Service Worker for PWA

const CACHE_NAME = 'vibezy-cache-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/map.js',
  '/video.js',
  '/firebase-config.js',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cache-first for map tiles
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith((async () => {
      const cache = await caches.open('osm-tiles');
      const cached = await cache.match(event.request);
      if (cached) return cached;
      try {
        const response = await fetch(event.request, { mode: 'cors' });
        cache.put(event.request, response.clone());
        return response;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // Network-first for HTML, cache-first for others
  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(event.request);
        const cache = await caches.open(CACHE_NAME);
        cache.put(event.request, fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE_NAME);
        return (await cache.match('/index.html')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (['style', 'script', 'image'].includes(event.request.destination)) {
        cache.put(event.request, response.clone());
      }
      return response;
    } catch (e) {
      return cached || Response.error();
    }
  })());
});

// Background sync placeholder for failed uploads (app coordinates retries when online)
self.addEventListener('sync', (event) => {
  if (event.tag === 'vibezy-upload') {
    event.waitUntil((async () => {
      const clientsArr = await self.clients.matchAll();
      clientsArr.forEach(c => c.postMessage({ type: 'RETRY_UPLOADS' }));
    })());
  }
});