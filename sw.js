// sw.js — Service Worker：预缓存应用外壳并缓存同源资源（引擎/语言包已内置，无 CDN 依赖）
const VERSION = 'storybook-v14';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/db.js',
  './js/ocr.js',
  './js/cloudocr.js',
  './js/parser.js',
  './js/tts.js',
  './js/pdfimport.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// 引擎、wasm、语言包全部为本地文件：同源 cache-first 即可覆盖离线场景

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // 同源资源（含运行时才请求的语言包/wasm）：cache-first
  if (url.origin === location.origin) {
    event.respondWith(cacheFirst(event.request, VERSION));
  }
  // 跨域请求直接放行
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    // 仅缓存成功响应（tesseract worker 等跨域资源为 opaque 响应 status=0，也可缓存）
    if (res.ok || res.type === 'opaque') {
      const cache = await caches.open(cacheName);
      cache.put(request, res.clone());
    }
    return res;
  } catch (err) {
    // 离线且无缓存：语言包等大资源失败时给一个明确的错误
    return new Response('离线且缓存中无此资源', { status: 504, statusText: 'Offline' });
  }
}
