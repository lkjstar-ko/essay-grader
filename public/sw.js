const VERSION = '1.5';
const CACHE_NAME = 'essay-grader-' + VERSION;

// 설치 시 기본 파일 캐시 (index.html 제외 — 항상 최신 버전 사용)
self.addEventListener('install', function(event) {
  event.waitUntil(caches.open(CACHE_NAME));
  self.skipWaiting();
});

// 활성화 시 이전 캐시 삭제
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) { return key !== CACHE_NAME; })
            .map(function(key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

// 네트워크 요청 처리
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // API 요청 및 HTML 파일은 항상 네트워크 우선
  if (url.pathname.startsWith('/api/') ||
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(event.request).catch(function() {
        return caches.match(event.request);
      })
    );
    return;
  }

  // 그 외 정적 파일은 캐시 우선, 없으면 네트워크
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      });
    })
  );
});
